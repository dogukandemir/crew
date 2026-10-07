"""Integration: a whole goal-driven run with the offline runner (no network, ADR 0002)."""

from __future__ import annotations

import pytest
from sqlalchemy import select

from crew.control.orchestrator import orchestrator
from crew.core.brains import brain_service
from crew.core.db import session_scope
from crew.core.models import (
    Agent,
    Brain,
    BrainEntry,
    Department,
    Event,
    Project,
    RewardEvent,
    Run,
    Squad,
    Task,
)
from crew.core.security import verify_audit_chain

GOAL = "Write a short technical brief about vector databases for backend engineers"


async def _advance(project_id: str, goal: str = GOAL) -> dict:
    run = await orchestrator.start_run(project_id=project_id, goal=goal)
    result = await orchestrator.advance(run["id"])
    return {**result, "run_id": run["id"]}


@pytest.mark.asyncio
async def test_goal_to_verified_result_end_to_end(bound_loop, project):
    result = await _advance(project["id"])
    assert result["status"] == "completed", result
    assert result["stage"] == "DONE"

    async with session_scope() as s:
        run = await s.get(Run, result["run_id"])
        tasks = (await s.scalars(select(Task).where(Task.run_id == result["run_id"]))).all()
        agents = (await s.scalars(select(Agent).where(Agent.project_id == project["id"]))).all()
        depts = (await s.scalars(select(Department).where(Department.project_id == project["id"]))).all()
        squads = (await s.scalars(select(Squad).where(Squad.project_id == project["id"]))).all()
        rewards = (await s.scalars(select(RewardEvent).where(RewardEvent.project_id == project["id"]))).all()

    # 1. the org formed itself (M3)
    assert len(depts) >= 1, "a capability gap must produce at least one department"
    assert len(agents) >= 3, "orchestrator + head + at least one worker expected"
    assert len(squads) >= 1
    orchestrators = [a for a in agents if a.role == "orchestrator" and a.state != "archived"]
    assert len(orchestrators) == 1, "exactly one orchestrator per project (docs/02 §1)"

    # 2. every task was planned with acceptance criteria and reached a terminal state
    assert len(tasks) >= 3
    for t in tasks:
        assert t.acceptance_criteria, "tasks without criteria are invalid (docs/03 §3)"
        assert t.state in ("completed", "failed", "aborted")
    completed = [t for t in tasks if t.state == "completed"]
    assert completed, "offline runner should satisfy at least one task"

    # 3. verification produced a verdict and rewards were paid (M5)
    assert rewards, "verification must settle rewards"
    producer_rewards = [r for r in rewards if r.role_in_task == "producer"]
    assert producer_rewards, "the producer must be rewarded"
    assert any(r.reward > 0 for r in producer_rewards)
    paid_agents = {r.agent_id for r in rewards}
    assert len(paid_agents) >= 1
    for r in rewards:
        assert -1.0 <= r.reward <= 1.0

    # 4. scores moved from their initial value and stay recomputable
    scored = [a for a in agents if a.evidence_count > 0]
    assert scored, "agents that did work must accumulate evidence"
    assert all(-1.0 <= a.score <= 1.0 for a in agents)

    # 5. cost accounting is consistent (docs/08 §8) and the run recorded it
    assert run.cost_micros >= 0
    assert run.tokens_in > 0
    assert run.report and run.report.get("delivered") is not None

    # 6. memory: lessons written into a brain (M8)
    async with session_scope() as s:
        entries = (await s.scalars(select(BrainEntry).where(BrainEntry.project_id == project["id"]))).all()
    assert entries, "the learning stage must write at least one memory entry"
    assert all(e.source for e in entries), "every memory entry needs provenance (docs/10 §3.6)"


@pytest.mark.asyncio
async def test_events_are_gapless_and_well_typed(bound_loop, project):
    await _advance(project["id"], "Analyse the unit economics of a subscription product")
    async with session_scope() as s:
        seqs = (await s.scalars(select(Event.seq).where(Event.project_id == project["id"])
                                .order_by(Event.seq))).all()
        types = {t for (t,) in (await s.execute(select(Event.type).where(
            Event.project_id == project["id"]).distinct())).all()}
    assert seqs == list(range(1, len(seqs) + 1)), "seq must be gapless per project"
    expected = {"project.created", "run.started", "run.stage.changed", "run.completed",
                "task.created", "task.assigned", "task.completed", "verify.verdict",
                "reward.settled", "org.agent.hired", "org.department.created", "llm.response",
                "agent.thought"}
    missing = expected - types
    assert not missing, f"missing event types: {missing}"


