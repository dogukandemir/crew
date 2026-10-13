import asyncio
import hashlib
import json

import pytest

from crew.control import verify
from crew.core.db import session_scope
from crew.core.models import Artifact, Task
from crew.core.settings import settings


@pytest.mark.asyncio
@pytest.mark.parametrize("raw", [
    '{"quality":NaN,"confidence":1,"criteria":[{"met":true}]}',
    '{"quality":1,"confidence":2,"criteria":[{"met":true}]}',
    '{"quality":1,"confidence":1,"criteria":[{"met":"true"}]}',
    '{"quality":1,"confidence":1,"criteria":null}',
])
async def test_malformed_evaluator_output_cannot_be_treated_as_a_pass(project, bound_loop, monkeypatch, raw):
    from crew.execution import gateway

    monkeypatch.setattr(settings, "offline_llm", False)
    monkeypatch.setattr(settings, "deepseek_api_key", "fake-evidence-test-key")
    monkeypatch.setattr(settings, "tier_standard", "deepseek/deepseek-flash")

    async def complete(**kwargs):
        return raw

    monkeypatch.setattr(gateway, "complete", complete)
    task = Task(project_id=project["id"], title="Judge", acceptance_criteria=["Verified result"])
    assert await asyncio.to_thread(verify._judge, task, "Evidence") is None


@pytest.mark.asyncio
async def test_evaluator_gets_publication_metadata_full_small_files_and_execution_receipts(project, bound_loop, monkeypatch):
    from crew.core import events
    from crew.execution import gateway

    monkeypatch.setattr(settings, "offline_llm", False)
    monkeypatch.setattr(settings, "deepseek_api_key", "fake-evidence-test-key")
    monkeypatch.setattr(settings, "tier_standard", "deepseek/deepseek-flash")
    task = Task(project_id=project["id"], title="Test report", acceptance_criteria=["Tests ran and report published"])
    async with session_scope() as s:
        s.add(task)
        await s.flush()
    root = settings.artifacts_dir(project["id"])
    root.mkdir(parents=True, exist_ok=True)
    for name, body in [("converter.py", "# source\n" * 900), ("TEST-RESULTS.md", "TAIL ACTUAL OUTPUT: Ran 10 tests. OK")]:
        path = root / name
        path.write_bytes(body.encode())
        async with session_scope() as s:
            s.add(Artifact(project_id=project["id"], task_id=task.id, path=str(path), bytes=len(body.encode()),
                           sha256=hashlib.sha256(body.encode()).hexdigest(), meta={"name": name, "source_path": name}))
    await events.emit("agent.tool.result", project_id=project["id"], task_id=task.id,
        title="real tool receipt", payload={"tool": "python_eval", "ok": True,
            "invocation": {"code": "run the tests"}, "execution": {"exit_code": 0, "mode": "docker",
                "stdout": "", "stderr": "Ran 10 tests. OK"}})
    calls = []

    async def complete(**kwargs):
        calls.append(kwargs)
        packet = json.loads(kwargs["messages"][1]["content"])
        assert kwargs["compact"] is True
        assert "TAIL ACTUAL OUTPUT" in packet["deliverable"]
        assert {a["name"] for a in packet["publication_manifest"]} == {"converter.py", "TEST-RESULTS.md"}
        assert all(a["source_path"] == a["name"] for a in packet["publication_manifest"])
        assert packet["execution_receipts"][0]["exit_code"] == 0
        assert packet["execution_receipts"][0]["stderr"] == "Ran 10 tests. OK"
        return json.dumps({"quality": 1, "confidence": 1, "criteria": [{"met": True}]})

    monkeypatch.setattr(gateway, "complete", complete)
    outcome = await verify.verifier.verify_task(project_id=project["id"], task=task, result_text="done")
    assert outcome.passed and len(calls) == 1


@pytest.mark.asyncio
async def test_narrative_cannot_prove_imaginary_deliverable(project):
    task = Task(project_id=project["id"], title="Implement calculator",
                acceptance_criteria=["Implement validated calculator"])
    async with session_scope() as s:
        s.add(task)
        await s.flush()
    outcome = await verify.verifier.verify_task(project_id=project["id"], task=task,
        result_text="Implement validated calculator. Everything is done and validated; see imaginary.py.")
    assert not outcome.passed


@pytest.mark.asyncio
async def test_rejecting_judge_vetoes_real_artifact_and_tampering_fails(project, monkeypatch):
    task = Task(project_id=project["id"], title="Evidence", acceptance_criteria=["validated calculator"])
    async with session_scope() as s:
        s.add(task)
        await s.flush()
    root = settings.artifacts_dir(project["id"])
    root.mkdir(parents=True, exist_ok=True)
    path = root / "calculator.txt"
    data = b"A validated calculator with a detailed explanation of all outputs and their evidence."
    path.write_bytes(data)
    async with session_scope() as s:
        s.add(Artifact(project_id=project["id"], task_id=task.id, path=str(path), bytes=len(data),
                       sha256=hashlib.sha256(data).hexdigest()))
    monkeypatch.setattr(verify, "_judge", lambda *a: {"quality": 0, "criteria": [{"met": False}]})
    outcome = await verify.verifier.verify_task(project_id=project["id"], task=task, result_text=data.decode())
    assert not outcome.passed
    path.write_text("different file content")
    outcome = await verify.verifier.verify_task(project_id=project["id"], task=task, result_text=data.decode())
    assert any(c["name"] == "artifact_integrity" and not c["ok"] for c in outcome.checks)
