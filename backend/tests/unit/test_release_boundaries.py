"""Regressions for the public-readiness review; exercise the actual tool boundary."""

import asyncio

import pytest

from crew.core.db import session_scope
from crew.core.models import Agent, Project, Run
from crew.execution.tools import ToolContext, _jailed, h_fs_delete, h_fs_read, invoker


def test_sibling_prefix_cannot_escape_workspace(tmp_path):
    root = tmp_path / "workspace"
    other = tmp_path / "workspace-other"
    other.mkdir()
    (other / "secret.txt").write_text("private")
    ctx = ToolContext(project_id="p", workspace=root)
    for rel in ("../workspace-other/secret.txt", str(other / "secret.txt"), "../../secret.txt"):
        with pytest.raises(PermissionError):
            h_fs_read(ctx, {"path": rel})
    assert (other / "secret.txt").read_text() == "private"


@pytest.mark.parametrize("rel", ["", ".", "child/.."])
def test_workspace_root_cannot_be_deleted(tmp_path, rel):
    with pytest.raises(PermissionError):
        h_fs_delete(ToolContext(project_id="p", workspace=tmp_path), {"path": rel})
    assert tmp_path.exists()


def test_missing_workspace_fails_closed():
    with pytest.raises(PermissionError):
        _jailed(ToolContext(project_id="p"), "file.txt")


def test_symlink_is_not_a_workspace_authority(tmp_path):
    root = tmp_path / "root"
    root.mkdir()
    target = root / "target"
    target.write_text("content")
    link = root / "link"
    try:
        link.symlink_to(target)
    except OSError:
        pytest.skip("symlink creation requires platform permission")
    with pytest.raises(PermissionError):
        _jailed(ToolContext(project_id="p", workspace=root), "link")


@pytest.mark.asyncio
async def test_live_project_policy_and_run_state_override_worker_snapshot(tool_context, bound_loop, project, tmp_path):
    async with session_scope() as s:
        a = Agent(project_id=project["id"], name="Writer", role="worker", grade=5,
                  state="idle", autonomy="autonomous", tools=["fs.workspace"])
        r = Run(project_id=project["id"], goal="write")
        s.add_all([a, r])
        await s.flush()
    ctx = await tool_context(project_id=project["id"], agent=a, run_id=r.id, workspace=tmp_path)
    assert (await asyncio.to_thread(invoker.invoke, ctx, "fs_write", {"path": "ok.txt", "content": "ok"}))["ok"]
    async with session_scope() as s:
        p = await s.get(Project, project["id"])
        p.settings = {**p.settings, "tool_policy": {"deny_all": True}}
    denied = await asyncio.to_thread(invoker.invoke, ctx, "fs_write", {"path": "denied.txt", "content": "no"})
    assert denied["error"] == "policy_denied"
    assert not (tmp_path / "denied.txt").exists()
    async with session_scope() as s:
        p = await s.get(Project, project["id"])
        p.settings = {**p.settings, "tool_policy": {}}
        run = await s.get(Run, r.id)
        run.status = "aborted"
    denied = await asyncio.to_thread(invoker.invoke, ctx, "fs_write", {"path": "late.txt", "content": "no"})
    assert denied["error"] == "policy_denied"
    assert not (tmp_path / "late.txt").exists()


@pytest.mark.asyncio
async def test_tool_context_cannot_forge_workspace_or_task(tool_context, bound_loop, project, tmp_path):
    async with session_scope() as s:
        a = Agent(project_id=project["id"], name="Boundary tester", role="worker", grade=5,
                  autonomy="autonomous", tools=["fs.workspace"])
        s.add(a)
        await s.flush()
    ctx = await tool_context(project_id=project["id"], agent=a, workspace=tmp_path / "workspace")
    correct_workspace, correct_task = ctx.workspace, ctx.task_id
    for forged in ("path", "task", "missing_run"):
        ctx.workspace, ctx.task_id = correct_workspace, correct_task
        if forged == "path":
            ctx.workspace = tmp_path / "other"
        elif forged == "task":
            ctx.task_id = "nonexistent-task"
        else:
            ctx.run_id = None
        denied = await asyncio.to_thread(invoker.invoke, ctx, "fs_write", {"path": "forged.txt", "content": "no"})
        assert denied["error"] == "policy_denied"
    assert not (tmp_path / "other" / "forged.txt").exists()
    assert not (correct_workspace / "forged.txt").exists()


@pytest.mark.asyncio
async def test_legacy_overlapping_project_paths_fail_closed(tool_context, bound_loop, project, tmp_path):
    async with session_scope() as s:
        a = Agent(project_id=project["id"], name="Legacy boundary tester", role="worker", grade=5,
                  autonomy="autonomous", tools=["fs.workspace"])
        other = Project(name="Legacy duplicate", slug="legacy-duplicate", settings={"workspace": str(tmp_path)})
        s.add_all([a, other])
        await s.flush()
    ctx = await tool_context(project_id=project["id"], agent=a, workspace=tmp_path / "nested")
    denied = await asyncio.to_thread(invoker.invoke, ctx, "fs_write", {"path": "overlap.txt", "content": "no"})
    assert denied["error"] == "policy_denied"
    assert "overlaps" in denied["detail"]
