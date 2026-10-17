"""Security & governance primitives: policy engine, credential vault, budget guard,
audit hash chain, injection detection (docs/08)."""

from __future__ import annotations

import hashlib
import json
import re
import secrets
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

from cryptography.fernet import Fernet
from sqlalchemy import desc, func, or_, select, update

from crew.core import events as ev
from crew.core.db import session_scope
from crew.core.models import (
    Agent,
    Approval,
    AuditLog,
    BudgetLedger,
    Department,
    Event,
    Project,
    Run,
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

# conservative injection heuristics: a signal, never the only defence (docs/08 §6)
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
    (r"<!--[^>]{0,600}\b(ignore|instruction|system prompt|you are)\b[^>]{0,600}-->", "hidden-html-instructions"),
    (r"eval\s*\(\s*(atob|unescape|decodeURIComponent)", "js-obfuscation"),
    (r"(enter|provide|send|share|paste)\s+(your\s+)?(password|api[-_ ]?key|secret|token|credit card)", "credential-bait"),
    (r"(download|install|run|execute)\s+[^.\n]{0,60}\.(exe|scr|bat|cmd|ps1|msi)\b", "download-and-run"),
    (r"(this is|i am|message from)\s+(your|the)\s+(ceo|boss|administrator|admin|it department)", "fake-authority"),
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

        # Full autonomy (ADR 0018): the project turned the human gates off. Ceilings and
        # explicit denies above still bind; the invoker audits every call this skips.
        if project is not None and bool(project.setting("yolo", False)):
            return PolicyDecision(PolicyOutcome.ALLOW, "yolo: human gates are off", cap.value)

        # Then the gates that a human can lift.
        if cap.value in set(policy.get("require_approval", [])) or cap in ALWAYS_APPROVAL:
            return PolicyDecision(PolicyOutcome.REQUIRE_APPROVAL, f"{cap.value} requires human approval", cap.value)
        if agent.autonomy == Autonomy.SUPERVISED and cap in SUPERVISED_FORBIDDEN:
            return PolicyDecision(
                PolicyOutcome.REQUIRE_APPROVAL,
                f"supervised agent needs approval for {cap.value}",
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
        for v in sorted(self._values, key=len, reverse=True):
            if v in out:
                count += out.count(v)
                out = out.replace(v, "[REDACTED]")
        return out, count

    def clean(self, value):
        if isinstance(value, str):
            return self.redact(value)[0]
        if isinstance(value, dict):
            return {self.redact(str(k))[0]: self.clean(v) for k, v in value.items()}
        if isinstance(value, (list, tuple)):
            return [self.clean(v) for v in value]
        return value


redactor = SecretRedactor()
for _key in (settings.deepseek_api_key, settings.openai_api_key, settings.anthropic_api_key,
             settings.gemini_api_key, settings.openrouter_api_key, settings.jwt_secret, settings.vault_key):
    redactor.learn(_key)


class CredentialVault:
    """AES-based secret storage with a lease model: values are injected at call time and
    never enter an agent's context (docs/08 §3)."""

    def __init__(self, key: str | None = None) -> None:
        raw = (key or settings.vault_key).encode()
        try:
            self._fernet = Fernet(raw)
        except ValueError as exc:
            raise ValueError("CREW_VAULT_KEY must be a generated Fernet key; arbitrary passwords are not supported") from exc

    async def create(self, name: str, value: str, *, scope_kind: str = "project",
                     scope_id: str = "", actor: str = "user") -> str:
        aad = f"{name}:{scope_kind}:{scope_id}".encode()
        ct = self._fernet.encrypt(value.encode()).decode()
        digest = hashlib.sha256(ct.encode()).hexdigest()  # integrity over the stored blob
        async with session_scope() as s:
            existing = await s.scalar(select(Secret).where(Secret.name == name))
            if existing:
                if (existing.scope_kind, existing.scope_id) != (scope_kind, scope_id):
                    raise ValueError(
                        f"a secret named {name!r} already exists in scope "
                        f"{existing.scope_kind}/{existing.scope_id or '-'}; it is never silently "
                        f"re-scoped or overwritten, pick another name or rotate it in place")
                existing.ciphertext, existing.sha256, existing.aad = ct, digest, aad.decode()
                existing.rotated_at = datetime.now(UTC)
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
            redactor.learn(value)
            if use:
                row.last_used_at = datetime.now(UTC)
                s.add(SecretLease(secret_id=row.id, agent_id=agent_id, capability=capability,
                                  expires_at=datetime.now(UTC) + timedelta(minutes=5)))
                lease_id: str | None = row.id
            else:
                lease_id = None
        if lease_id is not None:
            # docs/08 §9: every secret lease is on the record, not only in the mutable
            # events table, the audit chain is the evidence trail for releases.
            await audit(actor_kind="agent", actor_id=agent_id or "", action="secret.leased",
                        resource_kind="secret", resource_id=lease_id,
                        reason=capability or "inject")
        return value

    async def list_handles(self) -> list[dict]:
        async with session_scope() as s:
            rows = (await s.scalars(select(Secret))).all()
        return [{"id": r.id, "name": r.name, "scope_kind": r.scope_kind, "scope_id": r.scope_id,
                 "sha256_prefix": (r.sha256 or "")[:12], "rotated_at": r.rotated_at.isoformat() if r.rotated_at else None}
                for r in rows]

    async def load_all_into_redactor(self) -> int:
        """Boot-time re-teach (docs/08 §3): the redactor is process memory, so after a
        restart every stored value must be re-learned or the event/log sinks silently
        stop masking it."""
        n = 0
        async with session_scope() as s:
            rows = (await s.scalars(select(Secret))).all()
        for r in rows:
            try:
                redactor.learn(self._fernet.decrypt(r.ciphertext.encode()).decode())
                n += 1
            except Exception:  # one corrupt row must not stop boot
                continue
        return n

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
                               department_id: str | None = None, run_id: str | None = None) -> int:
        async with session_scope() as s:
            return await self._available(s, project_id, agent_id, department_id, run_id)

    async def envelope_available(self, project_id: str) -> int:
        """Project plus company headroom only. The circuit breaker guards THIS envelope:
        an agent's daily/run cap or a department envelope must fail that job (docs/08 §8:
        "the job fails with a typed BudgetExceeded"), never pause the whole project."""
        async with session_scope() as s:
            return await self._envelope_available(s, project_id)

    @staticmethod
    async def _envelope_available(s, project_id: str) -> int:
        p = await s.get(Project, project_id)
        if p is None or p.status != "active":
            return 0
        avail = p.budget_cap_micros - p.spend_micros - p.reserved_micros
        if p.company_id:
            company = await s.get(Project, p.company_id)
            if company is None or company.status != "active":
                return 0
            avail = min(avail, company.budget_cap_micros - company.spend_micros - company.reserved_micros)
        return max(0, avail)

    async def recover_reservations(self) -> int:
        """Startup only: interrupted requests may have billed, so charge held estimates.

        Never release unknown usage as free credit or retry it automatically. Settlement
        keys make this safe if recovery itself is interrupted and restarted.
        """
        async with session_scope() as s:
            rows = (await s.scalars(select(BudgetLedger).where(
                BudgetLedger.kind.in_(["reserve", "release"]))
                .order_by(BudgetLedger.ts, BudgetLedger.id))).all()
        held = {}
        for row in rows:
            key = (row.project_id, row.scope_kind, row.scope_id, row.ref)
            held[key] = held.get(key, 0) + row.amount_micros * (1 if row.kind == "reserve" else -1)
        # Older recovery versions released a whole scope under one generic ref.
        # Match those releases to the oldest held operations, never charge them twice.
        legacy_releases = {key[:3]: -amount for key, amount in held.items()
                           if key[3] == "startup-recovery" and amount < 0}
        for key, amount in held.items():
            released = legacy_releases.get(key[:3], 0)
            if amount > 0 and released:
                matched = min(amount, released)
                held[key] -= matched
                legacy_releases[key[:3]] -= matched
        count = 0
        for (project_id, kind, scope_id, ref), amount in held.items():
            if amount <= 0:
                continue
            await self.settle(project_id, reserved_micros=amount, actual_micros=amount,
                              scope_kind=kind, scope_id=scope_id, ref=ref,
                              idempotency_key=f"recovery:{uuid_hint()}", _recovering=True)
            count += 1
        return count

    async def _available(self, s, project_id: str, agent_id: str | None, department_id: str | None,
                         run_id: str | None = None) -> int:
        p = await s.get(Project, project_id)
        if p is None or p.status != "active":
            return 0
        avail = p.budget_cap_micros - p.spend_micros - p.reserved_micros
        if p.company_id:
            company = await s.get(Project, p.company_id)
            if company is None or company.status != "active":
                return 0
            avail = min(avail, company.budget_cap_micros - company.spend_micros - company.reserved_micros)
        a = await s.get(Agent, agent_id) if agent_id else None
        if agent_id and (a is None or a.project_id != project_id):
            return 0
        if a:
            department_id = a.department_id
            start = datetime.now(UTC).replace(hour=0, minute=0, second=0, microsecond=0)
            spent = await s.scalar(select(func.coalesce(func.sum(BudgetLedger.amount_micros), 0)).where(
                BudgetLedger.project_id == project_id, BudgetLedger.scope_kind == "agent",
                BudgetLedger.scope_id == a.id, BudgetLedger.kind == "settle", BudgetLedger.ts >= start))
            held = await self._held(s, project_id, [a.id])
            avail = min(avail, a.spend_cap_per_day_micros - int(spent or 0) - held)
            if run_id:
                # New operation refs bind settlements (including crash recovery)
                # to their run. Legacy model events identify earlier plain refs.
                legacy_refs = select(Event.payload["call_id"].as_string()).where(
                    Event.project_id == project_id, Event.agent_id == a.id, Event.run_id == run_id,
                    Event.type == "llm.response")
                run_spent = await s.scalar(select(func.coalesce(func.sum(BudgetLedger.amount_micros), 0)).where(
                    BudgetLedger.project_id == project_id, BudgetLedger.scope_kind == "agent",
                    BudgetLedger.scope_id == a.id, BudgetLedger.kind == "settle", or_(
                        BudgetLedger.ref.startswith(f"run:{run_id}:", autoescape=True),
                        BudgetLedger.ref.in_(legacy_refs))))
                avail = min(avail, a.spend_cap_per_run_micros - int(run_spent or 0) - held)
        if department_id:
            d = await s.get(Department, department_id)
            if d is None or d.project_id != project_id:
                return 0
            if d.budget_envelope_micros:
                ids = list((await s.scalars(select(Agent.id).where(Agent.department_id == d.id))).all())
                held = await self._held(s, project_id, [d.id, *ids])
                avail = min(avail, d.budget_envelope_micros - d.spend_micros - held)
        return max(0, avail)

    @staticmethod
    async def _held(s, project_id: str, scope_ids: list[str]) -> int:
        rows = (await s.scalars(select(BudgetLedger).where(BudgetLedger.project_id == project_id,
                                                         BudgetLedger.scope_id.in_(scope_ids)))).all()
        return max(0, sum(r.amount_micros * (1 if r.kind == "reserve" else -1 if r.kind == "release" else 0)
                          for r in rows))

    @staticmethod
    async def _duplicate(s, key: str | None, project_id: str, scope_kind: str,
                         scope_id: str, kind: str, amount: int, ref: str, note: str = "") -> bool:
        if not key:
            return False
        row = await s.scalar(select(BudgetLedger).where(BudgetLedger.idempotency_key == key))
        if row is None:
            return False
        if (row.project_id, row.scope_kind, row.scope_id, row.kind, row.amount_micros, row.ref, row.note) != (
                project_id, scope_kind, scope_id, kind, amount, ref, note):
            raise ValueError("idempotency key was already used for a different budget operation")
        return True

    @staticmethod
    async def _held_operation(s, project_id, scope_kind, scope_id, ref):
        query = select(BudgetLedger).where(BudgetLedger.project_id == project_id,
            BudgetLedger.scope_kind == scope_kind, BudgetLedger.scope_id == scope_id,
            BudgetLedger.kind.in_(["reserve", "release"]))
        if ref is not None:
            query = query.where(BudgetLedger.ref == ref)
        rows = (await s.scalars(query)).all()
        return sum(r.amount_micros * (1 if r.kind == "reserve" else -1) for r in rows)

    @staticmethod
    async def _validate_scope(s, project_id, scope_kind, scope_id):
        if scope_kind == "project" and scope_id == project_id:
            return
        model = {"agent": Agent, "department": Department}.get(scope_kind)
        row = await s.get(model, scope_id) if model else None
        if row is None or row.project_id != project_id:
            raise ValueError("budget scope does not belong to this project")

    @staticmethod
    def _entry(s, project_id, scope_kind, scope_id, kind, amount, ref, key=None, note=""):
        s.add(BudgetLedger(project_id=project_id, scope_kind=scope_kind, scope_id=scope_id,
                           kind=kind, amount_micros=amount, ref=ref, note=note,
                           idempotency_key=key or f"{kind}:{uuid_hint()}"))

    async def reserve(self, project_id: str, *, amount_micros: int, scope_kind: str, scope_id: str,
                      ref: str = "", idempotency_key: str | None = None, run_id: str | None = None) -> None:
        if amount_micros < 0:
            raise ValueError("reservation cannot be negative")
        async with session_scope(write_lock=True) as s:
            await self._validate_scope(s, project_id, scope_kind, scope_id)
            if await self._duplicate(s, idempotency_key, project_id, scope_kind, scope_id, "reserve", amount_micros, ref):
                return
            available = await self._available(s, project_id, scope_id if scope_kind == "agent" else None,
                                              scope_id if scope_kind == "department" else None, run_id)
            if self.breaker_open(project_id):
                raise BudgetExceeded(scope_kind, scope_id, amount_micros, available)
            if amount_micros > available:
                # Only an exhausted PROJECT or COMPANY envelope stops the project. A scope
                # refusal (agent cap, department envelope) fails this job and leaves the run
                # to its other agents: latching here paused a run whose envelope was half
                # full (16 October) and no wave could heal it without a resume.
                if await self._envelope_available(s, project_id) <= 0:
                    self.open_breaker(project_id)
                raise BudgetExceeded(scope_kind, scope_id, amount_micros, available)
            p = await s.get(Project, project_id)
            if p is None or p.status != "active":
                raise BudgetExceeded(scope_kind, scope_id, amount_micros, 0)
            p.reserved_micros += amount_micros
            if p.company_id:
                company = await s.get(Project, p.company_id)
                company.reserved_micros += amount_micros
            self._entry(s, project_id, scope_kind, scope_id, "reserve", amount_micros, ref, idempotency_key)

    async def settle(self, project_id: str, *, reserved_micros: int, actual_micros: int,
                     scope_kind: str, scope_id: str, ref: str = "",
                     idempotency_key: str | None = None, _recovering: bool = False) -> None:
        if min(reserved_micros, actual_micros) < 0:
            raise ValueError("settlement cannot be negative")
        async with session_scope(write_lock=True) as s:
            await self._validate_scope(s, project_id, scope_kind, scope_id)
            note = f"reserved_micros={reserved_micros}"
            if await self._duplicate(s, idempotency_key, project_id, scope_kind, scope_id, "settle", actual_micros, ref, note):
                return
            held = await self._held_operation(s, project_id, scope_kind, scope_id, None if _recovering else ref)
            if held < reserved_micros:
                raise ValueError("settlement exceeds this operation's held reservation")
            p = await s.get(Project, project_id)
            if p is None or p.reserved_micros < reserved_micros:
                raise ValueError("settlement exceeds held reservation")
            p.reserved_micros = max(0, p.reserved_micros - reserved_micros)
            p.spend_micros += actual_micros
            if p.company_id:
                company = await s.get(Project, p.company_id)
                company.reserved_micros = max(0, company.reserved_micros - reserved_micros)
                company.spend_micros += actual_micros
            if scope_kind == "department" and scope_id:
                d = await s.get(Department, scope_id)
                if d:
                    d.spend_micros += actual_micros
                    s.add(d)
            if scope_kind == "agent" and scope_id:
                a = await s.get(Agent, scope_id)
                if a:
                    start = datetime.now(UTC).replace(hour=0, minute=0, second=0, microsecond=0)
                    today = await s.scalar(select(func.coalesce(func.sum(BudgetLedger.amount_micros), 0)).where(
                        BudgetLedger.project_id == project_id, BudgetLedger.scope_kind == "agent",
                        BudgetLedger.scope_id == scope_id, BudgetLedger.kind == "settle", BudgetLedger.ts >= start))
                    a.spend_today_micros = int(today or 0) + actual_micros
                    if a.department_id:
                        department = await s.get(Department, a.department_id)
                        if department:
                            department.spend_micros += actual_micros
            self._entry(s, project_id, scope_kind, scope_id, "release", reserved_micros, ref)
            self._entry(s, project_id, scope_kind, scope_id, "settle", actual_micros, ref, idempotency_key, note)

    async def release(self, project_id: str, *, amount_micros: int, scope_kind: str, scope_id: str,
                      ref: str = "", idempotency_key: str | None = None) -> None:
        if amount_micros < 0:
            raise ValueError("release cannot be negative")
        async with session_scope(write_lock=True) as s:
            await self._validate_scope(s, project_id, scope_kind, scope_id)
            if await self._duplicate(s, idempotency_key, project_id, scope_kind, scope_id, "release", amount_micros, ref):
                return
            if await self._held_operation(s, project_id, scope_kind, scope_id, ref) < amount_micros:
                raise ValueError("release exceeds this operation's held reservation")
            p = await s.get(Project, project_id)
            if p is None or p.reserved_micros < amount_micros:
                raise ValueError("release exceeds held reservation")
            p.reserved_micros = max(0, p.reserved_micros - amount_micros)
            if p.company_id:
                company = await s.get(Project, p.company_id)
                company.reserved_micros = max(0, company.reserved_micros - amount_micros)
            self._entry(s, project_id, scope_kind, scope_id, "release", amount_micros, ref, idempotency_key)

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
            project_ids = [project_id]
            if p is not None and p.kind == "company":
                project_ids.extend(await s.scalars(select(Project.id).where(Project.company_id == project_id)))
            settled = await s.scalar(
                select(func.coalesce(func.sum(BudgetLedger.amount_micros), 0)).where(
                    BudgetLedger.project_id.in_(project_ids),
                    BudgetLedger.kind == "settle",
                )
            )
            reserved = await s.scalar(
                select(func.coalesce(func.sum(BudgetLedger.amount_micros), 0)).where(
                    BudgetLedger.project_id.in_(project_ids),
                    BudgetLedger.kind == "reserve",
                )
            )
            released = await s.scalar(
                select(func.coalesce(func.sum(BudgetLedger.amount_micros), 0)).where(
                    BudgetLedger.project_id.in_(project_ids),
                    BudgetLedger.kind == "release",
                )
            )
        spend = p.spend_micros if p else 0
        held = int(reserved or 0) - int(released or 0)
        return {"project_id": project_id, "ledger_settle_micros": int(settled or 0),
                "ledger_reserved_micros": int(reserved or 0),
                "ledger_released_micros": int(released or 0),
                "spend_micros": spend, "reserved_micros": p.reserved_micros if p else 0,
                "ledger_held_micros": held,
                "ok": p is not None and int(settled or 0) == spend and held == p.reserved_micros}


def uuid_hint() -> str:
    return secrets.token_hex(6)


budget = BudgetGuard()


# ── audit chain ──────────────────────────────────────────────────────────────────────
def _canonical(entry: dict) -> str:
    return json.dumps(entry, sort_keys=True, separators=(",", ":"), default=str)


async def audit(*, actor_kind: str, actor_id: str, action: str, resource_kind: str = "",
                resource_id: str = "", outcome: str = "ok", reason: str = "",
                trace_id: str = "", project_id: str | None = None) -> str:
    reason = redactor.redact(reason)[0]
    async with session_scope(write_lock=True) as s:
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
        if project_id:
            # Rows bound to a project carry it (and hash it); pre-column rows hash unchanged.
            body["project_id"] = project_id
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
        if r.project_id:
            body["project_id"] = r.project_id
        if r.prev_hash != prev_hash:
            return {"ok": False, "broken_at": r.seq, "reason": "prev_hash mismatch"}
        want = hashlib.sha256((_canonical(body) + prev_hash).encode()).hexdigest()
        if want != r.hash:
            return {"ok": False, "broken_at": r.seq, "reason": "hash mismatch"}
        prev_hash = r.hash
    return {"ok": True, "entries": len(rows)}


# ── approvals ────────────────────────────────────────────────────────────────────────
async def standing_allow_hit(project_id: str, *, capability: str, agent_id: str | None) -> str | None:
    """The owner's standing tool approval: a human chose "Always allow" for this
    agent + capability, so the gate skips asking until the entry is revoked."""
    from crew.core.models import CapabilityAllow

    async with session_scope() as s:
        q = select(CapabilityAllow).where(
            CapabilityAllow.project_id == project_id,
            CapabilityAllow.capability == capability,
            CapabilityAllow.revoked_at.is_(None))
        if agent_id is None:
            q = q.where(CapabilityAllow.agent_id.is_(None))
        else:
            q = q.where((CapabilityAllow.agent_id == agent_id) | (CapabilityAllow.agent_id.is_(None)))
        row = (await s.scalars(q.limit(1))).first()
    return row.id if row else None


async def allow_capability(project_id: str, *, capability: str, agent_id: str | None, note: str,
                           decided_by: str, source_approval_id: str | None = None) -> str:
    """Write a standing approval for one agent + capability. Only a human grant calls
    this; agents can request approvals but never write here themselves."""
    from crew.core.models import CapabilityAllow

    async with session_scope() as s:
        row = CapabilityAllow(project_id=project_id, capability=capability, agent_id=agent_id,
                              note=note, created_by=decided_by, source_approval_id=source_approval_id)
        s.add(row)
        await s.flush()
        aid = row.id
    await audit(actor_kind="user", actor_id=decided_by, action="security.allow.added",
                resource_kind="capability_allow", resource_id=aid, reason=capability)
    await ev.emit("security.capability_allow.added", project_id=project_id, severity="notice",
                  title=f"standing approval added: {capability}",
                  payload={"capability": capability, "allow_id": aid}, actor=decided_by)
    return aid


async def revoke_capability_allow(allow_id: str, *, decided_by: str, reason: str = "") -> bool:
    from crew.core.models import CapabilityAllow

    async with session_scope() as s:
        row = await s.get(CapabilityAllow, allow_id)
        if row is None or row.revoked_at is not None:
            return False
        row.revoked_at = datetime.now(UTC)
        row.revoke_reason = reason
        s.add(row)
        project_id, capability, agent_id = row.project_id, row.capability, row.agent_id
    await audit(actor_kind="user", actor_id=decided_by, action="security.allow.removed",
                resource_kind="capability_allow", resource_id=allow_id, reason=reason or capability)
    await ev.emit("security.capability_allow.removed", project_id=project_id, severity="notice",
                  title=f"standing approval revoked: {capability}",
                  payload={"capability": capability, "allow_id": allow_id, "agent_id": agent_id},
                  actor=decided_by)
    return True


async def list_capability_allows(project_id: str, include_revoked: bool = False) -> list[dict]:
    from crew.core.models import CapabilityAllow

    async with session_scope() as s:
        q = select(CapabilityAllow).where(CapabilityAllow.project_id == project_id)
        if not include_revoked:
            q = q.where(CapabilityAllow.revoked_at.is_(None))
        rows = (await s.scalars(q.order_by(desc(CapabilityAllow.created_at)).limit(200))).all()
    return [{"id": r.id, "capability": r.capability, "agent_id": r.agent_id, "note": r.note,
             "created_by": r.created_by, "created_at": ev.utc_iso(r.created_at),
             "revoked_at": ev.utc_iso(r.revoked_at) if r.revoked_at else None,
             "revoke_reason": r.revoke_reason} for r in rows]


async def request_approval(project_id: str, *, capability: str, agent_id: str | None,
                           task_id: str | None, request: dict, ttl_minutes: int = 120) -> str:
    request = redactor.clean(request)
    async with session_scope(write_lock=True) as s:
        pending = (await s.scalars(select(Approval).where(
            Approval.project_id == project_id, Approval.agent_id == agent_id,
            Approval.task_id == task_id, Approval.capability == capability,
            Approval.state == "pending", Approval.expires_at > datetime.now(UTC)))).all()
        for existing in pending:
            if existing.request == request:
                return existing.id
        row = Approval(project_id=project_id, capability=capability, agent_id=agent_id, task_id=task_id,
                       request=request, expires_at=datetime.now(UTC) + timedelta(minutes=ttl_minutes))
        s.add(row)
        await s.flush()
        aid = row.id
    await audit(actor_kind="agent", actor_id=agent_id or "", action="approval.requested",
                resource_kind="approval", resource_id=aid, outcome="pending", reason=capability,
                project_id=project_id)
    return aid


async def decide_approval(approval_id: str, *, grant: bool, decided_by: str, reason: str = "",
                          ttl_minutes: int | None = None) -> Approval | None:
    async with session_scope(write_lock=True) as s:
        row = await s.get(Approval, approval_id)
        if not row or row.state != "pending":
            return None
        if row.expires_at and row.expires_at.replace(tzinfo=UTC) <= datetime.now(UTC):
            row.state = "expired"
            return None
        row.state = "granted" if grant else "denied"
        row.decided_by, row.decided_at, row.reason = decided_by, datetime.now(UTC), reason
        if grant and ttl_minutes is not None:
            # The human's chosen window is the window in force (clamped 1 min – 24 h).
            row.expires_at = datetime.now(UTC) + timedelta(minutes=max(1, min(1440, int(ttl_minutes))))
        s.add(row)
    await audit(actor_kind="user", actor_id=decided_by,
                action="approval.granted" if grant else "approval.denied",
                resource_kind="approval", resource_id=approval_id, reason=reason,
                project_id=row.project_id)
    return row


async def expire_inactive_approvals(*, run_id: str | None = None) -> int:
    """Close stale requests without touching valid permissions for active/paused work."""
    terminal = select(Run.id).where(Run.status.in_(["completed", "failed", "aborted"]))
    stmt = update(Approval).where(Approval.state.in_(["pending", "granted"]), or_(
        Approval.expires_at <= datetime.now(UTC), Approval.request["run_id"].as_string().in_(terminal)))
    if run_id is not None:
        stmt = stmt.where(Approval.request["run_id"].as_string() == run_id)
    async with session_scope(write_lock=True) as s:
        result = await s.execute(stmt.values(state="expired"))
        return result.rowcount


async def approval_granted(project_id: str, *, agent_id: str | None, capability: str,
                           task_id: str | None, invocation: dict | None = None) -> bool:
    """Is there a GRANTED approval that covers this call?

    `policy.check` will keep answering "requires human approval", that is correct; what
    was missing is the other half: nothing ever CONSUMED a grant, so approving a request
    was recorded and then ignored, and the retried call was denied forever. A grant
    covers one agent and one capability, scoped to the task it was requested for, or to
    the agent's general scope when it was requested without a task (task_id NULL).
    """
    async with session_scope(write_lock=invocation is not None) as s:
        q = select(Approval).where(Approval.project_id == project_id,
                                   Approval.capability == capability,
                                   Approval.state == "granted",
                                   or_(Approval.expires_at.is_(None), Approval.expires_at > datetime.now(UTC)))
        if agent_id is not None:
            q = q.where(Approval.agent_id == agent_id)
        rows = (await s.scalars(q.order_by(Approval.decided_at.desc()).limit(20))).all()
        for row in rows:
            if row.task_id not in (None, task_id):
                continue
            if invocation is not None:
                if (row.request or {}).get("invocation_hash") != invocation_hash(invocation):
                    continue
                row.state = "consumed"
            return True
    return False


def invocation_hash(invocation: dict) -> str:
    return hashlib.sha256(_canonical(invocation).encode()).hexdigest()


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
