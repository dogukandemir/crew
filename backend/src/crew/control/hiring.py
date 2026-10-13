"""HR interviews (ADR 0016): growth hires go through a person, not a stamp.

The owner's rule shapes the ladder: an opening rejects **at most two** candidates, and
the candidate after the rejections is **always** hire-worthy. Friction is occasional on
purpose (project setting `hr_friction`, default 0.28): most openings land on the first
candidate, some cost one rejection, rarely two — the record reads like a company, not a
pipeline loop.

Every rejection is grounded: the failing dimension (skill coverage, budget, team
overlap, vision) is computed from real numbers — the gap's skills, the remaining
headroom, the department envelope, the people already on the floor — and cited in the
event. Candidates are people too: each arrives with a soul (domain/soul.py) and the
event stream keeps who they were.
"""

from __future__ import annotations

import random
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select

from crew.core import events as ev
from crew.core.db import session_scope
from crew.core.models import Agent, Department, Project
from crew.domain import soul as soul_mod
from crew.domain.catalog import RoleSpec
from crew.domain.enums import ModelTier, Role

HR_DEPARTMENT = "People"
DEFAULT_FRICTION = 0.28
# reject #1 vs #2 split, once friction is on: two rejections are the rare kind
_TWO_REJECT_SHARE = 0.25

# visions the HR rubric treats as a conflict with a delivery department — curated,
# not text-matched: a conflict vision is WHY this candidate walks, and the event says so.
CONFLICT_VISIONS = [
    "Believes speed beats verification — ship it and fix it later.",
    "Thinks process is where ideas go to die; prefers to keep options open.",
    "Wants to explore ideas freely; deadlines are someone else's problem.",
    "Believes the best work happens without plans or acceptance criteria.",
]

# adjacent-but-not-the-gap skills a weak candidate may honestly carry
_GENERIC_SKILLS = ["stakeholder-updates", "scheduling", "documentation", "note-taking"]


@dataclass
class Opening:
    role: str
    title: str
    skills: list[str]
    grade: int
    headroom_micros: int          # min(project headroom, department envelope remaining)
    label: str = ""               # human tag for the record, e.g. "worker:Development r-7f3a"


@dataclass
class Candidate:
    name: str
    soul: dict
    skills: list[str]
    grade: int
    expected_spend_micros: int
    flaw: str | None = None       # skill_shortfall|grade_overreach|profile_clone|vision_conflict
    vision_score: float = 1.0
    note: str = ""


def _seed(*parts: str) -> str:
    return "crew-hiring:" + ":".join(parts)


def roll_rejects(friction: float, rng: random.Random) -> int:
    """0, 1 or 2 — and never more (the owner's cap)."""
    if friction <= 0 or rng.random() >= friction:
        return 0
    return 2 if rng.random() < _TWO_REJECT_SHARE else 1


def _used_names(rng: random.Random, existing: set[str], count: int) -> list[str]:
    names: list[str] = []
    for _ in range(count):
        _origin, _first, _last, full = soul_mod.pick_name(rng, existing | set(names))
        names.append(full)
    return names


def _strong_candidate(opening: Opening, rng: random.Random,
                      existing_names: set[str]) -> Candidate:
    name = _used_names(rng, existing_names, 1)[0]
    soul = soul_mod.compose_soul(role=opening.role, grade=opening.grade,
                                 seed=_seed("candidate", name), name=name)
    ask = max(50_000, min(opening.headroom_micros, 250_000))
    return Candidate(name=name, soul=soul, skills=list(opening.skills),
                     grade=opening.grade, expected_spend_micros=ask)


