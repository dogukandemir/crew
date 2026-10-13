"""Reward engine: verified outcomes → reward ledger → score → grade transitions (docs/05)."""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import desc, func, select

from crew.core import events as ev
from crew.core.db import session_scope
from crew.core.models import Agent, AgentSkill, RewardEvent, Task, uid
from crew.core.security import audit
from crew.domain.catalog import GRADE_LIMITS
from crew.domain.enums import AgentState, Grade, ModelTier, RewardRole, Verdict

log = logging.getLogger("crew.reward")

DEFAULT_WEIGHTS: dict[str, float] = {"outcome": 0.55, "quality": 0.25, "efficiency": 0.12, "reliability": 0.08}

PENALTY_VALUES: dict[str, float] = {
    "policy_violation": -0.50,
    "integrity_violation": -1.00,
    "unverified_claim": -0.30,
    "budget_overrun": -0.40,
    "duplicated_work": -0.20,
}

# participant shares within one task's reward pool (docs/05 §1)
SHARES: dict[RewardRole, float] = {
    RewardRole.PRODUCER: 0.70,
    RewardRole.LEAD: 0.15,
    RewardRole.HEAD: 0.05,
    RewardRole.VERIFIER: 0.10,
}

LAMBDA = 0.25          # EWMA weight of the newest observation
MIN_SAMPLES = 5        # evidence needed before promotion can fire
PROMOTE_SCORE = 0.45
PROBATION_SCORE = -0.10
DEMOTE_SCORE = -0.25
SUCCESS_FLOOR = 0.70

# Growth (ADR 0014): verified work compounds. Knowledge numbers are the day-one
# baseline and the per-unit-of-effort accrual; the cap is deliberately < 1.0 —
# familiarity is never certainty, and the prompt says to re-verify thin records.
KNOWLEDGE_ON_HIRE = 0.05
KNOWLEDGE_PER_EFFORT = 0.02
KNOWLEDGE_CAP = 0.95

ALLOWED_TRANSITIONS = {"idle": {"probation", "archived", "busy", "suspended"},
                       "probation": {"idle", "archived", "busy"},
                       "busy": {"idle", "probation"},
                       "suspended": {"idle", "archived"}}


def outcome_score(verdict: str | Verdict) -> float:
    v = Verdict(verdict)
    return {Verdict.PASS: 1.0, Verdict.PASS_WITH_NOTES: 0.7,
            Verdict.INCONCLUSIVE: 0.0, Verdict.FAIL: -1.0}[v]


def efficiency_score(est_cost_micros: int, act_cost_micros: int,
                     est_steps: int, act_steps: int) -> float:
    cost_over = 0.0 if not est_cost_micros else max(0.0, (act_cost_micros - est_cost_micros) / est_cost_micros)
    step_over = 0.0 if not est_steps else max(0.0, (act_steps - est_steps) / est_steps)
    return round(max(0.0, 1.0 - min(0.6, cost_over * 0.4 + step_over * 0.3)), 4)


def reliability_score(retries: int, tool_error_rate: float) -> float:
    return round(max(0.0, (1 - retries / (retries + 1)) - tool_error_rate * 0.3), 4)


def compute_reward(
    *,
    verdict: str | Verdict,
    quality: float = 0.5,
    est_cost_micros: int = 0,
    act_cost_micros: int = 0,
    est_steps: int = 3,
    act_steps: int = 3,
    retries: int = 0,
    tool_error_rate: float = 0.0,
    penalties: list[str] | None = None,
    effort_weight: float = 1.0,
    weights: dict[str, float] | None = None,
) -> tuple[float, dict[str, Any]]:
    """Pure function: the reward formula of docs/05 §2. Testable without a database."""
    w = {**DEFAULT_WEIGHTS, **(weights or {})}
    out = outcome_score(verdict)
    q = max(-0.2, min(1.0, (quality - 0.5) * 2.0)) if quality is not None else 0.0
    eff = efficiency_score(est_cost_micros, act_cost_micros, est_steps, act_steps)
    rel = reliability_score(retries, tool_error_rate)

    raw = w["outcome"] * out + w["quality"] * q + w["efficiency"] * eff + w["reliability"] * rel
    penalty_sum = sum(PENALTY_VALUES.get(p, -0.2) for p in (penalties or []))
    value = max(-1.0, min(1.0, raw + penalty_sum))
    components = {
        "outcome": round(out, 4), "quality": round(q, 4), "efficiency": eff, "reliability": rel,
        "weights": w, "penalties": penalties or [], "penalty_sum": round(penalty_sum, 4),
        "effort_weight": effort_weight,
    }
    return round(value, 4), components


