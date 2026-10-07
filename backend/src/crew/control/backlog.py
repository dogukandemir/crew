"""The backlog board (ADR 0010): epic → feature → story, bugs, and promotion.

Planning entities live in `work_items`; execution stays in `tasks`. The split is the
point: a board full of epics cannot be dispatched, and a task table cannot tell a
story. A READY story or bug is promoted into a real task by the orchestrator's board
pass, and the wave/verify/reward machinery takes it from there; after promotion the
board column is DERIVED from the task state, so the board cannot disagree with the
engine — the "one metre" rule, applied to workflow.
"""

from __future__ import annotations

import logging

from sqlalchemy import select

from crew.core import events as ev
from crew.core.db import session_scope
from crew.core.models import Agent, Task, WorkItem
from crew.domain.catalog import SKILLS_BY_ID

log = logging.getLogger(__name__)

KINDS = ("epic", "feature", "story", "bug")
COLUMNS = ("backlog", "ready", "in_progress", "review", "done", "blocked")
COLUMN_TITLES = {"backlog": "Backlog", "ready": "Ready", "in_progress": "In progress",
                 "review": "Review", "done": "Done", "blocked": "Blocked"}

TASK_STATE_TO_COLUMN = {
    "pending": "backlog", "ready": "backlog", "blocked": "blocked",
    "assigned": "ready", "running": "in_progress", "verifying": "review",
    "completed": "done", "failed": "blocked", "aborted": "blocked",
}


def _is_agent(handle: str) -> bool:
    return bool(handle) and handle not in ("user", "system") and not handle.startswith("user:")


async def create_item(*, project_id: str, kind: str, title: str, body: str = "",
                      acceptance: list | None = None, parent_id: str | None = None,
                      department_id: str | None = None, squad_id: str | None = None,
                      created_by: str = "user", severity: str = "normal",
                      state: str = "backlog", priority: int = 2,
                      tags: list | None = None, source: dict | None = None) -> dict:
    if kind not in KINDS:
        raise ValueError(f"unknown work-item kind: {kind}")
    if state not in COLUMNS:
        raise ValueError(f"unknown board column: {state}")
    item = WorkItem(project_id=project_id, kind=kind, title=title[:300], body=body,
                    acceptance=list(acceptance or []), parent_id=parent_id,
                    department_id=department_id, squad_id=squad_id, created_by=created_by,
                    severity=severity if kind == "bug" else "normal", state=state,
                    priority=priority, tags=list(tags or []), source=dict(source or {}))
    async with session_scope() as s:
        s.add(item)
        await s.flush()
        iid = item.id
    await ev.emit("board.item.created", project_id=project_id,
                  agent_id=created_by if _is_agent(created_by) else None,
                  title=f"{kind}: {title[:80]}", summary=(body or "")[:200],
                  payload={"item_id": iid, "kind": kind, "state": state,
                           "parent_id": parent_id, "severity": item.severity},
                  severity="warning" if kind == "bug" else "notice",
                  actor=f"agent:{created_by}" if _is_agent(created_by) else created_by)
    return {"id": iid, "kind": kind, "title": item.title, "state": state}


async def plan_items(*, project_id: str, goal: str, tasks: list[Task]) -> dict:
    """Turn a run's plan into the hierarchy: one epic (the goal), features per capability
    category, and stories 1:1 with the plan's tasks — linked, never re-promoted."""
    epic = await create_item(project_id=project_id, kind="epic", title=goal[:280],
                             body=f"The run's goal, decomposed into {len(tasks)} stories.",
                             created_by="system:planner", state="in_progress")
    features: dict[str, str] = {}
    stories = 0
    for t in tasks:
        skill_ids = [str(r.get("skill", "")) for r in (t.required_skills or [])]
        category = (SKILLS_BY_ID[skill_ids[0]].category
                    if skill_ids and skill_ids[0] in SKILLS_BY_ID else "org")
        fid = features.get(category)
        if fid is None:
            feature = await create_item(
                project_id=project_id, kind="feature",
                title=f"{category.capitalize()} workstream",
                body=f"Everything this run needs from the {category} capability.",
                parent_id=epic["id"], created_by="system:planner",
                department_id=t.department_id)
            fid = feature["id"]
            features[category] = fid
        story = await create_item(
            project_id=project_id, kind="story", title=t.title, body=t.description or "",
            acceptance=list(t.acceptance_criteria or []), parent_id=fid,
            created_by="system:planner", state="ready",
            department_id=t.department_id, squad_id=t.squad_id,
            source={"task_id": t.id})
        async with session_scope() as s:
            row = await s.get(WorkItem, story["id"])
            row.task_id = t.id  # already a real task: link, never promote again
            s.add(row)
        stories += 1
    return {"epic_id": epic["id"], "features": len(features), "stories": stories}


