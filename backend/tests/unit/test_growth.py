"""ADR 0014: agents grow with verified work, skills compound, company knowledge
accrues, and both land on the record as one `agent.grew` event (never inferred)."""

from __future__ import annotations

import pytest
from sqlalchemy import select

from crew.core.db import session_scope
from crew.core.models import Agent, AgentSkill, Event
from crew.core.reward import KNOWLEDGE_CAP, KNOWLEDGE_ON_HIRE, reward_engine


async def _worker(s, project_id: str, *, knowledge: float = KNOWLEDGE_ON_HIRE) -> Agent:
    a = Agent(project_id=project_id, name="Elena Rossi", role="worker", grade=2,
              state="idle", autonomy="autonomous", mission="x", company_knowledge=knowledge)
    s.add(a)
    await s.flush()
    s.add(AgentSkill(agent_id=a.id, skill_id="python", proficiency=0.5))
    await s.flush()
    return a


@pytest.mark.asyncio
async def test_verified_work_grows_skills_knowledge_and_the_record(bound_loop, project):
    async with session_scope() as s:
        a = await _worker(s, project["id"])
        aid = a.id

    out = await reward_engine.grow(agent_id=aid, skill_ids=["python", "web-research"],
                                   reward=0.31, effort_weight=2.6, task_id="t-42")
    assert out is not None

    async with session_scope() as s:
        agent = await s.get(Agent, aid)
        python = await s.scalar(select(AgentSkill).where(AgentSkill.agent_id == aid,
                                                         AgentSkill.skill_id == "python"))
        fresh = await s.scalar(select(AgentSkill).where(AgentSkill.agent_id == aid,
                                                        AgentSkill.skill_id == "web-research"))
        events = (await s.scalars(select(Event).where(Event.project_id == project["id"],
                                                      Event.type == "agent.grew"))).all()

    # a strong reward lifts the proficiency and counts the evidence
    assert python.proficiency > 0.5 and python.evidence_count == 1
    # a skill the agent did not carry is opened at the 0.5 prior and grows from there
    assert fresh is not None and fresh.evidence_count == 1
    assert out["skills_grown"] and all(g["to"] >= g["from"] for g in out["skills_grown"])
    # knowledge: the hire baseline plus 0.02 per unit of verified effort (L = 2.6)
    assert agent.company_knowledge == round(KNOWLEDGE_ON_HIRE + 0.02 * 2.6, 4)
    # the record: exactly one event, carrying the validated payload
    assert len(events) == 1 and events[0].agent_id == aid
    assert events[0].payload["company_knowledge"]["after"] == agent.company_knowledge


@pytest.mark.asyncio
async def test_growth_is_bounded(bound_loop, project):
    async with session_scope() as s:
        a = await _worker(s, project["id"], knowledge=0.9)
        aid = a.id
    for i in range(60):
        await reward_engine.grow(agent_id=aid, skill_ids=["python"], reward=0.3,
                                 effort_weight=4.0, task_id=f"t-{i}")
    async with session_scope() as s:
        agent = await s.get(Agent, aid)
        skill = await s.scalar(select(AgentSkill).where(AgentSkill.agent_id == aid,
                                                        AgentSkill.skill_id == "python"))
    assert agent.company_knowledge == KNOWLEDGE_CAP
    assert skill.proficiency <= 1.0


@pytest.mark.asyncio
async def test_the_evidence_rule_runs_both_ways(bound_loop, project):
    """A pass thin enough to carry penalties is not a full pass, the skill slides."""
    async with session_scope() as s:
        a = await _worker(s, project["id"])
        aid = a.id
    out = await reward_engine.grow(agent_id=aid, skill_ids=["python"], reward=-0.2,
                                   effort_weight=1.0, task_id="t-low")
    async with session_scope() as s:
        skill = await s.scalar(select(AgentSkill).where(AgentSkill.agent_id == aid,
                                                        AgentSkill.skill_id == "python"))
    assert skill.proficiency < 0.5
    assert out["skills_grown"][0]["to"] < out["skills_grown"][0]["from"]
