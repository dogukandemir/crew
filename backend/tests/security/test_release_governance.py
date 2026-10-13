"""Adversarial integration checks for public release governance."""

import asyncio
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from sqlalchemy import select

from crew.api.auth import create_user, issue_token
from crew.api.main import create_app
from crew.core import events
from crew.core.db import session_scope
from crew.core.models import Approval, BudgetLedger, Event, Project, User
from crew.core.security import BudgetExceeded, BudgetGuard, approval_granted, redactor, vault
from crew.core.settings import Settings, settings


def test_public_local_auth_and_weak_signing_secret_are_rejected():
    with pytest.raises(RuntimeError):
        Settings(host="0.0.0.0", container_local_auth=False, auth_mode="local")
    with pytest.raises(ValueError):
        Settings(auth_mode="token", jwt_secret="")


@pytest.mark.asyncio
async def test_login_viewer_authority_and_disabled_user(bound_loop, project, monkeypatch):
    monkeypatch.setattr(settings, "auth_mode", "token")
    user = await create_user(email=f"viewer-{project['id']}@example.test", name="Viewer",
                             password="test-password", role="viewer")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app()), base_url="http://localhost") as client:
        result = await client.post("/api/auth/login", json={"email": user["email"], "password": "test-password"})
        assert result.status_code == 200, result.text
        client.headers["Authorization"] = f"Bearer {result.json()['access_token']}"
        assert (await client.get("/api/auth/me")).status_code == 200
        assert (await client.patch(f"/api/projects/{project['id']}", json={"goal": "unauthorized"})).status_code == 403
        async with session_scope() as s:
            row = await s.get(User, user["id"])
            row.disabled_at = datetime.now(UTC)
        assert (await client.get("/api/auth/me")).status_code == 401
        client.headers["Authorization"] = f"Bearer {issue_token('nonexistent', 'admin')}"
        assert (await client.get("/api/auth/me")).status_code == 401


@pytest.mark.asyncio
async def test_browser_origin_is_enforced():
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app()), base_url="http://localhost") as client:
        assert (await client.get("/api/health", headers={"Origin": "https://attacker.example"})).status_code == 403


@pytest.mark.asyncio
async def test_parallel_and_repeated_reservations_are_atomic(project):
    async with session_scope() as s:
        p = await s.get(Project, project["id"])
        p.budget_cap_micros = 100
    guard = BudgetGuard()
    results = await asyncio.gather(*[
        guard.reserve(project["id"], amount_micros=80, scope_kind="project", scope_id=project["id"],
                      idempotency_key=f"race-{project['id']}-{i}") for i in range(2)
    ], return_exceptions=True)
    assert sum(isinstance(r, BudgetExceeded) for r in results) == 1
    async with session_scope() as s:
        p = await s.get(Project, project["id"])
        rows = (await s.scalars(select(BudgetLedger).where(BudgetLedger.project_id == p.id))).all()
        assert p.reserved_micros == sum(r.amount_micros for r in rows) == 80
        key = rows[0].idempotency_key
    await guard.reserve(project["id"], amount_micros=80, scope_kind="project", scope_id=project["id"], idempotency_key=key)
    for _ in range(2):
        await guard.settle(project["id"], reserved_micros=80, actual_micros=30, scope_kind="project",
                           scope_id=project["id"], idempotency_key=f"settle-{project['id']}")
    async with session_scope() as s:
        p = await s.get(Project, project["id"])
        assert (p.reserved_micros, p.spend_micros) == (0, 30)


@pytest.mark.asyncio
async def test_expired_approval_cannot_authorize(project):
    async with session_scope() as s:
        s.add(Approval(project_id=project["id"], capability="fs.delete", state="granted",
                       expires_at=datetime.now(UTC)-timedelta(days=1)))
    assert not await approval_granted(project["id"], agent_id=None, capability="fs.delete", task_id=None)


