"""Operating cadence: after a COMPLETED run the engine may start a bounded number of
follow-on passes; a person's run resets the streak; nothing runs when it is off."""

from __future__ import annotations

import asyncio

import pytest
from sqlalchemy import select

from crew.control.orchestrator import orchestrator
from crew.core.db import session_scope
from crew.core.models import Event, Project, Run


async def _set_cadence(project_id: str, *, enabled: bool, cap: int = 2) -> None:
    async with session_scope() as s:
        p = await s.get(Project, project_id)
        st = dict(p.settings or {})
        st.update({"cadence_enabled": enabled, "cadence_max_runs": cap})
        p.settings = st
        s.add(p)


async def _runs(project_id: str) -> list[Run]:
    async with session_scope() as s:
        return list((await s.scalars(select(Run).where(Run.project_id == project_id)
                                     .order_by(Run.started_at))).all())


async def _events(project_id: str, type_: str) -> list[Event]:
    async with session_scope() as s:
        return list((await s.scalars(select(Event).where(
            Event.project_id == project_id, Event.type == type_).order_by(Event.seq))).all())


@pytest.mark.asyncio
async def test_cadence_runs_bounded_follow_ons_then_holds(bound_loop, project):
    await _set_cadence(project["id"], enabled=True, cap=2)
    r1 = await orchestrator.start_run(project_id=project["id"], goal="ship the release")
    result = await orchestrator.advance(r1["id"])
    assert result["status"] == "completed", result

    # follow-ons run on background tasks; wait for the chain (2 kicks, then a hold)
    for _ in range(120):
        await asyncio.sleep(0.25)
        if await _events(project["id"], "run.cadence.held"):
            break

    runs = await _runs(project["id"])
    assert len(runs) == 3, f"1 manual + exactly 2 follow-on passes, got {len(runs)}"
    goals = [r.goal for r in runs]
    assert "follow-on pass 1/2" in goals[1] and "follow-on pass 2/2" in goals[2]
    assert all(r.status in ("completed", "failed") for r in runs), [r.status for r in runs]

    started = await _events(project["id"], "run.cadence.started")
    assert len(started) == 2, [e.title for e in started]
    async with session_scope() as s:
        p = await s.get(Project, project["id"])
    assert (p.settings or {}).get("cadence_streak") == 2, "the streak must land on the cap"


@pytest.mark.asyncio
async def test_cadence_off_means_no_follow_on_and_a_person_resets_the_streak(bound_loop, project):
    # off → a completed run starts nothing
    r1 = await orchestrator.start_run(project_id=project["id"], goal="ship quietly")
    assert (await orchestrator.advance(r1["id"]))["status"] == "completed"
    await asyncio.sleep(0.6)  # give a would-be follow-on time to appear
    assert len(await _runs(project["id"])) == 1
    assert not await _events(project["id"], "run.cadence.started")

    # on with a used streak: a person's run resets it (the cap counts follow-ons only)
    await _set_cadence(project["id"], enabled=True, cap=3)
    async with session_scope() as s:
        p = await s.get(Project, project["id"])
        st = dict(p.settings or {})
        st["cadence_streak"] = 2
        p.settings = st
        s.add(p)
    await orchestrator.start_run(project_id=project["id"], goal="a person takes over")
    async with session_scope() as s:
        p = await s.get(Project, project["id"])
    assert (p.settings or {}).get("cadence_streak") == 0
