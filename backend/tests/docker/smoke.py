"""Run inside the API container of a disposable Compose installation only.

Creates a test project, checks the actual broker/container/file round trip, and
leaves a marker for verification after container recreation. No model calls.
"""
import asyncio
import json
import sys
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from uuid import uuid4

from crew.core.security import vault
from crew.execution import sandbox_client

MARKER = Path("/data/release-smoke.json")


def api(path, payload=None):
    body = json.dumps(payload).encode() if payload is not None else None
    req = Request("http://127.0.0.1:8787/api" + path, data=body,
                  headers={"Content-Type": "application/json"})
    with urlopen(req, timeout=30) as response:
        return json.load(response)


def main():
    assert api("/health")["offline_llm"], "only run this check in an isolated Demo installation"
    if "--verify-persistence" in sys.argv:
        marker = json.loads(MARKER.read_text())
        project = api("/projects/" + marker["project_id"])
        assert project["settings"]["workspace"] == marker["workspace"]
        assert (Path(marker["workspace"]) / "release-smoke.txt").read_text() == marker["content"]
        assert asyncio.run(vault.reveal(marker["secret_id"])) == marker["content"]
        print("Database, project file and decryptable vault entry survived recovery.")
        return
    project = api("/projects", {"name": "Release sandbox smoke", "goal": "Check isolated command tools"})
    workspace = Path(project["settings"]["workspace"])
    content = "sandbox-marker-" + uuid4().hex
    command = f"printf '%s' '{content}' > release-smoke.txt; test ! -e /data/crew.db && test ! -S /var/run/docker.sock && cat release-smoke.txt"
    result = sandbox_client.run(workspace, ["sh", "-lc", command], 15, uuid4().hex)
    assert result.returncode == 0, result.stderr
    assert result.stdout == content
    assert (workspace / "release-smoke.txt").read_text() == content
    try:
        sandbox_client.run(Path("/data"), ["sh", "-lc", "true"], 5, uuid4().hex)
    except HTTPError as exc:
        assert exc.code == 400
    else:
        raise AssertionError("broker accepted a path outside the workspace volume")
    secret = api("/secrets", {"name": "release-smoke-fixture", "value": content,
                               "scope_kind": "project", "scope_id": project["id"]})
    MARKER.write_text(json.dumps({"project_id": project["id"], "workspace": str(workspace),
                                 "content": content, "secret_id": secret["id"]}))
    print("Broker executed a command, shared the project file, excluded host data/socket, and rejected an outside path.")


if __name__ == "__main__":
    main()
