"""Batch 2 of docs/17: collaboration that actually happens.

- ask → delivered → answered → the asker sees the answer (the loop the old
  ask_colleague only promised);
- delegate_task hands a real task to a colleague and the floor gets an
  agent.delegated event for it;
- a first failure goes back to the producer's Lead (the ladder's first rung);
- a collected council.requested becomes a real council session.
"""

from __future__ import annotations

import asyncio

import pytest
from sqlalchemy import select

from crew.control import inbox
from crew.control.orchestrator import orchestrator
from crew.core import events as ev
from crew.core.db import session_scope
from crew.core.models import Agent, Event, Project, Run, Task
from crew.domain.enums import Capability, TaskState
from crew.execution.tools import invoker


async def _agent(s, project_id: str, name: str, *, role: str = "worker", grade: int = 1,
                 tools: list[str] | None = None, manager_id: str | None = None,
                 state: str = "idle") -> Agent:
    a = Agent(project_id=project_id, name=name, role=role, grade=grade, state=state,
              tools=tools if tools is not None else [], autonomy="autonomous", mission="x",
              manager_id=manager_id)
    s.add(a)
    await s.flush()
    return a


def _twin(project_id: str, agent: Agent, tools: list[str]) -> Agent:
    """Detached copy carrying the identity the policy checks read."""
    t = Agent(project_id=project_id, name=agent.name, role=agent.role, grade=agent.grade,
              state="idle", tools=tools, autonomy="autonomous", mission="x",
              manager_id=agent.manager_id)
    t.id = agent.id
    return t


@pytest.mark.asyncio
async def test_ask_colleague_is_delivered_and_answered(bound_loop, project):
    async with session_scope() as s:
        ada = await _agent(s, project["id"], "Ada")
        bo = await _agent(s, project["id"], "Bo")
        ada_twin, bo_twin = _twin(project["id"], ada, []), _twin(project["id"], bo, [])
        bo_id = bo.id

    sent = await inbox.deliver(project["id"], sender=ada_twin, handle="Bo",
                               text="Can you sanity-check my numbers?", task_id="t-1", kind="ask")
    assert sent["to_agent"] is not None and sent["to_agent"].id == bo_id

    open_qs = await inbox.open_questions(project["id"], bo_id)
    assert open_qs and open_qs[0]["text"].startswith("Can you")
    assert "Ada" in open_qs[0]["from"]

    await inbox.deliver(project["id"], sender=bo_twin, handle="Ada",
                        text="Checked, the totals are right.", task_id="t-2", kind="reply",
                        reply_to=open_qs[0]["id"])
    assert await inbox.open_questions(project["id"], bo_id) == [], "the question is answered"
    answers = await inbox.replies_for(project["id"], ada_twin.id)
    assert answers and "totals" in answers[0]["text"]


@pytest.mark.asyncio
async def test_delegate_task_creates_a_real_task_and_event(tool_context, bound_loop, project):
    async with session_scope() as s:
        boss = await _agent(s, project["id"], "Boss", role="lead", tools=[Capability.COMMS_ASK.value])
        run = Run(project_id=project["id"], goal="delegate")
        s.add(run)
        await s.flush()
        target = await _agent(s, project["id"], "Target")
        boss_twin = _twin(project["id"], boss, [Capability.COMMS_ASK.value])
        target_id = target.id

    ctx = await tool_context(project_id=project["id"], agent=boss_twin, task_id="t-boss", run_id=run.id)
    r = await asyncio.to_thread(invoker.invoke, ctx, "delegate_task",
                                {"agent": "Target", "brief": "Check the crawl stats"})
    assert r["ok"] is True, r
    assert r["data"]["delegated_to"] == "Target"

    async with session_scope() as s:
        tasks = (await s.scalars(select(Task).where(Task.project_id == project["id"],
                                                    Task.parent_id == ctx.task_id))).all()
        evs = (await s.scalars(select(Event).where(Event.project_id == project["id"],
                                                   Event.type == "agent.delegated"))).all()
    assert len(tasks) == 1 and tasks[0].assignee_agent_id == target_id
    assert tasks[0].state == TaskState.ASSIGNED.value
    assert evs, "the floor must be able to see the handoff"


