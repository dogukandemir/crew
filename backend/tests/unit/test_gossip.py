"""Batch 2 of docs/17: gossip — real signals, retold, and problems that surface."""

from __future__ import annotations

import pytest
from sqlalchemy import select

from crew.control import gossip
from crew.core import events as ev
from crew.core.db import session_scope
from crew.core.models import Agent, Event, Task


async def _agent(s, project_id: str, name: str) -> Agent:
    a = Agent(project_id=project_id, name=name, role="worker", grade=1, state="idle",
              tools=[], autonomy="autonomous", mission="x")
    s.add(a)
    await s.flush()
    return a


@pytest.mark.asyncio
async def test_gossip_is_grounded_in_real_state(bound_loop, project):
    async with session_scope() as s:
        await _agent(s, project["id"], "G One")
        await _agent(s, project["id"], "G Two")
        s.add(Task(project_id=project["id"], title="crashy deploy", state="failed", attempts=3))
    told = await gossip.office_chatter(project["id"])
    assert told >= 1
    async with session_scope() as s:
        gs = (await s.scalars(select(Event).where(Event.project_id == project["id"],
                                                  Event.type == "agent.gossip"))).all()
    assert gs, "someone should have whispered something"
    for g in gs:
        p = g.payload or {}
        assert p.get("basis"), "gossip must cite its evidence — we never invent"
        assert p.get("topic") and p.get("from_agent_id") and p.get("to_agent_id")
        assert p["from_agent_id"] != p["to_agent_id"], "nobody gossips to themselves"


@pytest.mark.asyncio
async def test_rumours_surface_into_concerns_once(bound_loop, project):
    async with session_scope() as s:
        a = await _agent(s, project["id"], "Mouth One")
        b = await _agent(s, project["id"], "Mouth Two")
        c = await _agent(s, project["id"], "Mouth Three")
        ids = [a.id, b.id, c.id]
    for aid in ids:
        await ev.emit("agent.gossip", project_id=project["id"], agent_id=aid, severity="notice",
                      title="whisper", summary="the budget is nearly gone",
                      payload={"topic": "budget", "text": "the budget is nearly gone",
                               "basis": ["spend:high"], "from_agent_id": aid})
    assert await gossip.maybe_surface(project["id"], "budget") is True
    assert await gossip.maybe_surface(project["id"], "budget") is False, "a concern is raised once"
    async with session_scope() as s:
        surfaced = (await s.scalars(select(Event).where(Event.project_id == project["id"],
                                                        Event.type == "gossip.surfaced"))).all()
    assert len(surfaced) == 1 and surfaced[0].payload["mouths"] == 3


@pytest.mark.asyncio
async def test_a_single_mouth_is_not_a_concern(bound_loop, project, request=None):
    async with session_scope() as s:
        a = await _agent(s, project["id"], "Loner")
    await ev.emit("agent.gossip", project_id=project["id"], agent_id=a.id, severity="notice",
                  title="whisper", summary="something is off",
                  payload={"topic": "vibes", "text": "something is off", "basis": ["x"],
                           "from_agent_id": a.id})
    assert await gossip.maybe_surface(project["id"], "vibes") is False