def _weak_candidate(opening: Opening, rng: random.Random, existing_names: set[str],
                    flaw: str, team: list[dict]) -> Candidate:
    name = _used_names(rng, existing_names, 1)[0]
    soul = soul_mod.compose_soul(role=opening.role, grade=opening.grade,
                                 seed=_seed("candidate", name), name=name)
    if flaw == "skill_shortfall":
        skills = [s for s in _GENERIC_SKILLS if s not in opening.skills][:2]
        expected = min(opening.headroom_micros, 180_000)
    elif flaw == "grade_overreach":
        skills = list(opening.skills)
        # the candidate's ask: a quarter over what remains — a real negotiation fact
        expected = opening.headroom_micros + max(opening.headroom_micros // 4, 50_000)
    elif flaw == "profile_clone":
        donor = rng.choice(team) if team else None
        skills = list(donor["skills"]) if donor and donor["skills"] else list(opening.skills)[:1]
        expected = min(opening.headroom_micros, 220_000)
    else:  # vision_conflict
        skills = list(opening.skills)
        expected = min(opening.headroom_micros, 220_000)
        soul["vision"] = rng.choice(CONFLICT_VISIONS)
    return Candidate(name=name, soul=soul, skills=skills, grade=opening.grade,
                     expected_spend_micros=expected, flaw=flaw,
                     vision_score=0.1 if flaw == "vision_conflict" else 1.0)


def assess(cand: Candidate, opening: Opening, *, team_skills: set[str]) -> dict[str, Any]:
    """The rubric — every number computed from the opening, the budget and the floor."""
    needed = set(opening.skills)
    covered = needed & set(cand.skills)
    coverage = (len(covered) / len(needed)) if needed else 1.0
    budget_fit = cand.expected_spend_micros <= opening.headroom_micros
    fresh = needed - team_skills
    new_coverage = len(fresh & set(cand.skills))
    complementarity = (new_coverage / len(fresh)) if fresh else 0.3
    vision = cand.vision_score
    total = round(0.45 * coverage + 0.25 * (1.0 if budget_fit else 0.0)
                  + 0.2 * min(1.0, complementarity) + 0.1 * vision, 3)

    reasons: list[str] = []
    if coverage < 0.5:
        missing = ", ".join(sorted(needed - covered)) or "the required skills"
        reasons.append(f"covers {coverage:.0%} of the gap — {missing} goes uncovered")
    if not budget_fit:
        reasons.append(f"expects {cand.expected_spend_micros}µ$ against "
                       f"{opening.headroom_micros}µ$ remaining")
    if not reasons and fresh and new_coverage == 0:
        reasons.append(f"duplicates the coverage already on the floor — the gap in "
                       f"{', '.join(sorted(fresh))} stays open")
    if vision < 0.34:
        reasons.append("vision conflicts with the department's delivery mission")
    passed = not reasons and total >= 0.55
    return {"coverage": round(coverage, 3), "budget_fit": budget_fit,
            "complementarity": round(complementarity, 3), "vision": vision,
            "total": total, "passed": passed, "reasons": reasons,
            "failed_dimension": (cand.flaw or ("rubric" if reasons else None))}


def _note(opening: Opening, cand: Candidate, scores: dict) -> str:
    if scores["passed"]:
        return (f"Pass. Covers {scores['coverage']:.0%} of the {opening.title} gap "
                f"at {cand.expected_spend_micros:,}µ$; adds coverage the floor lacks.")
    return f"Reject. {'; '.join(scores['reasons'])}."


async def _model_note(opening: Opening, cand: Candidate, scores: dict, *, project_id: str) -> str | None:
    """One grounded paragraph when a provider is configured; None offline."""
    from crew.control.council import _llm_json

    system = (
        "You are the Head of People interviewing a candidate for an AI company. Write "
        "2-3 sentences of interview note for the record. Ground EVERY claim in the "
        "numbers given — never invent experience, names or facts. End with pass/reject."
    )
    user = (f"OPENING: {opening.title} — gap skills {opening.skills}; "
            f"budget bound {opening.headroom_micros}µ$.\n"
            f"CANDIDATE: {cand.name}; skills {cand.skills}; ask {cand.expected_spend_micros}µ$; "
            f"vision “{cand.soul.get('vision')}”.\n"
            f"SCORES: {scores}.\n"
            'JSON only: {"note": "..."}')
    raw = await _llm_json(ModelTier.FAST, system, user, project_id=project_id)
    note = str((raw or {}).get("note") or "").strip()
    return note[:600] if note else None


async def _hr_head_id(project_id: str) -> str | None:
    async with session_scope() as s:
        row = await s.scalar(select(Agent).where(Agent.project_id == project_id,
                                                 Agent.role == Role.HR.value,
                                                 Agent.state != "archived"))
        return row.id if row else None


async def _floor_facts(project_id: str, department_id: str | None,
                       fallback_headroom: int) -> tuple[int, set[str], list[dict]]:
    """(budget bound, team skills, team [{name, skills}]) — all real numbers."""
    from crew.core.security import budget as budget_mod

    headroom = await budget_mod.available_micros(project_id)
    bound = min(headroom, fallback_headroom) if fallback_headroom else headroom
    team: list[dict] = []
    async with session_scope() as s:
        if department_id:
            d = await s.get(Department, department_id)
            if d is not None:
                bound = min(bound, max(0, d.budget_envelope_micros - d.spend_micros))
            rows = (await s.scalars(select(Agent).where(
                Agent.project_id == project_id, Agent.department_id == department_id,
                Agent.state != "archived"))).all()
        else:
            rows = (await s.scalars(select(Agent).where(
                Agent.project_id == project_id, Agent.state != "archived"))).all()
        team = [{"name": a.name, "skills": list(a.responsibilities or [])} for a in rows]
    team_skills = {s for m in team for s in m["skills"]}
    return bound, team_skills, team


async def hr_hire(project: Project, *, spec: RoleSpec, run_id: str, actor: str,
                  department_id: str | None = None, squad_id: str | None = None,
                  manager_id: str | None = None, rationale: str = "",
                  category: str = "", label: str = "",
                  fallback_headroom: int | None = None) -> dict:
    """One opening, interviewed and filled. Returns the hired agent (org.hire_agent)."""
    from crew.control import org

    bound, team_skills, team = await _floor_facts(
        project.id, department_id, fallback_headroom or 0)
    opening = Opening(role=spec.role.value, title=spec.title, skills=list(spec.skills),
                      grade=int(spec.grade), headroom_micros=max(50_000, bound),
                      label=label or f"{spec.role.value}:{category or project.name}")
    rng = random.Random(_seed(project.id, run_id, opening.label))
    friction = float(project.setting("hr_friction", DEFAULT_FRICTION) or 0)
    rejects = roll_rejects(friction, rng)

    hr_id = await _hr_head_id(project.id)
    desk_actor = f"agent:{hr_id}" if hr_id else actor
    await ev.emit("hiring.role.opened", project_id=project.id, run_id=run_id,
                  severity="notice", title=f"opening: {opening.title}",
                  summary=f"gap skills {', '.join(opening.skills) or '—'}; "
                          f"bound {opening.headroom_micros}µ$",
                  payload={"role": opening.role, "title": opening.title,
                           "skills": opening.skills, "grade": opening.grade,
                           "headroom_micros": opening.headroom_micros,
                           "label": opening.label},
                  actor=desk_actor)

    async with session_scope() as s:
        existing = set((await s.scalars(select(Agent.name).where(
            Agent.project_id == project.id))).all())

    flaws = ["skill_shortfall", "grade_overreach", "profile_clone", "vision_conflict"]
    rng.shuffle(flaws)
    for i in range(rejects):
        cand = _weak_candidate(opening, rng, existing | set(), flaws[i % len(flaws)], team)
        await _interview(project.id, run_id, opening, cand, team_skills, desk_actor)
        existing.add(cand.name)

    final = _strong_candidate(opening, rng, existing)
    scores = await _interview(project.id, run_id, opening, final, team_skills, desk_actor)
    interview = {"summary": final.note, "scores": scores, "candidate": final.name}

    return await org.hire_agent(
        project_id=project.id, spec=spec, department_id=department_id, squad_id=squad_id,
        manager_id=manager_id, rationale=f"{rationale} — HR: {interview['summary']}"[:400],
        actor=desk_actor, soul=final.soul, name=final.name)


async def _interview(project_id: str, run_id: str, opening: Opening, cand: Candidate,
                     team_skills: set[str], desk_actor: str) -> dict:
    await ev.emit("hiring.candidate.proposed", project_id=project_id, run_id=run_id,
                  severity="info", title=f"candidate: {cand.name}",
                  summary=cand.soul.get("vision", ""),
                  payload={"candidate": cand.name, "role": opening.role,
                           "skills": cand.skills, "grade": cand.grade,
                           "expected_spend_micros": cand.expected_spend_micros,
                           "soul": cand.soul, "label": opening.label},
                  actor=desk_actor)
    scores = assess(cand, opening, team_skills=team_skills)
    note = _note(opening, cand, scores)
    method = "deterministic"
    enriched = await _model_note(opening, cand, scores, project_id=project_id)
    if enriched:
        note, method = enriched, "model"
    cand.note = note
    await ev.emit("hiring.candidate.interviewed", project_id=project_id, run_id=run_id,
                  severity="info", title=f"interviewed: {cand.name}",
                  summary=note[:200],
                  payload={"candidate": cand.name, "scores": scores, "method": method,
                           "note": note, "label": opening.label},
                  actor=desk_actor)
    if not scores["passed"]:
        await ev.emit("hiring.candidate.rejected", project_id=project_id, run_id=run_id,
                      severity="notice", title=f"rejected: {cand.name}",
                      summary="; ".join(scores["reasons"])[:200],
                      payload={"candidate": cand.name,
                               "reason": "; ".join(scores["reasons"]),
                               "dimension": scores["failed_dimension"],
                               "label": opening.label},
                      actor=desk_actor)
    return scores


async def ensure_hr(project: Project, *, run_id: str, orchestrator_id: str | None,
                    actor: str, department_budget_usd: float = 1.0) -> dict | None:
    """One Head of People per project, seated before the first growth wave.

    Returns the created hire (for the caller's `created` report) or None when HR is
    already seated. The bootstrap hire itself is direct — the first HR head cannot
    interview themselves.
    """
    from crew.control import org

    if await _hr_head_id(project.id):
        return None
    async with session_scope() as s:
        dept = await s.scalar(select(Department).where(Department.project_id == project.id,
                                                       Department.name == HR_DEPARTMENT,
                                                       Department.status == "active"))
    if dept is not None:
        dept_id = dept.id
    else:
        d = await org.create_department(
            project_id=project.id, name=HR_DEPARTMENT,
            mission=("Hire and keep a team that fits: interview every candidate against "
                     "the gap, the budget and the team they would join."),
            budget_usd=department_budget_usd,
            charter={"category": "people", "created_for_run": run_id},
            actor=actor)
        dept_id = d["id"]
    hr = await org.hire_agent(
        project_id=project.id,
        spec=RoleSpec.from_template(
            Role.HR, mission="Head of People: own every growth hire — interview the "
                             "candidates, reject the misfits, keep the record honest."),
        department_id=dept_id, manager_id=orchestrator_id,
        rationale="first growth wave: hiring needs a person, not a stamp",
        actor=actor)
    async with session_scope() as s:
        row = await s.get(Department, dept_id)
        if row is not None and not row.head_agent_id:
            row.head_agent_id = hr["id"]
            s.add(row)
    return {"kind": "agent", **hr}
