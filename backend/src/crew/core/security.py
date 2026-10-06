"""Security & governance primitives: policy engine, credential vault, budget guard,
audit hash chain, injection detection (docs/08)."""

from __future__ import annotations

import base64
import hashlib
import json
import re
import secrets
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

from cryptography.fernet import Fernet
from sqlalchemy import func, select

from crew.core.db import session_scope
from crew.core.models import (
    Agent,
    Approval,
    AuditLog,
    BudgetLedger,
    Department,
    Project,
    Secret,
    SecretLease,
    usd_to_micros,
)
from crew.core.settings import settings
from crew.domain.catalog import ALWAYS_APPROVAL, GRADE_CAPABILITY_CEILING
from crew.domain.enums import Autonomy, Capability, Grade, PolicyOutcome


# ── policy engine ────────────────────────────────────────────────────────────────────
@dataclass
class PolicyDecision:
    outcome: PolicyOutcome
    reason: str = ""
    capability: str = ""

    @property
    def allowed(self) -> bool:
        return self.outcome == PolicyOutcome.ALLOW


# Capabilities a supervised agent may never exercise, whatever its role says.
SUPERVISED_FORBIDDEN: set[Capability] = {
    Capability.SHELL_SANDBOX, Capability.CODE_PYTHON, Capability.GIT_PUSH,
    Capability.NET_POST, Capability.ORG_FIRE, Capability.DECISION_BIND,
}

# Baseline egress allowlist (docs/08 §7). Project settings can extend, never replace the
# private-IP block which lives in the proxy.
BASELINE_EGRESS: tuple[str, ...] = (
    "api.deepseek.com", "api.openai.com", "api.anthropic.com", "generativelanguage.googleapis.com",
    "openrouter.ai", "duckduckgo.com", "html.duckduckgo.com", "google.com", "wikipedia.org",
    "github.com", "raw.githubusercontent.com", "pypi.org", "files.pythonhosted.org",
    "registry.npmjs.org", "arxiv.org", "stackoverflow.com", "localhost:11434",
)

PRIVATE_HOST_RE = re.compile(
    r"^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\]|fc|fd|fe80)",
    re.IGNORECASE,
)

# conservative injection heuristics — a signal, never the only defence (docs/08 §6)
INJECTION_PATTERNS: tuple[tuple[str, str], ...] = (
    (r"ignore (all )?(previous|prior|above) (instructions|prompts)", "override-instructions"),
    (r"disregard (your|the) (system|previous) (prompt|instructions)", "override-instructions"),
    (r"you are now (a|an|the)\b", "role-switch"),
    (r"(new|updated) instructions?\s*:", "instruction-injection"),
    (r"system\s*:\s*you", "fake-system-role"),
    (r"<\s*/?(system|assistant|tool)\s*>", "fake-role-tag"),
    (r"send (the )?(api[_-]?key|token|secret|password)", "credential-exfil"),
    (r"(reveal|print|repeat) (your )?(system prompt|instructions)", "prompt-exfil"),
    (r"execute (this )?(command|code|script)", "command-injection"),
    (r"base64[,:]\s*[A-Za-z0-9+/]{40,}", "encoded-payload"),
    (r"[\u200b-\u200f\u202a-\u202e\ufeff]", "invisible-unicode"),
)


def scan_injection(text: str) -> list[str]:
    hits = []
    low = text or ""
    for pattern, label in INJECTION_PATTERNS:
        if re.search(pattern, low, re.IGNORECASE):
            hits.append(label)
    return hits


