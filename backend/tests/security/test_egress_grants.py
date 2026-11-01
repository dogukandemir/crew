"""Egress that can be widened safely: presets, the grant path, and the hard refusal.

docs/08 §7: the allowlist was one hard-coded baseline, so any host outside it was a
dead end. Presets widen it by category, a human grant widens it for one host, and
private or reserved addresses stay unreachable however the list is widened.
"""

from __future__ import annotations

import asyncio

import pytest
from sqlalchemy import select

from crew.control import security_review
from crew.core.db import session_scope
from crew.core.models import Agent, Approval, AuditLog, Event
from crew.core.security import (
    EGRESS_PRESETS,
    PolicyEngine,
    decide_approval,
    is_private_host,
    policy,
    preset_hosts,
)
from crew.domain.enums import Capability, PolicyOutcome
from crew.execution import http
from crew.execution import tools as tools_mod
from crew.execution.tools import invoker


# ── presets ─────────────────────────────────────────────────────────────────────────
def test_a_preset_adds_its_hosts_to_the_project_allowlist(fake_project):
    before = fake_project(settings={})
    assert not policy.check_egress("nature.com", before).allowed
    after = fake_project(settings={"egress_presets": ["research"]})
    assert policy.check_egress("nature.com", after).allowed
    assert policy.check_egress("arxiv.org", after).allowed
    assert "nature.com" in policy.allowed_egress(after)


def test_presets_only_widen_the_hosts_they_name(fake_project):
    p = fake_project(settings={"egress_presets": ["docs"]})
    assert policy.check_egress("docs.python.org", p).allowed
    assert not policy.check_egress("reuters.com", p).allowed, "an unselected category stays closed"


def test_an_unknown_preset_name_is_refused_not_ignored(fake_project):
    with pytest.raises(ValueError, match="unknown egress preset"):
        preset_hosts(["docs", "everything"])
    with pytest.raises(ValueError, match="unknown egress preset"):
        policy.allowed_egress(fake_project(settings={"egress_presets": ["everything"]}))


def test_the_preset_map_is_the_curated_one():
    assert set(EGRESS_PRESETS) == {"docs", "research", "news", "shopping", "code"}
    assert "developer.mozilla.org" in EGRESS_PRESETS["docs"]
    assert "apnews.com" in EGRESS_PRESETS["news"]
    assert "aliexpress.com" in EGRESS_PRESETS["shopping"]
    assert "registry.npmjs.org" in EGRESS_PRESETS["code"]


# ── private and reserved addresses: refused whatever the list says ──────────────────
@pytest.mark.parametrize("host", ["::1", "[::1]", "fd00::1", "fd00::", "fe80::1",
                                  "10.1.2.3", "192.168.0.10", "169.254.169.254",
                                  "localhost", "localhost:11434", "127.0.0.1"])
def test_private_and_reserved_addresses_are_recognised(host):
    assert is_private_host(host) is True


@pytest.mark.parametrize("host", ["python.org", "api.deepseek.com", "8.8.8.8"])
def test_public_hosts_are_not_mistaken_for_private_ones(host):
    assert is_private_host(host) is False


@pytest.mark.parametrize("host", ["localhost", "10.1.2.3", "169.254.169.254",
                                  "[::1]", "fd00::1", "192.168.1.5"])
def test_an_explicit_allow_entry_cannot_reach_a_private_address(host, fake_project):
    p = fake_project(settings={"egress_allow": [host], "egress_presets": ["docs", "research"]})
    decision = policy.check_egress(host, p)
    assert decision.outcome == PolicyOutcome.DENY
    assert "private/reserved" in decision.reason


def test_a_grant_cannot_reach_a_private_address(fake_project):
    allow_decision = PolicyEngine().check_egress("127.0.0.1", fake_project(settings={
        "egress_allow": ["127.0.0.1"]}))
    assert not allow_decision.allowed


@pytest.mark.asyncio
async def test_a_private_host_can_never_be_granted_or_added(project):
    with pytest.raises(ValueError, match="private or reserved"):
        await security_review.allow_egress_host(project["id"], host="10.0.0.7",
                                                decided_by="u-test")
    assert await security_review.release_for_egress(project["id"], agent_id=None,
                                                    host="10.0.0.7", task_id=None) is None


# ── the HTTP layer honours a one-shot grant for that host only ──────────────────────
class _Response:
    status = 200

    def getheader(self, name):
        return None

    def read(self, limit):
        return b"<html>ok</html>"


class _Connection:
    def __init__(self, host, port, address, secure):
        self.host, self.port, self.address, self.secure = host, port, address, secure

    def request(self, method, target, body=None, headers=None):
        self.method = method

    def getresponse(self):
        return _Response()

    def close(self):
        pass


def test_fetch_public_honours_a_grant_for_that_host_only(monkeypatch, fake_project):
    monkeypatch.setattr(http, "public_addresses", lambda host, port: ["93.184.216.34"])
    monkeypatch.setattr(http, "PinnedConnection", _Connection)
    p = fake_project(settings={})

    status, body, _ = http.fetch_public("https://blocked.example.org/page", p,
                                        granted_hosts=("blocked.example.org",))
    assert status == 200 and "ok" in body

    with pytest.raises(PermissionError, match="not on the egress allowlist"):
        http.fetch_public("https://other.example.org/page", p,
                          granted_hosts=("blocked.example.org",))
    with pytest.raises(PermissionError):
        http.fetch_public("https://127.0.0.1/page", p, granted_hosts=("127.0.0.1",))


