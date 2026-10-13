import asyncio

import httpx
import pytest
from sqlalchemy import func, select

from crew.api.main import create_app
from crew.control import backlog, org
from crew.core import events
from crew.core.db import session_scope
from crew.core.models import Event, Project, Task, WorkItem

pytestmark = pytest.mark.asyncio


def client():
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app(), raise_app_exceptions=False),
                             base_url="http://localhost")


@pytest.mark.parametrize("endpoint,body,model", [
    ("tasks", {"title": "Manual task", "acceptance_criteria": ["A real file exists"]}, Task),
    ("board/items", {"title": "Manual story", "kind": "story"}, WorkItem),
])
async def test_manual_creation_replay_is_single_durable_item(project, endpoint, body, model):
    body = {**body, "idempotency_key": "manual-work-retry"}
    async with client() as api:
        url = f"/api/projects/{project['id']}/{endpoint}"
        first, replay = await asyncio.gather(api.post(url, json=body), api.post(url, json=body))
        assert first.status_code == replay.status_code == 201
        assert first.json() == replay.json()
        conflict = await api.post(url, json={**body, "title": "Different item"})
        assert conflict.status_code == 409
    async with session_scope() as session:
        assert await session.scalar(select(func.count()).select_from(model).where(
            model.project_id == project["id"])) == 1


async def test_manual_task_failure_rolls_back_and_retry_can_succeed(project, monkeypatch):
    original = events.emit

    async def fail(kind, **kwargs):
        if kind == "task.created":
            raise RuntimeError("injected event failure")
        return await original(kind, **kwargs)

    monkeypatch.setattr(events, "emit", fail)
    body = {"title": "Atomic manual task", "acceptance_criteria": ["File exists"],
            "idempotency_key": "retry-after-event-failure"}
    async with client() as api:
        url = f"/api/projects/{project['id']}/tasks"
        assert (await api.post(url, json=body)).status_code == 500
        async with session_scope() as session:
            assert await session.scalar(select(Task).where(Task.project_id == project["id"])) is None
        monkeypatch.setattr(events, "emit", original)
        assert (await api.post(url, json=body)).status_code == 201


async def test_board_move_failure_preserves_state_and_does_not_publish(project, monkeypatch):
    item = await backlog.create_item(project_id=project["id"], kind="story", title="Keep backlog")
    queue = await events.bus.subscribe(project["id"])
    original = events.emit

    async def fail(kind, **kwargs):
        await original(kind, **kwargs)
        raise RuntimeError("failure after event staging")

    monkeypatch.setattr(events, "emit", fail)
    try:
        with pytest.raises(RuntimeError):
            await backlog.move_item(project_id=project["id"], item_id=item["id"], state="ready")
        assert queue.empty()
        async with session_scope() as session:
            assert (await session.get(WorkItem, item["id"])).state == "backlog"
            assert await session.scalar(select(Event).where(Event.type == "board.item.moved")) is None
    finally:
        await events.bus.unsubscribe(project["id"], queue)


async def test_board_promotion_rolls_back_both_events_and_is_single_under_concurrency(project, monkeypatch):
    item = await backlog.create_item(project_id=project["id"], kind="story", title="Ready story", state="ready")
    original = events.emit
    queue = await events.bus.subscribe(project["id"])

    async def fail(kind, **kwargs):
        if kind == "task.created":
            raise RuntimeError("failure after promotion event")
        return await original(kind, **kwargs)

    monkeypatch.setattr(events, "emit", fail)
    try:
        with pytest.raises(RuntimeError):
            await backlog.promote_ready(project_id=project["id"], run_id="bounded-test-run")
        assert queue.empty()
        async with session_scope() as session:
            assert (await session.get(WorkItem, item["id"])).task_id is None
            assert await session.scalar(select(Task).where(Task.project_id == project["id"])) is None
            assert await session.scalar(select(Event).where(Event.type == "board.item.promoted")) is None
        monkeypatch.setattr(events, "emit", original)
        outputs = await asyncio.gather(*(backlog.promote_ready(project_id=project["id"], run_id="bounded-test-run")
                                         for _ in range(2)))
        assert sum(len(output) for output in outputs) == 1
    finally:
        await events.bus.unsubscribe(project["id"], queue)


async def test_foreign_links_and_missing_task_dependencies_are_refused(project):
    other = await org.create_project(name="Other", goal="Keep separate")
    parent = await backlog.create_item(project_id=other["id"], kind="epic", title="Other epic")
    async with client() as api:
        url = f"/api/projects/{project['id']}"
        assert (await api.post(url + "/board/items", json={"title": "Foreign parent", "parent_id": parent["id"]})).status_code == 422
        assert (await api.post(url + "/tasks", json={"title": "Missing dependency", "acceptance_criteria": ["Done"],
                                                     "depends_on": ["missing-task"]})).status_code == 422
    async with session_scope() as session:
        assert await session.scalar(select(WorkItem).where(WorkItem.project_id == project["id"])) is None
        assert await session.scalar(select(Task).where(Task.project_id == project["id"])) is None


async def test_archive_event_failure_preserves_active_project(project, monkeypatch):
    original = events.emit

    async def fail(kind, **kwargs):
        if kind == "project.archived":
            raise RuntimeError("archive event failed")
        return await original(kind, **kwargs)

    monkeypatch.setattr(events, "emit", fail)
    async with client() as api:
        assert (await api.delete(f"/api/projects/{project['id']}")).status_code == 500
    async with session_scope() as session:
        row = await session.get(Project, project["id"])
        assert row.status == "active" and row.archived_at is None
