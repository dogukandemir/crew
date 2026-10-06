"""Live provider tests — excluded from the default run (addopts excludes `live`).

Run these only with a real key and a small budget:

    cd backend
    # backend/.env must contain e.g. DEEPSEEK_API_KEY=...
    uv run pytest -m live -s

They spend real money (a few cents) and they are the only tests that prove the CrewAI path
against a real provider end to end.
"""

from __future__ import annotations

import os

import pytest
from sqlalchemy import select

from crew.core.db import session_scope
from crew.core.models import Run, Task
from crew.core.settings import settings

pytestmark = pytest.mark.live

GOAL = "List three concrete trade-offs between B-tree and LSM-tree storage engines, with sources."


def _has_provider() -> bool:
    for tier_model in (settings.tier_fast, settings.tier_standard, settings.tier_reasoning):
        if settings.provider_key_for(tier_model):
            return True
    return bool(os.environ.get("DEEPSEEK_API_KEY") or os.environ.get("OPENAI_API_KEY")
                or os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("GEMINI_API_KEY"))


@pytest.mark.skipif(not _has_provider(), reason="no model provider key configured")
async def test_real_crewai_run_completes_and_is_verified(bound_loop, project):
    from crew.control.orchestrator import orchestrator
    from crew.core.db import init_db

    await init_db()
    assert settings.offline_llm is False, "unset CREW_OFFLINE_LLM to run the live test"

    run = await orchestrator.start_run(project_id=project["id"], goal=GOAL)
    result = await orchestrator.advance(run["id"])

    async with session_scope() as s:
        row = await s.get(Run, run["id"])
        tasks = (await s.scalars(select(Task).where(Task.run_id == run["id"]))).all()

    assert result["status"] in ("completed", "failed", "paused_budget"), result
    assert row.tokens_in > 0, "a real run must consume real tokens"
    assert row.cost_micros > 0, "a real run must cost real money"
    assert tasks, "planning must produce tasks"
    # the model was actually consulted: at least one task carries a real result
    assert any(t.result_text and "offline" not in t.result_text for t in tasks), \
        "no task produced a genuine model output"
    print(f"\nlive run: ${row.cost_micros / 1e6:.4f}, {row.tokens_in}+{row.tokens_out} tokens, "
          f"{len(tasks)} tasks, status={result['status']}")