class PolicyEngine:
    """Authoritative capability decisions. Prompts never decide what is allowed."""

    def check(
        self,
        *,
        agent: Agent | None,
        capability: Capability | str,
        project: Project | None = None,
        tool_policy: dict | None = None,
        context: dict | None = None,
    ) -> PolicyDecision:
        cap = Capability(capability)
        context = context or {}

        if project is not None and project.status == "paused" and cap != Capability.HUMAN_APPROVE:
            return PolicyDecision(PolicyOutcome.DENY, "project is paused", cap.value)

        if agent is None:
            return PolicyDecision(PolicyOutcome.DENY, "no actor", cap.value)

        policy = tool_policy if tool_policy is not None else (project.setting("tool_policy", {}) if project else {})
        if policy.get("deny_all"):
            return PolicyDecision(PolicyOutcome.DENY, "project denies all tool use", cap.value)
        if cap.value in set(policy.get("deny", [])):
            return PolicyDecision(PolicyOutcome.DENY, f"{cap.value} disabled for this project", cap.value)

        # Hard capability ceiling first: a grade simply cannot hold a capability, approval or not.
        grade = Grade(min(max(int(agent.grade), 0), 5))
        if cap not in GRADE_CAPABILITY_CEILING[grade]:
            return PolicyDecision(
                PolicyOutcome.DENY, f"grade {grade.label} may not use {cap.value}", cap.value
            )
        if agent.tools and cap.value not in set(agent.tools):
            return PolicyDecision(PolicyOutcome.DENY, f"{cap.value} not granted to this agent", cap.value)

        # Then the gates that a human can lift.
        if cap.value in set(policy.get("require_approval", [])) or cap in ALWAYS_APPROVAL:
            return PolicyDecision(PolicyOutcome.REQUIRE_APPROVAL, f"{cap.value} requires human approval", cap.value)
        if agent.autonomy == Autonomy.SUPERVISED and cap in SUPERVISED_FORBIDDEN:
            return PolicyDecision(
                PolicyOutcome.REQUIRE_APPROVAL,
                f"supervised agent needs approval for {cap.value}",
                cap.value,
            )
        if context.get("cost_usd") and float(context["cost_usd"]) > settings.require_approval_above_usd:
            return PolicyDecision(
                PolicyOutcome.REQUIRE_APPROVAL,
                f"costs ${context['cost_usd']:.2f} > approval threshold ${settings.require_approval_above_usd:.2f}",
                cap.value,
            )
        return PolicyDecision(PolicyOutcome.ALLOW, "", cap.value)

    def allowed_egress(self, project: Project | None) -> list[str]:
        extra = (project.setting("egress_allow", []) if project else []) or []
        return list(dict.fromkeys([*BASELINE_EGRESS, *settings.egress_extra, *extra]))

    def check_egress(self, host: str, project: Project | None) -> PolicyDecision:
        host = (host or "").strip().lower()
        if not host:
            return PolicyDecision(PolicyOutcome.DENY, "empty host")
        if PRIVATE_HOST_RE.match(host):
            return PolicyDecision(PolicyOutcome.DENY, f"private/reserved address blocked: {host}")
        allowed = self.allowed_egress(project)
        for a in allowed:
            a = a.lower()
            if host == a or host.endswith("." + a) or (a.startswith("*.") and host.endswith(a[1:])):
                return PolicyDecision(PolicyOutcome.ALLOW, "", "net.fetch")
        return PolicyDecision(PolicyOutcome.DENY, f"{host} is not on the egress allowlist")


policy = PolicyEngine()


# ── credential vault ─────────────────────────────────────────────────────────────────
class SecretRedactor:
    """Removes known secret values from anything that could be shown or logged."""

    def __init__(self) -> None:
        self._values: set[str] = set()

    def learn(self, value: str) -> None:
        if value and len(value) >= 8:
            self._values.add(value)

    def redact(self, text: str) -> tuple[str, int]:
        if not text:
            return text, 0
        count = 0
        out = text
        for v in list(self._values):
            if v in out:
                count += out.count(v)
                out = out.replace(v, "[REDACTED]")
        return out, count


redactor = SecretRedactor()


