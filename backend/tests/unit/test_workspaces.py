"""ADR 0017: company workspaces are chosen (or defaulted) at founding, materialized
once, and every resolver reads the recorded path. Nothing re-derives silently."""

from __future__ import annotations

import asyncio
import shutil
from pathlib import Path

import pytest
from sqlalchemy import select

from crew.control import company, org, workspaces
from crew.core.db import session_scope
from crew.core.models import AuditLog, Project
from crew.core.settings import settings


def test_sanitize_folder_is_path_safe_and_never_empty():
    cleaned = workspaces.sanitize_folder("a/b\\c")
    assert "/" not in cleaned and "\\" not in cleaned
    assert workspaces.sanitize_folder("   ...  ") == "unnamed"
    assert workspaces.sanitize_folder('Quarterly "Report": Q1?') == "Quarterly Report Q1"


def test_relative_path_is_refused():
    with pytest.raises(ValueError, match="absolute"):
        workspaces.validate_company_path("relative/nope")


def test_validate_creates_nested_dirs_and_tolerates_repeats(tmp_path):
    """A chosen root may be several levels deep without existing (fresh machine) and
    the wizard writes it again on a retry — both must just work."""
    nested = tmp_path / "fresh" / "deeper" / "root"
    out = workspaces.validate_company_path(str(nested))
    assert Path(out) == nested and nested.is_dir(), "parents must be created"
    assert workspaces.validate_company_path(str(nested)) == out, "re-validating is a no-op"


@pytest.mark.asyncio
async def test_resolve_reads_the_recorded_path_and_heals_a_missing_folder(tmp_path):
    """resolve_workspace is what the orchestrator hands to the tools: it must return
    the RECORDED path (not re-derive it) and recreate the folder if it vanished."""
    co = await company.create_company(name="Resolve Co", owner_id="tester")
    proj = await org.create_project(name="Heal Me", company_id=co["id"])
    async with session_scope() as s:
        row = await s.get(Project, proj["id"])
    chosen = Path(row.settings["workspace"])
    shutil.rmtree(chosen.parent)  # the whole company tree vanished (moved disk, cleanup)
    healed = workspaces.resolve_workspace(row)
    assert healed == chosen, "the recorded path wins — always"
    assert await asyncio.to_thread(chosen.is_dir), \
        "and a run must never die on an unmade directory (parents included)"


@pytest.mark.asyncio
async def test_resolve_falls_back_to_the_internal_dir():
    proj = await org.create_project(name="No Material", goal="solo")
    async with session_scope() as s:
        row = await s.get(Project, proj["id"])
        row.settings = {k: v for k, v in row.settings.items() if k != "workspace"}
        s.add(row)
        await s.flush()
    got = workspaces.resolve_workspace(row)
    assert got == settings.workspace_dir(proj["id"]) and got.is_dir()


@pytest.mark.asyncio
async def test_allocate_keeps_a_preexisting_record_and_guards_non_company_parents(tmp_path):
    co = await company.create_company(name="Idem Co", owner_id="tester", workspace_root=str(tmp_path / "idem"))
    proj = await org.create_project(name="Once", company_id=co["id"])
    first = await workspaces.allocate_project_workspace(proj["id"], company_id=co["id"])
    assert await workspaces.allocate_project_workspace(proj["id"], company_id=co["id"]) == first, \
        "an already-recorded path is kept, never re-derived"
    async with session_scope() as s:
        row = await s.get(Project, proj["id"])
    assert row.settings.get("autonomous_intake") is not None, \
        "allocate must not drop the rest of the project settings"

    # A manually-recorded path (no allocate yet) survives an allocate call too.
    other = await org.create_project(name="Preexisting", goal="g")
    pre = tmp_path / "preexisting"
    async with session_scope() as s:
        row = await s.get(Project, other["id"])
        row.settings = {**row.settings, "workspace": str(pre)}
        s.add(row)
        await s.flush()
    out = await workspaces.allocate_project_workspace(other["id"], company_id=co["id"])
    assert Path(out) == pre, "the record wins over a freshly computed company path"

    # A non-company id must be refused, not silently used as a root.
    solo = await org.create_project(name="Solo Guard", goal="g")
    async with session_scope() as s:
        row = await s.get(Project, solo["id"])
        row.settings = {k: v for k, v in row.settings.items() if k != "workspace"}
        s.add(row)
        await s.flush()
    with pytest.raises(KeyError):
        await workspaces.allocate_project_workspace(solo["id"], company_id=other["id"])


@pytest.mark.asyncio
async def test_founding_materializes_the_default_tree():
    co = await company.create_company(name="Northwind Labs", mission="m", owner_id="tester")
    proj = await org.create_project(name="Atlas 2.0", goal="g", company_id=co["id"])
    expected = workspaces.default_root() / f"Northwind Labs-{co['id']}" / f"Atlas 2.0-{proj['id']}"
    assert expected.is_dir(), "the default tree must exist on disk"
    assert Path(proj["settings"]["workspace"]) == expected
    async with session_scope() as s:
        row = await s.scalar(select(AuditLog).where(AuditLog.action == "workspace.allocated",
                                                    AuditLog.resource_id == proj["id"]))
    assert row is not None and row.reason, "the path is on the audit record"


@pytest.mark.asyncio
async def test_a_chosen_root_is_used_as_is(tmp_path):
    chosen = tmp_path / "studio"
    co = await company.create_company(name="Acme Media", owner_id="tester", workspace_root=str(chosen))
    proj = await org.create_project(name="Rocket", company_id=co["id"])
    assert (chosen / f"Rocket-{proj['id']}").is_dir(), "projects land directly under the chosen root"
    assert Path(proj["settings"]["workspace"]) == chosen / f"Rocket-{proj['id']}"
    async with session_scope() as s:
        row = await s.get(Project, co["id"])
        assert Path(row.settings["workspace_root"]) == chosen
        sel = await s.scalar(select(AuditLog).where(AuditLog.action == "workspace.selected",
                                                    AuditLog.resource_id == co["id"]))
    assert sel is not None, "the root choice is on the audit record"


@pytest.mark.asyncio
async def test_standalone_project_keeps_the_internal_dir():
    proj = await org.create_project(name="Lone Wolf", goal="solo")
    assert proj["settings"]["workspace"] == str(settings.workspace_dir(proj["id"]))
