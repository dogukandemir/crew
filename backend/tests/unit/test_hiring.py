"""ADR 0016: HR interviews — the bounded ladder, the grounded rubric, the seated
Head of People, and a soul on every hire."""

from __future__ import annotations

import random
from collections import Counter

import pytest
from sqlalchemy import select

from crew.control import hiring, org
from crew.core.db import session_scope
from crew.core.models import Agent, Department, Event, Project
from crew.domain.enums import Role

OPENING = hiring.Opening(role="worker", title="Engineering Specialist",
                         skills=["python", "unit-testing", "devops"],
                         grade=1, headroom_micros=1_000_000, label="t")


def test_the_ladder_never_exceeds_two_rejections():
    counts = Counter(hiring.roll_rejects(1.0, random.Random(f"c{i}")) for i in range(400))
    assert set(counts) <= {1, 2}, "friction forces a rejection, never a third"
    clean = sum(1 for i in range(400)
                if hiring.roll_rejects(0.28, random.Random(f"s{i}")) == 0)
    assert 240 <= clean <= 340, f"most openings land clean — got {clean}/400"


def test_the_rubric_rejects_each_flaw_for_its_own_reason():
    rng = random.Random("rubric")
    team_skills = {"python", "unit-testing"}
    team = [{"name": "Ida Novak", "skills": ["python", "unit-testing"]}]

    strong = hiring._strong_candidate(OPENING, rng, set())
    s = hiring.assess(strong, OPENING, team_skills=team_skills)
    assert s["passed"] and s["total"] >= 0.55

    cases = {
        "skill_shortfall": "goes uncovered",
        "grade_overreach": "remaining",
        "profile_clone": "duplicates",
        "vision_conflict": "vision conflicts",
    }
    for flaw, needle in cases.items():
        cand = hiring._weak_candidate(OPENING, rng, {"Used Name"}, flaw, team)
        sc = hiring.assess(cand, OPENING, team_skills=team_skills)
        assert not sc["passed"], flaw
        assert any(needle in r for r in sc["reasons"]), (flaw, sc["reasons"])


def test_candidate_generation_is_deterministic_per_seed():
    rng_a, rng_b = random.Random("seed-1"), random.Random("seed-1")
    a = hiring._strong_candidate(OPENING, rng_a, set())
    b = hiring._strong_candidate(OPENING, rng_b, set())
    assert a.name == b.name and a.soul == b.soul


@pytest.mark.asyncio
async def test_hr_seats_once_and_only_once(bound_loop, project):
    async with session_scope() as s:
        p = await s.get(Project, project["id"])
    first = await hiring.ensure_hr(project=p, run_id="r1", orchestrator_id=None,
                                   actor="system")
    second = await hiring.ensure_hr(project=p, run_id="r2", orchestrator_id=None,
                                    actor="system")
    assert first and first["role"] == Role.HR.value and " " in first["name"]
    assert second is None, "one Head of People per project"
    async with session_scope() as s:
        dept = await s.scalar(select(Department).where(
            Department.project_id == project["id"], Department.name == hiring.HR_DEPARTMENT))
        hr_agents = (await s.scalars(select(Agent).where(
            Agent.project_id == project["id"], Agent.role == Role.HR.value))).all()
        row = await s.get(Agent, hr_agents[0].id)
    assert dept is not None and dept.head_agent_id == row.id
    assert row.soul and row.soul.get("vision"), "the Head of People has a soul too"


