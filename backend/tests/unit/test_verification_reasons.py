"""F20: a failed verification says why, on the record and in the served task payload.

The finding: a failed task carried a verdict and a confidence but no reason, and
`escalation_reason` said only "retry 2", so an operator could not tell what failed.
"""

from __future__ import annotations

import hashlib

import pytest
from sqlalchemy import select

from crew.control import verify
from crew.core.db import session_scope
from crew.core.models import Artifact, Task, VerificationResult
from crew.core.settings import settings


async def _task(project_id: str, title: str, criteria: list[str]) -> str:
    async with session_scope() as s:
        t = Task(project_id=project_id, title=title, acceptance_criteria=criteria)
        s.add(t)
        await s.flush()
        return t.id


async def _stored(task_id: str) -> VerificationResult:
    async with session_scope() as s:
        row = await s.scalar(select(VerificationResult).where(VerificationResult.task_id == task_id))
    assert row is not None, "the verifier must leave a record"
    return row


@pytest.mark.asyncio
async def test_a_failed_verification_persists_its_reasons(project, bound_loop):
    """An unusable artifact fails, and the record names the checks that failed."""
    task_id = await _task(project["id"], "Price sheet",
                          ["Prices for three rival products", "A table of the numbers"])
    async with session_scope() as s:
        task = await s.get(Task, task_id)
    # Unusable on purpose: the path is outside this task's authority roots, so the
    # integrity check cannot read it, and the result text is empty.
    async with session_scope() as s:
        s.add(Artifact(project_id=project["id"], task_id=task_id, kind="file",
                       path=str(settings.data_dir / "elsewhere" / "price-sheet.md"),
                       bytes=len(b"# price sheet\n"), sha256="0" * 64,
                       meta={"name": "price-sheet.md", "attempt": 1}))

    outcome = await verify.verifier.verify_task(project_id=project["id"], task=task, result_text="")

    assert not outcome.passed
    assert outcome.reasons, "a failure that names nothing is the bug"
    assert all(isinstance(r, str) and r.strip() for r in outcome.reasons), outcome.reasons

    stored = await _stored(task_id)
    assert stored.verdict in ("fail", "inconclusive")
    reasons = (stored.rubric or {}).get("reasons") or []
    assert reasons, "the stored verification must carry the reasons, not just the verdict"
    assert all(str(r).strip() for r in reasons)
    assert any("artifact" in r for r in reasons), reasons
    assert any("criterion" in r for r in reasons), reasons


@pytest.mark.asyncio
async def test_a_passing_verification_still_passes_and_records_no_reasons(project, bound_loop):
    """A real, hash-bound artifact with full criteria coverage still passes."""
    criteria = ["Price comparison table"]
    task_id = await _task(project["id"], "Price sheet", criteria)
    async with session_scope() as s:
        task = await s.get(Task, task_id)
    root = settings.artifacts_dir(project["id"])
    root.mkdir(parents=True, exist_ok=True)
    path = root / "price-sheet.md"
    body = ("# Price comparison table\n\nA price comparison table for three rivals, "
            "with the numbers per unit and the date each was checked.\n")
    path.write_bytes(body.encode())
    async with session_scope() as s:
        s.add(Artifact(project_id=project["id"], task_id=task_id, kind="file", path=str(path),
                       mime="text/markdown", bytes=len(body.encode()),
                       sha256=hashlib.sha256(body.encode()).hexdigest(),
                       meta={"name": "price-sheet.md", "attempt": 1}))

    outcome = await verify.verifier.verify_task(project_id=project["id"], task=task, result_text=body)

    assert outcome.passed, outcome.checks
    stored = await _stored(task_id)
    assert stored.verdict in ("pass", "pass_with_notes")
    assert not (stored.rubric or {}).get("reasons"), "a pass names no failure cause"


def test_the_retry_note_keeps_the_reason_instead_of_saying_retry_2():
    """The symptom in the finding: `escalation_reason` ended up as only "retry 2"."""
    from crew.control.orchestrator import _carry_reason, _escalation_note

    note = _escalation_note("verification fail", ["non_empty: 0 chars",
                                                 "artifact_integrity: artifact is missing"])
    assert note.startswith("verification fail: non_empty: 0 chars")
    carried = _carry_reason(note, "retry 1")
    assert "non_empty" in carried, "the ladder note never erases the cause"
    assert carried.endswith("retry 1")
    assert len(carried) <= 300, "the record stays readable"

    assert _carry_reason("", "retry 2") == "retry 2"
    assert _escalation_note("verification fail", []) == "verification fail"
