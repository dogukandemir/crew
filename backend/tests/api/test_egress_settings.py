"""The egress surface over the API: presets in the project payload, the always grant.

docs/11 §6: the project payload carries the presets a project may switch on and the
ones it selected, and an approved `egress` request with `always` widens the project's
allowlist on the record.
"""

from __future__ import annotations

import pytest

from crew.api.main import create_app
from crew.core.db import session_scope
from crew.core.events import bind_loop
from crew.core.models import Approval

pytestmark = pytest.mark.asyncio


@pytest.fixture
async def client():
    import asyncio

    import httpx

    from crew.core.db import init_db

    bind_loop(asyncio.get_running_loop())
    await init_db()
    app = create_app()
    transport = httpx.ASGITransport(app=app, client=("127.0.0.1", 55100))
    async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as c:
        yield c


async def _project(client, name: str) -> dict:
    r = await client.post("/api/projects", json={"name": name, "goal": "egress", "budget_usd": 3.0})
    assert r.status_code == 201, r.text
    return r.json()


async def test_the_project_payload_carries_the_presets_and_the_selection(client):
    p = await _project(client, "Egress presets")
    payload = p["egress_presets"]
    assert set(payload["available"]) == {"docs", "research", "news", "shopping", "code"}
    assert "developer.mozilla.org" in payload["available"]["docs"]
    assert payload["selected"] == []

    r = await client.patch(f"/api/projects/{p['id']}", json={"settings": {"egress_presets": ["research"]}})
    assert r.status_code == 200, r.text
    assert r.json()["egress_presets"]["selected"] == ["research"]

    egress = (await client.get(f"/api/projects/{p['id']}/egress")).json()
    assert egress["presets_selected"] == ["research"]
    assert "nature.com" in [h.lower() for h in egress["allowlist"]]


async def test_an_unknown_preset_is_rejected_by_the_api(client):
    p = await _project(client, "Egress rejection")
    r = await client.patch(f"/api/projects/{p['id']}",
                           json={"settings": {"egress_presets": ["everything"]}})
    assert r.status_code == 422, r.text
    assert "egress_presets" in r.text


async def test_an_always_grant_widens_the_project_allowlist_on_the_record(client):
    p = await _project(client, "Egress always")
    async with session_scope() as s:
        approval = Approval(project_id=p["id"], capability="net.fetch", state="pending",
                            request={"kind": "egress", "host": "blocked.example.org",
                                     "url": "https://blocked.example.org/report",
                                     "run_id": None, "use": "once"})
        s.add(approval)
        await s.flush()
        aid = approval.id

    r = await client.post(f"/api/approvals/{aid}/grant",
                          json={"always": True, "reason": "the vendor docs are needed"})
    assert r.status_code == 200, r.text
    assert r.json()["allow_id"] == "blocked.example.org"

    project = (await client.get(f"/api/projects/{p['id']}")).json()
    assert "blocked.example.org" in project["settings"]["egress_allow"]

    audit = (await client.get(f"/api/projects/{p['id']}/audit")).json()["items"]
    assert any(row["action"] == "security.egress.allowed"
               and row["resource_id"] == "blocked.example.org" for row in audit), audit[:5]

    egress = (await client.get(f"/api/projects/{p['id']}/egress")).json()
    assert "blocked.example.org" in [h.lower() for h in egress["allowlist"]]
