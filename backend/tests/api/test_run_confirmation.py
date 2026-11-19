"""Goal confirmation is a gate, not a loop (19 November 2026 QA)."""

from __future__ import annotations

import asyncio

import httpx
import pytest

from crew.api.main import create_app
from crew.core.db import init_db
from crew.core.events import bind_loop

pytestmark = pytest.mark.asyncio


@pytest.fixture
async def client():
    bind_loop(asyncio.get_running_loop())
    await init_db()
    app = create_app()
    transport = httpx.ASGITransport(app=app, client=("127.0.0.1", 55000))
    async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as c:
        yield c


async def _wait_status(client, run_id: str, statuses: set[str], turns: int = 240) -> str:
    status = ""
    for _ in range(turns):
        await asyncio.sleep(0.25)
        status = (await client.get(f"/api/runs/{run_id}")).json()["status"]
        if status in statuses:
            return status
    return status


@pytest.fixture
async def confirmation_project(client):
    """A project waiting at the confirmation gate, cleaned up even on failure.

    Windows is slow enough that the old 20-second poll timed out and left a
    running run behind, which then interfered with unrelated lifecycle tests.
    The teardown is the guarantee, not the timeout.
    """
    r = await client.post("/api/projects",
                          json={"name": "Confirmation project", "goal": "confirm the gate", "budget_usd": 3.0})
    assert r.status_code == 201, r.text
    project_id = r.json()["id"]
    r = await client.patch(f"/api/projects/{project_id}",
                           json={"settings": {"require_goal_confirmation": True}})
    assert r.status_code == 200, r.text
    try:
        yield project_id
    finally:
        runs = (await client.get(f"/api/projects/{project_id}/runs")).json()["items"]
        for run in runs:
            if run["status"] not in ("completed", "failed", "aborted"):
                await client.post(f"/api/runs/{run['id']}/cancel")


async def test_confirmation_is_asked_once_and_the_run_continues(client, confirmation_project):
    project_id = confirmation_project
    r = await client.post(f"/api/projects/{project_id}/runs",
                          json={"goal": "confirm the gate", "mode": "autonomous"})
    assert r.status_code == 202, r.text
    run_id = r.json()["id"]

    status = await _wait_status(client, run_id, {"pending_confirmation", "failed", "aborted"})
    assert status == "pending_confirmation", status
    run = (await client.get(f"/api/runs/{run_id}")).json()
    assert run["goal_brief"].get("confirmed") is not True

    r = await client.post(f"/api/runs/{run_id}/answer",
                          json={"answers": ["Proceed with the brief shown"], "confirm": True})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "running"

    status = await _wait_status(client, run_id, {"completed", "failed", "aborted", "pending_confirmation"})
    assert status != "pending_confirmation", "the answered gate must not be asked again"
    assert status in ("completed", "failed"), status

    events = (await client.get(f"/api/projects/{project_id}/events?limit=2000")).json()["items"]
    types = [e["type"] for e in events]
    assert types.count("run.confirmation.requested") == 1, types
    assert "run.confirmation.answered" in types


async def test_rejecting_the_confirmation_aborts_the_run(client, confirmation_project):
    project_id = confirmation_project
    r = await client.post(f"/api/projects/{project_id}/runs",
                          json={"goal": "reject the gate", "mode": "autonomous"})
    assert r.status_code == 202, r.text
    run_id = r.json()["id"]
    status = await _wait_status(client, run_id, {"pending_confirmation", "failed", "aborted"})
    assert status == "pending_confirmation", status

    r = await client.post(f"/api/runs/{run_id}/answer", json={"answers": [], "confirm": False})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "aborted"
    run = (await client.get(f"/api/runs/{run_id}")).json()
    assert run["status"] == "aborted"
    assert run["stage"] == "DONE"