@pytest.mark.asyncio
async def test_growth_hires_go_through_interviews_with_a_bounded_ladder(bound_loop, project):
    """Friction on: every opening rejects at most two candidates and still lands one;
    rejected candidates exist only on the record, and every hire carries a soul."""
    async with session_scope() as s:
        p = await s.get(Project, project["id"])
        p.settings = {**(p.settings or {}), "hr_friction": 1.0}
        s.add(p)
    created = await org.staff_gaps(project=p, gaps=["python", "unit-testing", "devops"],
                                   run_id="r-hr1", trace_id="t-hr1", orchestrator_id=None)
    roles = [c.get("role") for c in created]
    assert "hr" in roles and "head" in roles and "lead" in roles and "worker" in roles

    async with session_scope() as s:
        evs = (await s.scalars(select(Event).where(Event.project_id == project["id"]))).all()
        agents = (await s.scalars(select(Agent).where(
            Agent.project_id == project["id"]))).all()
    rejected = [e for e in evs if e.type == "hiring.candidate.rejected"]
    opened = [e for e in evs if e.type == "hiring.role.opened"]
    assert opened and rejected, "friction=1 guarantees interviews with rejections"
    per_label = Counter(e.payload.get("label") for e in rejected)
    assert all(n <= 2 for n in per_label.values()), f"the cap holds: {per_label}"

    # every planned role still landed — the candidate after the rejects always hires
    hired_roles = [a.role for a in agents]
    assert hired_roles.count("head") == 1 and hired_roles.count("lead") == 1
    assert hired_roles.count("worker") >= 1
    # every fresh hire is a person with a soul, and names are human
    for a in agents:
        assert a.soul and a.soul.get("traits") and " " in a.name
    # rejected candidates are NOT agents — they exist only on the record
    on_floor = {a.name for a in agents}
    for e in rejected:
        assert e.payload["candidate"] not in on_floor


@pytest.mark.asyncio
async def test_friction_off_means_a_clean_hiring_wave(bound_loop, project):
    async with session_scope() as s:
        p = await s.get(Project, project["id"])
        p.settings = {**(p.settings or {}), "hr_friction": 0.0}
        s.add(p)
    await org.staff_gaps(project=p, gaps=["python", "unit-testing"], run_id="r-hr2",
                         trace_id="t-hr2", orchestrator_id=None)
    async with session_scope() as s:
        rejected = (await s.scalars(select(Event).where(
            Event.project_id == project["id"],
            Event.type == "hiring.candidate.rejected"))).all()
        proposed = (await s.scalars(select(Event).where(
            Event.project_id == project["id"],
            Event.type == "hiring.candidate.proposed"))).all()
    assert not rejected, "no drama when friction is off"
    assert proposed, "but the interviews still happen — one candidate per opening"


@pytest.mark.asyncio
async def test_rejected_names_are_never_re_drawn_by_a_later_opening(monkeypatch, bound_loop, project):
    """CI caught a rejected candidate returning as a hire in a later opening.

    The agent-name set alone is not enough: everyone already ON the hiring record
    (proposed / rejected) must be excluded from later draws, or a person the record
    rejected walks back in through the next opening.
    """
    from crew.domain import soul as soul_mod
    from crew.domain.catalog import RoleSpec
    from crew.domain.enums import Grade

    picked_excluded: list[set[str]] = []
    counter = {"n": 0}

    def fake_pick(rng, excluded):
        picked_excluded.append(set(excluded))
        counter["n"] += 1
        return ("pool", "First", "Last", f"Person {counter['n']}")

    monkeypatch.setattr(soul_mod, "pick_name", fake_pick)

    async with session_scope() as s:
        p = await s.get(Project, project["id"])
        p.settings = {**(p.settings or {}), "hr_friction": 1.0}
        s.add(p)

    spec = RoleSpec.from_template(Role.WORKER, grade=Grade.MID, skills=["python"])
    await hiring.hr_hire(p, spec=spec, run_id="r-draw1", actor="test")

    async with session_scope() as s:
        rejected1 = [(e.payload or {}).get("candidate") for e in
                     (await s.scalars(select(Event).where(
                         Event.project_id == project["id"],
                         Event.type == "hiring.candidate.rejected"))).all()]
    rejected1 = [n for n in rejected1 if n]
    assert rejected1, "friction=1 must interview with rejections"

    picked_excluded.clear()
    await hiring.hr_hire(p, spec=spec, run_id="r-draw2", actor="test")
    seen = set().union(*picked_excluded) if picked_excluded else set()
    assert set(rejected1) <= seen, (
        f"a rejected candidate was re-drawn by the next opening: {rejected1} vs excluded {seen}")
