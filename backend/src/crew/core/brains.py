"""Four-level memory: company / project / department / agent brains (docs/06, ADR 0015).

The company brain is the umbrella: it lives on the company's own row, review and
allocation decisions land in it, and every member project's agents retrieve from it —
so a directive written once is available across the whole portfolio.

MVP retrieval is lexical (token overlap) + recency + importance + trust, which keeps the
system dependency-free; the scoring function lives in one place so a vector index can be
dropped in behind it (docs/06 §5) without touching callers.
"""

from __future__ import annotations

import math
import re
from datetime import UTC, datetime

from sqlalchemy import select

from crew.core import events as ev
from crew.core.db import session_scope
from crew.core.models import Agent, Brain, BrainEntry, BrainLink, Department, Project
from crew.domain.enums import BrainKind, BrainScope, Trust

WORD_RE = re.compile(r"[a-zA-Z0-9_\-]{3,}")

TRUST_PENALTY = {Trust.INTERNAL: 0.0, Trust.VERIFIED: 0.0, Trust.UNVERIFIED: 0.05, Trust.UNTRUSTED_EXTERNAL: 0.15}
TOP_K_DEFAULT = {"agent": 8, "lead": 12, "head": 12, "orchestrator": 20, "default": 8}


def _tokens(text: str) -> set[str]:
    return {w.lower() for w in WORD_RE.findall(text or "")}


def score_entry(entry: BrainEntry, query_tokens: set[str], now: datetime | None = None) -> tuple[float, dict]:
    """Retrieval score as documented in docs/06 §2 (hybrid, explainable)."""
    now = now or datetime.now(UTC)
    body_tokens = _tokens(f"{entry.title} {entry.body}")
    overlap = len(query_tokens & body_tokens)
    similarity = overlap / max(1, len(query_tokens)) if query_tokens else 0.0

    created = entry.created_at or now
    if created.tzinfo is None:
        created = created.replace(tzinfo=UTC)
    age_days = max(0.0, (now - created).total_seconds() / 86400)
    recency = math.exp(-age_days / 14.0)             # half-life ~10 days

    importance = float(entry.importance or 0.5)
    usage = min(1.0, (entry.use_count or 0) / 10.0)
    penalty = TRUST_PENALTY.get(Trust(entry.trust), 0.1)

    total = 0.55 * similarity + 0.25 * recency + 0.15 * importance + 0.05 * usage - penalty
    return round(total, 4), {
        "similarity": round(similarity, 4), "recency": round(recency, 4),
        "importance": importance, "usage": round(usage, 4), "trust_penalty": penalty,
    }


