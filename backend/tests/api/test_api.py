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


async def test_command_desk_roundtrip(client):
    """ADR 0012 at the contract boundary: the desk answers and the record keeps it."""
    p = await _create_project(client, "Desk API")

    r = await client.post(f"/api/projects/{p['id']}/commands", json={"text": "durum ne?"})
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["message_id"] and body["reply_event_id"]
    assert body["reply"]["ok"] is True and body["reply"]["mode"] == "question"

    r = await client.get(f"/api/projects/{p['id']}/commands")
    assert r.status_code == 200
    msgs = r.json()["messages"]
    assert [m["role"] for m in msgs] == ["captain", "orchestrator"]
    assert msgs[0]["text"] == "durum ne?" and msgs[1]["ok"] is True
    assert msgs[0]["id"] == body["message_id"]

    r = await client.post("/api/projects/does-not-exist/commands", json={"text": "durum ne?"})
    assert r.status_code == 404

    # an empty message never reaches the desk
    r = await client.post(f"/api/projects/{p['id']}/commands", json={})
    assert r.status_code == 422


async def test_onboarding_key_roundtrip(client, monkeypatch):
    """ADR 0013: the key path — state, a rejected key, a stored key, the vault."""
    import os

    from crew.control import onboarding
    from crew.core.security import vault
    from crew.core.settings import settings

    r = await client.get("/api/onboarding/state")
    assert r.status_code == 200
    body = r.json()
    assert set(body) >= {"needed", "provider", "model", "offline_llm", "vault"}
    assert body["offline_llm"] is True, "the test env runs offline; needed stays false"

    r = await client.post("/api/onboarding/key",
                          json={"provider": "nope", "key": "sk-1234567890"})
    assert r.status_code == 400

    async def reject(provider: str, key: str) -> tuple[bool, str]:
        return False, "the provider rejected this key"

    monkeypatch.setattr(onboarding, "verify", reject)
    r = await client.post("/api/onboarding/key",
                          json={"provider": "deepseek", "key": "sk-bad-12345678"})
    assert r.status_code == 400 and "rejected" in r.text

    async def accept(provider: str, key: str) -> tuple[bool, str]:
        return True, "key verified against the provider"

    monkeypatch.setattr(onboarding, "verify", accept)
    try:
        r = await client.post("/api/onboarding/key",
                              json={"provider": "deepseek", "key": "sk-test-12345678"})
        assert r.status_code == 201 and r.json()["verified"] is True
        handles = await vault.list_handles()
        assert any(h["name"] == "provider:deepseek" for h in handles)
        assert os.environ.get("DEEPSEEK_API_KEY") == "sk-test-12345678"
    finally:
        # make the in-process side of the save invisible to the rest of the suite
        os.environ.pop("DEEPSEEK_API_KEY", None)
        settings.deepseek_api_key = ""


async def test_found_company_endpoint(client):
    """ADR 0015: one call founds the company, lands the first project UNDER it, and the
    payload carries the breadcrumb's upper half; the umbrella brain serves the page."""
    r = await client.post("/api/found", json={
        "name": "API Foundry", "mission": "ship the first slice", "budget_usd": 4.0,
        "project_name": "Slice", "project_goal": "ship the api slice",
        "project_budget_usd": 2.0, "start_run": False,
    })
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["company"]["kind"] == "company"
    assert body["project"]["company_id"] == body["company"]["id"]
    assert body["run"] is None, "start_run=False starts nothing"

    r2 = await client.get(f"/api/projects/{body['project']['id']}")
    assert r2.json()["company_name"] == "API Foundry"

    r3 = await client.get(f"/api/companies/{body['company']['id']}/brains")
    assert r3.status_code == 200
    page = r3.json()
    assert page["company_brain"]["entries"] >= 1, "the mission seeds the umbrella"
    assert page["members"][0]["project_id"] == body["project"]["id"]
    assert all("owner_name" in b for b in page["members"][0]["brains"]), \
        "the member index resolves names, not ids (audit Ö4)"

    # the member is a real project (listed), the company is not
    r4 = await client.get("/api/projects")
    listed = {x["id"] for x in r4.json()["items"]}
    assert body["project"]["id"] in listed and body["company"]["id"] not in listed


async def test_ui_contract_shapes(client):
    """The fields the UI actually reads, asserted against the REAL app (audit Ö1).

    Micros and the org root once vanished from these payloads while the mock kept
    serving them — the office, the org chart and every budget bar rendered empty
    against the real backend and nobody noticed. If a field here ever leaves a
    payload again, this test goes red instead of the product quietly lying."""
    p = await _create_project(client, "Contract Check", budget=3.0)

    # project list + detail: both units, both breadcrumb halves, the run count
    row = next(x for x in (await client.get("/api/projects")).json()["items"] if x["id"] == p["id"])
    for src in (p, row):
        assert src["budget_cap_micros"] == 3_000_000 and src["spend_micros"] == 0
        assert src["kind"] == "project" and src["company_id"] is None
        assert "company_name" in src and src["runs"] == 0

    # org: the tree the renderer walks; nodes carry both units
    org = (await client.get(f"/api/projects/{p['id']}/org")).json()
    assert org["root"]["kind"] == "project"
    assert org["root"]["budget_envelope_micros"] == 3_000_000
    kinds: set[str] = set()
    stack = [org["root"]]
    while stack:
        n = stack.pop()
        kinds.add(n["kind"])
        if n["kind"] == "agent":
            assert "spend_micros" in n and "grade" in n and "state" in n and "role" in n
        stack.extend(n.get("children", []))
    assert "agent" in kinds, "the orchestrator hangs off the root"
    assert org["orchestrator"] and org["departments"] is not None, "legacy flat keys stay (additive)"

    # brains: the {items} envelope (the client normalizes it) + resolved owner names
    brains = (await client.get(f"/api/projects/{p['id']}/brains")).json()
    assert isinstance(brains["items"], list)
    for b in brains["items"]:
        assert "owner_name" in b and "entries" in b and "scope" in b

    # tasks: the {items} array is what the UI cannot live without; the envelope tail
    # (total/next_cursor) is documented-optional and the client backfills it (docs/11 §5)
    tasks = (await client.get(f"/api/projects/{p['id']}/tasks")).json()
    assert "items" in tasks and isinstance(tasks["items"], list)
