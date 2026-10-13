"""Guards for the 2026-10-14 end-to-end review fixes.

One story per fix: the budget ceiling holds through the command desk, audit rows are
project-scoped, memory never crosses projects, foreign ids are refused on write paths,
the vault cannot be silently re-scoped, the redactor survives a restart, a grant's TTL
is the human's TTL, unmatched names are explained, python destruction is gated, and
pagination accepts no unbounded dialect.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime

import httpx
import pytest

from crew.core.events import bind_loop


@pytest.fixture
async def client():
    from crew.api.main import create_app
    from crew.core.db import init_db

    bind_loop(asyncio.get_running_loop())
    await init_db()
    app = create_app()
    transport = httpx.ASGITransport(app=app, client=("127.0.0.1", 55000))
    async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as c:
        yield c


# ── the command desk obeys the budget ceilings (BE-01) ──────────────────────────────
async def test_desk_refuses_cap_above_hard_ceiling(client, project):
    r = await client.post(f"/api/projects/{project['id']}/commands",
                          json={"text": "set the budget to $999999"})
    assert r.status_code == 201, r.text
    reply = r.json()["reply"]
    assert "hard ceiling" in reply["text"], reply
    got = (await client.get(f"/api/projects/{project['id']}")).json()
    assert got["budget_cap_micros"] == 5_000_000, "the cap must not move"


async def test_desk_applies_a_valid_cap(client, project):
    r = await client.post(f"/api/projects/{project['id']}/commands",
                          json={"text": "set the budget to $9"})
    assert "Budget set" in r.json()["reply"]["text"]
    got = (await client.get(f"/api/projects/{project['id']}")).json()
    assert got["budget_cap_micros"] == 9_000_000


# ── audit scoping (BE-02) ───────────────────────────────────────────────────────────
async def test_audit_is_project_scoped_and_chain_still_verifies(client, project):
    from crew.control import org

    other = await org.create_project(name="Other Project", goal="stay separate", budget_usd=3.0)
    for pid, amount in ((project["id"], "$4"), (other["id"], "$3")):
        await client.post(f"/api/projects/{pid}/commands", json={"text": f"set the budget to {amount}"})

    scoped = (await client.get(f"/api/projects/{project['id']}/audit?limit=1000")).json()["items"]
    assert any(i["resource_id"] == project["id"] for i in scoped)
    assert all(i["resource_id"] != other["id"] for i in scoped), \
        "another project's rows leaked into the scoped audit view"

    whole = (await client.get("/api/audit?limit=1000")).json()["items"]
    ids = {i["resource_id"] for i in whole}
    assert project["id"] in ids and other["id"] in ids

    verify = (await client.post("/api/system/audit/verify")).json()
    assert verify["ok"] is True, verify


# ── memory never crosses projects (BE-03) ───────────────────────────────────────────
async def test_brain_search_rejects_foreign_brain_ids(client, project):
    from crew.control import org

    other = await org.create_project(name="Brain Other", goal="x", budget_usd=2.0)
    mine = (await client.get(f"/api/projects/{project['id']}/brains")).json()["items"]
    if not mine:
        pytest.skip("no project brain materialised")
    r = await client.post(f"/api/projects/{other['id']}/brains/search",
                          json={"brain_ids": [mine[0]["id"]], "query": "anything"})
    assert r.status_code == 403, r.text


# ── write paths refuse foreign ids (BE-04) ──────────────────────────────────────────
async def test_reassign_refuses_a_foreign_agent(client, project):
    from crew.control import org
    from crew.core.db import session_scope
    from crew.core.models import Agent, Task

    other = await org.create_project(name="Reassign Other", goal="x", budget_usd=2.0)
    mine_agent = Agent(project_id=project["id"], name="Home Agent", role="worker", grade=1,
                       tools=[], autonomy="supervised", state="idle")
    foreign = Agent(project_id=other["id"], name="Foreign Agent", role="worker", grade=1,
                    tools=[], autonomy="supervised", state="idle")
    async with session_scope() as s:
        s.add(mine_agent)
        s.add(foreign)
        await s.flush()
        task = Task(project_id=project["id"], title="reassign me", state="pending")
        s.add(task)
        await s.flush()
        tid, good_id, bad_id = task.id, mine_agent.id, foreign.id

    r = await client.post(f"/api/tasks/{tid}/reassign", json={"agent_id": bad_id})
    assert r.status_code == 409, r.text
    r = await client.post(f"/api/tasks/{tid}/reassign", json={"agent_id": good_id})
    assert r.status_code == 200 and r.json()["assignee_agent_id"] == good_id


# ── the vault never silently re-scopes (BE-06) ──────────────────────────────────────
async def test_vault_scope_conflict_is_rejected(client):
    from crew.core.security import vault

    name = "scope-guard-secret"
    first = await vault.create(name, "value-one-aaaa", scope_kind="project", scope_id="proj-a")
    assert first
    with pytest.raises(ValueError):
        await vault.create(name, "value-two-bbbb", scope_kind="project", scope_id="proj-b")
    # rotating in place stays allowed and keeps the scope
    same = await vault.create(name, "value-two-bbbb", scope_kind="project", scope_id="proj-a")
    assert same == first
    assert await vault.reveal(name) == "value-two-bbbb"


# ── the redactor survives a restart (BE-07) ─────────────────────────────────────────
async def test_redactor_relearns_stored_secrets(client):
    from crew.core.security import redactor, vault

    value = "restart-proof-secret-value"
    await vault.create("restart-secret", value, scope_kind="project", scope_id="proj-r")
    saved = set(redactor._values)  # noqa: SLF001 - test seam for the process-memory set
    try:
        redactor._values = {v for v in saved if v != value}  # noqa: SLF001
        assert "[REDACTED]" not in redactor.redact(f"token={value}")[0]
        n = await vault.load_all_into_redactor()
        assert n >= 1
        assert "[REDACTED]" in redactor.redact(f"token={value}")[0]
    finally:
        redactor._values = saved | {value}  # noqa: SLF001


# ── a grant's TTL is the human's TTL (BE-15) ────────────────────────────────────────
async def test_grant_honours_ttl_minutes(project):
    from crew.core.security import decide_approval, request_approval

    aid = await request_approval(project["id"], capability="shell.sandbox", agent_id=None,
                                 task_id=None, request={"probe": "ttl"}, ttl_minutes=120)
    row = await decide_approval(aid, grant=True, decided_by="tester", reason="", ttl_minutes=5)
    assert row is not None
    exp = row.expires_at.replace(tzinfo=UTC) if row.expires_at.tzinfo is None else row.expires_at
    remaining = (exp - datetime.now(UTC)).total_seconds()
    assert 200 < remaining < 400, f"expected ~5 minutes, saw {remaining:.0f}s"


# ── unmatched names are explained (walkthrough finding) ─────────────────────────────
async def test_desk_explains_unmatched_names(project):
    from crew.control import commands as desk

    out = await desk.handle_command(project_id=project["id"], text="fire @Nobody Atall",
                                    actor="user:test")
    text = out["reply"]["text"]
    assert "couldn't match" in text and "Nobody" in text, text


# ── python / inline destruction is gated (BE-05) ────────────────────────────────────
def test_python_and_inline_destruction_is_gated():
    from crew.control.security_review import review_command

    gated = [
        "rm deliverable.md",
        "shutil.rmtree('.')",
        "import os; os.remove('deliverable.md')",
        "python -c \"import shutil; shutil.rmtree('.')\"",
        "find . -name '*.md' -delete",
        "truncate -s 0 report.md",
        "for f in *.md; do > \"$f\"; done",
        "Path('x').unlink()",
    ]
    for cmd in gated:
        assert review_command(cmd).verdict == "review", cmd
    assert review_command("ls -la && echo done").verdict == "clean"
    assert review_command("python -c \"print('hello')\"").verdict == "clean"


# ── pagination has a floor (BE-08) ──────────────────────────────────────────────────
async def test_negative_and_zero_limits_are_rejected(client, project):
    r = await client.get(f"/api/projects/{project['id']}/events", params={"limit": -1})
    assert r.status_code == 422
    r = await client.get(f"/api/projects/{project['id']}/tasks", params={"limit": 0})
    assert r.status_code == 422


def test_rate_limiter_trips_after_cap():
    from fastapi import HTTPException

    from crew.api import limits

    limits.reset()
    for _ in range(3):
        limits.hit("unit:key", limit=3)
    with pytest.raises(HTTPException) as err:
        limits.hit("unit:key", limit=3)
    assert err.value.status_code == 429
    limits.reset()


# ── dev CORS, the contract header, zip names (F-32, F-05, BE-16) ────────────────────
def test_dev_origins_allow_any_loopback_port():
    from crew.api.auth import origin_allowed

    assert origin_allowed("http://localhost:5199")
    assert origin_allowed("http://127.0.0.1:5177")
    assert origin_allowed("http://[::1]:3000")
    assert not origin_allowed("http://evil.example")
    assert not origin_allowed("https://localhost:5173")


async def test_contract_header_is_sent(client):
    r = await client.get("/api/health")
    assert r.headers.get("X-Crew-Contract") == "1"


def test_safe_filename_kills_dot_traversal():
    from crew.api.routes import _safe_filename

    assert _safe_filename("..") == "artifact"
    assert ".." not in _safe_filename("a/b/../../x")
    assert _safe_filename("..hidden") == "hidden"
