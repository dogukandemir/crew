import httpx
import pytest
from sqlalchemy import select

from crew.api.main import create_app
from crew.control import company
from crew.core import events
from crew.core.db import atomic_scope, session_scope
from crew.core.models import Event, Project


@pytest.mark.asyncio
async def test_found_replays_and_rejects_conflicting_input():
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app()), base_url="http://localhost") as client:
        body = {"name": "Replay company", "project_name": "First project", "project_goal": "Build a useful artifact",
                "start_run": False, "idempotency_key": "found-replay-regression"}
        first = await client.post("/api/found", json=body)
        assert first.status_code == 201, first.text
        replay = await client.post("/api/found", json=body)
        assert replay.json() == first.json()
        conflict = await client.post("/api/found", json={**body, "name": "Different company"})
        assert conflict.status_code == 409


@pytest.mark.asyncio
async def test_found_rolls_back_company_if_project_creation_fails(monkeypatch):
    original = company.org.create_project
    async def fail_project(**kwargs):
        if kwargs.get("company_id"):
            raise ValueError("injected project failure")
        return await original(**kwargs)
    monkeypatch.setattr(company.org, "create_project", fail_project)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app()), base_url="http://localhost") as client:
        result = await client.post("/api/found", json={"name": "Must roll back", "project_name": "Failure"})
        assert result.status_code == 400
    async with session_scope() as s:
        assert await s.scalar(select(Project).where(Project.name == "Must roll back")) is None


@pytest.mark.asyncio
async def test_rolled_back_events_are_never_published(project):
    queue = await events.bus.subscribe(project["id"])
    try:
        with pytest.raises(ValueError):
            async with atomic_scope():
                await events.emit("test.rollback", project_id=project["id"], title="invisible")
                assert queue.empty()
                raise ValueError("rollback")
        assert queue.empty()
        async with session_scope() as s:
            assert await s.scalar(select(Event).where(Event.project_id == project["id"], Event.type == "test.rollback")) is None
    finally:
        await events.bus.unsubscribe(project["id"], queue)


@pytest.mark.asyncio
async def test_invalid_money_and_modes_are_rejected_before_mutation():
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app()), base_url="http://localhost") as client:
        for changes in [{"budget_usd": -1}, {"budget_usd": 0}, {"budget_usd": 1e100}, {"mode": "anything"}, {"name": "   "}]:
            response = await client.post("/api/found", json={"name": "Validation", "project_name": "Example", **changes})
            assert response.status_code == 422, response.text


@pytest.mark.asyncio
async def test_settings_save_budget_and_reject_internal_path_changes(project):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app()), base_url="http://localhost") as client:
        url = f"/api/projects/{project['id']}"
        saved = await client.patch(url, json={"budget_cap_micros": 4_000_000, "settings": {"max_agents": 8}})
        assert saved.status_code == 200, saved.text
        assert saved.json()["budget_cap_micros"] == 4_000_000
        assert saved.json()["settings"]["max_agents"] == 8
        for settings in ({"workspace": "/private"}, {"workspace_root": "/private"},
                         {"orchestrator_id": "other"}, {"max_agents": -1}, {"auto_hire": "false"}):
            response = await client.patch(url, json={"settings": settings})
            assert response.status_code == 422, response.text
        response = await client.post("/api/projects", json={"name": "Bad path", "settings": {"workspace": "/private"}})
        assert response.status_code == 422
    async with session_scope() as s:
        p = await s.get(Project, project["id"])
        p.spend_micros = 3_000_000
        p.reserved_micros = 500_000
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app()), base_url="http://localhost") as client:
        response = await client.patch(url, json={"budget_cap_micros": 3_000_000})
        assert response.status_code == 409
        assert (await client.get(url)).json()["budget_cap_micros"] == 4_000_000
