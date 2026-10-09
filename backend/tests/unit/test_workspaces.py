"""ADR 0017: company workspaces are chosen (or defaulted) at founding, materialized
once, and every resolver reads the recorded path. Nothing re-derives silently."""

from __future__ import annotations

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


@pytest.mark.asyncio
async def test_founding_materializes_the_default_tree():
    co = await company.create_company(name="Northwind Labs", mission="m", owner_id="tester")
    proj = await org.create_project(name="Atlas 2.0", goal="g", company_id=co["id"])
    expected = workspaces.default_root() / "Northwind Labs" / "Atlas 2.0"
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
    assert (chosen / "Rocket").is_dir(), "projects land directly under the chosen root"
    assert Path(proj["settings"]["workspace"]) == chosen / "Rocket"
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
