"""ADR 0010: the board, hierarchy, derivation, promotion, bug intake, and helpers."""

from __future__ import annotations

import asyncio

import pytest
from sqlalchemy import select

from crew.control import backlog
from crew.control.orchestrator import orchestrator
from crew.core.db import session_scope
from crew.core.models import Agent, AgentSkill, Event, Run, Task, WorkItem
from crew.domain.enums import Capability, TaskState
from crew.execution.tools import invoker


async def _agent(s, project_id: str, name: str, *, tools: list[str] | None = None,
                 department_id: str | None = None, squad_id: str | None = None) -> Agent:
    a = Agent(project_id=project_id, name=name, role="worker", grade=1, state="idle",
              tools=tools if tools is not None else [], autonomy="autonomous", mission="x",
              department_id=department_id, squad_id=squad_id)
    s.add(a)
    await s.flush()
    return a


def _twin(agent: Agent, tools: list[str]) -> Agent:
    t = Agent(project_id=agent.project_id, name=agent.name, role=agent.role, grade=agent.grade,
              state="idle", tools=tools, autonomy="autonomous", mission="x",
              department_id=agent.department_id, squad_id=agent.squad_id)
    t.id = agent.id
    return t


@pytest.mark.asyncio
async def test_plan_items_builds_epic_features_and_linked_stories(bound_loop, project):
    async with session_scope() as s:
        t1 = Task(project_id=project["id"], run_id="r-1", title="write the exporter",
                  required_skills=[{"skill": "python", "weight": 1.0}],
                  acceptance_criteria=["it runs"], state="pending")
        t2 = Task(project_id=project["id"], run_id="r-1", title="research the market",
                  required_skills=[{"skill": "web-research", "weight": 1.0}],
                  acceptance_criteria=["sources cited"], state="pending")
        s.add_all([t1, t2])
        await s.flush()
        t1_id, t2_id = t1.id, t2.id

    out = await backlog.plan_items(project_id=project["id"], goal="Ship the thing",
                                   tasks=[t1, t2])
    assert out["features"] == 2 and out["stories"] == 2

    b = await backlog.board(project_id=project["id"])
    flat = [i for col in b["columns"] for i in col["items"]]
    assert len([i for i in flat if i["kind"] == "epic"]) == 1
    assert len([i for i in flat if i["kind"] == "feature"]) == 2
    stories = [i for i in flat if i["kind"] == "story"]
    assert {s["task_id"] for s in stories} == {t1_id, t2_id}, "stories are the tasks, linked"

    # the column of a promoted item is the TASK's truth, derived on read
    async with session_scope() as s:
        row = await s.get(Task, t1_id)
        row.state = TaskState.RUNNING.value
        s.add(row)
    b2 = await backlog.board(project_id=project["id"])
    flat2 = [i for col in b2["columns"] for i in col["items"]]
    story1 = next(i for i in flat2 if i["task_id"] == t1_id)
    assert story1["state"] == "in_progress"
    epic = next(i for i in flat2 if i["kind"] == "epic")
    assert epic["state"] in ("in_progress", "ready"), "the epic rolls up from its children"


@pytest.mark.asyncio
async def test_a_ready_bug_is_promoted_once_and_its_column_follows_the_task(bound_loop, project):
    item = await backlog.create_item(project_id=project["id"], kind="bug",
                                     title="the export fails on empty rows",
                                     severity="high", created_by="system:test", state="ready")
    promoted = await backlog.promote_ready(project_id=project["id"], run_id="r-2")
    assert len(promoted) == 1 and promoted[0]["kind"] == "bug"
    async with session_scope() as s:
        t = await s.get(Task, promoted[0]["task_id"])
        w = await s.get(WorkItem, item["id"])
        evs = (await s.scalars(select(Event).where(Event.project_id == project["id"],
                                                   Event.type == "board.item.promoted"))).all()
    assert t.title.startswith("[bug] ") and t.priority == 1
    assert w.task_id == t.id and evs

    # a second pass never duplicates the work
    assert await backlog.promote_ready(project_id=project["id"], run_id="r-2") == []
    # and a promoted item cannot be moved by hand, its column is the task's
    with pytest.raises(ValueError, match="follows the task"):
        await backlog.move_item(project_id=project["id"], item_id=item["id"], state="done")