@pytest.mark.asyncio
async def test_restored_secret_redacted_before_event_persistence(project):
    secret = f"synthetic-secret-{project['id']}"
    handle = await vault.create(f"review-{project['id']}", secret)
    redactor._values.discard(secret)  # simulate a fresh process's in-memory redactor
    assert await vault.reveal(handle) == secret
    e = await events.emit("review.probe", project_id=project["id"], title=secret,
                          summary=secret, payload={"nested": [secret]})
    async with session_scope() as s:
        row = await s.get(Event, e["id"])
        assert secret not in str((row.title, row.summary, row.payload))


def test_approval_command_hash_preserves_semantic_whitespace():
    from crew.control.security_review import normalize_command
    assert normalize_command("echo 'a b'") != normalize_command("echo 'a  b'")
    assert normalize_command("if True:\n    pass") != normalize_command("if True:\npass")


@pytest.mark.asyncio
async def test_settlement_is_bound_to_reservation_and_exact_retry_input(project):
    guard = BudgetGuard()
    pid = project["id"]
    await guard.reserve(pid, amount_micros=80, scope_kind="project", scope_id=pid, ref="call-a", idempotency_key=f"reserve-{pid}")
    with pytest.raises(ValueError, match="different budget operation"):
        await guard.reserve(pid, amount_micros=80, scope_kind="project", scope_id=pid, ref="call-b", idempotency_key=f"reserve-{pid}")
    with pytest.raises(ValueError, match="operation's held"):
        await guard.settle(pid, reserved_micros=80, actual_micros=30, scope_kind="project", scope_id=pid, ref="call-b")
    with pytest.raises(ValueError, match="operation's held"):
        await guard.release(pid, amount_micros=80, scope_kind="project", scope_id=pid, ref="call-b")
    await guard.settle(pid, reserved_micros=80, actual_micros=30, scope_kind="project", scope_id=pid,
                       ref="call-a", idempotency_key=f"settle-{pid}")
    with pytest.raises(ValueError, match="different budget operation"):
        await guard.settle(pid, reserved_micros=20, actual_micros=30, scope_kind="project", scope_id=pid,
                           ref="call-a", idempotency_key=f"settle-{pid}")
    assert (await guard.reconcile(pid))["ok"]


@pytest.mark.asyncio
async def test_company_reconciliation_and_project_move_preserve_usage(project):
    from crew.control import company
    from crew.core.security import budget

    first = await company.create_company(name="First accounting owner", budget_usd=5)
    second = await company.create_company(name="Second accounting owner", budget_usd=5)
    pid = project["id"]
    await company.attach_project(company_id=first["id"], project_id=pid)
    await budget.reserve(pid, amount_micros=80, scope_kind="project", scope_id=pid, ref="transfer-test")
    assert (await budget.reconcile(first["id"]))["ok"]
    with pytest.raises(ValueError, match="finish or cancel"):
        await company.attach_project(company_id=second["id"], project_id=pid)
    await budget.settle(pid, reserved_micros=80, actual_micros=30, scope_kind="project", scope_id=pid, ref="transfer-test")
    await company.attach_project(company_id=second["id"], project_id=pid)
    await company.attach_project(company_id=second["id"], project_id=pid)
    for company_id, expected in ((first["id"], 0), (second["id"], 30)):
        result = await budget.reconcile(company_id)
        assert result["ok"] and result["spend_micros"] == expected