class BrainService:
    # ── scopes ────────────────────────────────────────────────────────────────────
    async def ensure_brain(self, project_id: str, scope: BrainScope, owner_id: str, label: str = "") -> str:
        async with session_scope() as s:
            row = await s.scalar(select(Brain).where(Brain.project_id == project_id, Brain.scope == scope.value,
                                                     Brain.owner_id == owner_id))
            if row:
                return row.id
            b = Brain(project_id=project_id, scope=scope.value, owner_id=owner_id, label=label)
            s.add(b)
            await s.flush()
            return b.id

    async def ensure_project_brain(self, project_id: str, label: str = "project") -> str:
        return await self.ensure_brain(project_id, BrainScope.PROJECT, project_id, label)

    async def ensure_company_brain(self, company_id: str, label: str = "company") -> str:
        """The umbrella memory (ADR 0015). Companies created before the company scope
        existed kept their memory in a project-scope brain on the same row — flip it
        rather than strand the entries."""
        async with session_scope() as s:
            row = await s.scalar(select(Brain).where(Brain.project_id == company_id,
                                                     Brain.scope == BrainScope.COMPANY.value))
            if row:
                return row.id
            legacy = await s.scalar(select(Brain).where(Brain.project_id == company_id,
                                                        Brain.scope == BrainScope.PROJECT.value))
            if legacy:
                legacy.scope = BrainScope.COMPANY.value
                legacy.label = label
                s.add(legacy)
                return legacy.id
            b = Brain(project_id=company_id, scope=BrainScope.COMPANY.value,
                      owner_id=company_id, label=label)
            s.add(b)
            await s.flush()
            return b.id

    async def list_brains(self, project_id: str) -> list[dict]:
        from sqlalchemy import func

        async with session_scope() as s:
            brains = (await s.scalars(select(Brain).where(Brain.project_id == project_id))).all()
            rows = (await s.execute(
                select(BrainEntry.brain_id, func.count(BrainEntry.id)).where(
                    BrainEntry.project_id == project_id).group_by(BrainEntry.brain_id)
            )).all()
            counts = {bid: int(n) for bid, n in rows}
            # Resolve owner names (ADR 0015): the four levels get human labels —
            # "department · 3fa2c1" is a database, "Design" is an org.
            proj = await s.get(Project, project_id)
            dept_names = {d.id: d.name for d in (await s.scalars(
                select(Department).where(Department.project_id == project_id))).all()}
            agent_names = {a.id: a.name for a in (await s.scalars(
                select(Agent).where(Agent.project_id == project_id))).all()}
        out = []
        for b in brains:
            if b.scope in (BrainScope.COMPANY.value, BrainScope.PROJECT.value):
                owner_name = proj.name if proj is not None else ""
            elif b.scope == BrainScope.DEPARTMENT.value:
                owner_name = dept_names.get(b.owner_id, "")
            else:
                owner_name = agent_names.get(b.owner_id, "")
            out.append({"id": b.id, "scope": b.scope, "owner_id": b.owner_id, "label": b.label,
                        "owner_name": owner_name,
                        "entries": counts.get(b.id, 0), "created_at": b.created_at.isoformat()})
        return out

    # ── read/write rights ─────────────────────────────────────────────────────────
    @staticmethod
    def can_write(actor: Agent | None, brain: Brain) -> tuple[bool, str]:
        if actor is None:
            return True, "system"
        if brain.scope == BrainScope.AGENT.value:
            return (actor.brain_id == brain.id), "agent brain is private"
        if brain.scope == BrainScope.COMPANY.value:
            # The umbrella memory belongs to the company's own row: its officers
            # (CEO / board chair) write policy and directives; a member project's
            # orchestrator only READS it (ADR 0015).
            if actor.project_id == brain.project_id and actor.role in ("ceo", "chair"):
                return True, ""
            return False, "only the company's CEO/chair may write to the company brain"
        if brain.scope == BrainScope.DEPARTMENT.value:
            if actor.role in ("head", "lead") and actor.department_id == brain.owner_id:
                return True, ""
            if actor.role in ("orchestrator", "librarian"):
                return True, ""
            return False, "only a department head/lead (or orchestrator) may write here"
        # project brain
        if actor.role in ("orchestrator", "librarian", "decider"):
            return True, ""
        return False, "only the orchestrator/librarian may write to the project brain"

    @staticmethod
    def can_read(actor: Agent | None, brain: Brain) -> tuple[bool, str]:
        if actor is None:
            return True, "system"
        if brain.scope == BrainScope.AGENT.value:
            return (actor.brain_id == brain.id), "agent brain is private"
        if brain.scope == BrainScope.DEPARTMENT.value:
            if actor.department_id == brain.owner_id:
                return True, ""
            return (actor.role in ("orchestrator", "decider", "librarian", "critic", "evaluator")), "cross-department read denied"
        return True, ""

    # ── writes ────────────────────────────────────────────────────────────────────
    async def write(
        self, *, project_id: str, brain_id: str, kind: BrainKind | str, title: str, body: str,
        source: dict | None = None, actor: Agent | None = None, trust: Trust | str = Trust.INTERNAL,
        importance: float = 0.5, tags: list[str] | None = None, skill_ids: list[str] | None = None,
        payload: dict | None = None,
    ) -> dict:
        async with session_scope() as s:
            brain = await s.get(Brain, brain_id)
            if brain is None or brain.project_id != project_id:
                raise PermissionError("brain not found in this project")
            ok, why = self.can_write(actor, brain)
            if not ok:
                raise PermissionError(f"cannot write to brain: {why}")
            entry = BrainEntry(
                project_id=project_id, brain_id=brain_id, kind=str(kind), title=title[:300], body=body,
                payload=payload or {}, source=source or {}, trust=str(trust), importance=importance,
                tags=tags or [], skill_ids=skill_ids or [], created_by=actor.id if actor else "system",
            )
            s.add(entry)
            await s.flush()
            out = self._serialize(entry)
        await ev.emit("brain.written", project_id=project_id, agent_id=actor.id if actor else None,
                      title=f"memory: {title[:80]}", payload={"brain_id": brain_id, "entry_id": out["id"],
                                                              "kind": str(kind)}, actor=f"agent:{actor.id}" if actor else "system")
        return out

    async def promote(self, *, project_id: str, entry_id: str, to_brain_id: str, actor: Agent | None,
                      rationale: str = "") -> dict:
        async with session_scope() as s:
            entry = await s.get(BrainEntry, entry_id)
            target = await s.get(Brain, to_brain_id)
            if entry is None or target is None or entry.project_id != project_id:
                raise PermissionError("entry or target brain not found")
            ok, why = self.can_write(actor, target)
            if not ok:
                raise PermissionError(f"cannot promote into {target.scope} brain: {why}")
            promoted = BrainEntry(
                project_id=project_id, brain_id=to_brain_id, kind=entry.kind, title=entry.title,
                body=entry.body, payload={**(entry.payload or {}), "promoted_from": entry.id},
                source={**(entry.source or {}), "promoted_from_brain": entry.brain_id,
                        "rationale": rationale, "promoted_at": datetime.now(UTC).isoformat()},
                trust=entry.trust, importance=min(1.0, entry.importance + 0.1), tags=entry.tags,
                skill_ids=entry.skill_ids, created_by=actor.id if actor else "system",
            )
            s.add(promoted)
            await s.flush()
            s.add(BrainLink(project_id=project_id, from_entry_id=entry.id, to_entry_id=promoted.id,
                            relation="promoted_to"))
            out = self._serialize(promoted)
        await ev.emit("brain.promoted", project_id=project_id, severity="notice",
                      title=f"insight promoted: {entry.title[:70]}", summary=rationale,
                      payload={"entry_id": entry_id, "new_entry_id": out["id"], "to_brain_id": to_brain_id})
        return out

    async def supersede(self, *, project_id: str, old_id: str, new_id: str, reason: str = "") -> None:
        async with session_scope() as s:
            old = await s.get(BrainEntry, old_id)
            new = await s.get(BrainEntry, new_id)
            if not old or not new:
                return
            old.superseded_by = new_id
            s.add(old)
            s.add(BrainLink(project_id=project_id, from_entry_id=new_id, to_entry_id=old_id, relation="supersedes"))
        await ev.emit("brain.superseded", project_id=project_id, severity="notice",
                      title=f"memory superseded: {old.title[:70]}", summary=reason,
                      payload={"old_entry_id": old_id, "new_entry_id": new_id})

    # ── reads ─────────────────────────────────────────────────────────────────────
    async def search(self, *, project_id: str, brain_ids: list[str] | None, query: str, top_k: int = 8,
                     kinds: list[str] | None = None, record_use: bool = True) -> list[dict]:
        """Retrieval scoped by BRAIN, not by row: the company brain's entries live on the
        company's row (ADR 0015), so a member's agents must still find them — the brain
        list handed in IS the scope."""
        qtok = _tokens(query)
        async with session_scope() as s:
            stmt = select(BrainEntry).where(BrainEntry.superseded_by.is_(None),
                                            BrainEntry.archived_at.is_(None))
            if brain_ids:
                stmt = stmt.where(BrainEntry.brain_id.in_(brain_ids))
            else:
                stmt = stmt.where(BrainEntry.project_id == project_id)
            if kinds:
                stmt = stmt.where(BrainEntry.kind.in_(kinds))
            rows = (await s.scalars(stmt.limit(500))).all()
            scored = []
            for r in rows:
                total, parts = score_entry(r, qtok)
                if not qtok or total > 0.05:
                    scored.append((total, parts, r))
            scored.sort(key=lambda t: t[0], reverse=True)
            top = scored[:top_k]
            if record_use:
                for _, _, r in top:
                    r.use_count += 1
                    r.last_used_at = datetime.now(UTC)
                    s.add(r)
            return [{**self._serialize(r), "score": total, "score_parts": parts} for total, parts, r in top]

    async def brains_for_agent(self, project_id: str, agent: Agent | None) -> list[str]:
        """Scope resolution: agent brain, department brain, project brain, and the
        company brain of the project's parent company (docs/06 §1, ADR 0015)."""
        ids: list[str] = []
        async with session_scope() as s:
            # The umbrella first: company memory is retrieved by every member's agents,
            # which is what makes a directive written once binding everywhere.
            proj = await s.get(Project, project_id)
            company_id = proj.company_id if proj is not None else None
            if company_id:
                co_brain = await s.scalar(select(Brain).where(
                    Brain.project_id == company_id, Brain.scope == BrainScope.COMPANY.value))
                if co_brain:
                    ids.append(co_brain.id)
            if agent is not None:
                if not agent.brain_id:
                    agent.brain_id = None
                pid_brain = await s.scalar(select(Brain).where(Brain.project_id == project_id,
                                                               Brain.scope == BrainScope.PROJECT.value))
                if pid_brain:
                    ids.append(pid_brain.id)
                if agent.department_id:
                    dep = await s.scalar(select(Brain).where(Brain.project_id == project_id,
                                                             Brain.scope == BrainScope.DEPARTMENT.value,
                                                             Brain.owner_id == agent.department_id))
                    if dep:
                        ids.append(dep.id)
                if agent.brain_id:
                    ids.append(agent.brain_id)
            else:
                rows = (await s.scalars(select(Brain.id).where(Brain.project_id == project_id))).all()
                ids.extend(list(rows))
        return ids

    async def context_pack(self, *, project_id: str, agent: Agent | None, query: str,
                           top_k: int | None = None) -> list[dict]:
        ids = await self.brains_for_agent(project_id, agent)
        k = top_k or TOP_K_DEFAULT.get(agent.role if agent else "default", 8)
        hits = await self.search(project_id=project_id, brain_ids=ids, query=query, top_k=k)
        return hits

    @staticmethod
    def _serialize(e: BrainEntry) -> dict:
        return {
            "id": e.id, "brain_id": e.brain_id, "kind": e.kind, "title": e.title, "body": e.body,
            "payload": e.payload or {}, "source": e.source or {}, "trust": e.trust,
            "importance": e.importance, "tags": e.tags or [], "skill_ids": e.skill_ids or [],
            "use_count": e.use_count, "created_at": e.created_at.isoformat() if e.created_at else None,
            "superseded_by": e.superseded_by, "human_edited": e.human_edited,
            "created_by": e.created_by,
        }


brain_service = BrainService()


def render_context_pack(hits: list[dict], token_budget: int = 1200) -> str:
    """Render retrieved memory for a prompt, with provenance and trust labels (docs/06 §2)."""
    if not hits:
        return "(no relevant memory)"
    budget = token_budget
    lines: list[str] = []
    for h in hits:
        trust = h["trust"]
        label = "UNTRUSTED" if trust == Trust.UNTRUSTED_EXTERNAL.value else trust.upper()
        src = h.get("source") or {}
        prov = src.get("url") or src.get("task_id") or src.get("run_id") or "internal"
        body = (h["body"] or "")[:600]
        block = f"- [{label}] {h['title']}: {body} (source: {prov})"
        cost = len(block.split())
        if cost > budget and lines:
            break
        budget -= cost
        lines.append(block)
    return "\n".join(lines)


def summarize_working_set(text: str, limit: int = 800) -> str:
    """Cheap extractive summary used at task end (docs/06 §3)."""
    text = (text or "").strip()
    if len(text) <= limit:
        return text
    sentences = re.split(r"(?<=[.!?])\s+", text)
    out = ""
    for s in sentences:
        if len(out) + len(s) > limit:
            break
        out += s + " "
    return out.strip() or text[:limit]
