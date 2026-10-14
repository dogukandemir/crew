"""Standing tool approvals ("⚡ Always allow") — the owner's ask of 2026-10-14.

A human grant with `always: true` on a TOOL approval writes a capability allow for
that agent + capability; the tool gate then stops asking until the entry is revoked.
The hard gates (net_post / fs_delete / git_push) deliberately keep asking - a standing
allow can never cover them.
"""

from __future__ import annotations

import asyncio

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


async def _tool_approval(project_id: str, capability: str = "code.python",
                         tool: str = "python_eval") -> str:
    from crew.core.security import request_approval

    return await request_approval(project_id, capability=capability, agent_id=None, task_id=None,
                                  request={"tool": tool, "args": {}, "invocation_hash": "a" * 64,
                                           "use": "once", "run_id": None})


async def test_always_grant_on_a_tool_approval_writes_a_standing_allow(client, project):
    from crew.core.security import standing_allow_hit

    aid = await _tool_approval(project["id"])
    r = await client.post(f"/api/approvals/{aid}/grant",
                          json={"reason": "trusted agent", "always": True})
    assert r.status_code == 200, r.text
    allow_id = r.json()["allow_id"]
    assert allow_id, "always:true on a tool approval must write a standing allow"
    assert await standing_allow_hit(project["id"], capability="code.python", agent_id=None) == allow_id
    listed = (await client.get(f"/api/projects/{project['id']}/capability-allows")).json()["items"]
    assert [x["id"] for x in listed] == [allow_id]
    assert listed[0]["capability"] == "code.python"


async def test_plain_grant_writes_no_standing_allow(client, project):
    from crew.core.security import standing_allow_hit

    aid = await _tool_approval(project["id"])
    r = await client.post(f"/api/approvals/{aid}/grant", json={"reason": ""})
    assert r.status_code == 200 and r.json()["allow_id"] is None
    assert await standing_allow_hit(project["id"], capability="code.python", agent_id=None) is None


async def test_revoke_closes_the_gate_again(client, project):
    from crew.core.security import standing_allow_hit

    aid = await _tool_approval(project["id"])
    allow_id = (await client.post(f"/api/approvals/{aid}/grant",
                                  json={"always": True})).json()["allow_id"]
    r = await client.request("DELETE", f"/api/capability-allows/{allow_id}",
                             json={"reason": "changed my mind"})
    assert r.status_code == 200 and r.json()["state"] == "revoked"
    assert await standing_allow_hit(project["id"], capability="code.python", agent_id=None) is None
    # revoking twice is a 409, not a silent success
    r2 = await client.request("DELETE", f"/api/capability-allows/{allow_id}")
    assert r2.status_code == 409


async def test_hard_gates_never_receive_standing_allows(client, project):
    from crew.core.security import standing_allow_hit

    aid = await _tool_approval(project["id"], capability="fs.delete", tool="fs_delete")
    r = await client.post(f"/api/approvals/{aid}/grant", json={"always": True})
    assert r.status_code == 200
    assert r.json()["allow_id"] is None, "fs.delete is an ALWAYS_APPROVAL hard gate"
    assert await standing_allow_hit(project["id"], capability="fs.delete", agent_id=None) is None


async def test_standing_allow_skips_the_tool_gate(client, project, monkeypatch):
    """With an allow on file the invoker runs the tool instead of asking again."""
    from sqlalchemy import func, select

    from crew.core import security as sec
    from crew.core.db import session_scope
    from crew.core.models import Approval
    from crew.core.security import PolicyDecision, PolicyOutcome
    from crew.execution import tools as tools_mod

    await sec.allow_capability(project["id"], capability="code.python", agent_id=None,
                               note="test", decided_by="tester")

    class AlwaysAsk:
        def check(self, **kwargs):
            return PolicyDecision(PolicyOutcome.REQUIRE_APPROVAL,
                                  "supervised agent needs approval", "code.python")

    async def _noop(ctx):  # noqa: ANN001
        return None

    monkeypatch.setattr(tools_mod, "policy", AlwaysAsk())
    monkeypatch.setattr(tools_mod.ToolInvoker, "_refresh_authority", staticmethod(_noop))
    monkeypatch.setitem(tools_mod.TOOLS, "python_eval", tools_mod.ToolSpec(
        "python_eval", "test double", tools_mod.Capability.CODE_PYTHON, {"code": {"type": "string"}},
        lambda ctx, args: {"ok": True, "data": "ran with standing allow"}))

    invoker = tools_mod.ToolInvoker()
    ctx = tools_mod.ToolContext(project_id=project["id"])
    out = await asyncio.to_thread(invoker.invoke, ctx, "python_eval", {"code": "print(1)"})
    assert out.get("ok"), out
    async with session_scope() as s:
        n = await s.scalar(select(func.count()).select_from(Approval)
                           .where(Approval.project_id == project["id"]))
    assert n == 0, "the gate must not create a fresh approval while a standing allow is on file"

    # without the allow the same call parks as approval_required
    hit = await sec.standing_allow_hit(project["id"], capability="code.python", agent_id=None)
    assert hit is not None
    await sec.revoke_capability_allow(hit, decided_by="tester")
    out2 = await asyncio.to_thread(invoker.invoke, ctx, "python_eval", {"code": "print(2)"})
    assert out2.get("error") == "approval_required", out2
