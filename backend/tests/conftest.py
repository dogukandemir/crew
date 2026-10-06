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
    "CREW_TOOL_SANDBOX": "subprocess",
    "CREW_DEFAULT_PROJECT_BUDGET_USD": "5",
    "CREW_VALIDATE_EVENTS": "true",
    "CREW_JWT_SECRET": "test-secret-that-is-long-enough-0123456789",
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
    return p


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
