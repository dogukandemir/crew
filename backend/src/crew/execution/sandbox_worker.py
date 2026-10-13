"""Private, authenticated Docker broker. Never publish this port or daemon socket.

The API has no Docker socket. This worker accepts only a fixed command shape,
fixed image and an existing subdirectory of the dedicated workspace volume.
It cannot mount the database, vault, host paths or an arbitrary image/network.
"""
import hmac
import json
import os
import re
import secrets
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from crew.execution.process import run_bounded

IMAGE = "python:3.12-slim"
ROOT = Path("/workspaces")
VOLUME = os.environ.get("CREW_WORKSPACE_VOLUME", "crew-workspaces")
TOKEN_FILE = Path(os.environ.get("CREW_SANDBOX_TOKEN_FILE", "/sandbox-auth/token"))
_lock = threading.Lock()
_containers: dict[str, set[str]] = {}
_cancelled: set[str] = set()
_slots = threading.BoundedSemaphore(2)


def validate(payload: dict) -> tuple[str, list[str], int, str]:
    workspace = Path(str(payload.get("workspace", "")))
    if not workspace.is_absolute() or not workspace.is_relative_to(ROOT):
        raise ValueError("workspace must be inside the dedicated volume")
    relative = workspace.relative_to(ROOT)
    if len(relative.parts) < 2 or any(not re.fullmatch(r"[^,\x00-\x1f\\/]+", p) or p in (".", "..") for p in relative.parts):
        raise ValueError("a company/project subdirectory is required")
    for index in range(len(relative.parts)):
        path = ROOT.joinpath(*relative.parts[:index + 1])
        if path.is_symlink() or not path.is_dir():
            raise ValueError("workspace directories must exist and cannot be links")
    if not workspace.resolve().is_relative_to(ROOT.resolve()):
        raise ValueError("workspace escapes volume")
    argv = payload.get("argv")
    shell = isinstance(argv, list) and len(argv) == 3 and argv[:2] == ["sh", "-lc"]
    python = isinstance(argv, list) and len(argv) == 4 and argv[:3] == ["python", "-I", "-S"]
    if not (shell or python) or not all(isinstance(a, str) for a in argv):
        raise ValueError("unsupported sandbox command")
    if python and not re.fullmatch(r"/work/_eval_[0-9a-f]{8}\.py", argv[3]):
        raise ValueError("unsupported script path")
    if sum(len(a) for a in argv) > 32_000:
        raise ValueError("command is too large")
    run_id = payload.get("run_id") or ""
    if not isinstance(run_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", run_id):
        raise ValueError("run identity is required")
    return relative.as_posix(), argv, max(1, min(int(payload.get("timeout", 45)), 120)), run_id


def remove(name):
    try:
        subprocess.run(["docker", "rm", "-f", name], capture_output=True, timeout=10, check=False)
    except (OSError, subprocess.TimeoutExpired):
        pass


def execute(payload):
    relative, argv, timeout, run_id = validate(payload)
    if not _slots.acquire(timeout=1):
        raise RuntimeError("sandbox is busy; retry later")
    name = "crew-sandbox-" + secrets.token_hex(12)
    try:
        with _lock:
            if run_id in _cancelled:
                raise ValueError("run was cancelled")
            _containers.setdefault(run_id, set()).add(name)
        command = ["docker", "create", "--rm", "--name", name, "--label", "crew.sandbox=true",
                   "--network", "none", "--read-only", "--tmpfs", "/tmp:size=64m",
                   "--memory", "1g", "--cpus", "1", "--pids-limit", "128",
                   "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
                   "--mount", f"type=volume,src={VOLUME},dst=/work,volume-subpath={relative}",
                   "-w", "/work", IMAGE, *argv]
        result = run_bounded(command, 60)
        if result.returncode == 0:
            with _lock:
                if run_id in _cancelled:
                    raise ValueError("run was cancelled")
            result = run_bounded(["docker", "start", "-a", name], timeout)
        return {"ok": True, "returncode": result.returncode, "stdout": result.stdout, "stderr": result.stderr}
    finally:
        remove(name)
        with _lock:
            _containers.get(run_id, set()).discard(name)
        _slots.release()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # Do not log credentials or command bodies.

    def respond(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def authorized(self):
        expected = "Bearer " + TOKEN_FILE.read_text().strip()
        return hmac.compare_digest(self.headers.get("Authorization", ""), expected)

    def do_GET(self):
        if not self.authorized():
            return self.respond(401, {"ok": False})
        if self.path != "/health":
            return self.respond(404, {"ok": False})
        result = subprocess.run(["docker", "image", "inspect", IMAGE], capture_output=True, timeout=5)
        self.respond(200 if result.returncode == 0 else 503, {"ok": result.returncode == 0})

    def do_POST(self):
        if not self.authorized():
            return self.respond(401, {"ok": False})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 64_000:
                raise ValueError("invalid request size")
            payload = json.loads(self.rfile.read(length))
            if not isinstance(payload, dict):
                raise ValueError("object required")
            if self.path == "/run":
                return self.respond(200, execute(payload))
            if self.path == "/cancel":
                run_id = str(payload.get("run_id", ""))
                with _lock:
                    _cancelled.add(run_id)
                    names = list(_containers.get(run_id, ()))
                for name in names:
                    remove(name)
                return self.respond(200, {"ok": True})
            self.respond(404, {"ok": False})
        except (ValueError, RuntimeError, OSError, subprocess.SubprocessError) as exc:
            self.respond(400, {"ok": False, "error": str(exc)[:400]})


def main():
    TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
    if not TOKEN_FILE.exists():
        with TOKEN_FILE.open("x") as stream:
            TOKEN_FILE.chmod(0o600)
            stream.write(secrets.token_urlsafe(48))
    if subprocess.run(["docker", "image", "inspect", IMAGE], capture_output=True).returncode:
        subprocess.run(["docker", "pull", IMAGE], check=True, timeout=180)
    ThreadingHTTPServer(("0.0.0.0", 8790), Handler).serve_forever()


if __name__ == "__main__":
    main()
