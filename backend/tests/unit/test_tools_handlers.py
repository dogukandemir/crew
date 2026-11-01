"""Tool-handler behaviour, the surface the mutation run flagged as unexercised:
the fs workspace jail, search parsing, the colleague/join tools, truncation and
the CrewAI wrappers. (pytest-gremlins survivors, docs/13.)"""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from crew.core.db import session_scope
from crew.core.models import Agent, Approval, Event, Run, Task
from crew.core.security import decide_approval
from crew.domain.enums import Capability
from crew.execution import tools as tools_mod
from crew.execution.tools import ToolContext, invoker


async def _mk_agent(project_id: str, *, tools: list[str], name: str = "Handler") -> Agent:
    async with session_scope() as s:
        a = Agent(project_id=project_id, name=name, role="worker", grade=5,
                  state="idle", tools=tools, autonomy="autonomous", mission="test handlers")
        s.add(a)
        await s.flush()
        aid = a.id
        row = await s.get(Agent, aid)
        s.expunge(row)
    return row


# ── pure helpers ────────────────────────────────────────────────────────────────────
def test_actor_is_agent_scoped_or_system():
    """Closes: the actor ternary (None blank would erase the actor on every event)."""
    ctx = ToolContext(project_id="p")
    assert ctx.actor == "system"
    ctx.agent = SimpleNamespace(id="a-1")
    assert ctx.actor == "agent:a-1"


def test_run_on_loop_without_a_bound_loop_raises(monkeypatch):
    """Closes: the `loop is None or loop.is_closed()` guard, swapped to `and` it
    would AttributeError instead of refusing."""
    monkeypatch.setattr(tools_mod.ev, "current_loop", lambda: None)
    coro = asyncio.sleep(0)
    try:
        with pytest.raises(RuntimeError):
            tools_mod.run_on_loop(coro)
    finally:
        coro.close()

    monkeypatch.setattr(tools_mod.ev, "current_loop", lambda: SimpleNamespace(is_closed=lambda: True))
    coro = asyncio.sleep(0)
    try:
        with pytest.raises(RuntimeError):
            tools_mod.run_on_loop(coro)
    finally:
        coro.close()


def test_jailed_creates_the_root_and_blocks_escapes(tmp_path):
    """Closes: the mkdir flags (parents/exist_ok) and the containment check."""
    from crew.execution.tools import _jailed

    ctx = ToolContext(project_id="p", workspace=tmp_path / "nested" / "deeper")
    p = _jailed(ctx, "notes/a.txt")
    assert ctx.workspace.is_dir(), "the root is created, nested (parents=True)"
    assert str(p).startswith(str(ctx.workspace.resolve())) and p.name == "a.txt"
    assert _jailed(ctx, "notes/a.txt") == p, "repeat calls are idempotent"
    with pytest.raises(PermissionError):
        _jailed(ctx, "../escape.txt")


def test_truncate_boundaries_and_markers():
    """Closes: the truncation arithmetic and returns (exact boundary, str and dict)."""
    exact = "x" * tools_mod.MAX_BYTES
    assert tools_mod._truncate(exact) == exact, "the exact boundary is untouched"
    over = "x" * (tools_mod.MAX_BYTES + 10)
    t = tools_mod._truncate(over)
    assert t.startswith("x" * tools_mod.MAX_BYTES) and "truncated 10 chars" in t
    d = tools_mod._truncate({"k": "v" * (tools_mod.MAX_BYTES + 5)})
    assert d["truncated"] is True and len(d["preview"]) == tools_mod.MAX_BYTES
    small = {"a": 1}
    assert tools_mod._truncate(small) is small


def test_schema_and_agent_roster():
    """Closes: _schema shape and tools_for_agent's roster (None blank, unknown caps)."""
    assert tools_mod._schema({"a": {"type": "string"}}, ["a"]) == {
        "type": "object", "properties": {"a": {"type": "string"}}, "required": ["a"]}
    assert tools_mod.tools_for_agent(None) == []
    agent = SimpleNamespace(tools=[Capability.FS_WORKSPACE.value, "bogus.cap"])
    assert sorted(tools_mod.tools_for_agent(agent)) == ["fs_list", "fs_read", "fs_write"]


def test_invoker_refuses_unknown_tools_without_touching_the_loop():
    """Closes: the unknown-tool early return (None blank would crash the caller)."""
    r = invoker.invoke(ToolContext(project_id="p"), "nope", {})
    assert r == {"ok": False, "error": "unknown tool: nope"}