def _share(reward: float, role: RewardRole, verdict: str) -> float:
    """Managerial shares are damped by the verdict; a failed task pays managers little/nothing."""
    s = SHARES[role]
    v = Verdict(verdict)
    if role is RewardRole.PRODUCER:
        return round(reward * s, 4)
    if v in (Verdict.FAIL, Verdict.INCONCLUSIVE):
        return round(min(0.0, reward * s), 4) if v is Verdict.FAIL else 0.0
    if role is RewardRole.VERIFIER:
        # verifier is scored on accuracy, not on the outcome: passing a contradiction is penalised
        return round(0.10 if v is Verdict.PASS else 0.0, 4)
    return round(reward * s, 4)


class RewardEngine:
    async def settle_task(
        self,
        *,
        project_id: str,
        task: Task,
        verdict: str,
        quality: float = 0.5,
        retries: int = 0,
        penalties: list[str] | None = None,
        est_cost_micros: int = 0,
        est_steps: int = 3,
        act_steps: int = 3,
        tool_error_rate: float = 0.0,
        verifier_id: str | None = None,
        lead_id: str | None = None,
        head_id: str | None = None,
        orchestrator_id: str | None = None,
        weights: dict[str, float] | None = None,
        verifier_contradiction: bool = False,
    ) -> list[dict]:
        from crew.domain.enums import Effort

        effort_weight = Effort(task.effort).weight if task.effort else 1.0
        reward, components = compute_reward(
            verdict=verdict, quality=quality, est_cost_micros=est_cost_micros,
            act_cost_micros=task.cost_micros, est_steps=est_steps, act_steps=act_steps,
            retries=retries, tool_error_rate=tool_error_rate, penalties=penalties,
            effort_weight=effort_weight, weights=weights,
        )
        # difficulty normalisation: hard tasks are worth more (docs/05 §6)
        reward = round(max(-1.0, min(1.0, reward * (0.7 + 0.15 * effort_weight))), 4)

        settled: list[dict] = []
        participants: list[tuple[RewardRole, str | None]] = [
            (RewardRole.PRODUCER, task.assignee_agent_id),
            (RewardRole.LEAD, lead_id),
            (RewardRole.HEAD, head_id),
            (RewardRole.VERIFIER, verifier_id),
        ]
        for role, agent_id in participants:
            if not agent_id:
                continue
            value = _share(reward, role, verdict)
            if role is RewardRole.VERIFIER and verifier_contradiction:
                value = PENALTY_VALUES["unverified_claim"]
            row = await self.apply(
                project_id=project_id, agent_id=agent_id, task_id=task.id, run_id=task.run_id,
                verdict=verdict, reward=value, role=role, components=components,
                note=f"{task.title[:80]} [{role.value}]",
            )
            settled.append(row)
        if orchestrator_id:
            settled.append(await self.apply(
                project_id=project_id, agent_id=orchestrator_id, task_id=task.id, run_id=task.run_id,
                verdict=verdict, reward=round(reward * 0.10, 4), role=RewardRole.ORCHESTRATOR,
                components=components, note=f"orchestration share for {task.title[:60]}",
            ))
        return settled

    async def apply(
        self, *, project_id: str, agent_id: str, task_id: str | None, run_id: str | None,
        verdict: str, reward: float, role: RewardRole, components: dict, note: str = "",
    ) -> dict:
        async with session_scope() as s:
            a = await s.get(Agent, agent_id)
            if a is None:
                return {}
            before = int(a.grade)
            a.score = round((1 - LAMBDA) * a.score + LAMBDA * reward, 4)
            a.evidence_count += 1
            if role is RewardRole.PRODUCER and task_id:
                if Verdict(verdict) in (Verdict.PASS, Verdict.PASS_WITH_NOTES):
                    a.tasks_done += 1
                elif Verdict(verdict) is Verdict.FAIL:
                    a.tasks_failed += 1
                total = a.tasks_done + a.tasks_failed
                a.success_rate = round(a.tasks_done / total, 4) if total else 0.0
            if components.get("penalties"):
                a.penalty_count += len(components["penalties"])
            a.score_confidence = round(min(1.0, a.evidence_count / 20), 3)
            a.last_active_at = datetime.now(UTC)
            s.add(a)
            row = RewardEvent(
                project_id=project_id, run_id=run_id, task_id=task_id, agent_id=agent_id,
                role_in_task=role.value, verdict=verdict, components=components,
                penalties=components.get("penalties", []), reward=reward,
                weight=SHARES.get(role, 0.0), score_after=a.score,
                grade_before=before, grade_after=before, note=note,
            )
            s.add(row)
            await s.flush()
            payload = {"agent_id": agent_id, "task_id": task_id, "reward": reward,
                       "role": role.value, "verdict": verdict, "score_after": a.score, "id": row.id}

        await ev.emit("reward.settled", project_id=project_id, agent_id=agent_id, task_id=task_id,
                      run_id=run_id, title=f"reward {reward:+.3f} to {role.value}",
                      summary=note, payload=payload,
                      actor=f"agent:{agent_id}")
        transition = await self.maybe_transition(project_id=project_id, agent_id=agent_id)
        if transition:
            payload["transition"] = transition
        return payload

    async def maybe_transition(self, *, project_id: str, agent_id: str) -> dict | None:
        """Promotion / probation / demotion — the org consequence of the score (docs/05 §4)."""
        async with session_scope() as s:
            a = await s.get(Agent, agent_id)
            if a is None or a.state == AgentState.ARCHIVED:
                return None
            grade = Grade(min(5, max(0, int(a.grade))))
            recent_penalties = await s.scalar(
                select(func.count(RewardEvent.id)).where(RewardEvent.agent_id == agent_id)
                .order_by(desc(RewardEvent.created_at)).limit(10)
            )
            senior_count = await s.scalar(
                select(func.count(Agent.id)).where(Agent.project_id == a.project_id, Agent.grade >= Grade.SENIOR)
            )
            total_agents = await s.scalar(
                select(func.count(Agent.id)).where(Agent.project_id == a.project_id, Agent.state != "archived")
            )

            promote = (
                a.score >= PROMOTE_SCORE and a.evidence_count >= MIN_SAMPLES
                and a.success_rate >= SUCCESS_FLOOR and not recent_penalties
                and grade < Grade.CHIEF
                and (senior_count or 0) < max(1, int(0.4 * (total_agents or 1)))
            )
            probation = a.score < PROBATION_SCORE or a.penalty_count >= 2
            demote = grade > Grade.TRAINEE and (a.score < DEMOTE_SCORE or (a.evidence_count >= 10 and a.success_rate < 0.4))

            if demote and a.state != AgentState.PROBATION:
                pass  # demotion requires a probation period first (docs/05 §4)
            if promote and a.state != AgentState.PROBATION:
                a.grade = int(grade) + 1
                self._apply_grade_limits(a)
                s.add(a)
                action, payload = "org.agent.promoted", {
                    "agent_id": a.id, "grade_before": int(grade), "grade_after": a.grade,
                    "score": a.score, "reason": "score/evidence thresholds met",
                }
            elif demote and a.state == AgentState.PROBATION:
                a.grade = int(grade) - 1
                a.state = AgentState.IDLE
                self._apply_grade_limits(a)
                s.add(a)
                action, payload = "org.agent.demoted", {
                    "agent_id": a.id, "grade_before": int(grade), "grade_after": a.grade,
                    "score": a.score, "reason": "sustained underperformance",
                }
            elif probation and a.state not in (AgentState.PROBATION, AgentState.ARCHIVED):
                a.state = AgentState.PROBATION
                self._apply_grade_limits(a)
                s.add(a)
                action, payload = "org.agent.probation", {
                    "agent_id": a.id, "score": a.score, "reason": "score below probation floor or repeated penalties",
                }
            else:
                return None
            name, role, grade_after = a.name, a.role, a.grade

        await ev.emit(action, project_id=project_id, agent_id=agent_id, severity="notice",
                      title=f"{name} → {action.split('.')[-1]} (grade {grade_after})",
                      payload=payload, actor="system:reward-engine")
        await audit(actor_kind="system", actor_id="reward-engine", action=action,
                    resource_kind="agent", resource_id=agent_id, reason=payload.get("reason", ""))
        return {"action": action, "agent_id": agent_id, "role": role, **payload}

    @staticmethod
    def apply_grade_limits_pure(a: Agent) -> None:
        limits = GRADE_LIMITS[Grade(min(5, max(0, int(a.grade))))]
        a.model_tier = ModelTier(limits["tier"]).value
        a.token_cap_per_step = int(limits["tokens_step"])
        a.spend_cap_per_run_micros = int(limits["spend_run_usd"] * 1_000_000)
        a.spend_cap_per_day_micros = int(limits["spend_day_usd"] * 1_000_000)
        a.autonomy = limits["autonomy"].value if a.state != AgentState.PROBATION else "supervised"

    def _apply_grade_limits(self, a: Agent) -> None:
        self.apply_grade_limits_pure(a)
        if a.state == AgentState.PROBATION or (a.role in ("worker", "analyst") and a.grade <= 1):
            a.autonomy = "supervised"

    async def recompute(self, *, project_id: str, agent_id: str) -> float:
        """Recompute the score from the append-only ledger (docs/05 §8)."""
        async with session_scope() as s:
            rows = (await s.scalars(
                select(RewardEvent).where(RewardEvent.agent_id == agent_id).order_by(RewardEvent.created_at)
            )).all()
        score = 0.0
        for r in rows:
            score = (1 - LAMBDA) * score + LAMBDA * r.reward
        return round(score, 4)

    async def grow(self, *, agent_id: str, skill_ids: list[str], reward: float,
                   effort_weight: float = 1.6, task_id: str | None = None,
                   alpha: float = 0.15) -> dict | None:
        """Verified success grows the agent (ADR 0014): evidence-based skill proficiency
        (docs/04 §3) plus company knowledge that accrues with the work — never with
        prompt words or wall-clock alone. One `agent.grew` event, so the growth is on
        the record instead of inferred from two snapshots.
        """
        grown: list[dict] = []
        async with session_scope() as s:
            a = await s.get(Agent, agent_id)
            if a is None:
                return None
            for sid in dict.fromkeys(sid for sid in skill_ids if sid):
                row = await s.scalar(select(AgentSkill).where(AgentSkill.agent_id == agent_id,
                                                              AgentSkill.skill_id == sid))
                if row is None:
                    row = AgentSkill(agent_id=agent_id, skill_id=sid, proficiency=0.5, evidence_count=0)
                    s.add(row)
                before = float(row.proficiency)
                row.proficiency = round(max(0.0, min(1.0, before + alpha * (reward - (before - 0.5)))), 4)
                row.evidence_count += 1
                row.last_used_at = datetime.now(UTC)
                s.add(row)
                if abs(row.proficiency - before) >= 0.0005:
                    grown.append({"skill_id": sid, "from": round(before, 4), "to": row.proficiency,
                                  "evidence_count": int(row.evidence_count)})
            k_before = float(a.company_knowledge or 0.0)
            a.company_knowledge = round(min(KNOWLEDGE_CAP, k_before + KNOWLEDGE_PER_EFFORT * (effort_weight or 1.0)), 4)
            s.add(a)
            name, pid, k_after = a.name, a.project_id, a.company_knowledge
        skills_part = ", ".join(f"{g['skill_id']} {g['from']:.2f}→{g['to']:.2f}" for g in grown) or "no skill move"
        payload = {"agent_id": agent_id, "task_id": task_id, "skills_grown": grown,
                   "company_knowledge": {"before": round(k_before, 4), "after": k_after},
                   "effort_weight": effort_weight}
        await ev.emit("agent.grew", project_id=pid, agent_id=agent_id, task_id=task_id,
                      title=f"{name} grew: {skills_part}",
                      summary=f"company knowledge {k_before:.2f} → {k_after:.2f}",
                      payload=payload, actor="system:reward-engine")
        return payload


reward_engine = RewardEngine()


async def leaderboard(project_id: str, limit: int = 50) -> list[dict]:
    async with session_scope() as s:
        rows = (await s.scalars(
            select(Agent).where(Agent.project_id == project_id, Agent.state != "archived")
            .order_by(desc(Agent.score)).limit(limit)
        )).all()
    return [{
        "id": a.id, "agent_id": a.id, "name": a.name, "role": a.role, "grade": int(a.grade),
        "grade_label": Grade(int(a.grade)).label, "state": a.state, "score": a.score,
        "score_100": a.score_100, "confidence": a.score_confidence,
        "success_rate": a.success_rate, "tasks_done": a.tasks_done, "tasks_failed": a.tasks_failed,
        "cost_micros": a.spend_today_micros,
        "evidence_count": a.evidence_count, "model_tier": a.model_tier,
        "company_knowledge": round(float(a.company_knowledge or 0.0), 3),
        "department_id": a.department_id,
    } for a in rows]


def new_reward_event_id() -> str:  # pragma: no cover - helper for tests
    return uid()
