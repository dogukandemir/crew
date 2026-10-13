"""Private broker transport used only by the container distribution."""
import json
import subprocess
from pathlib import Path
from urllib.request import Request, urlopen

from crew.core.settings import settings


def request(endpoint: str, payload=None):
    token = Path(settings.sandbox_token_file).read_text(encoding="utf-8").strip()
    body = json.dumps(payload).encode() if payload is not None else None
    req = Request(settings.sandbox_url.rstrip("/") + endpoint, data=body,
                  headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    with urlopen(req, timeout=135 if endpoint == "/run" else 5) as response:
        result = json.loads(response.read(150_000))
    if not result.get("ok"):
        raise RuntimeError(result.get("error", "sandbox request failed"))
    return result


def available() -> bool:
    try:
        return bool(request("/health")["ok"])
    except (OSError, ValueError, RuntimeError):
        return False


def run(workspace: Path, argv: list[str], timeout: int, run_id: str | None):
    result = request("/run", {"workspace": str(workspace), "argv": argv,
                               "timeout": timeout, "run_id": run_id})
    return subprocess.CompletedProcess(argv, result["returncode"], result["stdout"], result["stderr"])
