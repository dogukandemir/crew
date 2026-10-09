"""Council: bounded debate among specialists, then a binding Decision Record (docs/02 §6, docs/03)."""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass

from sqlalchemy import select

from crew.core import events as ev
from crew.core.db import session_scope
from crew.core.models import Agent, CouncilPosition, CouncilSession, Decision, Project
from crew.core.security import audit
from crew.core.settings import settings
from crew.domain.enums import CouncilStatus, ModelTier, Role
from crew.execution.models import router

log = logging.getLogger("crew.council")

POSITION_PROMPT = """You are {name}, a {role} in an autonomous organization. Take a position on the
question. Attack the strongest version of the alternatives; be concrete; cite evidence or say
"no evidence". Return ONLY JSON:
{{"option_id":"<one of the options>","claim":"...","reasoning":"...","evidence":["..."],
  "risks":["..."],"confidence":0.0-1.0}}"""

DECISION_PROMPT = """You are the Chief Decision Officer. You have the council's positions. Issue a
binding ruling. Weigh evidence over volume; preserve dissent; state what would change your mind.
Return ONLY JSON: {"chosen_option":"<option id>","rationale":"...","confidence":0.0-1.0,
"reversibility":"one_way|two_way","follow_ups":["..."]}"""


@dataclass
class CouncilOutcome:
    session_id: str
    decision_id: str
    chosen_option: str
    rationale: str
    confidence: float


def _llm_json(model_tier: ModelTier, system: str, user: str) -> dict | None:
    model = router.model_for_tier(model_tier)
    if not settings.provider_key_for(model) or settings.offline_llm:
        return None
    try:
        from crewai import LLM

        llm = LLM(model=model, temperature=0.2, api_key=settings.provider_key_for(model))
        raw = llm.call(messages=[{"role": "system", "content": system}, {"role": "user", "content": user}])
        m = re.search(r"\{.*\}", str(raw), re.S)
        return json.loads(m.group(0)) if m else None
    except Exception as e:
        log.warning("council llm call failed: %s", e)
        return None