# ── fs tools through the real invoker (capability + jail + events) ─────────────────
@pytest.mark.asyncio
async def test_fs_roundtrip_jail_and_delete_flow(tool_context, bound_loop, project, tmp_path):
    agent = await _mk_agent(project["id"], tools=[Capability.FS_WORKSPACE.value,
                                                  Capability.FS_DELETE.value])
    ctx = await tool_context(project_id=project["id"], agent=agent, task_id="t-fs", workspace=tmp_path)

    w = await asyncio.to_thread(invoker.invoke, ctx, "fs_write",
                                {"path": "deep/x/y/z.txt", "content": "level three"})
    assert w["ok"] is True, "multi-level parents are created on demand"
    w2 = await asyncio.to_thread(invoker.invoke, ctx, "fs_write",
                                 {"path": "docs/readme.txt", "content": "hello workspace"})
    assert w2["ok"] is True and w2["data"]["bytes"] == len(b"hello workspace")
    w3 = await asyncio.to_thread(invoker.invoke, ctx, "fs_write",
                                 {"path": "docs/readme.txt", "content": "rewritten"})
    assert w3["ok"] is True, "rewriting an existing file is fine (exist_ok)"
    empty = await asyncio.to_thread(invoker.invoke, ctx, "fs_write", {"path": "", "content": "x"})
    assert empty["ok"] is False and "path is required" in empty["error"]

    r = await asyncio.to_thread(invoker.invoke, ctx, "fs_read", {"path": "docs/readme.txt"})
    assert r["ok"] is True and r["data"] == "rewritten"
    missing = await asyncio.to_thread(invoker.invoke, ctx, "fs_read", {"path": "docs/none.txt"})
    assert missing["ok"] is False and "not found" in missing["error"]

    fresh = await _mk_agent(project["id"], tools=[Capability.FS_WORKSPACE.value], name="Lister")
    lctx = await tool_context(project_id=project["id"], agent=fresh, task_id="t-fs2", workspace=tmp_path)
    await asyncio.to_thread(invoker.invoke, lctx, "fs_write", {"path": "docs/sub/note.md",
                                                               "content": "hi"})
    listing = await asyncio.to_thread(invoker.invoke, lctx, "fs_list", {"path": "docs"})
    assert listing["ok"] is True and listing["data"] == ["readme.txt", "sub/"]
    l2 = await asyncio.to_thread(invoker.invoke, lctx, "fs_list", {"path": "nowhere"})
    assert l2 == {"ok": True, "data": []}
    l3 = await asyncio.to_thread(invoker.invoke, lctx, "fs_list", {})
    assert l3["ok"] is True and "docs/" in l3["data"], "default listing is the workspace root"

    esc = await asyncio.to_thread(invoker.invoke, ctx, "fs_write",
                                  {"path": "../escape.txt", "content": "x"})
    assert esc["ok"] is False and "PermissionError" in esc["error"], esc
    assert not (tmp_path.parent / "escape.txt").exists()

    d1 = await asyncio.to_thread(invoker.invoke, ctx, "fs_delete", {"path": "docs/readme.txt"})
    assert d1["error"] == "approval_required", d1
    await decide_approval(d1["approval_id"], grant=True, decided_by="owner")
    d2 = await asyncio.to_thread(invoker.invoke, ctx, "fs_delete", {"path": "docs/readme.txt"})
    assert d2["ok"] is True and not (tmp_path / "docs" / "readme.txt").exists()
    assert (tmp_path / "docs" / "sub").is_dir(), "deleting one file leaves its siblings alone"

    d3 = await asyncio.to_thread(invoker.invoke, ctx, "fs_delete", {"path": "docs/sub"})
    if d3.get("approval_id"):           # the d1 grant may already cover the retry
        await decide_approval(d3["approval_id"], grant=True, decided_by="owner")
        d3 = await asyncio.to_thread(invoker.invoke, ctx, "fs_delete", {"path": "docs/sub"})
    assert d3["ok"] is True and not (tmp_path / "docs" / "sub").exists(), "a directory is removed"


# ── web_search parsing ──────────────────────────────────────────────────────────────
def _serp(n: int) -> str:
    rows = "".join(f'<a rel="nofollow" class="result__a" href="https://s{i}.example">'
                   f"<b>Hit</b> {i}, title</a>" for i in range(n))
    return f"<html><body>{rows}</body></html>"


