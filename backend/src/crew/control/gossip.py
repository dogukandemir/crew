"""Company gossip — real signals, retold (docs/17 batch 2).

Gossip here is not invention: every item carries `basis` (the rows it is retold from),
so the office can only repeat what the books already say — the budget really is that
thin, that task really did die three times. When the same topic is heard from enough
different mouths, `gossip.surfaced` fires and the concern is recorded in the project
brain: that is how a rumour turns into something the company has to look at.
"""

from __future__ import annotations

import random

from sqlalchemy import func, select

from crew.core import events as ev
from crew.core.brains import brain_service
from crew.core.db import session_scope
from crew.core.models import Agent, Event, Project, Task

MIN_MOUTHS = 3   # distinct speakers before a topic stops being a rumour
SCAN = 800


async def seeds(project_id: str) -> list[dict]:
    """Mine the real state for things worth whispering about, each with its evidence."""
    out: list[dict] = []
    async with session_scope() as s:
        p = await s.get(Project, project_id)
        if p is None:
            return out
        ratio = (p.spend_micros + p.reserved_micros) / max(1, p.budget_cap_micros)
        if ratio >= 0.55:
            out.append({
                "topic": "budget", "weight": 2,
                "text": f"The budget is {ratio:.0%} gone and the run isn't finished — I'd watch what I request.",
                "basis": [f"project:{p.id}", f"spend:{p.spend_micros}", f"reserved:{p.reserved_micros}"],
            })
        failed = (await s.scalars(select(Task).where(Task.project_id == project_id,
                                                     Task.state == "failed").limit(5))).all()
        for t in failed[:2]:
            out.append({
                "topic": "failing_work", "weight": 1,
                "text": f"Did you hear “{t.title[:60]}” keeps dying? {t.attempts} attempt(s) and nothing to show.",
                "basis": [f"task:{t.id}", f"attempts:{t.attempts}"],
            })
        blocked = int(await s.scalar(select(func.count(Task.id)).where(
            Task.project_id == project_id, Task.state == "blocked")) or 0)
        if blocked:
            out.append({
                "topic": "blocked_work", "weight": 1,
                "text": f"{blocked} task(s) are parked because nobody covers their skills — whoever plans hiring should hear that.",
                "basis": [f"blocked_count:{blocked}"],
            })
        struggling = (await s.scalars(select(Agent).where(
            Agent.project_id == project_id, Agent.state.in_(("probation", "suspended"))))).all()
        for a in struggling[:2]:
            out.append({
                "topic": "struggling_agent", "weight": 1,
                "text": f"{a.name} is on {a.state} — keep it between us, but that's telling.",
                "basis": [f"agent:{a.id}", f"state:{a.state}"],
            })
    if len(out) > 4:
        out = sorted(out, key=lambda x: -x["weight"])[:4]
    return out


async def office_chatter(project_id: str, *, max_items: int = 2) -> int:
    """A round of chatter between two colleagues; returns how many items were told."""
    async with session_scope() as s:
        agents = (await s.scalars(select(Agent).where(
            Agent.project_id == project_id,
            Agent.state.notin_(("archived", "suspended"))))).all()
    if len(agents) < 2:
        return 0
    seeds_ = await seeds(project_id)
    if not seeds_:
        return 0
    told = 0
    for seed in seeds_[:max_items]:
        a, b = random.sample(list(agents), 2)
        if random.random() < 0.5:
            a, b = b, a
        await ev.emit("agent.gossip", project_id=project_id, agent_id=a.id, severity="notice",
                      title=f"{a.name} ⟷ {b.name}: {seed['topic']}",
                      summary=seed["text"],
                      payload={"topic": seed["topic"], "text": seed["text"],
                               "from_agent_id": a.id, "from_name": a.name,
                               "to_agent_id": b.id, "to_name": b.name,
                               "basis": seed["basis"]})
        told += 1
        await maybe_surface(project_id, seed["topic"])
    return told


async def maybe_surface(project_id: str, topic: str) -> bool:
    """Enough different mouths on one topic → a surfaced concern (emitted once)."""
    async with session_scope() as s:
        rows = (await s.scalars(select(Event).where(Event.project_id == project_id,
                                                    Event.type == "agent.gossip")
                                .order_by(Event.seq.desc()).limit(SCAN))).all()
        already = (await s.scalars(select(Event).where(Event.project_id == project_id,
                                                       Event.type == "gossip.surfaced")
                                   .order_by(Event.seq.desc()).limit(SCAN))).all()
    if any((e.payload or {}).get("topic") == topic for e in already):
        return False
    mouths = {e.agent_id for e in rows
              if (e.payload or {}).get("topic") == topic and e.agent_id}
    if len(mouths) < MIN_MOUTHS:
        return False
    sample = next(e for e in rows if (e.payload or {}).get("topic") == topic)
    await ev.emit("gossip.surfaced", project_id=project_id, severity="warning",
                  title=f"concern surfaced: {topic}",
                  summary=(sample.summary or "")[:400],
                  payload={"topic": topic, "mouths": len(mouths),
                           "basis": (sample.payload or {}).get("basis", [])})
    try:
        brain_id = await brain_service.ensure_project_brain(project_id)
        await brain_service.write(project_id=project_id, brain_id=brain_id, kind="concern",
                                  title=f"Surfaced by office talk: {topic}",
                                  body=sample.summary or topic,
                                  source={"via": "gossip", "topic": topic},
                                  importance=0.7, tags=["gossip", topic])
    except Exception:
        pass  # the event is the record; the brain note is best-effort
    return True
