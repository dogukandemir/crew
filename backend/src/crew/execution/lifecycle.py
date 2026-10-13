"""In-process cancellation registry for the supported single-server deployment."""

import subprocess
import threading
from contextvars import ContextVar

current_run: ContextVar[str | None] = ContextVar("crew_run", default=None)
_lock = threading.Lock()
_cancelled: set[str] = set()
_containers: dict[str, set[str]] = {}


def check_cancelled(run_id: str | None = None) -> None:
    with _lock:
        if (run_id or current_run.get()) in _cancelled:
            raise RuntimeError("run was cancelled")


def register_container(name: str) -> None:
    run_id = current_run.get()
    with _lock:
        if run_id in _cancelled:
            raise RuntimeError("run was cancelled")
        if run_id:
            _containers.setdefault(run_id, set()).add(name)


def unregister_container(name: str) -> None:
    with _lock:
        for names in _containers.values():
            names.discard(name)


def cancel(run_id: str) -> None:
    with _lock:
        _cancelled.add(run_id)
        names = list(_containers.get(run_id, ()))
    from crew.core.settings import settings
    if settings.sandbox_url:
        from crew.execution.sandbox_client import request
        try:
            request("/cancel", {"run_id": run_id})
        except (OSError, ValueError, RuntimeError):
            pass  # The bounded sandbox timeout remains the final stop guarantee.
    for name in names:
        try:
            subprocess.run(["docker", "rm", "-f", name], capture_output=True, timeout=10, check=False)
        except (OSError, subprocess.TimeoutExpired):
            pass  # the worker's finally block retries cleanup; the API reports request acceptance