# A real zero-result page says so in its markup; a challenge or a silently unparseable
# page must NOT be reported as "no results" (F2: the price sheet was told there were
# none when the fetch had actually been blocked).
_NO_RESULTS = ('<html><body><div class=\'no-results__container\'>'
               '<div class="no-results__message"><h1>No results found for '
               '<strong>alpha</strong></h1></div></div></body></html>')
_CHALLENGE = ('<html><body><form class="challenge-form" action="/anomaly.js?sv=lite">'
              '<button class="js-anomaly-modal-submit">Submit</button></form></body></html>')


@pytest.mark.asyncio
async def test_search_parses_strips_and_caps(tool_context, bound_loop, project, tmp_path, monkeypatch):
    agent = await _mk_agent(project["id"], tools=[Capability.NET_SEARCH.value], name="Seeker")
    ctx = await tool_context(project_id=project["id"], agent=agent, task_id="t-s", workspace=tmp_path)

    # The html provider is down, so the chain falls through to the lite provider.
    monkeypatch.setattr(tools_mod, "_html_search_page",
                        lambda q, grants=(): (_ for _ in ()).throw(ConnectionError("html down")))
    monkeypatch.setattr(tools_mod, "_search_page", lambda q, grants=(): _serp(6))
    r = await asyncio.to_thread(invoker.invoke, ctx, "web_search", {"query": "alpha"})
    assert r["ok"] is True and r["untrusted"] is True
    assert r["review"]["verdict"] == "clean" and r["review"]["method"] == "deterministic"
    assert r["meta"]["provider"] == "duckduckgo_lite" and r["meta"]["outcome"] == "results"
    assert len(r["data"]) == 5, "at most five hits"
    assert r["data"][0] == {"url": "https://s0.example", "title": "Hit 0, title", "snippet": ""}
    assert r["meta"]["attempts"][0]["outcome"] == "failed", "the dead provider is on the record"

    monkeypatch.setattr(tools_mod, "_search_page", lambda q, grants=(): _NO_RESULTS)
    r2 = await asyncio.to_thread(invoker.invoke, ctx, "web_search", {"query": "alpha"})
    assert r2["ok"] is True and r2["data"] == []
    assert r2["meta"]["outcome"] == "empty"
    assert "genuine empty answer" in r2["note"], "an empty answer says why it is empty"

    bad = await asyncio.to_thread(invoker.invoke, ctx, "web_search", {"query": ""})
    assert bad["ok"] is False and "query is required" in bad["error"]


@pytest.mark.asyncio
async def test_search_says_a_blocked_or_unreadable_chain_is_not_zero_results(
        tool_context, bound_loop, project, tmp_path, monkeypatch):
    agent = await _mk_agent(project["id"], tools=[Capability.NET_SEARCH.value], name="Sifting")
    ctx = await tool_context(project_id=project["id"], agent=agent, task_id="t-b", workspace=tmp_path)

    monkeypatch.setattr(tools_mod, "_html_search_page", lambda q, grants=(): _CHALLENGE)
    monkeypatch.setattr(tools_mod, "_search_page", lambda q, grants=(): _CHALLENGE)
    blocked = await asyncio.to_thread(invoker.invoke, ctx, "web_search", {"query": "alpha"})
    assert blocked["ok"] is False and blocked["meta"]["outcome"] == "all_failed"
    assert {a["outcome"] for a in blocked["meta"]["attempts"]} == {"blocked"}
    assert "NOT a zero-result answer" in blocked["error"], blocked

    monkeypatch.setattr(tools_mod, "_html_search_page", lambda q, grants=(): "<html>maintenance</html>")
    monkeypatch.setattr(tools_mod, "_search_page", lambda q, grants=(): "<html>maintenance</html>")
    broken = await asyncio.to_thread(invoker.invoke, ctx, "web_search", {"query": "alpha"})
    assert broken["ok"] is False and broken["meta"]["outcome"] == "all_failed"
    assert {a["outcome"] for a in broken["meta"]["attempts"]} == {"unparsed"}
    assert "NOT a zero-result answer" in broken["error"], broken