async def move_item(*, project_id: str, item_id: str, state: str, actor: str = "user") -> dict:
    if state not in COLUMNS:
        raise ValueError(f"unknown board column: {state}")
    async with session_scope() as s:
        item = await s.get(WorkItem, item_id)
        if item is None or item.project_id != project_id:
            raise KeyError(item_id)
        if item.task_id:
            # a promoted item's column is the task's truth; allowing a manual move here
            # would be a second source of workflow — refuse, and say why
            raise ValueError("this item is a live task's record; its column follows the task")
        item.state = state
        s.add(item)
        kind, title = item.kind, item.title
    await ev.emit("board.item.moved", project_id=project_id,
                  title=f"{kind} → {state}: {title[:60]}",
                  payload={"item_id": item_id, "state": state, "kind": kind}, actor=actor)
    return {"id": item_id, "state": state}


async def move_item_by_id(*, item_id: str, state: str, actor: str = "user") -> dict:
    """Move by item id alone: the API resolves the project from the item itself."""
    async with session_scope() as s:
        item = await s.get(WorkItem, item_id)
        if item is None:
            raise KeyError(item_id)
        project_id = item.project_id
    return await move_item(project_id=project_id, item_id=item_id, state=state, actor=actor)


async def promote_ready(*, project_id: str, run_id: str) -> list[dict]:
    """READY stories/bugs without a task become real tasks; the wave engine runs them."""
    promoted: list[dict] = []
    pending_events: list[dict] = []
    async with session_scope() as s:
        items = (await s.scalars(select(WorkItem).where(
            WorkItem.project_id == project_id,
            WorkItem.state == "ready",
            WorkItem.task_id.is_(None),
            WorkItem.kind.in_(("story", "bug"))))).all()
        for item in items:
            prefix = "[bug] " if item.kind == "bug" else ""
            task = Task(project_id=project_id, run_id=run_id, department_id=item.department_id,
                        squad_id=item.squad_id, title=f"{prefix}{item.title}"[:300],
                        description=item.body or item.title,
                        deliverable="A verified fix or a verified refusal with reasons.",
                        acceptance_criteria=list(item.acceptance) or (
                            ["The reported problem is fixed and the fix is verified"]
                            if item.kind == "bug"
                            else ["The story's outcome is delivered and verified"]),
                        effort="S" if item.kind == "bug" else "M",
                        priority=1 if item.severity in ("high", "critical") else item.priority,
                        state="pending")
            s.add(task)
            await s.flush()
            item.task_id = task.id
            s.add(item)
            promoted.append({"item_id": item.id, "task_id": task.id, "kind": item.kind,
                             "title": item.title})
            pending_events.append({"item_id": item.id, "task_id": task.id, "kind": item.kind,
                                   "task_title": task.title, "item_title": item.title})
    # events AFTER the write session closes: emitting inside it nests a second write
    # transaction and SQLite answers with "database is locked" (learned the hard way)
    for e in pending_events:
        await ev.emit("board.item.promoted", project_id=project_id, run_id=run_id,
                      task_id=e["task_id"], title=f"board → work: {e['item_title'][:60]}",
                      payload={"item_id": e["item_id"], "task_id": e["task_id"], "kind": e["kind"]},
                      actor="system:orchestrator")
        await ev.emit("task.created", project_id=project_id, run_id=run_id, task_id=e["task_id"],
                      title=e["task_title"][:80],
                      payload={"task_id": e["task_id"], "title": e["task_title"]},
                      actor="system:orchestrator")
    return promoted


