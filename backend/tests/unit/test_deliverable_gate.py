"""F22: a task that names a deliverable file is not verified until that file exists.

The live finding: the task "Verify changes with Python and write test-note.md" carried
the deliverable "test-note.md containing verification results for each check", passed
verification at confidence 0.95, and no test-note.md existed anywhere in the workspace
or the artifact store.
"""

from __future__ import annotations

import hashlib

import pytest
from sqlalchemy import select

from crew.control import verify
from crew.control.workspaces import resolve_workspace
from crew.core.db import session_scope
from crew.core.models import Artifact, Project, Task
from crew.core.settings import settings

LIVE_DELIVERABLE = "test-note.md containing verification results for each check"
RESULT_TEXT = ("Ran the python checks against the workspace and recorded each outcome, "
               "with exit codes and the notes a reader needs to repeat them.\n")


def test_the_live_deliverable_names_the_file_it_promised():
    assert verify.named_deliverable(LIVE_DELIVERABLE) == "test-note.md"


def test_a_deliverable_prefix_does_not_matter_only_the_base_name():
    assert verify.named_deliverable("deliverables/qa/test-note.md") == "test-note.md"
    assert verify.named_deliverable("write `notes/report.json` for the review") == "report.json"


@pytest.mark.parametrize("prose", [
    "An evidence brief: findings, sources, uncertainties, open questions.",
    "A complete draft, structured for the target reader.",
    "The main deliverable requested by the goal.",
    "see e.g. the price sheet",
    "version v1.2 of the numbers",
])
def test_prose_is_not_checkable_and_is_left_alone(prose):
    assert verify.named_deliverable(prose) is None, "prose must never be turned into a missing file"


async def _task(project_id: str, deliverable: str) -> Task:
    async with session_scope() as s:
        t = Task(project_id=project_id, title="Verify changes with Python", deliverable=deliverable)
        s.add(t)
        await s.flush()
    async with session_scope() as s:
        return await s.get(Task, t.id)


async def _workspace(project_id: str):
    async with session_scope() as s:
        p = await s.get(Project, project_id)
    return resolve_workspace(p).resolve()


async def _publish(project_id: str, task_id: str, path, body: str) -> None:
    data = body.encode()
    async with session_scope() as s:
        s.add(Artifact(project_id=project_id, task_id=task_id, kind="file", path=str(path),
                       bytes=len(data), sha256=hashlib.sha256(data).hexdigest(),
                       meta={"name": path.name, "attempt": 1}))


@pytest.mark.asyncio
async def test_a_named_deliverable_that_never_landed_fails_verification(project, bound_loop):
    task = await _task(project["id"], LIVE_DELIVERABLE)
    # The producer did real work, just not the work it named: one unrelated artifact.
    workspace = await _workspace(project["id"])
    (workspace / "checks").mkdir(parents=True, exist_ok=True)
    other = workspace / "checks" / "walkthrough.md"
    other.write_bytes(RESULT_TEXT.encode("utf-8"))
    await _publish(project["id"], task.id, other, RESULT_TEXT)

    outcome = await verify.verifier.verify_task(project_id=project["id"], task=task,
                                                result_text=RESULT_TEXT)

    assert not outcome.passed, "a task cannot pass without the deliverable it named"
    assert any("test-note.md" in r for r in outcome.reasons), outcome.reasons
    assert any("deliverable_present" in str(c["name"]) for c in outcome.checks)
    async with session_scope() as s:
        stored = await s.scalar(select(verify.VerificationResult).where(
            verify.VerificationResult.task_id == task.id))
    assert stored is not None and stored.verdict == "fail"
    assert any("test-note.md" in r for r in (stored.rubric or {}).get("reasons", []))


@pytest.mark.asyncio
@pytest.mark.parametrize("where", ["workspace", "artifact_store"])
async def test_the_same_task_passes_when_the_named_file_exists(project, bound_loop, where):
    task = await _task(project["id"], LIVE_DELIVERABLE)
    if where == "workspace":
        root = await _workspace(project["id"])
    else:
        root = settings.artifacts_dir(project["id"]).resolve()
    target = root / "qa" / "test-note.md"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(RESULT_TEXT.encode("utf-8"))
    await _publish(project["id"], task.id, target, RESULT_TEXT)

    outcome = await verify.verifier.verify_task(project_id=project["id"], task=task,
                                                result_text=RESULT_TEXT)

    assert outcome.passed, outcome.checks
    present = [c for c in outcome.checks if c["name"] == "deliverable_present"]
    assert present and present[0]["ok"] is True


@pytest.mark.asyncio
async def test_a_prose_deliverable_adds_no_check(project, bound_loop):
    task = await _task(project["id"], "An evidence brief: findings, sources, uncertainties.")

    outcome = await verify.verifier.verify_task(project_id=project["id"], task=task,
                                                result_text=RESULT_TEXT)

    assert not any(c["name"] == "deliverable_present" for c in outcome.checks), \
        "inventing a file name for prose would fail honest work"