@pytest.mark.asyncio
async def test_search_refuses_honestly_when_egress_is_denied_or_the_net_fails(tool_context,
        bound_loop, project, tmp_path, monkeypatch):
    """Closes: the egress-denied return and the search-failure return, both must be
    honest refusals, never an empty 'success'.

    Since docs/08 §7 a denied host files an `egress` approval (the allowlist can be
    widened on the record) instead of a dead end; the refusal still says which host.
    """
    from types import SimpleNamespace

    agent = await _mk_agent(project["id"], tools=[Capability.NET_SEARCH.value], name="Denied")
    ctx = await tool_context(project_id=project["id"], agent=agent, task_id="t-d", workspace=tmp_path)

    monkeypatch.setattr(tools_mod.policy, "check_egress",
                        lambda host, proj: SimpleNamespace(allowed=False, reason="blocked for test"))
    r = await asyncio.to_thread(invoker.invoke, ctx, "web_search", {"query": "alpha"})
    assert r["ok"] is False and r["error"] == "approval_required", r
    assert r["host"] == tools_mod.SEARCH_HOST
    async with session_scope() as s:
        request = (await s.get(Approval, r["approval_id"])).request
    assert request["kind"] == "egress" and request["host"] == tools_mod.SEARCH_HOST

    monkeypatch.setattr(tools_mod.policy, "check_egress",
                        lambda host, proj: SimpleNamespace(allowed=True, reason=""))
    monkeypatch.setattr(tools_mod, "_html_search_page",
                        lambda q, grants=(): (_ for _ in ()).throw(ConnectionError("dns down")))
    monkeypatch.setattr(tools_mod, "_search_page",
                        lambda q, grants=(): (_ for _ in ()).throw(ConnectionError("dns down")))
    r2 = await asyncio.to_thread(invoker.invoke, ctx, "web_search", {"query": "alpha"})
    assert r2["ok"] is False and r2["error"].startswith("search_unavailable: every provider failed")
    assert "ConnectionError: dns down" in r2["error"]
    assert r2["meta"]["outcome"] == "all_failed"


@pytest.mark.asyncio
async def test_http_get_requires_a_url(tool_context, bound_loop, project, tmp_path):
    """Closes: the empty-url guard in h_http_get."""
    agent = await _mk_agent(project["id"], tools=[Capability.NET_FETCH.value], name="Fetcher")
    ctx = await tool_context(project_id=project["id"], agent=agent, task_id="t-h", workspace=tmp_path)
    r = await asyncio.to_thread(invoker.invoke, ctx, "http_get", {})
    assert r["ok"] is False and "url is required" in r["error"]


# ── join_task ───────────────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_join_task_lifecycle(tool_context, bound_loop, project, tmp_path):
    owner = await _mk_agent(project["id"], tools=[Capability.BOARD_WRITE.value], name="Owner")
    joiner = await _mk_agent(project["id"], tools=[Capability.BOARD_WRITE.value], name="Joiner")
    async with session_scope() as s:
        run = Run(project_id=project["id"], goal="parser")
        s.add(run)
        await s.flush()
        t = Task(project_id=project["id"], run_id=run.id, title="Wire the parser",
                 state="running", assignee_agent_id=owner.id)
        s.add(t)
        await s.flush()
        tid = t.id

    ctx = await tool_context(project_id=project["id"], agent=joiner, task_id="t-j",
                      run_id=run.id, workspace=tmp_path)
    r = await asyncio.to_thread(invoker.invoke, ctx, "join_task", {"task_id": tid})
    assert r["ok"] is True and r["data"]["joined"] is True
    async with session_scope() as s:
        t = await s.get(Task, tid)
        assert joiner.id in (t.helpers or [])
        joined_ev = (await s.scalars(select(Event).where(Event.type == "task.helper.joined",
                                                         Event.project_id == project["id"]))).all()
        dm = (await s.scalars(select(Event).where(Event.type == "agent.message",
                                                  Event.project_id == project["id"]))).all()
    assert joined_ev and joiner.id in json.dumps(joined_ev[-1].payload), "the join is a domain event"
    assert any("joined to help" in (e.title or "") or "joined to help" in json.dumps(e.payload)
               for e in dm), "the assignee gets a DM"

    again = await asyncio.to_thread(invoker.invoke, ctx, "join_task", {"task_id": tid})
    assert again["ok"] is True and again["data"]["note"] == "already on it"

    own = await tool_context(project_id=project["id"], agent=owner, task_id="t-j2", workspace=tmp_path)
    r_own = await asyncio.to_thread(invoker.invoke, own, "join_task", {"task_id": tid})
    assert r_own["ok"] is False and "your own task" in r_own["error"]

    r_missing = await asyncio.to_thread(invoker.invoke, ctx, "join_task", {"task_id": "nope"})
    assert r_missing["ok"] is False and "no such task" in r_missing["error"]
    r_blank = await asyncio.to_thread(invoker.invoke, ctx, "join_task", {})
    assert r_blank["ok"] is False and "required" in r_blank["error"]

    async with session_scope() as s:
        t = await s.get(Task, tid)
        t.state = "completed"
        s.add(t)
    r_done = await asyncio.to_thread(invoker.invoke, ctx, "join_task", {"task_id": tid})
    assert r_done["ok"] is False and "already completed" in r_done["error"]