async def board(*, project_id: str, department_id: str | None = None,
                squad_id: str | None = None) -> dict:
    """The kanban view. Columns are derived; filters use each item's EFFECTIVE team —
    the task's once promoted, the item's own before that."""
    async with session_scope() as s:
        items = (await s.scalars(select(WorkItem).where(WorkItem.project_id == project_id)
                                 .order_by(WorkItem.priority, WorkItem.created_at))).all()
        task_ids = [i.task_id for i in items if i.task_id]
        tasks = {t.id: t for t in (await s.scalars(select(Task).where(Task.id.in_(task_ids)))).all()} \
            if task_ids else {}
        agent_ids = {i.assignee_agent_id for i in items if i.assignee_agent_id}
        agent_ids |= {t.assignee_agent_id for t in tasks.values() if t.assignee_agent_id}
        creator_ids = {i.created_by for i in items if _is_agent(i.created_by)}
        agents = {a.id: a.name for a in (await s.scalars(select(Agent).where(
            Agent.id.in_(list(agent_ids | creator_ids))))).all()} if (agent_ids or creator_ids) else {}

    def columns_of(item) -> str:
        t = tasks.get(item.task_id) if item.task_id else None
        if t is not None:
            return TASK_STATE_TO_COLUMN.get(t.state, "backlog")
        return item.state

    own = {i.id: columns_of(i) for i in items}
    children: dict[str | None, list[WorkItem]] = {}
    for i in items:
        children.setdefault(i.parent_id, []).append(i)

    def rolled(item) -> str:
        if item.kind not in ("epic", "feature"):
            return own[item.id]
        kids = [rolled(k) for k in children.get(item.id, [])]
        if not kids:
            return own[item.id]
        if all(k == "done" for k in kids):
            return "done"
        if any(k == "blocked" for k in kids):
            return "blocked"
        if any(k in ("in_progress", "review") for k in kids):
            return "in_progress"
        if any(k == "ready" for k in kids):
            return "ready"
        return "backlog"

    out: list[dict] = []
    for i in items:
        t = tasks.get(i.task_id) if i.task_id else None
        dept = (t.department_id if t and t.department_id else i.department_id)
        sq = (t.squad_id if t and t.squad_id else i.squad_id)
        if department_id and dept != department_id:
            continue
        if squad_id and sq != squad_id:
            continue
        if (department_id or squad_id) and i.kind == "epic":
            continue  # a team board shows the team's work, not the run's whole epic
        assignee = (t.assignee_agent_id if t else i.assignee_agent_id)
        out.append({"id": i.id, "kind": i.kind, "title": i.title, "body": i.body,
                    "state": rolled(i), "own_state": i.state, "severity": i.severity,
                    "priority": i.priority, "parent_id": i.parent_id,
                    "department_id": dept, "squad_id": sq, "created_by": i.created_by,
                    "creator_name": agents.get(i.created_by) if _is_agent(i.created_by) else None,
                    "assignee_agent_id": assignee, "assignee_name": agents.get(assignee or ""),
                    "task_id": i.task_id, "task_state": t.state if t else None,
                    "attempts": t.attempts if t else 0,
                    "helpers": list(t.helpers or []) if t else [],
                    "acceptance": i.acceptance, "tags": i.tags,
                    "created_at": i.created_at.isoformat() if i.created_at else None,
                    "updated_at": i.updated_at.isoformat() if i.updated_at else None})
    return {"project_id": project_id,
            "columns": [{"key": k, "title": COLUMN_TITLES[k],
                         "items": [x for x in out if x["state"] == k]} for k in COLUMNS],
            "filter": {"department_id": department_id, "squad_id": squad_id}}