class CouncilService:
    async def convene(
        self, *, project: Project, question: str, options: list[dict], criteria: list[str] | None = None,
        constraints: list[str] | None = None, task_id: str | None = None, run_id: str | None = None,
        convened_by: str = "system", panel: list[str] | None = None, rationale: str = "",
    ) -> dict:
        if len(options) < 2:
            raise ValueError("a council needs at least two options")
        async with session_scope() as s:
            sess = CouncilSession(
                project_id=project.id, run_id=run_id, task_id=task_id, question=question,
                options=options, criteria=criteria or ["correctness", "cost", "risk", "reversibility"],
                constraints=constraints or [], panel=panel or [], convened_by=convened_by,
                max_rounds=int(project.setting("council_policy", {}).get("max_rounds", 3)),
                rationale=rationale,
            )
            s.add(sess)
            await s.flush()
            sid = sess.id
        await ev.emit("council.convened", project_id=project.id, run_id=run_id, task_id=task_id,
                      severity="notice", title=f"council convened: {question[:60]}",
                      payload={"session_id": sid, "question": question, "options": options,
                               "criteria": criteria or [], "rationale": rationale},
                      actor=convened_by)
        await audit(actor_kind="agent" if convened_by.startswith("agent:") else "system",
                    actor_id=convened_by, action="council.convened", resource_kind="council",
                    resource_id=sid, reason=question[:200])
        if not panel:
            # a debate needs peers: grow the org rather than debate with nobody (docs/02 §5)
            await self.ensure_panel_agents(project=project, convened_by=convened_by)
        return {"session_id": sid, "question": question, "options": options}

    async def ensure_panel_agents(self, *, project: Project, convened_by: str = "system") -> list[str]:
        """Hire the minimum independent panel roles when the org lacks them."""
        from crew.control import org as org_service
        from crew.domain.catalog import RoleSpec

        async with session_scope() as s:
            roles = {a.role for a in (await s.scalars(
                select(Agent).where(Agent.project_id == project.id, Agent.state != "archived"))).all()}
        hired: list[str] = []
        for role, why in ((Role.DECIDER, "a binding decision needs a decider"),
                          (Role.CRITIC, "a debate needs an independent critic")):
            if role.value in roles:
                continue
            try:
                created = await org_service.hire_agent(
                    project_id=project.id, spec=RoleSpec.from_template(role, rationale=why),
                    rationale=f"council requirement: {why}", actor=convened_by)
                hired.append(created["id"])
            except ValueError as e:      # org limits / budget: debate with whoever exists
                log.info("council panel hire refused (%s): %s", role.value, e)
        return hired

    async def select_panel(self, *, project_id: str, session_id: str, size: int = 3,
                           exclude: list[str] | None = None) -> list[Agent]:
        """Relevance + independence: at least one critic, at most one member from the proposer's squad."""
        async with session_scope() as s:
            agents = (await s.scalars(select(Agent).where(Agent.project_id == project_id,
                                                          Agent.state != "archived"))).all()
        exclude = set(exclude or [])
        pool = [a for a in agents if a.id not in exclude and a.role != Role.ORCHESTRATOR.value]
        pool.sort(key=lambda a: (a.role != Role.CRITIC.value, a.role != Role.SPECIALIST.value, -a.score))
        panel: list[Agent] = []
        seen_squads: set[str] = set()
        for a in pool:
            if a.squad_id and a.squad_id in seen_squads:
                continue
            panel.append(a)
            if a.squad_id:
                seen_squads.add(a.squad_id)
            if len(panel) >= max(3, size):
                break
        if len(panel) < 2:
            # tiny org: the executives sit in rather than there being no debate at all
            for a in agents:
                if a in panel or a.id in exclude:
                    continue
                panel.append(a)
                if len(panel) >= max(3, size):
                    break
        async with session_scope() as s:
            row = await s.get(CouncilSession, session_id)
            row.panel = [a.id for a in panel]
            s.add(row)
        return panel

    async def run_round(self, *, project_id: str, session_id: str, round_no: int | None = None) -> list[dict]:
        async with session_scope() as s:
            sess = await s.get(CouncilSession, session_id)
            if sess is None:
                raise KeyError(session_id)
            panel_ids = list(sess.panel or [])
            session_round = (sess.rounds or 0) + 1
            question, options, criteria = sess.question, sess.options, sess.criteria
            agents = {a.id: a for a in (await s.scalars(select(Agent).where(Agent.id.in_(panel_ids)))).all()} if panel_ids else {}
        if not panel_ids:
            panel = await self.select_panel(project_id=project_id, session_id=session_id)
            agents = {a.id: a for a in panel}
            panel_ids = [a.id for a in panel]

        positions: list[dict] = []
        prior = await self.positions(project_id=project_id, session_id=session_id)
        strongest = max(prior, key=lambda p: p["confidence"]) if prior else None

        for aid in panel_ids:
            a = agents.get(aid)
            if a is None:
                continue
            user = json.dumps({
                "question": question, "options": options, "criteria": criteria,
                "round": session_round,
                "strongest_counter_argument": (strongest or {}).get("claim") if session_round > 1 else None,
            })
            data = _llm_json(ModelTier.REASONING, POSITION_PROMPT.format(name=a.name, role=a.role), user)
            if data is None:   # deterministic fallback: argue from skills, flag no evidence
                data = {
                    "option_id": (options[0] or {}).get("id", "a"),
                    "claim": f"[offline] {a.name} ({a.role}) favours option {(options[0] or {}).get('id', 'a')} "
                             f"based on {', '.join(list(a.responsibilities or [])[:3]) or 'general judgement'}",
                    "reasoning": "Offline position generated without a model provider: reasoning is "
                                 "limited to the agent's declared expertise.",
                    "evidence": [], "risks": ["position was generated without model access"],
                    "confidence": 0.3,
                }
            pos = {
                "session_id": session_id, "round": session_round, "agent_id": aid,
                "option_id": str(data.get("option_id", "")), "claim": str(data.get("claim", ""))[:2000],
                "reasoning": str(data.get("reasoning", ""))[:4000],
                "evidence": [str(e)[:400] for e in (data.get("evidence") or [])],
                "risks": [str(r)[:400] for r in (data.get("risks") or [])],
                "confidence": float(data.get("confidence", 0.3)),
                "critique_of_position_id": strongest["id"] if (strongest and session_round > 1) else None,
            }
            async with session_scope() as s:
                row = CouncilPosition(project_id=project_id, **pos)
                s.add(row)
                await s.flush()
                pos["id"] = row.id
            positions.append(pos)
            await ev.emit("council.position", project_id=project_id, agent_id=aid,
                          title=f"{a.name} on {pos['option_id']}", summary=pos["claim"][:200],
                          payload={"session_id": session_id, "agent_id": aid, "round": session_round,
                                   **{k: pos[k] for k in ("option_id", "claim", "confidence", "risks")}},
                          actor=f"agent:{aid}")
        async with session_scope() as s:
            sess = await s.get(CouncilSession, session_id)
            sess.rounds = session_round
            s.add(sess)
        return positions

    async def positions(self, *, project_id: str, session_id: str) -> list[dict]:
        async with session_scope() as s:
            rows = (await s.scalars(select(CouncilPosition).where(CouncilPosition.session_id == session_id)
                                    .order_by(CouncilPosition.created_at))).all()
        return [{"id": r.id, "agent_id": r.agent_id, "round": r.round, "option_id": r.option_id,
                 "claim": r.claim, "reasoning": r.reasoning, "evidence": r.evidence, "risks": r.risks,
                 "confidence": r.confidence, "critique_of_position_id": r.critique_of_position_id}
                for r in rows]

    async def decide(self, *, project: Project, session_id: str, decider: Agent | None = None,
                     actor: str = "system:decider") -> CouncilOutcome:
        async with session_scope() as s:
            sess = await s.get(CouncilSession, session_id)
            if sess is None:
                raise KeyError(session_id)
            if decider is None:
                decider = await s.scalar(select(Agent).where(Agent.project_id == project.id,
                                                            Agent.role == Role.DECIDER.value,
                                                            Agent.state != "archived").order_by(Agent.score.desc()))
        positions = await self.positions(project_id=project.id, session_id=session_id)
        if not positions:
            positions = await self.run_round(project_id=project.id, session_id=session_id)

        option_ids = [str(o.get("id")) for o in sess.options]
        tally: dict[str, float] = {oid: 0.0 for oid in option_ids}
        for p in positions:
            if p["option_id"] in tally:
                tally[p["option_id"]] += max(0.05, p["confidence"])

        data = _llm_json(ModelTier.REASONING, DECISION_PROMPT, json.dumps({
            "question": sess.question, "options": sess.options, "positions": positions,
            "tally": tally, "criteria": sess.criteria}))
        if data is None:
            chosen = max(tally, key=lambda k: tally[k]) if tally else option_ids[0]
            dissent = [{"agent_id": p["agent_id"], "claim": p["claim"], "confidence": p["confidence"]}
                       for p in positions if p["option_id"] != chosen]
            data = {
                "chosen_option": chosen,
                "rationale": f"Decided by weighted confidence tally ({tally}) because no decision model "
                             "was available; dissent preserved for review.",
                "confidence": min(0.6, max(0.2, tally.get(chosen, 0.0) / max(1.0, sum(tally.values())))),
                "reversibility": "two_way", "follow_ups": ["re-evaluate with a decision model when available"],
            }
        chosen = str(data.get("chosen_option", option_ids[0]))
        dissent = [{"agent_id": p["agent_id"], "claim": p["claim"], "confidence": p["confidence"],
                    "option_id": p["option_id"]} for p in positions if p["option_id"] != chosen]

        async with session_scope() as s:
            d = Decision(project_id=project.id, session_id=session_id, task_id=sess.task_id,
                         question=sess.question, chosen_option=chosen,
                         rationale=str(data.get("rationale", ""))[:4000], dissent=dissent,
                         confidence=float(data.get("confidence", 0.5)),
                         reversibility=str(data.get("reversibility", "two_way")),
                         follow_ups=[str(f)[:300] for f in (data.get("follow_ups") or [])],
                         decider_agent_id=decider.id if decider else "")
            s.add(d)
            await s.flush()
            did = d.id
            row = await s.get(CouncilSession, session_id)
            row.status = CouncilStatus.CLOSED.value
            row.decision_id = did
            s.add(row)
        await ev.emit("decision.recorded", project_id=project.id,
                      severity="notice", title=f"decision: {chosen}",
                      summary=str(data.get("rationale", ""))[:300],
                      payload={"decision_id": did, "chosen_option": chosen, "confidence": float(data.get("confidence", 0.5)),
                               "dissent_count": len(dissent), "question": sess.question},
                      actor=actor)
        await audit(actor_kind="agent", actor_id=decider.id if decider else "system", action="decision.recorded",
                    resource_kind="decision", resource_id=did, reason=chosen)
        return CouncilOutcome(session_id=session_id, decision_id=did, chosen_option=chosen,
                              rationale=str(data.get("rationale", "")), confidence=float(data.get("confidence", 0.5)))

    async def get_session(self, *, session_id: str) -> dict:
        async with session_scope() as s:
            sess = await s.get(CouncilSession, session_id)
            if sess is None:
                raise KeyError(session_id)
        return {"id": sess.id, "question": sess.question, "options": sess.options,
                "criteria": sess.criteria, "constraints": sess.constraints, "panel": sess.panel,
                "status": sess.status, "rounds": sess.rounds, "decision_id": sess.decision_id,
                "convened_by": sess.convened_by, "created_at": ev.utc_iso(sess.created_at),
                "positions": await self.positions(project_id=sess.project_id, session_id=session_id)}

    async def decision_constraints(self, *, project_id: str) -> list[str]:
        """Binding decisions become planning constraints (docs/02 §6.5)."""
        async with session_scope() as s:
            rows = (await s.scalars(select(Decision).where(Decision.project_id == project_id,
                                                           Decision.overridden_by.is_(None))
                                    .order_by(Decision.created_at.desc()).limit(10))).all()
        return [f"{d.question[:120]} → {d.chosen_option} ({d.rationale[:160]})" for d in rows]


council = CouncilService()