@pytest.mark.asyncio
async def test_terminal_run_approvals_expire_but_valid_paused_permissions_remain(project):
    from datetime import UTC, datetime, timedelta

    from crew.core.models import Approval, Run
    from crew.core.security import expire_inactive_approvals

    async with session_scope() as s:
        finished = Run(project_id=project["id"], goal="Done", status="completed")
        paused = Run(project_id=project["id"], goal="Still waiting", status="paused")
        s.add_all([finished, paused])
        await s.flush()
        closed = Approval(project_id=project["id"], capability="code.python", state="pending",
                          request={"run_id": finished.id}, expires_at=datetime.now(UTC) + timedelta(hours=1))
        valid = Approval(project_id=project["id"], capability="code.python", state="pending",
                         request={"run_id": paused.id}, expires_at=datetime.now(UTC) + timedelta(hours=1))
        old = Approval(project_id=project["id"], capability="code.python", state="granted",
                       request={}, expires_at=datetime.now(UTC) - timedelta(minutes=1))
        s.add_all([closed, valid, old])
        await s.flush()
    assert await expire_inactive_approvals() >= 2
    async with session_scope() as s:
        assert (await s.get(Approval, closed.id)).state == "expired"
        assert (await s.get(Approval, old.id)).state == "expired"
        assert (await s.get(Approval, valid.id)).state == "pending"


@pytest.mark.asyncio
async def test_agent_run_cap_counts_legacy_settlements_and_new_operation_refs(project):
    from crew.core import events
    from crew.core.models import Agent, Run
    from crew.core.security import BudgetExceeded, budget

    async with session_scope() as s:
        agent = Agent(project_id=project["id"], name="Run cap", role="worker", spend_cap_per_run_micros=500,
                      spend_cap_per_day_micros=10_000)
        first, second = Run(project_id=project["id"], goal="First"), Run(project_id=project["id"], goal="Second")
        s.add_all([agent, first, second])
        await s.flush()
    legacy = "legacy-call"
    await budget.reserve(project["id"], amount_micros=100, scope_kind="agent", scope_id=agent.id, ref=legacy)
    await budget.settle(project["id"], reserved_micros=100, actual_micros=50,
                        scope_kind="agent", scope_id=agent.id, ref=legacy)
    await events.emit("llm.response", project_id=project["id"], run_id=first.id, agent_id=agent.id,
        title="legacy usage", cost_micros=50, payload={"model": "openai/gpt-4o-mini", "call_id": legacy})
    ref = f"run:{first.id}:current-call"
    await budget.reserve(project["id"], amount_micros=200, scope_kind="agent", scope_id=agent.id,
                         ref=ref, run_id=first.id)
    await budget.settle(project["id"], reserved_micros=200, actual_micros=150,
                        scope_kind="agent", scope_id=agent.id, ref=ref)
    assert await budget.available_micros(project["id"], agent_id=agent.id, run_id=first.id) == 300
    assert await budget.available_micros(project["id"], agent_id=agent.id, run_id=second.id) == 500
    with pytest.raises(BudgetExceeded):
        await budget.reserve(project["id"], amount_micros=301, scope_kind="agent", scope_id=agent.id,
                             ref=f"run:{first.id}:too-much", run_id=first.id)


@pytest.mark.asyncio
async def test_recovery_preserves_run_caps_and_does_not_recharge_legacy_recovery(project):
    from crew.core.models import Agent, Run
    from crew.core.security import budget

    async with session_scope() as s:
        agent = Agent(project_id=project["id"], name="Recovery cap", role="worker", spend_cap_per_run_micros=500,
                      spend_cap_per_day_micros=10_000)
        run = Run(project_id=project["id"], goal="Recovery")
        s.add_all([agent, run])
        await s.flush()
    await budget.reserve(project["id"], amount_micros=100, scope_kind="agent", scope_id=agent.id, ref="old-call")
    await budget.settle(project["id"], reserved_micros=100, actual_micros=100,
                        scope_kind="agent", scope_id=agent.id, ref="startup-recovery", _recovering=True)
    await budget.reserve(project["id"], amount_micros=50, scope_kind="agent", scope_id=agent.id,
                         ref=f"run:{run.id}:interrupted", run_id=run.id)
    await budget.recover_reservations()
    await budget.recover_reservations()
    assert await budget.available_micros(project["id"], agent_id=agent.id, run_id=run.id) == 450
    assert (await budget.reconcile(project["id"]))["spend_micros"] == 150
