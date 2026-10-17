"""Guards for the hardening the 16 October publish audit demanded.

Each test names the finding it holds shut, so a later refactor that reopens one fails here
rather than in a stranger's deployment.
"""

from __future__ import annotations

import asyncio

import httpx
import pytest
from sqlalchemy import select

from crew.api.main import create_app
from crew.core.db import init_db, session_scope
from crew.core.events import bind_loop
from crew.core.models import AuditLog
from crew.core.settings import settings


@pytest.fixture
async def client():
    bind_loop(asyncio.get_running_loop())
    await init_db()
    transport = httpx.ASGITransport(app=create_app(), client=("127.0.0.1", 55000))
    async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as c:
        yield c


@pytest.mark.asyncio
async def test_an_oversized_body_is_refused_before_it_is_parsed(client, monkeypatch):
    """P1-2 (unbounded request bodies): the cap is enforced on the declared length, so the
    body never reaches the parser."""
    monkeypatch.setattr(settings, "max_request_bytes", 2048)
    r = await client.post("/api/auth/login", json={"email": "a" * 4000, "password": "x"})
    assert r.status_code == 413, r.text
    assert "exceeds" in r.json()["detail"]
    ok = await client.post("/api/auth/login", json={"email": "a@b.c", "password": "wrong"})
    assert ok.status_code in (401, 422), "a normal-sized request still reaches the route"


@pytest.mark.asyncio
async def test_a_write_without_a_declared_length_is_refused(client):
    """A chunked body has no declared cap, so write methods require Content-Length."""
    async def chunked():
        yield b'{"email": "a@b.c", "password": "x"}'

    r = await client.post("/api/auth/login", content=chunked())
    assert r.status_code in (411, 413), r.text


@pytest.mark.asyncio
async def test_yolo_must_be_a_boolean(client):
    """P2-2: the most consequential setting on the project was the one not type-checked."""
    created = await client.post("/api/projects", json={"name": "Type check", "goal": "g"})
    assert created.status_code == 201, created.text
    project_id = created.json()["id"]
    bad = await client.patch(f"/api/projects/{project_id}", json={"settings": {"yolo": "yes"}})
    assert bad.status_code == 422, bad.text
    good = await client.patch(f"/api/projects/{project_id}", json={"settings": {"yolo": True}})
    assert good.status_code == 200, good.text


@pytest.mark.asyncio
async def test_a_budget_cap_change_lands_on_the_audit_chain(client, project):
    """P1-3: docs/08 §9 promises every budget cap change is audited."""
    before = (await client.get(f"/api/projects/{project['id']}")).json()["budget_cap_micros"]
    r = await client.patch(f"/api/projects/{project['id']}",
                           json={"budget_cap_micros": before + 500_000})
    assert r.status_code == 200, r.text
    async with session_scope() as s:
        row = await s.scalar(select(AuditLog).where(AuditLog.action == "budget.updated",
                                                    AuditLog.project_id == project["id"]))
    assert row is not None, "the cap change is not on the hash chain"
    assert f"{before} -> {before + 500_000}" in (row.reason or "")


def test_a_workspace_path_cannot_be_a_system_directory(tmp_path):
    """N1: the sandbox mounts a workspace read-write, so a system root is refused at founding."""
    from crew.control import workspaces

    for bad in ("/", "/etc", "/usr", "C:/", "C:/Windows"):
        with pytest.raises(ValueError):
            workspaces.validate_company_path(bad)
    good = workspaces.validate_company_path(str(tmp_path / "chosen"))
    assert good and (tmp_path / "chosen").exists()


def test_the_rate_limiter_evicts_instead_of_clearing_every_window(monkeypatch):
    """N6: clearing the whole store handed a hostile key space a reset of every live window."""
    from fastapi import HTTPException

    from crew.api import limits

    limits.reset()
    for i in range(limits.MAX_KEYS + 5):
        limits.hit(f"flood:{i}", limit=1000)
    assert len(limits._buckets) <= limits.MAX_KEYS + 1, "the store stayed bounded"
    assert "flood:0" not in limits._buckets, "the eviction took the idle keys, not everything"
    # A window opened after the flood still applies: the store was never cleared wholesale.
    limits.hit("fresh", limit=1)
    with pytest.raises(HTTPException):
        limits.hit("fresh", limit=1)
    limits.reset()


@pytest.mark.asyncio
async def test_the_host_directory_picker_is_disabled_in_a_deployment(client, monkeypatch):
    """P2-5: behind a same-host proxy every peer is loopback, so the picker needs an opt-in."""
    monkeypatch.setattr(settings, "env", "prod")
    monkeypatch.setattr(settings, "allow_host_picker", False)
    r = await client.post("/api/system/pick-directory")
    assert r.status_code == 403, r.text
    assert "disabled" in r.json()["detail"]
