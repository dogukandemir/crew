"""F21: a run that landed work is completed, and says which work did not land.

The live finding: run 2 of a three-project company had one build task completed with
a working deliverable and its verification task aborted at the retry cap. The run read
`failed` on every list, while the file was on disk and worked.
"""

from __future__ import annotations

import pytest
from sqlalchemy import select

from crew.control.orchestrator import orchestrator
from crew.core.db import session_scope
from crew.core.models import Event, Project, Run, Task


async def _run_with(project_id: str, tasks: list[tuple[str, str, str]]) -> tuple[str, Project]:
    async with session_scope() as s:
        p = await s.get(Project, project_id)
        run = Run(project_id=p.id, goal="Ship the price sheet", status="running", stage="LEARNING")
        s.add(run)
        await s.flush()
        for title, state, reason in tasks:
            s.add(Task(project_id=p.id, run_id=run.id, title=title, state=state,
                       escalation_reason=reason))
    return run.id, p


async def _row(run_id: str) -> Run:
    async with session_scope() as s:
        return await s.get(Run, run_id)


@pytest.mark.asyncio
async def test_one_of_two_tasks_failing_completes_the_run_and_names_the_failure(project):
    run_id, p = await _run_with(project["id"], [
        ("Build the price sheet", "completed", ""),
        ("Verify the price sheet", "aborted", "retry cap: verification fail: non_empty: 0 chars"),
    ])

    await orchestrator._learn(await _row(run_id), p)

    row = await _row(run_id)
    assert row.status == "completed", "the deliverable landed; the run did not fail"
    report = row.report
    assert report["partial"] is True
    assert [f["title"] for f in report["failed_tasks"]] == ["Verify the price sheet"]
    assert "retry cap" in report["failed_tasks"][0]["reason"]
    # the keys the report already carried are still there
    for key in ("goal", "delivered", "not_delivered", "cost_usd", "tokens", "agents_used", "lessons"):
        assert key in report, f"the report lost its existing key {key}"
    assert [d["task"] for d in report["delivered"]] == ["Build the price sheet"]


@pytest.mark.asyncio
async def test_nothing_completed_stays_failed(project):
    run_id, p = await _run_with(project["id"], [
        ("Build the price sheet", "failed", "verification fail: non_empty: 0 chars"),
        ("Verify the price sheet", "aborted", "retry cap"),
    ])

    await orchestrator._learn(await _row(run_id), p)

    row = await _row(run_id)
    assert row.status == "failed", "a run that delivered nothing is a failed run"
    assert row.report["partial"] is False
    assert [f["title"] for f in row.report["failed_tasks"]] == [
        "Build the price sheet", "Verify the price sheet"]


@pytest.mark.asyncio
async def test_a_fully_delivered_run_is_not_partial(project):
    run_id, p = await _run_with(project["id"], [("Build the price sheet", "completed", "")])

    await orchestrator._learn(await _row(run_id), p)

    row = await _row(run_id)
    assert row.status == "completed"
    assert row.report["partial"] is False
    assert row.report["failed_tasks"] == []
    async with session_scope() as s:
        event = await s.scalar(select(Event).where(Event.run_id == run_id,
                                                   Event.type == "run.completed"))
    assert event is not None and event.payload["partial"] is False
