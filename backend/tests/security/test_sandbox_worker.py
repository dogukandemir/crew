import sys

import pytest

from crew.execution import sandbox_worker as worker
from crew.execution.process import run_bounded


@pytest.fixture
def sandbox(tmp_path, monkeypatch):
    root = tmp_path / "workspaces"
    workspace = root / "Example Company-id" / "Project-id"
    workspace.mkdir(parents=True)
    monkeypatch.setattr(worker, "ROOT", root)
    return {"workspace": str(workspace), "argv": ["sh", "-lc", "echo hi"], "run_id": "r-test"}


def test_worker_accepts_only_dedicated_project_mounts(sandbox):
    relative, argv, timeout, run_id = worker.validate(sandbox)
    assert relative == "Example Company-id/Project-id"
    for path in [str(worker.ROOT), str(worker.ROOT.parent), str(worker.ROOT / ".." / "outside")]:
        with pytest.raises(ValueError):
            worker.validate({**sandbox, "workspace": path})
    with pytest.raises(ValueError):
        worker.validate({**sandbox, "argv": ["docker", "run", "--privileged", "image"]})
    with pytest.raises(ValueError):
        worker.validate({**sandbox, "argv": ["python", "-I", "-S", "/etc/passwd"]})


def test_worker_mount_arguments_cannot_inject_options(sandbox):
    malicious = worker.ROOT / "company" / "project,src=/"
    with pytest.raises(ValueError):
        worker.validate({**sandbox, "workspace": str(malicious)})


def test_capture_kills_excessive_output_without_buffering_it():
    with pytest.raises(ValueError, match="output exceeded"):
        run_bounded([sys.executable, "-c", "print('x' * 1000000)"], timeout=5, limit=1000)


def test_capture_times_out_and_reaps_child():
    import subprocess
    with pytest.raises(subprocess.TimeoutExpired):
        run_bounded([sys.executable, "-c", "import time; time.sleep(30)"], timeout=1)
