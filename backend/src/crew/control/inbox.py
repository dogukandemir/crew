"""Colleague messaging, the loop closes (docs/17 batch 2).

A message IS an `agent.message` event: no second ledger, no delivery state that can go
stale. `ask_colleague` delivers into the recipient's inbox; the recipient's next run
sees the open question in its task prompt and answers with `reply_colleague`; the answer
is delivered back and the asker sees it before ITS next task. A question that never
reaches a recipient stays open and visible, honest, rather than pretend-answered.
"""

from __future__ import annotations

from sqlalchemy import select

from crew.core import events as ev
from crew.core.db import session_scope
from crew.core.models import Agent, Event

SCAN_LIMIT = 600  # how far back into the event stream the inbox reaches


async def resolve_recipient(project_id: str, handle: str, *, sender: Agent | None = None) -> Agent | None:
    """'manager' → the sender's manager; else an exact id, then a name (first word, case-free)."""
    async with session_scope() as s:
        if handle in ("manager", "my manager") and sender is not None and sender.manager_id:
            return await s.get(Agent, sender.manager_id)
        agents = (await s.scalars(select(Agent).where(Agent.project_id == project_id,
                                                      Agent.state != "archived"))).all()
    h = (handle or "").strip()
    if not h:
        return None
    for a in agents:
        if a.id == h:
            return a
    low = h.lower()
    for a in agents:
        if a.name.lower() == low or a.name.lower().split()[0] == low:
            return a
    return None


async def deliver(project_id: str, *, sender: Agent | None, handle: str, text: str,
                  task_id: str | None, run_id: str | None = None, kind: str = "ask",
                  reply_to: str | None = None) -> dict:
    """Send one colleague message. Returns {"event": ..., "to_agent": Agent | None}."""
    to_agent = await resolve_recipient(project_id, handle, sender=sender)
    payload: dict = {"to": handle, "text": text, "direction": "out", "kind": kind}
    if to_agent is not None:
        payload.update({"to_agent_id": to_agent.id, "to_name": to_agent.name})
    if reply_to:
        payload["reply_to"] = reply_to
    event = await ev.emit("agent.message", project_id=project_id, task_id=task_id, run_id=run_id,
                          agent_id=sender.id if sender else None,
                          title=f"→ {to_agent.name if to_agent else handle}: {text[:80]}",
                          summary=text, payload=payload)
    return {"event": event, "to_agent": to_agent}


async def _recent(project_id: str) -> list[Event]:
    async with session_scope() as s:
        rows = (await s.scalars(select(Event).where(Event.project_id == project_id,
                                                    Event.type == "agent.message")
                                .order_by(Event.seq.desc()).limit(SCAN_LIMIT))).all()
    return list(rows)


async def _name_of(agent_id: str | None) -> str:
    if not agent_id:
        return "someone"
    async with session_scope() as s:
        a = await s.get(Agent, agent_id)
    return a.name if a else agent_id


async def open_questions(project_id: str, agent_id: str) -> list[dict]:
    """Questions addressed to this agent that nobody has answered yet."""
    rows = await _recent(project_id)
    answered = {str((e.payload or {}).get("reply_to")) for e in rows
                if (e.payload or {}).get("kind") == "reply" and (e.payload or {}).get("reply_to")}
    out: list[dict] = []
    for e in rows:
        p = e.payload or {}
        if p.get("kind") != "ask" or p.get("to_agent_id") != agent_id or e.id in answered:
            continue
        out.append({"id": e.id, "from": await _name_of(e.agent_id), "text": str(p.get("text", "")),
                    "task_id": e.task_id})
    return out


async def replies_for(project_id: str, agent_id: str) -> list[dict]:
    """Answers that came back to questions this agent asked."""
    rows = await _recent(project_id)
    mine = {e.id for e in rows
            if (e.payload or {}).get("kind") == "ask" and e.agent_id == agent_id}
    out: list[dict] = []
    for e in rows:
        p = e.payload or {}
        if p.get("kind") != "reply" or str(p.get("reply_to") or "") not in mine:
            continue
        out.append({"from": await _name_of(e.agent_id), "text": str(p.get("text", ""))})
    return out
