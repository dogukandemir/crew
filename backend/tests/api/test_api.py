"""API contract tests against the real ASGI app (docs/11)."""

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
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


async def _create_project(client, name: str, goal: str = "test goal", budget: float = 3.0) -> dict:
    r = await client.post("/api/projects", json={"name": name, "goal": goal, "budget_usd": budget})
    assert r.status_code == 201, r.text
    return r.json()


async def test_health_and_contract(client):
    r = await client.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["contract"] == 1 and body["version"]


async def test_project_lifecycle(client):
    p = await _create_project(client, "API Lifecycle")
    assert p["status"] == "active" and p["spend_usd"] == 0

    r = await client.get("/api/projects")
    assert any(x["id"] == p["id"] for x in r.json()["items"])

    r = await client.patch(f"/api/projects/{p['id']}", json={"goal": "updated goal",
                                                             "settings": {"auto_hire": False}})
    assert r.status_code == 200 and r.json()["goal"] == "updated goal"
    assert r.json()["settings"]["auto_hire"] is False

    r = await client.post(f"/api/projects/{p['id']}/pause")
    assert r.json()["status"] == "paused"
    r = await client.post(f"/api/projects/{p['id']}/resume")
    assert r.json()["status"] == "active"

    r = await client.delete(f"/api/projects/{p['id']}")
    assert r.json()["status"] == "archived"


async def test_org_has_orchestrator_from_birth(client):
    p = await _create_project(client, "Org Project")
    r = await client.get(f"/api/projects/{p['id']}/org")
    assert r.status_code == 200
    org = r.json()
    assert org["orchestrator"] is not None
    assert org["orchestrator"]["role"] == "orchestrator"
    assert org["orchestrator"]["kind"] == "agent"


async def test_manual_hire_and_task_creation(client):
    p = await _create_project(client, "Manual Org")
    r = await client.post(f"/api/projects/{p['id']}/departments",
                          json={"name": "Engineering", "mission": "build things", "budget_usd": 1.0})
    assert r.status_code == 201
    dept = r.json()

    r = await client.post(f"/api/projects/{p['id']}/agents",
                          json={"role": "worker", "skills": ["python"], "department_id": dept["id"],
                                "rationale": "manual capacity"})
    assert r.status_code == 201, r.text
    agent = r.json()
    assert agent["grade"] == 1, "a manual worker hire starts cheap (docs/02 §5)"

    r = await client.get(f"/api/agents/{agent['id']}")
    assert r.json()["tools"], "an agent must never have an empty capability set"

    # tasks need acceptance criteria (docs/03 §3)
    r = await client.post(f"/api/projects/{p['id']}/tasks",
                          json={"title": "no criteria", "description": "x"})
    assert r.status_code == 422

    r = await client.post(f"/api/projects/{p['id']}/tasks",
                          json={"title": "with criteria", "description": "do the thing",
                                "acceptance_criteria": ["the thing exists"],
                                "required_skills": [{"skill": "python", "weight": 1.0}]})
    assert r.status_code == 201
    task_id = r.json()["task_id"]

    r = await client.get(f"/api/tasks/{task_id}")
    assert r.json()["acceptance_criteria"] == ["the thing exists"]


async def test_run_produces_events_and_reward_ledger(client):
    p = await _create_project(client, "Run Project", goal="explain the CAP theorem", budget=3.0)
    r = await client.post(f"/api/projects/{p['id']}/runs",
                          json={"goal": "explain the CAP theorem", "mode": "autonomous"})
    assert r.status_code == 202, r.text
    run_id = r.json()["id"]

    # the run is driven by a background task; poll the same endpoints the UI uses
    status = "running"
    for _ in range(60):
        await asyncio.sleep(0.25)
        rr = await client.get(f"/api/runs/{run_id}")
        status = rr.json()["status"]
        if status in ("completed", "failed", "paused_budget", "aborted"):
            break
    assert status in ("completed", "failed"), f"run stuck in {status}"

    events = (await client.get(f"/api/projects/{p['id']}/events?limit=2000")).json()["items"]
    assert events, "the event stream must carry the run"
    assert all({"seq", "type", "ts", "payload"} <= set(e) for e in events)
    types = {e["type"] for e in events}
    assert {"run.started", "run.stage.changed", "task.created", "verify.verdict"} <= types

    board = (await client.get(f"/api/projects/{p['id']}/leaderboard")).json()["items"]
    assert board, "the leaderboard must list the roster"
    top = board[0]
    rw = (await client.get(f"/api/agents/{top['id']}/rewards")).json()
    assert "items" in rw and "recomputed" in rw

    metrics = (await client.get(f"/api/projects/{p['id']}/metrics")).json()
    assert metrics["tasks_total"] >= 1
    assert metrics["spend_usd"] >= 0
    assert (await client.get(f"/api/projects/{p['id']}/budget/ledger")).json()["ok"] in (True, False)