# ── CrewAI wrappers ─────────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_crewai_wrappers_roundtrip(tool_context, bound_loop, project, tmp_path):
    """Closes: build_crewai_tools' loop building and _run's JSON return."""
    agent = await _mk_agent(project["id"], tools=[Capability.FS_WORKSPACE.value], name="Wrap")
    ctx = await tool_context(project_id=project["id"], agent=agent, task_id="t-w", workspace=tmp_path)
    built = await asyncio.to_thread(tools_mod.build_crewai_tools, ctx)
    assert sorted(t.name for t in built) == ["fs_list", "fs_read", "fs_write"]
    writer = next(t for t in built if t.name == "fs_write")
    out = await asyncio.to_thread(writer._run, path="wrap.txt", content="via crewai")
    assert json.loads(out)["ok"] is True
    assert (tmp_path / "wrap.txt").read_text(encoding="utf-8") == "via crewai"
    lister = next(t for t in built if t.name == "fs_list")
    assert "path" not in lister.args_schema.model_json_schema().get("required", [])
    assert json.loads(await asyncio.to_thread(lister.run))["ok"] is True


@pytest.mark.asyncio
async def test_publish_existing_file_preserves_bytes_and_enforces_filesystem_policy(tool_context, bound_loop, project, tmp_path):
    import hashlib
    from pathlib import Path

    agent = await _mk_agent(project["id"], tools=[Capability.FS_WORKSPACE.value, Capability.ARTIFACT_PUBLISH.value])
    ctx = await tool_context(project_id=project["id"], agent=agent, workspace=tmp_path)
    source = b"first\r\nsecond \xc3\xa9\r\n"
    (tmp_path / "existing.txt").write_bytes(source)
    built = await asyncio.to_thread(tools_mod.build_crewai_tools, ctx)
    publisher = next(t for t in built if t.name == "artifact_publish")
    result = json.loads(await asyncio.to_thread(publisher.run, name="published.txt", source_path="existing.txt"))
    assert result["ok"] is True
    assert await asyncio.to_thread(Path(result["data"]["path"]).read_bytes) == source
    assert result["data"]["sha256"] == hashlib.sha256(source).hexdigest()
    assert result["data"]["bytes"] == len(source)
    (tmp_path / "existing.txt").write_bytes(b"updated content")
    second = json.loads(await asyncio.to_thread(publisher.run, name="published.txt", source_path="existing.txt"))
    assert second["data"]["path"] != result["data"]["path"]
    assert await asyncio.to_thread(Path(result["data"]["path"]).read_bytes) == source
    from crew.control.verify import current_artifacts
    from crew.core.models import Artifact

    async with session_scope() as s:
        versions = list((await s.scalars(select(Artifact).where(Artifact.task_id == ctx.task_id))).all())
    assert len(versions) == 2
    latest = current_artifacts(versions)
    assert len(latest) == 1 and latest[0].path == second["data"]["path"]
    assert latest[0].meta["source_path"] == "existing.txt"
    async with session_scope() as s:
        from crew.core.models import Project

        p = await s.get(Project, project["id"])
        p.settings = {**p.settings, "tool_policy": {"deny": ["fs.workspace"]}}
    denied = await asyncio.to_thread(invoker.invoke, ctx, "artifact_publish",
        {"name": "denied.txt", "source_path": "existing.txt"})
    assert not denied["ok"] and denied["error"] == "policy_denied"


@pytest.mark.asyncio
async def test_publish_source_cannot_escape_workspace(tool_context, bound_loop, project, tmp_path):
    agent = await _mk_agent(project["id"], tools=[Capability.FS_WORKSPACE.value, Capability.ARTIFACT_PUBLISH.value])
    ctx = await tool_context(project_id=project["id"], agent=agent, workspace=tmp_path)
    result = await asyncio.to_thread(invoker.invoke, ctx, "artifact_publish",
        {"name": "escape.txt", "source_path": "../outside.txt"})
    assert not result["ok"] and "path escapes" in result["error"]