@pytest.mark.asyncio
async def test_first_failure_goes_back_to_the_lead(bound_loop, project):
    run = await orchestrator.start_run(project_id=project["id"], goal="ladder")
    async with session_scope() as s:
        lead = await _agent(s, project["id"], "Lead L", role="lead")
        worker = await _agent(s, project["id"], "W", role="worker", manager_id=lead.id)
        t = Task(project_id=project["id"], run_id=run["id"], title="fails once", description="d",
                 deliverable="x", acceptance_criteria=["a"], output_contract={}, effort="S",
                 state=TaskState.FAILED.value, attempts=1, assignee_agent_id=worker.id)
        s.add(t)
        await s.flush()
        lead_id, tid = lead.id, t.id
    async with session_scope() as s:
        run_row = await s.get(Run, run["id"])
    await orchestrator._requeue_retries(run_row)
    async with session_scope() as s:
        t = await s.get(Task, tid)
    assert t.state == TaskState.ASSIGNED.value
    assert t.assignee_agent_id == lead_id, "the lead re-plans the first failure"
    assert "lead re-plans" in (t.escalation_reason or "")


@pytest.mark.asyncio
async def test_a_requested_decision_convenes_a_real_council(bound_loop, project):
    await ev.emit("council.requested", project_id=project["id"], task_id="t-q", title="decision requested",
                  payload={"question": "Which storage engine should we adopt?",
                           "options": [{"id": "pg", "label": "Postgres"}, {"id": "lite", "label": "SQLite"}]})
    async with session_scope() as s:
        p = await s.get(Project, project["id"])
    served = await orchestrator._service_decisions(p)
    assert served >= 1, "the request must be consumed"
    async with session_scope() as s:
        conv = (await s.scalars(select(Event).where(Event.project_id == project["id"],
                                                    Event.type == "council.convened"))).all()
    assert any("storage engine" in str((e.payload or {}).get("question", "")) for e in conv), \
        "a real council session must exist for the question"
    # and it is not served twice
    assert await orchestrator._service_decisions(p) == 0


@pytest.mark.asyncio
async def test_escalate_tool_persists_where_it_went(tool_context, bound_loop, project):
    """Escalating is a fact about the task: reason + escalated_to are written, not just
    emitted, the API has served that field all along (docs/17 batch 3)."""
    async with session_scope() as s:
        lead = await _agent(s, project["id"], "Lead", role="lead")
        worker = await _agent(s, project["id"], "Escalator", manager_id=lead.id,
                              tools=[Capability.COMMS_ESCALATE.value])
        run = Run(project_id=project["id"], goal="escalate")
        s.add(run)
        await s.flush()
        twin = _twin(project["id"], worker, [Capability.COMMS_ESCALATE.value])
        t = Task(project_id=project["id"], run_id=run.id, title="stuck on the CDN",
                 description="d", deliverable="x", acceptance_criteria=["a"], output_contract={},
                 effort="S", state=TaskState.RUNNING.value, assignee_agent_id=worker.id)
        s.add(t)
        await s.flush()
        tid, lead_id = t.id, lead.id
    ctx = await tool_context(project_id=project["id"], agent=twin, task_id=tid, run_id=run.id)
    r = await asyncio.to_thread(invoker.invoke, ctx, "escalate",
                                {"reason": "the CDN rejects our payload format"})
    assert r["ok"] is True and r["data"]["escalated_to"] == lead_id
    async with session_scope() as s:
        t = await s.get(Task, tid)
        evs = (await s.scalars(select(Event).where(Event.project_id == project["id"],
                                                   Event.type == "task.escalated"))).all()
    assert t.escalated_to == lead_id, "the manager the escalation went to is persisted"
    assert "CDN rejects" in (t.escalation_reason or "")
    assert any((e.payload or {}).get("escalated_to") == lead_id for e in evs), \
        "the event carries the same destination"
