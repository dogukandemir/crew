"""WebSocket hub: one socket per project per UI tab (docs/11 §3, ADR 0006)."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from datetime import UTC, datetime

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlalchemy import func, select

from crew.api.auth import authenticate_socket
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
    token = websocket.query_params.get("token")
    user = await authenticate_socket(token)
    if user is None:
        await websocket.close(code=4401)
        return
    since_seq = int(websocket.query_params.get("since_seq") or 0)
    await websocket.accept()
    queue = await ev.bus.subscribe(project_id)
    filters: dict = {}
    try:
        async with session_scope() as s:
            head = int(await s.scalar(select(func.max(Event.seq)).where(Event.project_id == project_id)) or 0)
        await websocket.send_json({"type": "hello", "project_id": project_id, "seq_head": head,
                                   "contract": CONTRACT,
                                   "server_time": datetime.now(UTC).isoformat(),
                                   "auth_mode": settings.auth_mode})

        async def pump_events() -> None:
            """Coalesce high-frequency events into 100 ms frames."""
            buffer: list[dict] = []
            while True:
                try:
                    frame = await asyncio.wait_for(queue.get(), timeout=COALESCE_MS / 1000)
                    if frame.get("type") == "event":
                        e = frame["event"]
                        if not ev._matches(e, filters):
                            continue
                        buffer.append(e)
                except TimeoutError:
                    pass
                if buffer:
                    payload = ({"type": "event", "seq": buffer[-1]["seq"], "event": buffer[0]}
                               if len(buffer) == 1 else
                               {"type": "events", "seq": buffer[-1]["seq"], "events": buffer[:500]})
                    text = json.dumps(payload, default=str)
                    if len(text) > MAX_FRAME_BYTES:
                        payload = {"type": "events", "seq": buffer[-1]["seq"],
                                   "events": buffer[:50], "truncated": True}
                    await websocket.send_json(payload)
                    buffer = []

        async def pump_client() -> None:
            nonlocal filters
            while True:
                raw = await websocket.receive_text()
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    await websocket.send_json({"type": "error", "code": "bad_json"})
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
        if since_seq >= 0:
            async with session_scope() as s:
                rows = (await s.scalars(select(Event).where(Event.project_id == project_id,
                                                            Event.seq > since_seq)
                                        .order_by(Event.seq).limit(2000))).all()
            batch = [ev.event_to_dict(e) for e in rows]
            batch = [e for e in batch if ev._matches(e, filters)] if filters else batch
            for i in range(0, len(batch), 200):
                await websocket.send_json({"type": "events", "events": batch[i:i + 200],
                                           "seq": batch[min(i + 199, len(batch) - 1)]["seq"],
                                           "replay": True})
            await websocket.send_json({"type": "replay.complete", "up_to": head})

        tasks = [asyncio.create_task(pump_events()), asyncio.create_task(pump_client())]
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_EXCEPTION)
        for p in pending:
            p.cancel()
    except WebSocketDisconnect:
        pass
    except Exception as e:  # pragma: no cover - socket robustness
        log.warning("socket error for %s: %s", project_id, e)
    finally:
        await ev.bus.unsubscribe(project_id, queue)
        with contextlib.suppress(Exception):
            await websocket.close()