class CredentialVault:
    """AES-based secret storage with a lease model: values are injected at call time and
    never enter an agent's context (docs/08 §3)."""

    def __init__(self, key: str | None = None) -> None:
        raw = (key or settings.vault_key).encode()
        try:
            self._fernet = Fernet(raw)
        except Exception:
            self._fernet = Fernet(base64.urlsafe_b64encode(hashlib.sha256(raw).digest()))

    async def create(self, name: str, value: str, *, scope_kind: str = "project",
                     scope_id: str = "", actor: str = "user") -> str:
        aad = f"{name}:{scope_kind}:{scope_id}".encode()
        ct = self._fernet.encrypt(value.encode()).decode()
        digest = hashlib.sha256(value.encode()).hexdigest()
        async with session_scope() as s:
            existing = await s.scalar(select(Secret).where(Secret.name == name))
            if existing:
                existing.ciphertext, existing.sha256, existing.rotated_at = ct, digest, datetime.now(UTC)
                sid = existing.id
            else:
                row = Secret(name=name, scope_kind=scope_kind, scope_id=scope_id, ciphertext=ct,
                             nonce="fernet", aad=aad.decode(), sha256=digest)
                s.add(row)
                await s.flush()
                sid = row.id
        redactor.learn(value)
        await audit(actor_kind="user", actor_id=actor, action="secret.created",
                    resource_kind="secret", resource_id=sid, reason=f"name={name}")
        return sid

    async def reveal(self, name_or_id: str, *, agent_id: str | None = None, capability: str = "",
                     use: bool = False) -> str | None:
        """Read a secret value. Only the ToolInvoker may call this, to inject into an
        outbound call. Never surfaced to an agent."""
        async with session_scope() as s:
            row = await s.scalar(select(Secret).where((Secret.name == name_or_id) | (Secret.id == name_or_id)))
            if not row:
                return None
            value = self._fernet.decrypt(row.ciphertext.encode()).decode()
            if use:
                row.last_used_at = datetime.now(UTC)
                s.add(SecretLease(secret_id=row.id, agent_id=agent_id, capability=capability,
                                  expires_at=datetime.now(UTC) + timedelta(minutes=5)))
        return value

    async def list_handles(self) -> list[dict]:
        async with session_scope() as s:
            rows = (await s.scalars(select(Secret))).all()
        return [{"id": r.id, "name": r.name, "scope_kind": r.scope_kind, "scope_id": r.scope_id,
                 "sha256_prefix": (r.sha256 or "")[:12], "rotated_at": r.rotated_at.isoformat() if r.rotated_at else None}
                for r in rows]

    def import_env_secret(self, name: str, value: str) -> None:
        """Register an env-provided secret with the redactor without storing it."""
        redactor.learn(value)


vault = CredentialVault()


# ── budget guard ─────────────────────────────────────────────────────────────────────
class BudgetExceeded(RuntimeError):
    def __init__(self, scope_kind: str, scope_id: str, needed_micros: int, available_micros: int):
        self.scope_kind, self.scope_id = scope_kind, scope_id
        self.needed_micros, self.available_micros = needed_micros, available_micros
        super().__init__(
            f"budget exceeded at {scope_kind}:{scope_id}: needs ${needed_micros/1e6:.4f}, "
            f"available ${available_micros/1e6:.4f}"
        )