@pytest.mark.asyncio
async def test_report_bug_files_under_the_story_of_the_current_task(tool_context, bound_loop, project):
    async with session_scope() as s:
        agent = await _agent(s, project["id"], "Finder", tools=[Capability.BOARD_WRITE.value])
        run = Run(project_id=project["id"], goal="build")
        s.add(run)
        await s.flush()
        t = Task(project_id=project["id"], run_id=run.id, title="build it",
                 state=TaskState.RUNNING.value, assignee_agent_id=agent.id)
        s.add(t)
        await s.flush()
        story = WorkItem(project_id=project["id"], kind="story", title="build it",
                         state="ready", task_id=t.id)
        s.add(story)
        await s.flush()
        twin = _twin(agent, [Capability.BOARD_WRITE.value])
        t_id, story_id, agent_id = t.id, story.id, agent.id

    ctx = await tool_context(project_id=project["id"], agent=twin, task_id=t_id, run_id=run.id)
    r = await asyncio.to_thread(invoker.invoke, ctx, "report_bug",
                                {"title": "rows overflow the panel", "severity": "high"})
    assert r["ok"] is True, r
    async with session_scope() as s:
        bug = await s.get(WorkItem, r["data"]["item_id"])
    assert bug.kind == "bug" and bug.state == "ready"
    assert bug.parent_id == story_id, "the bug hangs under the story being worked"
    assert bug.created_by == agent_id and bug.severity == "high"


@pytest.mark.asyncio
async def test_a_user_task_kind_promotes_too(bound_loop, project):
    item = await backlog.create_item(project_id=project["id"], kind="task",
                                     title="wire the settings page", created_by="user:tester",
                                     state="ready")
    promoted = await backlog.promote_ready(project_id=project["id"], run_id="r-5")
    assert len(promoted) == 1 and promoted[0]["kind"] == "task"
    async with session_scope() as s:
        t = await s.get(Task, promoted[0]["task_id"])
    assert not t.title.startswith("[bug] ")
    assert t.acceptance_criteria == ["The task's outcome is delivered and verified"]
    # and it sits on the board under its own badge
    b = await backlog.board(project_id=project["id"])
    card = next(i for col in b["columns"] for i in col["items"] if i["id"] == item["id"])
    assert card["kind"] == "task" and card["state"] == "backlog"


@pytest.mark.asyncio
async def test_join_task_and_the_helper_takes_the_retry(tool_context, bound_loop, project):
    run = await orchestrator.start_run(project_id=project["id"], goal="helpers finish it")
    async with session_scope() as s:
        primary = await _agent(s, project["id"], "Primary")
        helper = await _agent(s, project["id"], "Helper", tools=[Capability.BOARD_WRITE.value])
        s.add(AgentSkill(agent_id=helper.id, skill_id="python", proficiency=0.7))
        t = Task(project_id=project["id"], run_id=run["id"], title="the fix",
                 state=TaskState.RUNNING.value, assignee_agent_id=primary.id,
                 required_skills=[{"skill": "python", "weight": 1.0}])
        s.add(t)
        await s.flush()
        twin = _twin(helper, [Capability.BOARD_WRITE.value])
        t_id, helper_id = t.id, helper.id

    ctx = await tool_context(project_id=project["id"], agent=twin, task_id="other", run_id=run["id"])
    r = await asyncio.to_thread(invoker.invoke, ctx, "join_task", {"task_id": t_id})
    assert r["ok"] is True, r
    async with session_scope() as s:
        t = await s.get(Task, t_id)
        joined = (await s.scalars(select(Event).where(Event.project_id == project["id"],
                                                      Event.type == "task.helper.joined"))).all()
    assert helper_id in (t.helpers or []) and joined

    # the first failure goes to the helper who joined, joint work finishes together
    async with session_scope() as s:
        row = await s.get(Task, t_id)
        row.state = TaskState.FAILED.value
        row.attempts = 1
        s.add(row)
    async with session_scope() as s:
        run_row = await s.get(Run, run["id"])
    await orchestrator._requeue_retries(run_row)
    async with session_scope() as s:
        t = await s.get(Task, t_id)
    assert t.assignee_agent_id == helper_id
    assert "helper takes over" in (t.escalation_reason or "")
