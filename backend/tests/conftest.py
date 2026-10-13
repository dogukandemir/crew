"""Test bootstrap. Environment must be set BEFORE crew modules are imported."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

TMP_DATA = Path(tempfile.mkdtemp(prefix="crew-test-"))
os.environ.update({
    "CREW_ENV": "dev",
    "CREW_DATA_DIR": str(TMP_DATA),
    "CREW_OFFLINE_LLM": "true",          # no network in tests (ADR 0002)
    "CREW_AUTH_MODE": "local",
    # Company workspaces must NEVER land in a real home dir during tests (ADR 0017).
    "CREW_WORKSPACE_ROOT": str(TMP_DATA / "workspaces"),
    "CREW_DEFAULT_PROJECT_BUDGET_USD": "5",
    "CREW_VALIDATE_EVENTS": "true",
    "CREW_JWT_SECRET": "test-secret-that-is-long-enough-0123456789",  # gitleaks:allow -- test-only signing secret
})

import pytest  # noqa: E402
import pytest_asyncio  # noqa: E402

from crew.core import events as ev  # noqa: E402
from crew.core.db import drop_db, init_db  # noqa: E402
from crew.core.models import Agent, Project  # noqa: E402


@pytest_asyncio.fixture(scope="session", autouse=True)
async def _schema():
    from crew.api.main import seed_skills

    ev.bind_loop(__import__("asyncio").get_running_loop())
    await drop_db()
    await init_db(create_all=True)
    await seed_skills()          # the skill catalog is referenced by agent_skills (FK)
    yield
    await drop_db()


@pytest_asyncio.fixture
async def project() -> dict:
    from crew.control import org

    p = await org.create_project(name="Test Project", goal="Test the pipeline end to end", budget_usd=5.0)
    yield p
    # Tests share the schema, but active-run admission is installation-wide.
    # Retire this test's unfinished runs so later provider tests exercise their
    # intended path instead of being rejected by unrelated fixture state.
    from sqlalchemy import update

    from crew.core.db import session_scope
    from crew.core.models import Run

    async with session_scope() as s:
        await s.execute(update(Run).where(Run.project_id == p["id"],
            Run.status.notin_(["completed", "failed", "aborted"])).values(status="aborted"))


@pytest.fixture
def tool_context():
    """Persist real run/task authority for tests that exercise the tool adapter."""
    async def make(*, project_id, agent, task_id=None, run_id=None, workspace=None, **kwargs):
        from crew.core.db import session_scope
        from crew.core.models import Run, Task
        from crew.execution.tools import ToolContext

        async with session_scope() as s:
            p = await s.get(Project, project_id)
            if workspace is not None:
                p.settings = {**p.settings, "workspace": str(workspace)}
            run = await s.get(Run, run_id) if run_id else None
            if run is None:
                run = Run(project_id=project_id, goal="Tool integration test")
                s.add(run)
                await s.flush()
            task = await s.get(Task, task_id) if task_id else None
            if task is None:
                task = Task(project_id=project_id, run_id=run.id, title=task_id or "Tool integration test",
                            state="running", assignee_agent_id=agent.id)
                s.add(task)
                await s.flush()
            return ToolContext(project_id=project_id, agent=agent, task_id=task.id, run_id=run.id,
                               workspace=workspace, **kwargs)
    return make


@pytest_asyncio.fixture
async def bound_loop():
    import asyncio

    ev.bind_loop(asyncio.get_running_loop())
    return asyncio.get_running_loop()


@pytest.fixture
def fake_agent():
    """A detached agent row usable for pure policy checks (no DB)."""
    def _make(role: str = "worker", grade: int = 1, tools: list[str] | None = None,
              autonomy: str = "supervised"):
        a = Agent(project_id="p", name="Tester", role=role, grade=grade,
                  tools=tools if tools is not None else [], autonomy=autonomy, state="idle")
        return a
    return _make


@pytest.fixture
def fake_project():
    def _make(settings: dict | None = None, status: str = "active"):
        return Project(name="P", slug="p", goal="g", status=status, settings=settings or {},
                       owner_id="local-user")
    return _make