class BudgetGuard:
    """Pre-flight reservation against project + department + agent caps (docs/08 §8)."""

    def __init__(self) -> None:
        self._breaker_open: set[str] = set()

    def breaker_open(self, project_id: str) -> bool:
        return project_id in self._breaker_open

    def open_breaker(self, project_id: str) -> None:
        self._breaker_open.add(project_id)

    def close_breaker(self, project_id: str) -> None:
        self._breaker_open.discard(project_id)

    async def available_micros(self, project_id: str, *, agent_id: str | None = None,
                               department_id: str | None = None) -> int:
        async with session_scope() as s:
            p = await s.get(Project, project_id)
            if p is None:
                return 0
            avail = p.budget_cap_micros - p.spend_micros - p.reserved_micros
            if department_id:
                d = await s.get(Department, department_id)
                if d and d.budget_envelope_micros:
                    avail = min(avail, d.budget_envelope_micros - d.spend_micros)
            if agent_id:
                a = await s.get(Agent, agent_id)
                if a:
                    avail = min(avail, a.spend_cap_per_day_micros - a.spend_today_micros)
            return max(0, avail)

    async def reserve(self, project_id: str, *, amount_micros: int, scope_kind: str, scope_id: str,
                      ref: str = "", idempotency_key: str | None = None) -> None:
        if self.breaker_open(project_id):
            raise BudgetExceeded(scope_kind, scope_id, amount_micros, 0)
        available = await self.available_micros(
            project_id,
            agent_id=scope_id if scope_kind == "agent" else None,
            department_id=scope_id if scope_kind == "department" else None,
        )
        if amount_micros > available:
            self.open_breaker(project_id)
            await self._ledger(project_id, scope_kind, scope_id, "reserve", 0, ref,
                               note="refused: insufficient budget", idem=idempotency_key)
            raise BudgetExceeded(scope_kind, scope_id, amount_micros, available)
        async with session_scope() as s:
            p = await s.get(Project, project_id)
            p.reserved_micros += amount_micros
            s.add(p)
        await self._ledger(project_id, scope_kind, scope_id, "reserve", amount_micros, ref, idem=idempotency_key)

    async def settle(self, project_id: str, *, reserved_micros: int, actual_micros: int,
                     scope_kind: str, scope_id: str, ref: str = "",
                     idempotency_key: str | None = None) -> None:
        async with session_scope() as s:
            p = await s.get(Project, project_id)
            p.reserved_micros = max(0, p.reserved_micros - reserved_micros)
            p.spend_micros += actual_micros
            s.add(p)
            if scope_kind == "department" and scope_id:
                d = await s.get(Department, scope_id)
                if d:
                    d.spend_micros += actual_micros
                    s.add(d)
            if scope_kind == "agent" and scope_id:
                a = await s.get(Agent, scope_id)
                if a:
                    a.spend_today_micros += actual_micros
                    s.add(a)
        await self._ledger(project_id, scope_kind, scope_id, "settle", actual_micros, ref, idem=idempotency_key)

    async def release(self, project_id: str, *, amount_micros: int, scope_kind: str, scope_id: str,
                      ref: str = "", idempotency_key: str | None = None) -> None:
        async with session_scope() as s:
            p = await s.get(Project, project_id)
            p.reserved_micros = max(0, p.reserved_micros - amount_micros)
            s.add(p)
        await self._ledger(project_id, scope_kind, scope_id, "release", amount_micros, ref, idem=idempotency_key)

    async def _ledger(self, project_id: str, scope_kind: str, scope_id: str, kind: str,
                      amount_micros: int, ref: str, note: str = "",
                      idem: str | None = None) -> None:
        key = idem or f"{kind}:{scope_kind}:{scope_id}:{ref}:{uuid_hint()}"
        async with session_scope() as s:
            s.add(BudgetLedger(project_id=project_id, scope_kind=scope_kind, scope_id=scope_id,
                               kind=kind, amount_micros=amount_micros, ref=ref, note=note,
                               idempotency_key=key))

    async def reconcile(self, project_id: str) -> dict:
        """Ledger must agree with the project's spend counter (docs/10 §3.5).

        Every settlement charges the project exactly once, whatever scope it was attributed to,
        so project spend must equal the sum of all `settle` rows.
        """
        async with session_scope() as s:
            p = await s.get(Project, project_id)
            settled = await s.scalar(
                select(func.coalesce(func.sum(BudgetLedger.amount_micros), 0)).where(
                    BudgetLedger.project_id == project_id,
                    BudgetLedger.kind == "settle",
                )
            )
            reserved = await s.scalar(
                select(func.coalesce(func.sum(BudgetLedger.amount_micros), 0)).where(
                    BudgetLedger.project_id == project_id,
                    BudgetLedger.kind == "reserve",
                )
            )
            released = await s.scalar(
                select(func.coalesce(func.sum(BudgetLedger.amount_micros), 0)).where(
                    BudgetLedger.project_id == project_id,
                    BudgetLedger.kind == "release",
                )
            )
        spend = p.spend_micros if p else 0
        return {"project_id": project_id, "ledger_settle_micros": int(settled or 0),
                "ledger_reserved_micros": int(reserved or 0),
                "ledger_released_micros": int(released or 0),
                "spend_micros": spend, "ok": int(settled or 0) == spend}


def uuid_hint() -> str:
    return secrets.token_hex(6)


budget = BudgetGuard()


# ── audit chain ──────────────────────────────────────────────────────────────────────
def _canonical(entry: dict) -> str:
    return json.dumps(entry, sort_keys=True, separators=(",", ":"), default=str)


