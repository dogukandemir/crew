"""Tools: capability-guarded handlers + the invoker that is the only path to a side effect.

Every tool call goes through ToolInvoker: policy check → approval gate → sandbox → redaction
→ event + audit. Agents cannot reach a tool any other way (docs/04 §4, docs/08 §4).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import subprocess
import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from sqlalchemy import select

from crew.control import backlog, inbox
from crew.control import security_review as sreview
from crew.core import events as ev
from crew.core.db import session_scope
from crew.core.models import Agent, Project, Run, Task, WorkItem
from crew.core.security import (
    SUPERVISED_FORBIDDEN,
    approval_granted,
    audit,
    invocation_hash,
    policy,
    redactor,
    request_approval,
    scan_injection,
    standing_allow_hit,
)
from crew.core.settings import settings
from crew.domain.catalog import ALWAYS_APPROVAL
from crew.domain.enums import Capability, PolicyOutcome

log = logging.getLogger("crew.tools")

MAX_BYTES = 20_000
SANDBOX_IMAGE = "python:3.13-slim"


def _yolo_on(ctx) -> bool:
    """Full autonomy for this project (ADR 0018): every human gate is off."""
    try:
        return ctx.project is not None and bool(ctx.project.setting("yolo", False))
    except Exception:
        return False


def _yolo_audit(ctx, *, tool: str, capability: str) -> None:
    """The honest half of YOLO: what a human would have been asked to approve is
    recorded, hash-chained, so the decision trail survives the missing prompt."""
    run_on_loop(ev.emit("policy.yolo", project_id=ctx.project_id, task_id=ctx.task_id,
                        run_id=ctx.run_id, agent_id=ctx.agent.id if ctx.agent else None,
                        severity="notice", title=f"yolo: auto-granted {capability}",
                        payload={"tool": tool, "capability": capability}))
    run_on_loop(audit(actor_kind="agent", actor_id=ctx.agent.id if ctx.agent else "",
                      action="policy.yolo.grant", resource_kind="capability",
                      resource_id=capability, outcome="allowed",
                      reason=f"yolo mode: {tool}", project_id=ctx.project_id))


@dataclass
class ToolContext:
    """Everything a handler is allowed to know. Deliberately narrow."""

    project_id: str
    agent: Agent | None = None
    project: Project | None = None
    task_id: str | None = None
    run_id: str | None = None
    trace_id: str = ""
    workspace: Path | None = None
    artifacts: Path | None = None
    extra: dict = field(default_factory=dict)

    @property
    def actor(self) -> str:
        return f"agent:{self.agent.id}" if self.agent else "system"


class ToolApprovalPending(RuntimeError):
    """A bounded worker must yield to the operator before another generation."""


def run_on_loop(coro, timeout: float = 30.0):
    """Run an async coroutine from a worker thread on the server loop."""
    loop = ev.current_loop()
    if loop is None or loop.is_closed():
        raise RuntimeError("no server event loop bound; cannot perform async tool work")
    return asyncio.run_coroutine_threadsafe(coro, loop).result(timeout)


def _jailed(ctx: ToolContext, rel: str) -> Path:
    """Only relative paths below an explicitly assigned workspace are accepted."""
    if ctx.workspace is None:
        raise PermissionError("no project workspace assigned")
    root = ctx.workspace.resolve()
    root.mkdir(parents=True, exist_ok=True)
    if Path(rel).is_absolute() or Path(rel).drive:
        raise PermissionError("absolute paths are not permitted")
    candidate = (root / rel).resolve()
    if not candidate.is_relative_to(root):
        raise PermissionError(f"path escapes the project workspace: {rel}")
    # Refuse links/reparse points, including links that currently point inward.
    # Their targets must never be a second, mutable source of authority.
    current = root
    for part in Path(rel).parts:
        current = current / part
        if current.is_symlink() or current.is_junction():
            raise PermissionError("workspace links are not permitted")
    return candidate


def _truncate(data: Any) -> Any:
    text = json.dumps(data, default=str) if not isinstance(data, str) else data
    if len(text) > MAX_BYTES:
        if isinstance(data, str):
            return data[:MAX_BYTES] + f"\n...[truncated {len(data) - MAX_BYTES} chars]"
        return {"truncated": True, "preview": text[:MAX_BYTES]}
    return data


# ── handlers ─────────────────────────────────────────────────────────────────────────
def _search_page(query: str) -> str:
    """The raw DuckDuckGo SERP. Factored out so tests can fake the network (ADR 0017)."""
    from urllib.parse import urlencode

    from crew.execution.http import fetch_public

    return fetch_public("https://html.duckduckgo.com/html/?" + urlencode({"q": query}))[1]


def _fetch_url(url: str, project: Project | None = None) -> tuple[int, str, str]:
    """One GET, no redirect tail-chasing beyond 5 hops. Factored out for tests."""
    from crew.execution.http import fetch_public

    return fetch_public(url, project)


def _screen_fetched(ctx: ToolContext, *, url: str, kind: str, text: str) -> dict:
    """The security review gate for fetched web content (ADR 0017).

    → {"outcome": "clean"|"released"|"gated", "review": Verdict, "body": str|None,
       "response": dict|None}. Risky content is quarantined and an approval is filed,
    the agent never sees it before a human releases it.
    """
    review = run_on_loop(sreview.review_content(text, url=url, kind=kind, project_id=ctx.project_id), timeout=150)
    run_on_loop(ev.emit("security.content.reviewed", project_id=ctx.project_id,
                        severity="warning" if review.risky else "info",
                        title=f"content reviewed ({review.verdict}): {url[:70]}",
                        payload={"url": url, "verdict": review.verdict, "kind": kind,
                                 "score": review.score, "method": review.method,
                                 "reasons": review.reasons[:6]},
                        agent_id=ctx.agent.id if ctx.agent else None, task_id=ctx.task_id))
    if not review.risky:
        return {"outcome": "clean", "review": review, "body": None, "response": None}
    if _yolo_on(ctx):
        # Full autonomy: the gate is off, and the release is still on the record.
        run_on_loop(ev.emit("security.content.released", project_id=ctx.project_id,
                            severity="notice", title=f"content released (yolo): {url[:70]}",
                            payload={"url": url, "via": "yolo"},
                            agent_id=ctx.agent.id if ctx.agent else None, task_id=ctx.task_id))
        run_on_loop(audit(actor_kind="agent", actor_id=ctx.agent.id if ctx.agent else "",
                          action="security.content.released", resource_kind="capability",
                          resource_id="net.fetch", outcome="allowed",
                          reason=f"yolo: {url}", project_id=ctx.project_id))
        return {"outcome": "released", "review": review, "body": text, "response": None}
    released = run_on_loop(sreview.release_for_content(
        ctx.project_id, agent_id=ctx.agent.id if ctx.agent else None, url=url,
        task_id=ctx.task_id, run_id=ctx.run_id))
    if released:
        body = sreview.load_quarantined(released)
        if body is not None:
            run_on_loop(ev.emit("security.content.released", project_id=ctx.project_id,
                                severity="notice", title=f"content released after review: {url[:70]}",
                                payload={"url": url, "approval_id": released["approval_id"]},
                                agent_id=ctx.agent.id if ctx.agent else None, task_id=ctx.task_id))
            run_on_loop(audit(actor_kind="agent", actor_id=ctx.agent.id if ctx.agent else "",
                              action="security.content.released", resource_kind="approval",
                              resource_id=released["approval_id"], reason=url))
            return {"outcome": "released", "review": review, "body": body, "response": None}
        # The quarantine file vanished (cleaned up, tampered): gate afresh rather than
        # serving something unverified.
    meta = sreview.quarantine_content(ctx.project_id, url=url, text=text, review=review)
    response = run_on_loop(sreview.gate_content(
        ctx.project_id, agent_id=ctx.agent.id if ctx.agent else None, task_id=ctx.task_id,
        url=url, kind=kind, review=review, meta=meta, run_id=ctx.run_id))
    return {"outcome": "gated", "review": review, "body": None, "response": response}


def h_web_search(ctx: ToolContext, args: dict) -> dict:
    query = str(args.get("query", ""))[:300]
    if not query:
        return {"ok": False, "error": "query is required"}
    # Search is internet access too, it obeys egress, same as http_get (ADR 0017).
    decision = policy.check_egress("html.duckduckgo.com", ctx.project)
    if not decision.allowed:
        run_on_loop(ev.emit("security.egress.blocked", project_id=ctx.project_id,
                            severity="warning", title="egress blocked: web search",
                            payload={"url": "https://html.duckduckgo.com/html/",
                                     "host": "html.duckduckgo.com", "reason": decision.reason},
                            agent_id=ctx.agent.id if ctx.agent else None))
        return {"ok": False, "error": f"egress_denied: {decision.reason}"}
    try:
        page = _search_page(query)
    except Exception as e:  # network is optional; report honestly
        return {"ok": False, "error": f"search failed: {type(e).__name__}: {e}"}
    hits = []
    import re
    for m in re.finditer(r'<a rel="nofollow" class="result__a" href="([^"]+)">(.*?)</a>', page, re.S):
        hits.append({"url": m.group(1), "title": re.sub(r"<[^>]+>", "", m.group(2)).strip()})
        if len(hits) >= 5:
            break
    scr = _screen_fetched(ctx, url=f"search:{query}", kind="search",
                          text=json.dumps(hits, ensure_ascii=False))
    if scr["outcome"] == "gated":
        return scr["response"]
    if scr["outcome"] == "released":
        try:
            released_hits = json.loads(scr["body"])
        except json.JSONDecodeError:
            released_hits = hits
        return {"ok": True, "data": released_hits, "untrusted": True, "released": "approved",
                "review": {"verdict": "review", "method": "human", "score": scr["review"].score},
                "meta": {"provider": "duckduckgo"}}
    return {"ok": True, "data": hits, "untrusted": True,
            "review": {"verdict": "clean", "method": scr["review"].method,
                       "score": scr["review"].score},
            "meta": {"provider": "duckduckgo"}}


def h_http_get(ctx: ToolContext, args: dict) -> dict:
    url = str(args.get("url", ""))
    if not url:
        return {"ok": False, "error": "url is required"}
    import httpx

    host = httpx.URL(url).host or ""
    decision = policy.check_egress(host, ctx.project)
    if not decision.allowed:
        run_on_loop(ev.emit("security.egress.blocked", project_id=ctx.project_id,
                            severity="warning", title=f"egress blocked: {host}",
                            payload={"url": url, "host": host, "reason": decision.reason},
                            agent_id=ctx.agent.id if ctx.agent else None))
        return {"ok": False, "error": f"egress_denied: {decision.reason}"}
    try:
        status, raw, final_url = _fetch_url(url, ctx.project)
    except Exception as e:
        return {"ok": False, "error": f"fetch failed: {type(e).__name__}: {e}"}
    body = raw[:MAX_BYTES]
    labels = scan_injection(body)
    if labels:
        run_on_loop(ev.emit("security.injection.detected", project_id=ctx.project_id,
                            severity="warning", title=f"injection pattern in {host}",
                            payload={"where": url, "labels": labels},
                            agent_id=ctx.agent.id if ctx.agent else None))
    scr = _screen_fetched(ctx, url=url, kind="page", text=body)
    if scr["outcome"] == "gated":
        return scr["response"]
    if scr["outcome"] == "released":
        return {"ok": True, "data": scr["body"], "untrusted": True, "released": "approved",
                "review": {"verdict": "review", "method": "human", "score": scr["review"].score},
                "meta": {"status": status, "url": final_url}}
    return {"ok": True, "data": body, "untrusted": True,
            "review": {"verdict": "clean", "method": scr["review"].method,
                       "score": scr["review"].score},
            "meta": {"status": status, "url": final_url, "injection_labels": labels}}


def h_fs_write(ctx: ToolContext, args: dict) -> dict:
    rel = str(args.get("path", ""))
    content = args.get("content", "")
    if not rel:
        return {"ok": False, "error": "path is required"}
    p = _jailed(ctx, rel)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(str(content), encoding="utf-8")
    return {"ok": True, "data": {"path": rel, "bytes": p.stat().st_size}}


def h_fs_read(ctx: ToolContext, args: dict) -> dict:
    rel = str(args.get("path", ""))
    p = _jailed(ctx, rel)
    if not p.exists():
        return {"ok": False, "error": f"not found: {rel}"}
    if p.stat().st_size > 2_000_000:
        return {"ok": False, "error": "file exceeds the supported read size (2 MB)"}
    with p.open(encoding="utf-8", errors="replace") as stream:
        data = stream.read(MAX_BYTES + 1)
    return {"ok": True, "data": _truncate(data)}


def h_fs_list(ctx: ToolContext, args: dict) -> dict:
    rel = str(args.get("path", "."))
    p = _jailed(ctx, rel)
    if not p.exists():
        return {"ok": True, "data": []}
    items = sorted(x.name + ("/" if x.is_dir() else "") for x in p.iterdir())[:200]
    return {"ok": True, "data": items}


def h_fs_delete(ctx: ToolContext, args: dict) -> dict:
    rel = str(args.get("path", ""))
    p = _jailed(ctx, rel)
    if p == ctx.workspace.resolve():
        raise PermissionError("the workspace root cannot be deleted")
    if p.is_dir():
        shutil.rmtree(p)
    elif p.exists():
        p.unlink()
    return {"ok": True, "data": {"deleted": rel}}


def _sandbox_available() -> bool:
    """Execution happens in the container or not at all (ADR 0017)."""
    if settings.sandbox_url:
        from crew.execution.sandbox_client import available
        return available()
    if not shutil.which("docker"):
        return False
    try:
        return subprocess.run(["docker", "info", "--format", "{{.ServerVersion}}"],
                              capture_output=True, timeout=5, check=False).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def _run_in_container(*, workspace: Path, argv: list[str], timeout: int) -> subprocess.CompletedProcess:
    """The one way a command runs: no network, read-only root, tmpfs /tmp, capped,
    the project workspace at /work and nothing else mounted. Factored out so tests
    can stub the execution while still exercising the gate."""
    from crew.execution import lifecycle
    from crew.execution.process import run_bounded

    lifecycle.check_cancelled()
    if settings.sandbox_url:
        from crew.execution.sandbox_client import run
        return run(workspace, argv, timeout, lifecycle.current_run.get())
    name = f"crew-{os.urandom(8).hex()}"
    full = ["docker", "create", "--rm", "--name", name, "--network", "none",
            "--read-only", "--tmpfs", "/tmp", "--memory", "1g", "--cpus", "1",
            "--pids-limit", "256", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
            "-v", f"{workspace}:/work", "-w", "/work",
            SANDBOX_IMAGE] + argv
    lifecycle.register_container(name)
    try:
        lifecycle.check_cancelled()
        created = run_bounded(full, 60)
        if created.returncode:
            return created
        lifecycle.check_cancelled()
        return run_bounded(["docker", "start", "-a", name], timeout)
    finally:
        try:
            subprocess.run(["docker", "rm", "-f", name], capture_output=True, timeout=10, check=False)
        except (OSError, subprocess.TimeoutExpired):
            pass
        finally:
            lifecycle.unregister_container(name)


def _command_gate(ctx: ToolContext, *, tool: str, capability: str, cmd: str) -> dict | None:
    """The command security review gate (ADR 0017).

    Order: the owner's always-allow list first (no re-query), then the deterministic
    review. A risky command runs only with a granted approval on file for exactly this
    normalized command, otherwise the approval is filed and the command is held.
    Returns a gating response dict, or None when the command may run.
    """
    norm = sreview.normalize_command(cmd)
    allowed_via = None
    if run_on_loop(sreview.allowlist_hit(ctx.project_id, norm)):
        allowed_via = "allowlist"
    else:
        review = sreview.review_command(cmd)
        if review.risky:
            if _yolo_on(ctx):
                allowed_via = "yolo"
            else:
                released = run_on_loop(sreview.release_for_command(
                    ctx.project_id, agent_id=ctx.agent.id if ctx.agent else None, norm=norm,
                    capability=capability, task_id=ctx.task_id, run_id=ctx.run_id))
                if released is not None:
                    allowed_via = "approval"
                else:
                    return run_on_loop(sreview.gate_command(
                        ctx.project_id, agent_id=ctx.agent.id if ctx.agent else None,
                        task_id=ctx.task_id, tool=tool, capability=capability, cmd=cmd, review=review, run_id=ctx.run_id))
    if allowed_via:
        run_on_loop(ev.emit("security.command.allowed", project_id=ctx.project_id,
                            severity="notice", title=f"command allowed via {allowed_via}",
                            payload={"cmd": cmd[:2000], "via": allowed_via, "tool": tool},
                            agent_id=ctx.agent.id if ctx.agent else None, task_id=ctx.task_id))
    return None


def h_shell_run(ctx: ToolContext, args: dict) -> dict:
    cmd = str(args.get("cmd", ""))
    timeout = int(args.get("timeout_s", 60))
    if not cmd:
        return {"ok": False, "error": "cmd is required"}
    gate = _command_gate(ctx, tool="shell_run", capability="shell.sandbox", cmd=cmd)
    if gate is not None:
        return gate
    if not _sandbox_available():
        run_on_loop(ev.emit("security.sandbox.unavailable", project_id=ctx.project_id,
                            severity="error", title="shell sandbox unavailable",
                            payload={"tool": "shell_run"},
                            agent_id=ctx.agent.id if ctx.agent else None, task_id=ctx.task_id))
        return {"ok": False, "error": "sandbox_unavailable: Docker is required, "
                                      "commands never run on the host"}
    workspace = (ctx.workspace or Path.cwd()).resolve()
    try:
        proc = _run_in_container(workspace=workspace, argv=["sh", "-lc", cmd], timeout=timeout)
        return {"ok": proc.returncode == 0,
                "data": {"stdout": (proc.stdout or "")[-8000:], "stderr": (proc.stderr or "")[-4000:],
                         "exit_code": proc.returncode, "mode": "docker"}}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"timed out after {timeout}s (docker)"}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


def h_python_eval(ctx: ToolContext, args: dict) -> dict:
    code = str(args.get("code", ""))
    if not code:
        return {"ok": False, "error": "code is required"}
    gate = _command_gate(ctx, tool="python_eval", capability="code.python", cmd=code)
    if gate is not None:
        return gate
    if not _sandbox_available():
        run_on_loop(ev.emit("security.sandbox.unavailable", project_id=ctx.project_id,
                            severity="error", title="python sandbox unavailable",
                            payload={"tool": "python_eval"},
                            agent_id=ctx.agent.id if ctx.agent else None, task_id=ctx.task_id))
        return {"ok": False, "error": "sandbox_unavailable: Docker is required, "
                                      "code never runs on the host"}
    workspace = (ctx.workspace or Path.cwd()).resolve()
    name = f"_eval_{os.urandom(4).hex()}.py"
    script = workspace / name
    script.write_text(code, encoding="utf-8")
    try:
        proc = _run_in_container(workspace=workspace, argv=["python", "-I", "-S", f"/work/{name}"],
                                 timeout=int(args.get("timeout_s", 45)))
        return {"ok": proc.returncode == 0,
                "data": {"stdout": (proc.stdout or "")[-8000:], "stderr": (proc.stderr or "")[-4000:],
                         "exit_code": proc.returncode, "mode": "docker"}}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "python eval timed out (docker)"}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}
    finally:
        script.unlink(missing_ok=True)



def h_brain_search(ctx: ToolContext, args: dict) -> dict:
    from crew.core.brains import brain_service

    query = str(args.get("query", ""))
    hits = run_on_loop(brain_service.context_pack(project_id=ctx.project_id, agent=ctx.agent, query=query))
    return {"ok": True, "data": [{"title": h["title"], "body": h["body"][:400], "trust": h["trust"],
                                  "source": h["source"], "score": h["score"]} for h in hits]}


def h_brain_write(ctx: ToolContext, args: dict) -> dict:
    from crew.core.brains import brain_service

    title = str(args.get("title", ""))[:200]
    body = str(args.get("body", ""))
    kind = str(args.get("kind", "lesson"))
    if not title:
        return {"ok": False, "error": "title is required"}
    brain_id = (ctx.agent.brain_id if ctx.agent else None)
    if not brain_id:
        return {"ok": False, "error": "agent has no brain assigned"}
    try:
        out = run_on_loop(brain_service.write(
            project_id=ctx.project_id, brain_id=brain_id, kind=kind, title=title, body=body,
            source={"task_id": ctx.task_id, "run_id": ctx.run_id, "agent_id": ctx.agent.id if ctx.agent else None},
            actor=ctx.agent, importance=float(args.get("importance", 0.5)),
        ))
        return {"ok": True, "data": {"entry_id": out["id"]}}
    except PermissionError as e:
        return {"ok": False, "error": f"policy_denied: {e}"}


def h_artifact_publish(ctx: ToolContext, args: dict) -> dict:
    name = Path(str(args.get("name", "artifact.txt"))).name
    source = args.get("source_path")
    if source is not None:
        if "content" in args:
            return {"ok": False, "error": "provide source_path or content, not both"}
        # Publishing a workspace file also requires current filesystem authority.
        # Re-enter the normal invoker so project policy and exact approvals apply.
        checked = invoker.invoke(ctx, "fs_read", {"path": source})
        if not checked.get("ok"):
            return checked
        data = _jailed(ctx, str(source)).read_bytes()
    else:
        if "content" not in args:
            return {"ok": False, "error": "content or source_path is required"}
        data = str(args["content"]).encode("utf-8")
    # A retry may replace a logical deliverable, but published evidence is immutable.
    root = (ctx.artifacts or (ctx.workspace or Path.cwd())) / (ctx.task_id or "task") / os.urandom(16).hex()
    root.mkdir(parents=True, exist_ok=True)
    p = root / name
    # Byte-exact write: text mode mangles \n to \r\n on Windows, and the recorded
    # sha256 must describe the bytes actually stored (downloads verify against it).
    p.write_bytes(data)
    import hashlib
    digest = hashlib.sha256(data).hexdigest()
    nbytes = len(data)
    run_on_loop(_record_artifact(ctx, name, p, nbytes, digest, source_path=str(source) if source is not None else None))
    return {"ok": True, "data": {"name": name, "path": str(p), "sha256": digest, "bytes": nbytes}}


async def _record_artifact(ctx: ToolContext, name: str, path: Path, size: int, digest: str,
                           source_path: str | None = None) -> None:
    from crew.core.db import session_scope
    from crew.core.models import Artifact

    attempt = 0
    if ctx.task_id:
        async with session_scope() as s:
            task_row = await s.get(Task, ctx.task_id)
            attempt = int(task_row.attempts or 0) if task_row else 0
    async with session_scope() as s:
        s.add(Artifact(project_id=ctx.project_id, task_id=ctx.task_id,
                       agent_id=ctx.agent.id if ctx.agent else None, kind="file", path=str(path),
                       bytes=size, sha256=digest, meta={"name": name, "attempt": attempt,
                           **({"source_path": source_path} if source_path is not None else {})}))
    await ev.emit("artifact.published", project_id=ctx.project_id, task_id=ctx.task_id,
                  agent_id=ctx.agent.id if ctx.agent else None, title=f"artifact: {name}",
                  run_id=ctx.run_id, payload={"name": name, "sha256": digest, "bytes": size,
                                            "source_path": source_path})


def h_ask_colleague(ctx: ToolContext, args: dict) -> dict:
    question = str(args.get("question", ""))[:2000]
    to = str(args.get("agent", "manager"))
    sent = run_on_loop(inbox.deliver(ctx.project_id, sender=ctx.agent, handle=to, text=question,
                                     task_id=ctx.task_id, run_id=ctx.run_id, kind="ask"))
    recipient = sent.get("to_agent")
    return {"ok": True, "data": {
        "delivered": recipient is not None,
        "to": recipient.name if recipient else to,
        "message_id": (sent.get("event") or {}).get("id"),
        "note": ("your question is in their inbox; they answer with reply_colleague and you will "
                 "see it before your next task") if recipient else "nobody matches that name right now",
        "join_hint": (f"they can join_task(task_id='{ctx.task_id}') to help you directly"
                      if recipient and ctx.task_id else None)}}


def h_escalate(ctx: ToolContext, args: dict) -> dict:
    reason = str(args.get("reason", ""))[:2000]

    async def _record() -> dict:
        """Escalating is a fact about the task, not just a ribbon on the floor.

        The tool used to emit and return, the API has served `escalated_to` all along
        and nothing ever wrote it. The reason and the manager it went to are persisted
        now, so the panel, the verifier and the failure ladder read one escalation
        (docs/17 batch 3).
        """
        target_id = ctx.agent.manager_id if ctx.agent else None
        if target_id is None:
            async with session_scope() as s:
                p = await s.get(Project, ctx.project_id)
                target_id = (p.settings or {}).get("orchestrator_id") if p else None
        if ctx.task_id:
            async with session_scope() as s:
                t = await s.get(Task, ctx.task_id)
                if t is not None:
                    if not t.escalation_reason or t.escalation_reason.startswith("retry"):
                        t.escalation_reason = f"escalated: {reason[:300]}"
                    t.escalated_to = target_id
                    s.add(t)
        await ev.emit("task.escalated", project_id=ctx.project_id, task_id=ctx.task_id,
                      agent_id=ctx.agent.id if ctx.agent else None, severity="warning",
                      title=f"escalation: {reason[:80]}",
                      payload={"task_id": ctx.task_id, "reason": reason,
                               "by": ctx.agent.id if ctx.agent else None,
                               "escalated_to": target_id},
                      actor=(f"agent:{ctx.agent.id}" if ctx.agent else "system"))
        return {"ok": True, "data": {"escalated": True, "escalated_to": target_id}}

    return run_on_loop(_record())


def h_request_decision(ctx: ToolContext, args: dict) -> dict:
    question = str(args.get("question", ""))[:1000]
    options = args.get("options") or []
    run_on_loop(ev.emit("council.requested", project_id=ctx.project_id, task_id=ctx.task_id,
                        agent_id=ctx.agent.id if ctx.agent else None, severity="notice",
                        title=f"decision requested: {question[:70]}",
                        payload={"question": question, "options": options}))
    return {"ok": True, "data": {"queued": True,
                                 "note": "the orchestrator will convene a council"}}


def h_report(ctx: ToolContext, args: dict) -> dict:
    text = str(args.get("text", ""))[:4000]
    run_on_loop(ev.emit("agent.message", project_id=ctx.project_id, task_id=ctx.task_id,
                        agent_id=ctx.agent.id if ctx.agent else None, title=f"report: {text[:70]}",
                        summary=text, payload={"direction": "up", "text": text}))
    return {"ok": True, "data": {"reported": True}}


def h_reply_colleague(ctx: ToolContext, args: dict) -> dict:
    text = str(args.get("text", ""))[:2000]
    to = str(args.get("agent", ""))
    if not text:
        return {"ok": False, "error": "text is required"}
    sent = run_on_loop(inbox.deliver(ctx.project_id, sender=ctx.agent, handle=to, text=text,
                                     task_id=ctx.task_id, run_id=ctx.run_id, kind="reply",
                                     reply_to=str(args.get("answer_to", "")) or None))
    return {"ok": True, "data": {"delivered": sent.get("to_agent") is not None}}


def h_delegate(ctx: ToolContext, args: dict) -> dict:
    brief = str(args.get("brief", ""))[:4000]
    to = str(args.get("agent", ""))
    if not brief or ctx.agent is None:
        return {"ok": False, "error": "brief and a sender are required"}

    async def _create() -> dict:
        target = await inbox.resolve_recipient(ctx.project_id, to, sender=ctx.agent)
        if target is None:
            return {"ok": False, "error": f"no such colleague: {to}"}
        async with session_scope() as s:
            t = Task(project_id=ctx.project_id, run_id=ctx.run_id, parent_id=ctx.task_id,
                     title=f"[delegated] {brief[:80]}", description=brief,
                     deliverable="A short written result the delegator can verify.",
                     acceptance_criteria=["The result addresses the brief"],
                     effort="S", state="assigned", assignee_agent_id=target.id,
                     assignee_squad_id=target.squad_id, department_id=target.department_id)
            s.add(t)
            await s.flush()
            tid = t.id
        await ev.emit("task.created", project_id=ctx.project_id, run_id=ctx.run_id, task_id=tid,
                      agent_id=target.id, title=f"delegated to {target.name}: {brief[:60]}",
                      payload={"task_id": tid, "title": f"[delegated] {brief[:80]}"},
                      actor=f"agent:{ctx.agent.id}")
        await ev.emit("agent.delegated", project_id=ctx.project_id, task_id=tid, run_id=ctx.run_id,
                      agent_id=ctx.agent.id, title=f"{ctx.agent.name} → {target.name}",
                      summary=brief[:200],
                      payload={"from_agent_id": ctx.agent.id, "to_agent_id": target.id,
                               "task_id": tid, "brief": brief[:400]},
                      actor=f"agent:{ctx.agent.id}")
        return {"ok": True, "data": {"delegated_to": target.name, "task_id": tid}}

    return run_on_loop(_create())


def h_report_bug(ctx: ToolContext, args: dict) -> dict:
    title = str(args.get("title", "")).strip()[:200]
    body = str(args.get("body", ""))[:2000]
    severity = str(args.get("severity", "normal")).lower()
    if not title:
        return {"ok": False, "error": "title is required"}
    if severity not in ("low", "normal", "high", "critical"):
        severity = "normal"

    async def _file() -> dict:
        # the bug lands on the board under the story being worked, READY, the next
        # wave's board pass brings it to the team that owns it (ADR 0010)
        parent = None
        if ctx.task_id:
            async with session_scope() as s:
                parent = await s.scalar(select(WorkItem.id).where(
                    WorkItem.project_id == ctx.project_id, WorkItem.task_id == ctx.task_id,
                    WorkItem.kind == "story").limit(1))
        item = await backlog.create_item(
            project_id=ctx.project_id, kind="bug", title=title, body=body,
            acceptance=["The reported problem is fixed and the fix is verified"],
            parent_id=parent,
            department_id=ctx.agent.department_id if ctx.agent else None,
            squad_id=ctx.agent.squad_id if ctx.agent else None,
            created_by=ctx.agent.id if ctx.agent else "system:agent", severity=severity,
            state="ready",
            source={"task_id": ctx.task_id,
                    "by_name": ctx.agent.name if ctx.agent else None})
        return {"ok": True, "data": {"item_id": item["id"], "state": "ready",
                                     "note": "on the board, ready, the next wave brings it to the team"}}

    return run_on_loop(_file())


def h_join_task(ctx: ToolContext, args: dict) -> dict:
    task_id = str(args.get("task_id", "")).strip()
    if not task_id or ctx.agent is None:
        return {"ok": False, "error": "task_id and a sender are required"}

    async def _join() -> dict:
        async with session_scope() as s:
            t = await s.get(Task, task_id)
            if t is None or t.project_id != ctx.project_id:
                return {"ok": False, "error": f"no such task: {task_id}"}
            if t.state in ("completed", "failed", "aborted"):
                return {"ok": False, "error": f"task already {t.state}"}
            if t.assignee_agent_id == ctx.agent.id:
                return {"ok": False, "error": "this is your own task"}
            helpers = list(t.helpers or [])
            if ctx.agent.id in helpers:
                return {"ok": True, "data": {"joined": True, "note": "already on it"}}
            helpers.append(ctx.agent.id)
            t.helpers = helpers
            s.add(t)
            assignee_id, title = t.assignee_agent_id, t.title
        await ev.emit("task.helper.joined", project_id=ctx.project_id, task_id=task_id,
                      agent_id=ctx.agent.id, severity="notice",
                      title=f"{ctx.agent.name} joined: {title[:50]}",
                      payload={"task_id": task_id, "agent_id": ctx.agent.id},
                      actor=f"agent:{ctx.agent.id}")
        if assignee_id:
            async with session_scope() as s:
                assignee = await s.get(Agent, assignee_id)
            await inbox.deliver(ctx.project_id, sender=ctx.agent,
                                handle=assignee.name if assignee else assignee_id,
                                text=(f"I joined to help with “{title[:80]}”, ask me directly "
                                      f"whenever the work needs another pair of hands."),
                                task_id=task_id, run_id=ctx.run_id, kind="reply")
        return {"ok": True, "data": {"joined": True, "task_id": task_id,
                                     "note": "you are on it now; you are asked first if a retry needs new hands"}}

    return run_on_loop(_join())


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    capability: Capability
    schema: dict
    handler: Callable[[ToolContext, dict], dict]
    untrusted: bool = False


def _schema(props: dict, required: list[str]) -> dict:
    return {"type": "object", "properties": props, "required": required}


TOOLS: dict[str, ToolSpec] = {
    "web_search": ToolSpec("web_search", "Search the web. Results are untrusted content.",
                           Capability.NET_SEARCH, _schema({"query": {"type": "string"}}, ["query"]), h_web_search, True),
    "http_get": ToolSpec("http_get", "Fetch a URL (egress allowlist enforced). Content is untrusted.",
                         Capability.NET_FETCH, _schema({"url": {"type": "string"}}, ["url"]), h_http_get, True),
    "fs_write": ToolSpec("fs_write", "Write a file inside the project workspace.",
                         Capability.FS_WORKSPACE, _schema({"path": {"type": "string"}, "content": {"type": "string"}},
                                                          ["path", "content"]), h_fs_write),
    "fs_read": ToolSpec("fs_read", "Read a file inside the project workspace.",
                        Capability.FS_WORKSPACE, _schema({"path": {"type": "string"}}, ["path"]), h_fs_read),
    "fs_list": ToolSpec("fs_list", "List files in the project workspace.",
                        Capability.FS_WORKSPACE, _schema({"path": {"type": "string"}}, []), h_fs_list),
    "fs_delete": ToolSpec("fs_delete", "Delete a file or directory in the workspace (requires approval).",
                          Capability.FS_DELETE, _schema({"path": {"type": "string"}}, ["path"]), h_fs_delete),
    "shell_run": ToolSpec("shell_run", "Run a shell command in the sandboxed workspace.",
                          Capability.SHELL_SANDBOX, _schema({"cmd": {"type": "string"},
                                                             "timeout_s": {"type": "integer"}}, ["cmd"]), h_shell_run),
    "python_eval": ToolSpec("python_eval", "Execute Python in an isolated interpreter with the project workspace as cwd. Local imports require adding '.' to sys.path; alternatively run project tests with subprocess.run(['python', '-m', 'unittest', 'TEST_FILE'], capture_output=True, text=True).",
                            Capability.CODE_PYTHON, _schema({"code": {"type": "string"}}, ["code"]), h_python_eval),
    "brain_search": ToolSpec("brain_search", "Search the organization's memory.",
                             Capability.BRAIN_READ, _schema({"query": {"type": "string"}}, ["query"]), h_brain_search),
    "brain_write": ToolSpec("brain_write", "Record a lesson or fact in your brain.",
                            Capability.BRAIN_WRITE, _schema({"title": {"type": "string"}, "body": {"type": "string"},
                                                             "kind": {"type": "string"}},
                                                            ["title", "body"]), h_brain_write),
    "artifact_publish": ToolSpec("artifact_publish", "Publish a deliverable. Prefer source_path for an existing workspace file; otherwise provide content. Supply one, not both.",
                                 Capability.ARTIFACT_PUBLISH, _schema({"name": {"type": "string"},
                                                                       "content": {"type": "string"},
                                                                       "source_path": {"type": "string"}},
                                                                      ["name"]), h_artifact_publish),
    "ask_colleague": ToolSpec("ask_colleague", "Ask another agent a question.",
                              Capability.COMMS_ASK, _schema({"agent": {"type": "string"},
                                                             "question": {"type": "string"}},
                                                            ["question"]), h_ask_colleague),
    "reply_colleague": ToolSpec("reply_colleague", "Answer a colleague's question (they see it before their next task).",
                                Capability.COMMS_ASK, _schema({"agent": {"type": "string"},
                                                               "text": {"type": "string"},
                                                               "answer_to": {"type": "string"}},
                                                              ["agent", "text"]), h_reply_colleague),
    "delegate_task": ToolSpec("delegate_task", "Hand a piece of work to a colleague as a real task.",
                              Capability.COMMS_ASK, _schema({"agent": {"type": "string"},
                                                             "brief": {"type": "string"}},
                                                            ["agent", "brief"]), h_delegate),
    "report_bug": ToolSpec("report_bug", "File a bug on the team's board (the next wave picks it up).",
                           Capability.BOARD_WRITE, _schema({"title": {"type": "string"},
                                                            "body": {"type": "string"},
                                                            "severity": {"type": "string"}},
                                                           ["title"]), h_report_bug),
    "join_task": ToolSpec("join_task", "Join a colleague's task as a helper so you finish it together.",
                          Capability.BOARD_WRITE, _schema({"task_id": {"type": "string"}},
                                                          ["task_id"]), h_join_task),
    "escalate": ToolSpec("escalate", "Escalate a blocker to your manager.",
                         Capability.COMMS_ESCALATE, _schema({"reason": {"type": "string"}}, ["reason"]), h_escalate),
    "request_decision": ToolSpec("request_decision", "Ask for a binding decision on a contested issue.",
                                 Capability.COMMS_REQUEST_DECISION,
                                 _schema({"question": {"type": "string"}, "options": {"type": "array"}},
                                         ["question"]), h_request_decision),
    "report_to_head": ToolSpec("report_to_head", "Report status upward.",
                               Capability.COMMS_ESCALATE, _schema({"text": {"type": "string"}}, ["text"]), h_report),
}


def tools_for_agent(agent: Agent | None) -> list[str]:
    if agent is None:
        return []
    granted = set(agent.tools or [])
    return [name for name, spec in TOOLS.items() if spec.capability.value in granted]


class ToolInvoker:
    """The single choke point for tool side effects."""

    def __init__(self):
        self._guard = threading.Lock()
        self._workspace_locks: dict[str, threading.RLock] = {}

    def invoke(self, ctx: ToolContext, name: str, args: dict) -> dict:
        # A sandbox command can create symlinks. Serialize it with file-tool calls
        # so another agent cannot swap a checked path while a read/write is pending.
        key = ctx.project_id
        with self._guard:
            lock = self._workspace_locks.setdefault(key, threading.RLock())
        if not lock.acquire(timeout=150):
            return {"ok": False, "error": "workspace busy; retry later"}
        try:
            return self._invoke(ctx, name, args)
        finally:
            lock.release()

    def _invoke(self, ctx: ToolContext, name: str, args: dict) -> dict:
        spec = TOOLS.get(name)
        if spec is None:
            return {"ok": False, "error": f"unknown tool: {name}"}
        try:
            run_on_loop(self._refresh_authority(ctx))
        except (PermissionError, KeyError) as exc:
            self._denied(ctx, name, spec.capability, str(exc))
            return {"ok": False, "error": "policy_denied", "detail": str(exc)}
        if ctx.agent is not None and spec.capability.value not in set(ctx.agent.tools or []):
            decision_reason = f"{spec.capability.value} not granted"
            self._denied(ctx, name, spec.capability, decision_reason)
            return {"ok": False, "error": "policy_denied", "detail": decision_reason}

        decision = policy.check(agent=ctx.agent, capability=spec.capability, project=ctx.project)
        if (decision.outcome == PolicyOutcome.ALLOW and decision.reason.startswith("yolo")
                and (spec.capability in ALWAYS_APPROVAL or spec.capability in SUPERVISED_FORBIDDEN)):
            _yolo_audit(ctx, tool=name, capability=spec.capability.value)
        if decision.outcome == PolicyOutcome.DENY:
            self._denied(ctx, name, spec.capability, decision.reason)
            return {"ok": False, "error": "policy_denied", "detail": decision.reason}
        if decision.outcome == PolicyOutcome.REQUIRE_APPROVAL:
            invocation = {"tool": name, "args": args, "run_id": ctx.run_id}
            # A human's standing approval ("Always allow") covers this agent +
            # capability until revoked. The hard gates (net_post / fs_delete /
            # git_push) deliberately keep asking every time.
            standing = None
            if spec.capability not in ALWAYS_APPROVAL:
                standing = run_on_loop(standing_allow_hit(ctx.project_id,
                                                          capability=spec.capability.value,
                                                          agent_id=ctx.agent.id if ctx.agent else None))
            # The gate opens when a decision is ALREADY on file. Without this half the
            # human's "granted" was recorded and then ignored: the retried call was denied
            # forever and the approval queue was theatre (docs/17 batch 1).
            if standing:
                run_on_loop(ev.emit("policy.approval.used", project_id=ctx.project_id, task_id=ctx.task_id,
                                    agent_id=ctx.agent.id if ctx.agent else None, severity="notice",
                                    title=f"standing approval: {spec.capability.value}",
                                    payload={"capability": spec.capability.value, "tool": name,
                                             "allow_id": standing}))
            elif run_on_loop(approval_granted(ctx.project_id,
                                              agent_id=ctx.agent.id if ctx.agent else None,
                                              capability=spec.capability.value, task_id=ctx.task_id,
                                              invocation=invocation)):
                run_on_loop(ev.emit("policy.approval.used", project_id=ctx.project_id, task_id=ctx.task_id,
                                    agent_id=ctx.agent.id if ctx.agent else None, severity="notice",
                                    title=f"approval on file: {spec.capability.value}",
                                    payload={"capability": spec.capability.value, "tool": name}))
            else:
                approval_id = run_on_loop(request_approval(
                    ctx.project_id, capability=spec.capability.value,
                    agent_id=ctx.agent.id if ctx.agent else None, task_id=ctx.task_id,
                    request={"tool": name, "args": redactor.clean(args),
                             "invocation_hash": invocation_hash(invocation), "use": "once", "run_id": ctx.run_id},
                ))
                run_on_loop(ev.emit("policy.approval.requested", project_id=ctx.project_id, task_id=ctx.task_id,
                                    agent_id=ctx.agent.id if ctx.agent else None, severity="warning",
                                    title=f"approval needed: {spec.capability.value}",
                                    payload={"capability": spec.capability.value, "tool": name,
                                             "approval_id": approval_id}))
                return {"ok": False, "error": "approval_required", "detail": decision.reason,
                        "approval_id": approval_id}

        run_on_loop(ev.emit("agent.tool.call", project_id=ctx.project_id, task_id=ctx.task_id,
                            run_id=ctx.run_id, agent_id=ctx.agent.id if ctx.agent else None,
                            trace_id=ctx.trace_id, title=f"tool: {name}",
                            payload={"tool": name, "args": {k: str(v)[:400] for k, v in args.items()}},
                            actor=ctx.actor))
        try:
            from crew.execution import lifecycle

            token = lifecycle.current_run.set(ctx.run_id)
            try:
                lifecycle.check_cancelled()
                result = spec.handler(ctx, args)
            finally:
                lifecycle.current_run.reset(token)
        except Exception as e:  # a tool must never kill the run
            log.exception("tool %s failed", name)
            result = {"ok": False, "error": f"{type(e).__name__}: {e}"}
        text = json.dumps(result, default=str)
        clean, redactions = redactor.redact(text)
        if redactions:
            run_on_loop(ev.emit("security.secret.redaction", project_id=ctx.project_id,
                                severity="warning", title=f"{redactions} secret(s) redacted from {name} output",
                                payload={"tool": name, "count": redactions}))
        receipt = {}
        if name in ("shell_run", "python_eval"):
            receipt = {"execution": json.loads(clean).get("data", {}), "invocation": redactor.clean(args),
                       "invocation_hash": invocation_hash({"tool": name, "args": args, "run_id": ctx.run_id})}
        run_on_loop(ev.emit("agent.tool.result", project_id=ctx.project_id, task_id=ctx.task_id,
                            run_id=ctx.run_id, agent_id=ctx.agent.id if ctx.agent else None,
                            trace_id=ctx.trace_id, title=f"tool result: {name}",
                            summary=clean[:400],
                            payload={"tool": name, "ok": bool(result.get("ok")),
                                     "untrusted": bool(spec.untrusted or result.get("untrusted")), **receipt},
                            severity="info" if result.get("ok") else "warning", actor=ctx.actor))
        return json.loads(clean)

    @staticmethod
    async def _refresh_authority(ctx: ToolContext) -> None:
        """Worker snapshots cannot grant authority after an operator changes policy."""
        async with session_scope() as s:
            project = await s.get(Project, ctx.project_id)
            if project is None:
                raise PermissionError("project no longer exists")
            if project.status != "active":
                raise PermissionError("project is not active")
            agent = await s.get(Agent, ctx.agent.id) if ctx.agent is not None else None
            if agent is None or agent.project_id != project.id or agent.archived_at is not None:
                raise PermissionError("agent is not active in this project")
            run = await s.get(Run, ctx.run_id) if ctx.run_id else None
            if run is None or run.project_id != project.id or run.status != "running":
                raise PermissionError("run is not active in this project")
            task = await s.get(Task, ctx.task_id) if ctx.task_id else None
            if (task is None or task.project_id != project.id or task.run_id != run.id
                    or task.state in ("aborted", "completed", "failed")):
                raise PermissionError("task is not active in this run")
            others = (await s.scalars(select(Project).where(Project.id != project.id, Project.kind == "project"))).all()
            await asyncio.to_thread(ToolInvoker._bind_paths, ctx, project, others)
            ctx.project, ctx.agent = project, agent

    @staticmethod
    def _bind_paths(ctx, project, others):
        from crew.control.workspaces import resolve_workspace

        workspace = resolve_workspace(project).resolve()
        if ctx.workspace is not None and ctx.workspace.resolve() != workspace:
            raise PermissionError("workspace does not match the project's recorded path")
        artifacts = settings.artifacts_dir(project.id).resolve()
        if ctx.artifacts is not None and ctx.artifacts.resolve() != artifacts:
            raise PermissionError("artifact directory does not match this project")
        # Legacy name-based allocations can overlap. Refuse access until an
        # operator separates them; never silently move or merge user files.
        for other in others:
            raw = (other.settings or {}).get("workspace")
            other_path = Path(raw).resolve() if raw else settings.workspace_dir(other.id).resolve()
            if workspace.is_relative_to(other_path) or other_path.is_relative_to(workspace):
                raise PermissionError("workspace overlaps another project; separate the recorded paths before running")
        ctx.workspace, ctx.artifacts = workspace, artifacts

    @staticmethod
    def _denied(ctx: ToolContext, name: str, cap: Capability, reason: str) -> None:
        run_on_loop(ev.emit("policy.denied", project_id=ctx.project_id, task_id=ctx.task_id,
                            agent_id=ctx.agent.id if ctx.agent else None, severity="warning",
                            title=f"denied {name}", summary=reason,
                            payload={"capability": cap.value, "tool": name, "reason": reason}))


invoker = ToolInvoker()


_PY_TYPES: dict[str, type] = {"string": str, "integer": int, "number": float,
                              "array": list, "boolean": bool, "object": dict}


def build_crewai_tools(ctx: ToolContext) -> list[Any]:
    """Wrap the agent's granted capabilities as CrewAI tools."""
    from crewai.tools import BaseTool
    from pydantic import create_model

    out: list[Any] = []
    for name in tools_for_agent(ctx.agent):
        spec = TOOLS[name]
        required = set(spec.schema.get("required", []))
        fields = {prop: ((_PY_TYPES.get(cfg.get("type", "string"), str), ...) if prop in required else
                         (_PY_TYPES.get(cfg.get("type", "string"), str) | None, None))
                  for prop, cfg in spec.schema.get("properties", {}).items()}
        args_model = create_model(f"{name}_args", **fields)

        def _make(spec_name: str, schema_cls: type, desc: str, tool_name: str) -> Any:
            class _Tool(BaseTool):  # type: ignore[misc]
                # the class attributes must not shadow the closure names they read,
                # `description: str = description` is a NameError raised at build time
                # (found by mutation-testing the never-called build path)
                name: str = tool_name
                description: str = desc
                args_schema: type = schema_cls

                def _run(self, **kwargs: Any) -> str:
                    result = invoker.invoke(ctx, spec_name, {k: v for k, v in kwargs.items() if v is not None})
                    if result.get("error") == "approval_required" and result.get("approval_id"):
                        ctx.extra["pending_approval"] = result["approval_id"]
                    return json.dumps(result, default=str)

            return _Tool()

        out.append(_make(name, args_model, spec.description, spec.name))
    return out
