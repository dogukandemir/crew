"""WebSocket hub: one socket per project per UI tab (docs/11 §3, ADR 0006)."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from datetime import UTC, datetime

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlalchemy import func, select

from crew.api.auth import authenticate_socket, origin_allowed
from crew.core import events as ev
from crew.core.db import session_scope
from crew.core.models import Event
from crew.core.settings import settings

log = logging.getLogger("crew.ws")
router = APIRouter()
CONTRACT = 1
COALESCE_MS = 100
MAX_FRAME_BYTES = 64 * 1024


@router.websocket("/ws/projects/{project_id}")
async def project_socket(websocket: WebSocket, project_id: str) -> None:
    if not origin_allowed(websocket.headers.get("origin")):
        await websocket.close(code=4403)
        return
    protocols = [p.strip() for p in websocket.headers.get("sec-websocket-protocol", "").split(",")]
    token = next((p.removeprefix("crew.auth.") for p in protocols if p.startswith("crew.auth.")), None)
    user = await authenticate_socket(token)
    if user is None:
        await websocket.close(code=4401)
        return
    try:
        since_seq = max(0, int(websocket.query_params.get("since_seq") or 0))
    except ValueError:
        await websocket.close(code=4400)
        return
    await websocket.accept(subprotocol="crew.v1" if "crew.v1" in protocols else None)
    queue = await ev.bus.subscribe(project_id)
    filters: dict = {}
    try:
        async with session_scope() as s:
            head = int(await s.scalar(select(func.max(Event.seq)).where(Event.project_id == project_id)) or 0)
        await websocket.send_json({"type": "hello", "project_id": project_id, "seq_head": head,
                                   "contract": CONTRACT,
                                   "server_time": datetime.now(UTC).isoformat(),
                                   "auth_mode": settings.auth_mode})
        last_seq = since_seq

        async def replay_through(head_seq: int) -> None:
            nonlocal last_seq
            while last_seq < head_seq:
                async with session_scope() as s:
                    rows = (await s.scalars(select(Event).where(Event.project_id == project_id,
                        Event.seq > last_seq, Event.seq <= head_seq).order_by(Event.seq).limit(200))).all()
                if not rows:
                    break
                for row in rows:
                    event = ev.event_to_dict(row)
                    if ev._matches(event, filters):
                        await websocket.send_json({"type": "event", "event": event, "seq": row.seq, "replay": True})
                    last_seq = row.seq

        async def pump_events() -> None:
            """Coalesce high-frequency events into 100 ms frames."""
            nonlocal last_seq
            buffer: list[dict] = []
            next_auth_check = 0.0
            while True:
                now = asyncio.get_running_loop().time()
                if settings.auth_mode != "local" and now >= next_auth_check:
                    next_auth_check = now + 5
                    if not await authenticate_socket(token):
                        await websocket.close(code=4401)
                        raise WebSocketDisconnect(code=4401)
                try:
                    frame = await asyncio.wait_for(queue.get(), timeout=COALESCE_MS / 1000)
                    if frame.get("type") == "gap":
                        await websocket.send_json(frame)
                        await replay_through(frame["to"])
                        continue
                    if frame.get("type") == "event":
                        e = frame["event"]
                        if e["seq"] <= last_seq:
                            continue
                        if e["seq"] > last_seq + 1:
                            await replay_through(e["seq"] - 1)
                        if not ev._matches(e, filters):
                            last_seq = e["seq"]
                            continue
                        buffer.append(e)
                except TimeoutError:
                    pass
                if buffer:
                    for event in buffer:
                        await websocket.send_json({"type": "event", "seq": event["seq"], "event": event})
                        last_seq = event["seq"]
                    buffer = []

        async def pump_client() -> None:
            nonlocal filters
            while True:
                raw = await websocket.receive_text()
                if len(raw.encode()) > MAX_FRAME_BYTES:
                    await websocket.close(code=4400)
                    raise WebSocketDisconnect(code=4400)
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    await websocket.send_json({"type": "error", "code": "bad_json"})
                    continue
                if not isinstance(msg, dict) or not isinstance(msg.get("filters", {}), dict) or not isinstance(msg.get("target", {}), dict):
                    await websocket.send_json({"type": "error", "code": "bad_message"})
                    continue
                action = msg.get("action")
                if action == "subscribe":
                    filters = msg.get("filters") or {}
                    f = filters.get("since_seq")
                    if f is None and msg.get("since_seq"):
                        f = msg["since_seq"]
                    await websocket.send_json({"type": "subscribed", "filters": filters})
                elif action == "unsubscribe":
                    filters = {}
                elif action == "ping":
                    await websocket.send_json({"type": "pong", "ts": msg.get("ts")})
                elif action == "steer":
                    current_user = await authenticate_socket(token)
                    if not current_user or current_user["role"] not in ("admin", "operator"):
                        await websocket.send_json({"type": "error", "code": "forbidden"})
                        continue
                    from crew.control.orchestrator import orchestrator

                    target = msg.get("target") or {}
                    text = str(msg.get("text", ""))[:2000]
                    if text:
                        await orchestrator.steer(project_id=project_id, text=text,
                                                 target_kind=target.get("kind", "project"),
                                                 target_id=target.get("id"), actor=user["id"])
                else:
                    await websocket.send_json({"type": "error", "code": "unknown_action",
                                               "detail": action})

        # replay history, then stream live (docs/11 §3 resume semantics)
        await replay_through(head)
        await websocket.send_json({"type": "replay.complete", "up_to": last_seq})

        tasks = [asyncio.create_task(pump_events()), asyncio.create_task(pump_client())]
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_EXCEPTION)
        for p in pending:
            p.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
    except WebSocketDisconnect:
        pass
    except Exception as e:  # pragma: no cover - socket robustness
        log.warning("socket error for %s: %s", project_id, e)
    finally:
        await ev.bus.unsubscribe(project_id, queue)
        with contextlib.suppress(Exception):
            await websocket.close()