async def audit(*, actor_kind: str, actor_id: str, action: str, resource_kind: str = "",
                resource_id: str = "", outcome: str = "ok", reason: str = "",
                trace_id: str = "") -> str:
    async with session_scope() as s:
        prev = await s.scalar(select(AuditLog).order_by(AuditLog.seq.desc()).limit(1))
        seq = (prev.seq + 1) if prev else 1
        prev_hash = prev.hash if prev else "genesis"
        ts = datetime.now(UTC)
        body = {
            "seq": seq, "ts": _iso(ts), "actor_kind": actor_kind,
            "actor_id": actor_id, "action": action, "resource_kind": resource_kind,
            "resource_id": resource_id, "outcome": outcome, "reason": reason,
            "prev_hash": prev_hash, "trace_id": trace_id,
        }
        digest = hashlib.sha256((_canonical(body) + prev_hash).encode()).hexdigest()
        row = {k: v for k, v in body.items() if k != "ts"}
        s.add(AuditLog(**row, ts=ts, hash=digest))
    return digest


def _iso(dt: datetime) -> str:
    """Canonical ISO form used in the hash chain (SQLite drops tzinfo on the way in)."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC).isoformat()


async def verify_audit_chain() -> dict:
    async with session_scope() as s:
        rows = (await s.scalars(select(AuditLog).order_by(AuditLog.seq))).all()
    prev_hash = "genesis"
    for r in rows:
        body = {
            "seq": r.seq, "ts": _iso(r.ts), "actor_kind": r.actor_kind, "actor_id": r.actor_id,
            "action": r.action, "resource_kind": r.resource_kind, "resource_id": r.resource_id,
            "outcome": r.outcome, "reason": r.reason, "prev_hash": prev_hash, "trace_id": r.trace_id,
        }
        if r.prev_hash != prev_hash:
            return {"ok": False, "broken_at": r.seq, "reason": "prev_hash mismatch"}
        want = hashlib.sha256((_canonical(body) + prev_hash).encode()).hexdigest()
        if want != r.hash:
            return {"ok": False, "broken_at": r.seq, "reason": "hash mismatch"}
        prev_hash = r.hash
    return {"ok": True, "entries": len(rows)}


# ── approvals ────────────────────────────────────────────────────────────────────────
async def request_approval(project_id: str, *, capability: str, agent_id: str | None,
                           task_id: str | None, request: dict, ttl_minutes: int = 120) -> str:
    async with session_scope() as s:
        row = Approval(project_id=project_id, capability=capability, agent_id=agent_id, task_id=task_id,
                       request=request, expires_at=datetime.now(UTC) + timedelta(minutes=ttl_minutes))
        s.add(row)
        await s.flush()
        aid = row.id
    await audit(actor_kind="agent", actor_id=agent_id or "", action="approval.requested",
                resource_kind="approval", resource_id=aid, outcome="pending", reason=capability)
    return aid


async def decide_approval(approval_id: str, *, grant: bool, decided_by: str, reason: str = "") -> Approval | None:
    async with session_scope() as s:
        row = await s.get(Approval, approval_id)
        if not row or row.state != "pending":
            return None
        row.state = "granted" if grant else "denied"
        row.decided_by, row.decided_at, row.reason = decided_by, datetime.now(UTC), reason
        s.add(row)
    await audit(actor_kind="user", actor_id=decided_by, action="approval.granted" if grant else "approval.denied",
                resource_kind="approval", resource_id=approval_id, reason=reason)
    return row


async def ensure_default_caps(project: Project) -> None:
    """Guard: a project can never be given a cap above the configured hard ceiling."""
    if project.budget_cap_micros > usd_to_micros(settings.hard_budget_usd):
        project.budget_cap_micros = usd_to_micros(settings.hard_budget_usd)


def approvals_required_for(capability: str) -> bool:
    try:
        return Capability(capability) in ALWAYS_APPROVAL
    except ValueError:
        return False


@dataclass
class InjectionReport:
    labels: list[str] = field(default_factory=list)

    @property
    def suspicious(self) -> bool:
        return bool(self.labels)