# ── the approval request and the tool path ──────────────────────────────────────────
async def _agent(project_id: str) -> Agent:
    async with session_scope() as s:
        a = Agent(project_id=project_id, name="Fetcher", role="worker", grade=5, state="idle",
                  tools=[Capability.NET_FETCH.value, Capability.NET_SEARCH.value],
                  autonomy="autonomous", mission="egress tests")
        s.add(a)
        await s.flush()
        row = await s.get(Agent, a.id)
        s.expunge(row)
    return row


@pytest.mark.asyncio
async def test_a_blocked_host_files_an_egress_approval_carrying_host_and_url(
        project, tool_context, bound_loop, tmp_path):
    agent = await _agent(project["id"])
    ctx = await tool_context(project_id=project["id"], agent=agent, task_id="t-egress",
                             workspace=tmp_path)
    url = "https://blocked.example.org/data.json"

    result = await asyncio.to_thread(invoker.invoke, ctx, "http_get", {"url": url})

    assert result["ok"] is False and result["error"] == "approval_required", result
    async with session_scope() as s:
        approval = await s.get(Approval, result["approval_id"])
    assert approval is not None and approval.state == "pending"
    assert approval.request["kind"] == "egress"
    assert approval.request["host"] == "blocked.example.org"
    assert approval.request["url"] == url
    assert approval.task_id is not None


@pytest.mark.asyncio
async def test_a_one_shot_grant_opens_that_host_for_the_rest_of_the_task(
        project, tool_context, bound_loop, tmp_path, monkeypatch):
    agent = await _agent(project["id"])
    ctx = await tool_context(project_id=project["id"], agent=agent, task_id="t-grant",
                             workspace=tmp_path)
    url = "https://blocked.example.org/data.json"
    first = await asyncio.to_thread(invoker.invoke, ctx, "http_get", {"url": url})
    assert first["error"] == "approval_required"
    await decide_approval(first["approval_id"], grant=True, decided_by="u-test")

    fetched = []

    def fake_fetch(target, project=None, granted_hosts=()):
        fetched.append((target, tuple(granted_hosts)))
        return 200, "<html>body</html>", target

    monkeypatch.setattr(tools_mod, "_fetch_url", fake_fetch)
    second = await asyncio.to_thread(invoker.invoke, ctx, "http_get", {"url": url})
    third = await asyncio.to_thread(invoker.invoke, ctx, "http_get", {"url": url})

    assert second["ok"] is True and third["ok"] is True, "the grant lasts for the task, not one call"
    assert fetched and all("blocked.example.org" in grants for _, grants in fetched), fetched
    async with session_scope() as s:
        assert (await s.get(Approval, first["approval_id"])).state == "granted", \
            "a task-scoped grant is not burnt by the first use"


@pytest.mark.asyncio
async def test_a_grant_for_one_task_does_not_open_another(
        project, tool_context, bound_loop, tmp_path):
    agent = await _agent(project["id"])
    ctx = await tool_context(project_id=project["id"], agent=agent, task_id="t-a", workspace=tmp_path)
    first = await asyncio.to_thread(invoker.invoke, ctx, "http_get",
                                    {"url": "https://blocked.example.org/x"})
    await decide_approval(first["approval_id"], grant=True, decided_by="u-test")
    other = await tool_context(project_id=project["id"], agent=agent, task_id="t-b", workspace=tmp_path)

    second = await asyncio.to_thread(invoker.invoke, other, "http_get",
                                     {"url": "https://blocked.example.org/x"})

    assert second["error"] == "approval_required", "the grant belongs to the task that asked"


@pytest.mark.asyncio
async def test_the_always_grant_appends_the_host_with_an_audit_row_and_event(project):
    from crew.core.models import Project

    async with session_scope() as s:
        approval = Approval(project_id=project["id"], capability="net.fetch", state="granted",
                            request={"kind": "egress", "host": "blocked.example.org",
                                     "url": "https://blocked.example.org/x", "run_id": None})
        s.add(approval)
        await s.flush()
        aid = approval.id

    await security_review.allow_egress_host(
        project["id"], host="blocked.example.org", url="https://blocked.example.org/x",
        decided_by="u-test", source_approval_id=aid)

    async with session_scope() as s:
        row = await s.get(Project, project["id"])
        assert "blocked.example.org" in (row.settings or {}).get("egress_allow", [])
        assert await s.scalar(select(AuditLog).where(
            AuditLog.action == "security.egress.allowed",
            AuditLog.resource_id == "blocked.example.org")) is not None
        assert await s.scalar(select(Event).where(
            Event.project_id == project["id"],
            Event.type == "security.egress.allow.added")) is not None
        assert policy.check_egress("blocked.example.org", row).allowed, \
            "the granted host is on the project's allowlist now"