async def test_council_debate_and_decision(client):
    p = await _create_project(client, "Council Project")
    r = await client.post(f"/api/projects/{p['id']}/councils", json={
        "question": "Which storage engine should the event log use?",
        "options": [{"id": "sqlite", "label": "SQLite"}, {"id": "postgres", "label": "Postgres"}],
        "criteria": ["cost", "scale"], "rounds": 1})
    assert r.status_code == 201, r.text
    sid = r.json()["session_id"]

    session = (await client.get(f"/api/councils/{sid}")).json()
    assert session["positions"], "a round must produce positions"
    for pos in session["positions"]:
        assert pos["claim"] and 0.0 <= pos["confidence"] <= 1.0

    d = await client.post(f"/api/councils/{sid}/decide")
    assert d.status_code == 200
    decision = d.json()
    assert decision["decision_id"] and decision["chosen_option"] in ("sqlite", "postgres")

    items = (await client.get(f"/api/decisions?project_id={p['id']}")).json()["items"]
    assert items and items[0]["rationale"]

    ov = await client.post(f"/api/decisions/{decision['decision_id']}/override",
                           json={"reason": "operator disagrees"})
    assert ov.status_code == 200


async def test_approval_flow(client):
    p = await _create_project(client, "Approval Project")
    from crew.core.security import request_approval

    aid = await request_approval(p["id"], capability="net.post", agent_id=None, task_id=None,
                                 request={"tool": "http_post"})
    items = (await client.get(f"/api/projects/{p['id']}/approvals")).json()["items"]
    assert any(a["id"] == aid and a["state"] == "pending" for a in items)
    r = await client.post(f"/api/approvals/{aid}/grant", json={"reason": "ok"})
    assert r.json()["state"] == "granted"
    r = await client.post(f"/api/approvals/{aid}/deny", json={"reason": "too late"})
    assert r.status_code == 409, "an already-decided approval must not be re-decided"


async def test_secrets_never_return_values(client):
    r = await client.post("/api/secrets", json={"name": "api-test-key", "value": "sk-abcdef1234567890"})
    assert r.status_code == 201
    r = await client.get("/api/secrets")
    assert r.status_code == 200
    text = r.text
    assert "sk-abcdef1234567890" not in text
    assert all("ciphertext" not in h for h in r.json()["items"])


async def test_websocket_streams_live_events(client):
    """The socket must deliver the replay and then live frames (docs/11 §3)."""

    from starlette.testclient import TestClient

    from crew.api.main import create_app

    p = await _create_project(client, "Socket Project", budget=2.0)
    app = create_app()
    with TestClient(app) as tc:
        with tc.websocket_connect(f"/ws/projects/{p['id']}?since_seq=0") as ws:
            hello = ws.receive_json()
            assert hello["type"] == "hello" and hello["contract"] == 1
            ws.send_json({"action": "subscribe", "filters": {"types": ["task.*"]}})
            # replay frames and the subscribe ack race; drain until the ack arrives
            seen: list[str] = []
            for _ in range(12):
                frame = ws.receive_json()
                seen.append(frame["type"])
                if frame["type"] == "subscribed":
                    break
            assert "subscribed" in seen, f"no subscribe ack in {seen}"
            assert "replay.complete" in seen, f"no replay completion in {seen}"
            ws.send_json({"action": "ping", "ts": 1})
            pong = ws.receive_json()
            assert pong["type"] == "pong"


async def test_unauthenticated_mode_is_explicit(client):
    r = await client.get("/api/system/status")
    assert r.status_code == 200
    body = r.json()
    assert body["runner"] in ("FakeCrewRunner", "CrewAICrewRunner")
    assert body["vault"] in ("configured", "missing")