@pytest.mark.asyncio
async def test_interpretation_is_searchable_in_memory(bound_loop, project):
    await _advance(project["id"], "Design a schema for storing event streams")
    hits = await brain_service.search(project_id=project["id"], brain_ids=None,
                                      query="event streams schema", top_k=5)
    assert hits, "the project brain must be retrievable"
    for h in hits:
        assert {"similarity", "recency", "importance", "usage", "trust_penalty"} <= set(h["score_parts"])


@pytest.mark.asyncio
async def test_budget_cap_is_enforced(bound_loop, project):
    """A project with a near-zero budget cannot dispatch work."""
    from crew.control import org
    from crew.control.orchestrator import orchestrator as orch
    from crew.core.security import budget

    tiny = await org.create_project(name="Tiny Budget", goal="Should be refused", budget_usd=0.000001)
    run = await orch.start_run(project_id=tiny["id"], goal="Do something expensive")
    result = await orch.advance(run["id"])
    assert result["status"] in ("paused_budget", "failed", "completed")
    async with session_scope() as s:
        p = await s.get(Project, tiny["id"])
        assert p.spend_micros <= p.budget_cap_micros + 1, "spend must never exceed the cap"
        exceeded = (await s.scalars(select(Event).where(Event.project_id == tiny["id"],
                                                        Event.type == "budget.exceeded"))).all()
    if result["status"] == "paused_budget":
        assert exceeded, "a budget pause must be explained by a budget.exceeded event"
        assert budget.breaker_open(tiny["id"])
        budget.close_breaker(tiny["id"])


@pytest.mark.asyncio
async def test_budget_ledger_reconciles_with_spend(bound_loop, project):
    """Ledger == spend counter, or the money story is untrustworthy (docs/10 §3.5)."""
    from crew.core.security import budget

    await _advance(project["id"], "Summarise the trade-offs of REST versus gRPC")
    result = await budget.reconcile(project["id"])
    assert result["ok"] is True, result
    assert result["ledger_settle_micros"] == result["spend_micros"] > 0


@pytest.mark.asyncio
async def test_individual_contributors_do_the_work(bound_loop, project):
    """Managers manage: a head must not absorb the backlog; workers get the tasks (docs/02 §2)."""
    await _advance(project["id"], "Compare two hosting options and recommend one")
    async with session_scope() as s:
        agents = (await s.scalars(select(Agent).where(Agent.project_id == project["id"]))).all()
        tasks = (await s.scalars(select(Task).where(Task.project_id == project["id"],
                                                    Task.state == "completed"))).all()
    by_id = {a.id: a for a in agents}
    producers = [by_id[t.assignee_agent_id] for t in tasks if t.assignee_agent_id in by_id]
    assert producers, "completed tasks need producers"
    assert all(a.role not in ("head", "orchestrator") for a in producers), \
        f"managers did IC work: {[a.name for a in producers]}"
    assert any(a.role in ("worker", "specialist", "analyst") for a in producers), \
        "individual contributors must be the ones producing deliverables"


@pytest.mark.asyncio
async def test_audit_chain_intact_after_a_run(bound_loop, project):
    await _advance(project["id"], "Produce a one page summary of quantum error correction")
    result = await verify_audit_chain()
    assert result["ok"] is True


@pytest.mark.asyncio
async def test_projects_are_isolated(bound_loop, project):
    """An agent in project A must not see project B's memory (docs/06 §1)."""
    from crew.control import org

    other = await org.create_project(name="Other Project", goal="unrelated", budget_usd=1.0)
    await _advance(project["id"], "Write about relational indexes")
    hits = await brain_service.search(project_id=other["id"], brain_ids=None, query="relational indexes",
                                      top_k=10)
    assert all(h["brain_id"] for h in hits)
    async with session_scope() as s:
        brains = (await s.scalars(select(Brain).where(Brain.project_id == other["id"]))).all()
        other_ids = {b.id for b in brains}
        own = (await s.scalars(select(BrainEntry).where(BrainEntry.project_id == project["id"]))).all()
    assert not ({e.brain_id for e in own} & other_ids), "brain namespaces must not leak across projects"


@pytest.mark.asyncio
async def test_nobody_is_left_marked_busy(bound_loop, project):
    """`busy` is claimed at task start and released on every end path (docs/17 batch 1)."""
    await _advance(project["id"], "List three risks of overnight deployments")
    async with session_scope() as s:
        stuck = (await s.scalars(select(Agent).where(Agent.project_id == project["id"],
                                                     Agent.state == "busy"))).all()
    assert not stuck, f"agents left marked busy: {[a.name for a in stuck]}"
