"""Org service: planning, capability-gap detection, hiring, task DAG construction (docs/02, docs/03)."""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field

from sqlalchemy import desc, func, select

from crew.core import events as ev
from crew.core.brains import brain_service
from crew.core.db import session_scope
from crew.core.models import (
    Agent,
    AgentSkill,
    BrainEntry,
    Department,
    Project,
    Squad,
    Task,
    usd_to_micros,
)
from crew.core.reward import RewardEngine
from crew.core.security import audit, budget
from crew.core.settings import settings
from crew.domain.catalog import ROLE_TEMPLATES, SKILLS_BY_ID, RoleSpec, skills_for_keywords
from crew.domain.enums import BrainScope, Capability, Effort, Grade, ModelTier, Role, TaskState
from crew.execution.models import router
from crew.execution.runner import estimated_cost_micros

log = logging.getLogger("crew.org")

DEFAULT_PROJECT_SETTINGS: dict = {
    "autonomous_intake": True,
    "require_goal_confirmation": False,
    "require_human_verification": False,
    "max_agents": settings.max_agents_per_project,
    "max_departments": settings.max_departments_per_project,
    "max_senior_ratio": 0.4,
    "auto_hire": settings.auto_hire_default,
    "layoff_idle_days": 14,
    "reward_weights": {},
    "council_policy": {"impact": "high", "min_panel": 3, "max_rounds": 3},
    "egress_allow": [],
    "tool_policy": {"deny": [], "require_approval": []},
    "model_tiers": {},
    "retention": {"events_days": 0},
    "notify": {},
    "verification": {"min_quality": 0.4},
}

CATEGORY_TO_DEPARTMENT: dict[str, str] = {
    "org": "Operations",
    "research": "Research",
    "data": "Data",
    "engineering": "Engineering",
    "security": "Security",
    "content": "Content",
    "media": "Media",
    "design": "Design",
    "business": "Business",
    "meta": "Quality",
}

COMMON_CAPS = [Capability.BRAIN_READ, Capability.BRAIN_WRITE, Capability.COMMS_ASK,
               Capability.COMMS_ESCALATE, Capability.ARTIFACT_PUBLISH, Capability.HUMAN_APPROVE]

# Who actually does the work: individual contributors first, managers only when nobody else can
# (docs/02 §2 authority matrix — a lead sequences and integrates, it does not absorb the backlog).
ROLE_ASSIGNMENT_PENALTY: dict[str, float] = {
    "worker": 0.0, "specialist": 0.0, "analyst": 0.0, "critic": 0.05,
    "evaluator": 0.10, "architect": 0.10, "lead": 0.30, "librarian": 0.30,
    "head": 0.60, "decider": 0.60, "orchestrator": 1.0,
}


# ── project ─────────────────────────────────────────────────────────────────────────
async def create_project(*, name: str, goal: str = "", budget_usd: float | None = None,
                         description: str = "", owner_id: str | None = None,
                         settings_patch: dict | None = None) -> dict:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "project"
    cap_usd = min(budget_usd or settings.default_project_budget_usd, settings.hard_budget_usd)
    p = Project(name=name, slug=slug, goal=goal, description=description, owner_id=owner_id,
                settings={**DEFAULT_PROJECT_SETTINGS, **(settings_patch or {})},
                budget_cap_micros=usd_to_micros(cap_usd))
    async with session_scope() as s:
        s.add(p)
        await s.flush()
        pid = p.id
    project_brain = await brain_service.ensure_project_brain(pid)
    async with session_scope() as s:
        row = await s.get(Project, pid)
        row.settings = {**row.settings, "project_brain_id": project_brain}
        s.add(row)
    settings.workspace_dir(pid).mkdir(parents=True, exist_ok=True)
    settings.artifacts_dir(pid).mkdir(parents=True, exist_ok=True)
    # every project has exactly one orchestrator (docs/02 §1 invariant)
    orch = await hire_agent(project_id=pid, spec=RoleSpec.from_template(Role.ORCHESTRATOR),
                            rationale="project bootstrap: executive owner of the goal")
    async with session_scope() as s:
        row = await s.get(Project, pid)
        row.settings = {**row.settings, "orchestrator_id": orch["id"]}
        s.add(row)
    await ev.emit("project.created", project_id=pid, severity="notice", title=f"project created: {name}",
                  payload={"project_id": pid, "name": name, "budget_usd": cap_usd}, actor="user")
    await audit(actor_kind="user", actor_id=owner_id or "local", action="project.created",
                resource_kind="project", resource_id=pid, reason=f"budget=${cap_usd}")
    return await get_project(pid)


async def get_project(project_id: str) -> dict:
    async with session_scope() as s:
        p = await s.get(Project, project_id)
        if p is None:
            raise KeyError(project_id)
    return serialize_project(p)


def serialize_project(p: Project) -> dict:
    return {
        "id": p.id, "name": p.name, "slug": p.slug, "goal": p.goal, "status": p.status,
        "stage": p.stage, "description": p.description,
        "budget_usd": p.budget_usd, "spend_usd": p.spend_usd,
        "spend_ratio": round(p.spend_micros / p.budget_cap_micros, 4) if p.budget_cap_micros else 0.0,
        "reserved_usd": round(p.reserved_micros / 1e6, 6),
        "settings": p.settings or {}, "tags": p.tags or [],
        "created_at": p.created_at.isoformat(), "archived_at": p.archived_at.isoformat() if p.archived_at else None,
    }


async def list_projects() -> list[dict]:
    async with session_scope() as s:
        rows = (await s.scalars(select(Project).order_by(desc(Project.created_at)))).all()
    out = []
    for p in rows:
        d = serialize_project(p)
        async with session_scope() as s:
            d["agents"] = int(await s.scalar(select(func.count(Agent.id)).where(
                Agent.project_id == p.id, Agent.state != "archived")))
            d["departments"] = int(await s.scalar(select(func.count(Department.id)).where(
                Department.project_id == p.id, Department.status != "archived")))
            d["open_tasks"] = int(await s.scalar(select(func.count(Task.id)).where(
                Task.project_id == p.id, Task.state.in_(["pending", "blocked", "ready", "assigned", "running"]))))
            d["pending_approvals"] = 0
        out.append(d)
    return out


# ── departments, squads, agents ─────────────────────────────────────────────────────
async def create_department(*, project_id: str, name: str, mission: str, budget_usd: float = 0.0,
                            capabilities: list[str] | None = None, charter: dict | None = None,
                            actor: str = "system") -> dict:
    async with session_scope() as s:
        p = await s.get(Project, project_id)
        count = int(await s.scalar(select(func.count(Department.id)).where(
            Department.project_id == project_id, Department.status != "archived")))
        if count >= int(p.setting("max_departments", settings.max_departments_per_project)):
            raise ValueError("org_limit_reached: max departments for this project")
        d = Department(project_id=project_id, name=name, mission=mission,
                       budget_envelope_micros=usd_to_micros(budget_usd),
                       capabilities=capabilities or [], charter=charter or {})
        s.add(d)
        await s.flush()
        did = d.id
    brain = await brain_service.ensure_brain(project_id, BrainScope.DEPARTMENT, did, f"{name} department")
    async with session_scope() as s:
        row = await s.get(Department, did)
        row.brain_id = brain
        s.add(row)
    await ev.emit("org.department.created", project_id=project_id, department_id=did, severity="notice",
                  title=f"department created: {name}", summary=mission,
                  payload={"department_id": did, "name": name, "mission": mission,
                           "budget_usd": budget_usd, "brain_id": brain},
                  actor=actor)
    await audit(actor_kind="system", actor_id=actor, action="department.created",
                resource_kind="department", resource_id=did, reason=mission[:200])
    return {"id": did, "name": name, "mission": mission, "brain_id": brain, "budget_usd": budget_usd}


async def create_squad(*, project_id: str, department_id: str, name: str, mission: str = "",
                       workstream: str = "", lead_agent_id: str | None = None, actor: str = "system") -> dict:
    async with session_scope() as s:
        sq = Squad(project_id=project_id, department_id=department_id, name=name, mission=mission,
                   workstream=workstream, lead_agent_id=lead_agent_id)
        s.add(sq)
        await s.flush()
        sid = sq.id
    await ev.emit("org.squad.created", project_id=project_id, department_id=department_id,
                  squad_id=sid, title=f"squad formed: {name}", summary=mission,
                  payload={"squad_id": sid, "name": name, "mission": mission, "lead": lead_agent_id},
                  actor=actor)
    return {"id": sid, "name": name, "department_id": department_id, "lead_agent_id": lead_agent_id}


async def hire_agent(*, project_id: str, spec: RoleSpec, department_id: str | None = None,
                     squad_id: str | None = None, manager_id: str | None = None,
                     rationale: str = "", actor: str = "system") -> dict:
    # hiring respects the budget (docs/17 batch 2): a project at its ceiling must not be
    # staffed into the ground by a planner loop. estimate_agent_cost finally guards a decision.
    est = estimate_agent_cost(spec.role)
    available = await budget.available_micros(project_id)
    # The estimate rides in the message; the gate itself is the breaker — a project whose
    # ceiling was already reached must not grow, while a fresh project's bootstrap hire
    # passes (the cap governs SPEND, and staff_gaps' plan gate is what stops a planner
    # loop from over-building a small project).
    if budget.breaker_open(project_id):
        await ev.emit("budget.exceeded", project_id=project_id, severity="warning",
                      title="hire refused: no headroom",
                      summary=f"a {spec.role.value} needs ~{est} micro-dollars of headroom",
                      payload={"scope_kind": "org", "scope_id": project_id,
                               "needed_micros": est, "available_micros": available})
        raise ValueError("budget: not enough headroom to staff this project")
    async with session_scope() as s:
        p = await s.get(Project, project_id)
        active = int(await s.scalar(select(func.count(Agent.id)).where(
            Agent.project_id == project_id, Agent.state != "archived")))
        cap = int(p.setting("max_agents", settings.max_agents_per_project))
        if active >= cap:
            raise ValueError(f"org_limit_reached: {active}/{cap} agents")
        # anti-thrash: refuse an identical role laid off RECENTLY (docs/02 §5). "Recently"
        # needs a clock — without the window an archive from any era blocks a no-rationale
        # rehire until the project dies: a policy nothing ever expires (docs/17 batch 3).
        from datetime import UTC, datetime, timedelta

        window_days = int(p.setting("layoff_idle_days", 14) or 14)
        floor = datetime.now(UTC) - timedelta(days=window_days)
        recent = await s.scalar(select(Agent).where(Agent.project_id == project_id,
                                                    Agent.role == spec.role.value,
                                                    Agent.state == "archived",
                                                    Agent.archived_at >= floor)
                                .order_by(desc(Agent.archived_at)).limit(1))
        if recent and not rationale:
            raise ValueError("hire refused: identical role was laid off recently without a new rationale")

        grade = spec.grade
        if spec.role in (Role.WORKER, Role.ANALYST) and grade > Grade.JUNIOR:
            grade = Grade.JUNIOR           # cheap by default; promotion is earned (docs/02 §5)
        a = Agent(
            project_id=project_id, department_id=department_id, squad_id=squad_id, manager_id=manager_id,
            name=await _unique_name(s, project_id, spec.title, spec.role),
            role=spec.role.value, grade=int(grade), mission=spec.mission,
            responsibilities=spec.skills[:8], tools=sorted({c.value for c in spec.capabilities}),
            hire_rationale=rationale, state="idle",
        )
        RewardEngine.apply_grade_limits_pure(a)
        s.add(a)
        await s.flush()
        aid = a.id
        for sid in spec.skills:
            if sid in SKILLS_BY_ID:
                s.add(AgentSkill(agent_id=aid, skill_id=sid, proficiency=0.5))
        # personal brain
        b = await _ensure_agent_brain(s, project_id, aid)
        row = await s.get(Agent, aid)
        row.brain_id = b
        s.add(row)

    await ev.emit("org.agent.hired", project_id=project_id, department_id=department_id, squad_id=squad_id,
                  agent_id=aid, severity="notice", title=f"hired {spec.title} (grade {Grade(int(grade)).label})",
                  summary=spec.mission, payload={"agent_id": aid, "role": spec.role.value,
                                                 "grade": int(grade), "skills": spec.skills,
                                                 "rationale": rationale},
                  actor=actor)
    await audit(actor_kind="system", actor_id=actor, action="agent.hired", resource_kind="agent",
                resource_id=aid, reason=rationale[:200])
    return {"id": aid, "name": spec.title, "role": spec.role.value, "grade": int(grade),
            "department_id": department_id, "squad_id": squad_id, "brain_id": b, "skills": spec.skills}


async def _ensure_agent_brain(s, project_id: str, agent_id: str) -> str:
    from crew.core.models import Brain

    existing = await s.scalar(select(Brain).where(Brain.project_id == project_id,
                                                 Brain.scope == BrainScope.AGENT.value,
                                                 Brain.owner_id == agent_id))
    if existing:
        return existing.id
    b = Brain(project_id=project_id, scope=BrainScope.AGENT.value, owner_id=agent_id, label="personal")
    s.add(b)
    await s.flush()
    return b.id


async def _unique_name(s, project_id: str, title: str, role: Role) -> str:
    base = title if role not in (Role.WORKER,) else "Specialist"
    n = int(await s.scalar(select(func.count(Agent.id)).where(Agent.project_id == project_id))) + 1
    return f"{base} #{n}"


async def layoff_agent(*, project_id: str, agent_id: str, reason: str, actor: str = "system") -> None:
    from datetime import UTC, datetime

    async with session_scope() as s:
        a = await s.get(Agent, agent_id)
        if a is None or a.project_id != project_id:
            raise KeyError(agent_id)
        if a.role == Role.ORCHESTRATOR.value:
            raise ValueError("cannot lay off the project orchestrator")
        a.state = "archived"
        a.archived_at = datetime.now(UTC)
        s.add(a)
    await ev.emit("org.agent.archived", project_id=project_id, agent_id=agent_id, severity="notice",
                  title=f"layoff: {a.name}", summary=reason, payload={"agent_id": agent_id, "reason": reason},
                  actor=actor)
    await audit(actor_kind="system", actor_id=actor, action="agent.archived", resource_kind="agent",
                resource_id=agent_id, reason=reason[:200])


# ── planning ────────────────────────────────────────────────────────────────────────
@dataclass
class PlannedTask:
    key: str
    title: str
    description: str
    deliverable: str = ""
    required_skills: list[dict] = field(default_factory=list)   # [{skill, weight}]
    acceptance_criteria: list[str] = field(default_factory=list)
    depends_on: list[str] = field(default_factory=list)         # keys
    effort: str = "M"
    priority: int = 2
    output_contract: dict = field(default_factory=dict)


@dataclass
class Plan:
    success_criteria: list[str]
    assumptions: list[str]
    tasks: list[PlannedTask]
    interpretation: str = ""
    source: str = "heuristic"

    def to_dict(self) -> dict:
        return {
            "interpretation": self.interpretation, "success_criteria": self.success_criteria,
            "assumptions": self.assumptions, "source": self.source,
            "tasks": [{"key": t.key, "title": t.title, "description": t.description,
                       "deliverable": t.deliverable, "required_skills": t.required_skills,
                       "acceptance_criteria": t.acceptance_criteria, "depends_on": t.depends_on,
                       "effort": t.effort, "priority": t.priority, "output_contract": t.output_contract}
                      for t in self.tasks],
        }


def plan_heuristic(goal: str, *, max_tasks: int = 8) -> Plan:
    """Deterministic, dependency-free decomposition. Also the fallback when no model is available."""
    goal = goal.strip()
    skills = skills_for_keywords(goal, limit=6)
    criteria = [
        f"The stated goal is satisfied: {goal[:160]}",
        "The deliverable is a concrete artifact, not a plan to make one",
        "Every factual claim carries a source or is explicitly marked unverified",
    ]
    steps: list[PlannedTask] = []
    steps.append(PlannedTask(
        key="research",
        title="Research and evidence gathering",
        description=(f"Establish what is actually known about: {goal}\n"
                     "Collect primary sources, note contradictions, and record provenance for "
                     "everything you assert. Do not propose solutions yet."),
        deliverable="An evidence brief: findings, sources, uncertainties, open questions.",
        required_skills=[{"skill": s, "weight": 1.0} for s in skills[:3] or ["web-research"]],
        acceptance_criteria=["At least 3 independent sources are cited with URLs",
                            "Contradictions between sources are stated explicitly",
                            "Uncertainties are listed rather than smoothed over"],
        effort="M", priority=1,
        output_contract={"type": "object", "properties": {"findings": {"type": "array"},
                                                          "sources": {"type": "array"},
                                                          "uncertainties": {"type": "array"}}},
    ))
    # choose the shape of the core work from the skills detected
    core_skills = skills or ["critical-review"]
    if any(s in ("python", "typescript", "csharp", "system-design", "api-design") for s in core_skills):
        steps.append(PlannedTask(
            key="build",
            title="Produce the implementation",
            description=(f"Implement the solution for: {goal}\n"
                         "Work inside the project workspace. Keep it minimal and verifiable; "
                         "publish artifacts and include the exact commands to reproduce."),
            deliverable="Working implementation plus a short reproduction note.",
            required_skills=[{"skill": s, "weight": 1.0} for s in core_skills if s in
                             ("python", "typescript", "csharp", "system-design", "api-design",
                              "unit-testing", "debugging", "devops", "docker", "sql-design")] or
                            [{"skill": "python", "weight": 1.0}],
            acceptance_criteria=["The artifact exists in the workspace and is non-empty",
                                 "It runs (or its tests pass) and the command is documented",
                                 "Known limitations are stated"],
            depends_on=["research"], effort="L", priority=2,
        ))
    if any(s in ("copywriting", "content", "storytelling", "seo", "technical-writing") for s in core_skills):
        steps.append(PlannedTask(
            key="draft",
            title="Draft the deliverable content",
            description=f"Write the requested content for: {goal}. Ground every claim in the research brief.",
            deliverable="A complete draft, structured for the target reader.",
            required_skills=[{"skill": s, "weight": 1.0} for s in core_skills if s in
                             ("copywriting", "technical-writing", "storytelling", "seo", "editing")] or
                            [{"skill": "copywriting", "weight": 1.0}],
            acceptance_criteria=["Every section in the brief is answered",
                                 "Claims trace back to cited sources",
                                 "No filler: each paragraph carries information"],
            depends_on=["research"], effort="L", priority=2,
        ))
    if any(s in ("data-analysis", "statistics", "sql-design", "database-design") for s in core_skills):
        steps.append(PlannedTask(
            key="analyse",
            title="Analyse the data",
            description=f"Answer the quantitative part of: {goal}. Show the method, not just the number.",
            deliverable="Analysis with method, inputs and results.",
            required_skills=[{"skill": s, "weight": 1.0} for s in core_skills if s in
                             ("data-analysis", "statistics", "sql-design", "database-design")] or
                            [{"skill": "data-analysis", "weight": 1.0}],
            acceptance_criteria=["Method is stated and reproducible",
                                 "Uncertainty is quantified",
                                 "Assumptions are explicit"],
            depends_on=["research"], effort="M", priority=2,
        ))
    if not steps[1:]:
        steps.append(PlannedTask(
            key="solve",
            title="Produce the solution",
            description=f"Deliver the core work for: {goal}. Use the evidence brief as input.",
            deliverable="The main deliverable requested by the goal.",
            required_skills=[{"skill": s, "weight": 1.0} for s in core_skills[:3]],
            acceptance_criteria=["The deliverable directly answers the goal",
                                 "Each acceptance criterion is addressed explicitly",
                                 "Limitations are stated"],
            depends_on=["research"], effort="L", priority=2,
        ))
    steps.append(PlannedTask(
        key="review",
        title="Adversarial review of the deliverable",
        description=("Attack the deliverable: find factual errors, unsupported claims, missing "
                     "requirements and cheaper alternatives. Report only real problems."),
        deliverable="Review verdict: defects found (with evidence) or an explicit 'could not break it'.",
        required_skills=[{"skill": "critical-review", "weight": 0.6},
                         {"skill": "verification", "weight": 0.4}],
        acceptance_criteria=["Every objection names a concrete failure mode",
                             "Claims are checked against the artifacts, not the narrative"],
        depends_on=[t.key for t in steps[1:]] or ["research"], effort="M", priority=3,
    ))
    return Plan(success_criteria=criteria,
                assumptions=["The goal text is the full requirement (no hidden stakeholder)",
                             "Outbound publication is not required"],
                tasks=steps[:max_tasks], interpretation=f"Deliver: {goal[:200]}", source="heuristic")


PLANNER_PROMPT = """You are the Orchestrator of an autonomous AI organization. Decompose the goal
into 3-6 tasks that can each be independently verified. Return ONLY JSON:

{"interpretation": "...", "success_criteria": ["..."], "assumptions": ["..."],
 "tasks": [{"key":"short_id","title":"...","description":"...","deliverable":"...",
            "required_skills":[{"skill":"python","weight":1.0}],
            "acceptance_criteria":["..."],"depends_on":["other_key"],"effort":"S|M|L|XL",
            "priority":1,"output_contract":{}}]}

Rules: acceptance criteria are mandatory and must be checkable from artifacts. Use the exact
skill ids from this catalog when possible: {skills}. At most 6 tasks. depends_on must reference
keys defined in the same response and must not form a cycle."""


async def plan_run(*, project: Project, goal: str, orchestrator: Agent | None = None) -> Plan:
    """LLM planning when a provider key exists, deterministic planning otherwise."""
    plan: Plan | None = None
    tier_model = router.model_for_tier(ModelTier.REASONING)
    if settings.provider_key_for(tier_model) and not settings.offline_llm:
        try:
            from crewai import LLM

            llm = LLM(model=tier_model, temperature=0.1, api_key=settings.provider_key_for(tier_model))
            catalog = ", ".join(sorted(SKILLS_BY_ID)[:60])
            raw = llm.call(messages=[
                {"role": "system", "content": PLANNER_PROMPT.format(skills=catalog)},
                {"role": "user", "content": f"PROJECT: {project.name}\nGOAL: {goal}"},
            ])
            plan = _parse_plan(str(raw))
        except Exception as e:
            log.warning("LLM planning failed (%s); falling back to heuristic plan", e)
    if plan is None:
        plan = plan_heuristic(goal)
    _validate_plan(plan)
    return plan


def _parse_plan(raw: str) -> Plan | None:
    match = re.search(r"\{.*\}", raw, re.S)
    if not match:
        return None
    data = json.loads(match.group(0))
    tasks = [
        PlannedTask(
            key=str(t.get("key") or f"t{i}"), title=str(t.get("title", ""))[:200],
            description=str(t.get("description", "")), deliverable=str(t.get("deliverable", "")),
            required_skills=[{"skill": str(r.get("skill")), "weight": float(r.get("weight", 1.0))}
                             for r in (t.get("required_skills") or [])],
            acceptance_criteria=[str(c) for c in (t.get("acceptance_criteria") or [])],
            depends_on=[str(d) for d in (t.get("depends_on") or [])],
            effort=str(t.get("effort", "M")).upper()[:2], priority=int(t.get("priority", 2)),
            output_contract=t.get("output_contract") or {},
        )
        for i, t in enumerate(data.get("tasks") or [])
    ]
    if not tasks:
        return None
    return Plan(success_criteria=[str(c) for c in (data.get("success_criteria") or [])],
                assumptions=[str(a) for a in (data.get("assumptions") or [])],
                tasks=tasks, interpretation=str(data.get("interpretation", "")), source="llm")


def _validate_plan(plan: Plan) -> None:
    keys = {t.key for t in plan.tasks}
    for t in plan.tasks:
        t.depends_on = [d for d in t.depends_on if d in keys and d != t.key]
        if not t.acceptance_criteria:
            t.acceptance_criteria = [f"The deliverable satisfies: {t.title}"]
        if t.effort not in {e.value for e in Effort}:
            t.effort = "M"
    if _has_cycle({t.key: t.depends_on for t in plan.tasks}):
        for t in plan.tasks:      # break cycles deterministically instead of failing the run
            t.depends_on = [d for d in t.depends_on if d == "research"] or []
    if _has_cycle({t.key: t.depends_on for t in plan.tasks}):
        raise ValueError("dag_cycle: plan dependencies form a cycle")


def _has_cycle(graph: dict[str, list[str]]) -> bool:
    """Kahn's algorithm (docs/03 §3.3)."""
    indeg = {k: 0 for k in graph}
    for k, deps in graph.items():
        for d in deps:
            if d in indeg:
                indeg[k] += 1
    queue = [k for k, v in indeg.items() if v == 0]
    seen = 0
    edges: dict[str, list[str]] = {k: [] for k in graph}
    for k, deps in graph.items():
        for d in deps:
            if d in edges:
                edges[d].append(k)
    while queue:
        node = queue.pop()
        seen += 1
        for nxt in edges.get(node, []):
            indeg[nxt] -= 1
            if indeg[nxt] == 0:
                queue.append(nxt)
    return seen != len(graph)


async def persist_plan(*, project_id: str, run_id: str, plan: Plan) -> dict[str, str]:
    """Create Task rows for a plan, with dependency ids resolved. Returns key → task_id."""
    key_to_id: dict[str, str] = {}
    async with session_scope() as s:
        for t in plan.tasks:
            row = Task(
                run_id=run_id, project_id=project_id, title=t.title, description=t.description,
                deliverable=t.deliverable, required_skills=t.required_skills,
                acceptance_criteria=t.acceptance_criteria, output_contract=t.output_contract,
                effort=t.effort, priority=t.priority,
                state=TaskState.PENDING.value,
            )
            s.add(row)
            await s.flush()
            key_to_id[t.key] = row.id
        for t in plan.tasks:
            if t.depends_on:
                row = await s.get(Task, key_to_id[t.key])
                row.depends_on = [key_to_id[d] for d in t.depends_on if d in key_to_id]
                s.add(row)
        rows = (await s.scalars(select(Task).where(Task.run_id == run_id))).all()
    for r in rows:
        await ev.emit("task.created", project_id=project_id, run_id=run_id, task_id=r.id,
                      title=f"task planned: {r.title[:70]}",
                      payload={"task_id": r.id, "title": r.title, "effort": r.effort,
                               "required_skills": r.required_skills, "depends_on": r.depends_on},
                      actor="agent:orchestrator")
    return key_to_id


# ── capability gaps & staffing ──────────────────────────────────────────────────────
def required_skill_weights(tasks: list[Task]) -> dict[str, float]:
    out: dict[str, float] = {}
    for t in tasks:
        for req in (t.required_skills or []):
            sid = req.get("skill")
            if sid:
                out[sid] = out.get(sid, 0.0) + float(req.get("weight", 1.0))
    return out


async def current_coverage(project_id: str) -> dict[str, float]:
    """Best proficiency per skill across the active roster."""
    async with session_scope() as s:
        rows = (await s.execute(
            select(AgentSkill.skill_id, func.max(AgentSkill.proficiency))
            .join(Agent, Agent.id == AgentSkill.agent_id)
            .where(Agent.project_id == project_id, Agent.state != "archived")
            .group_by(AgentSkill.skill_id)
        )).all()
    return {sid: float(p or 0.0) for sid, p in rows}


async def capability_gaps(project_id: str, needed: dict[str, float], threshold: float = 0.75) -> list[str]:
    coverage = await current_coverage(project_id)
    return [sid for sid in needed if coverage.get(sid, 0.0) < threshold]


async def department_for_category(project_id: str, category: str) -> Department | None:
    name = CATEGORY_TO_DEPARTMENT.get(category, "Operations")
    async with session_scope() as s:
        return await s.scalar(select(Department).where(Department.project_id == project_id,
                                                       Department.name == name,
                                                       Department.status != "archived"))


async def staff_gaps(*, project: Project, gaps: list[str], run_id: str, trace_id: str,
                     orchestrator_id: str | None = None, per_department_budget_usd: float = 1.5) -> list[dict]:
    """Turn capability gaps into departments/agents (docs/02 §5). Cheap by default."""
    created: list[dict] = []
    by_category: dict[str, list[str]] = {}
    for sid in gaps:
        skill = SKILLS_BY_ID.get(sid)
        if skill is None:
            continue
        by_category.setdefault(skill.category, []).append(sid)

    for category, skill_ids in by_category.items():
        # the cost of staffing this gap, checked before a single row is written
        # (docs/17 batch 2 — estimate_agent_cost guards the decision it was written for)
        est_workers = max(1, len(skill_ids) // 2)
        plan_cost = (estimate_agent_cost(Role.HEAD) + estimate_agent_cost(Role.LEAD)
                     + est_workers * estimate_agent_cost(Role.WORKER))
        headroom = await budget.available_micros(project.id)
        if plan_cost > headroom:
            await ev.emit("budget.exceeded", project_id=project.id, run_id=run_id, severity="warning",
                          title=f"staffing refused: {category}",
                          summary=f"staffing {category} needs ~{plan_cost} µ$; {headroom} µ$ available",
                          payload={"scope_kind": "org", "scope_id": project.id,
                                   "needed_micros": plan_cost, "available_micros": headroom})
            continue
        dept_name = CATEGORY_TO_DEPARTMENT.get(category, "Operations")
        dept = await department_for_category(project.id, category)
        if dept is None:
            try:
                caps = sorted({c.value for s_ in skill_ids for c in SKILLS_BY_ID[s_].typical_tools} |
                              {c.value for c in COMMON_CAPS})
                d = await create_department(
                    project_id=project.id, name=dept_name,
                    mission=f"Own the {category} capability for this project: deliver verified work in {', '.join(skill_ids)}.",
                    budget_usd=per_department_budget_usd, capabilities=caps,
                    charter={"category": category, "skills": skill_ids, "created_for_run": run_id},
                    actor=f"agent:{orchestrator_id}" if orchestrator_id else "system",
                )
                created.append({"kind": "department", **d})
                dept_id = d["id"]
            except ValueError as e:
                log.info("department creation refused: %s", e)
                continue
            try:
                head = await hire_agent(
                    project_id=project.id,
                    spec=RoleSpec.from_template(Role.HEAD, mission=f"Head of {dept_name}", rationale=f"new department for {skill_ids}"),
                    department_id=dept_id, manager_id=orchestrator_id,
                    rationale=f"department {dept_name} needs a head to staff {', '.join(skill_ids)}",
                    actor=f"agent:{orchestrator_id}" if orchestrator_id else "system",
                )
            except ValueError as e:
                log.info("head hire refused: %s", e)
                continue
            created.append({"kind": "agent", **head})
            async with session_scope() as s:
                row = await s.get(Department, dept_id)
                row.head_agent_id = head["id"]
                s.add(row)
            head_id = head["id"]
        else:
            dept_id = dept.id
            head_id = dept.head_agent_id

        squad = await create_squad(
            project_id=project.id, department_id=dept_id, name=f"{dept_name} squad {run_id[:4]}",
            mission=f"Execute {category} tasks for run {run_id[:6]}",
            workstream=", ".join(skill_ids)[:200],
            actor=f"agent:{orchestrator_id}" if orchestrator_id else "system",
        )
        created.append({"kind": "squad", **squad})
        try:
            lead = await hire_agent(
                project_id=project.id,
                spec=RoleSpec.from_template(Role.LEAD, skills=skill_ids, mission=f"Lead the {dept_name} squad",
                                            rationale=f"sequencing and integration for {skill_ids}"),
                department_id=dept_id, squad_id=squad["id"],
                manager_id=head_id, rationale=f"a squad of {len(skill_ids)} skills needs a lead",
                actor=f"agent:{orchestrator_id}" if orchestrator_id else "system",
            )
        except ValueError as e:
            log.info("lead hire refused: %s", e)
            continue
        created.append({"kind": "agent", **lead})
        async with session_scope() as s:
            row = await s.get(Squad, squad["id"])
            row.lead_agent_id = lead["id"]
            s.add(row)
        # workers: one per two skills, minimum one
        worker_count = max(1, len(skill_ids) // 2)
        caps = [c.value for c in COMMON_CAPS] + [Capability.FS_WORKSPACE.value, Capability.CODE_PYTHON.value,
                                                 Capability.NET_SEARCH.value, Capability.NET_FETCH.value,
                                                 Capability.SHELL_SANDBOX.value]
        if category == "engineering":
            caps.append(Capability.GIT_LOCAL.value)
        if category in ("research", "data"):
            caps.append(Capability.DATA_SQL.value)
        for i in range(worker_count):
            spec = RoleSpec(
                title=f"{category.capitalize()} Specialist",
                role=Role.WORKER, mission=f"Execute {category} tasks: {', '.join(skill_ids)}",
                grade=Grade.JUNIOR, skills=skill_ids,
                capabilities=[Capability(c) for c in dict.fromkeys(caps)],
                rationale=f"capacity for {len(skill_ids)} skills in {dept_name}",
            )
            try:
                w = await hire_agent(project_id=project.id, spec=spec, department_id=dept_id,
                                     squad_id=squad["id"], manager_id=lead["id"],
                                     rationale=f"worker {i + 1} for {category}",
                                     actor=f"agent:{orchestrator_id}" if orchestrator_id else "system")
                created.append({"kind": "agent", **w})
            except ValueError as e:
                log.info("hire refused: %s", e)
                break
    return created


async def assign_tasks(*, project_id: str, run_id: str) -> int:
    """Match each ready task to the best available agent in its department (docs/03 §5)."""
    assigned = 0
    async with session_scope() as s:
        tasks = (await s.scalars(select(Task).where(Task.run_id == run_id))).all()
        agents = (await s.scalars(select(Agent).where(Agent.project_id == project_id,
                                                      Agent.state != "archived"))).all()
        skills_by_agent: dict[str, dict[str, float]] = {}
        for a in agents:
            rows = (await s.execute(select(AgentSkill.skill_id, AgentSkill.proficiency)
                                    .where(AgentSkill.agent_id == a.id))).all()
            skills_by_agent[a.id] = {sid: float(p) for sid, p in rows}

        for t in tasks:
            if t.state not in (TaskState.PENDING.value, TaskState.READY.value):
                continue
            needed = {r["skill"]: float(r.get("weight", 1.0)) for r in (t.required_skills or [])}
            best, best_score, best_coverage = None, 0.0, 0.0
            for a in agents:
                if a.role in (Role.ORCHESTRATOR.value, Role.HEAD.value) or a.state in ("busy", "archived", "suspended"):
                    continue
                prof = skills_by_agent.get(a.id, {})
                coverage = sum(w * prof.get(sid, 0.0) for sid, w in needed.items())
                # Grade is not coverage: without this check an agent holding NONE of the
                # required skills still scored +0.01 on the grade bonus and took the task,
                # when the honest answer was to park it (docs/02 §4, docs/03 §5).
                if needed and coverage <= 0.0:
                    continue
                score = coverage
                score += 0.05 * (a.grade / 5)          # slight preference for experience
                score -= 0.001 * (a.tasks_done)        # spread the work
                # managers manage: a lead only takes IC work when no hands are free (docs/02 §2)
                score -= ROLE_ASSIGNMENT_PENALTY.get(a.role, 0.25)
                if score > best_score:
                    best, best_score, best_coverage = a, score, coverage
            if best is None:
                # no capable agent: park the task for escalation rather than running it badly
                t.state = TaskState.BLOCKED.value
                t.escalation_reason = "no agent covers the required skills"
                s.add(t)
                await ev.emit("task.escalated", project_id=project_id, run_id=run_id, task_id=t.id,
                              severity="warning", title=f"task blocked: {t.title[:60]}",
                              payload={"task_id": t.id, "reason": "no agent covers the required skills"},
                              actor="system:scheduler")
                continue
            t.assignee_agent_id = best.id
            t.assignee_squad_id = best.squad_id
            t.department_id = best.department_id
            t.state = TaskState.ASSIGNED.value
            s.add(t)
            assigned += 1
            await ev.emit("task.assigned", project_id=project_id, run_id=run_id, task_id=t.id,
                          agent_id=best.id, department_id=best.department_id, squad_id=best.squad_id,
                          title=f"{best.name} ← {t.title[:50]}",
                          payload={"task_id": t.id, "agent_id": best.id, "match_score": round(best_score, 3),
                                   "coverage": round(best_coverage, 3)},
                          actor="system:scheduler")
    return assigned


async def ready_tasks(project_id: str, run_id: str | None = None) -> list[Task]:
    """Pure read: tasks whose dependencies are satisfied.

    Never mutates state — mutating ORM rows inside a read session commits them (a real bug this
    replaced: dependent tasks were being written as 'blocked' just by being inspected).
    """
    async with session_scope() as s:
        stmt = select(Task).where(Task.project_id == project_id)
        if run_id:
            stmt = stmt.where(Task.run_id == run_id)
        tasks = (await s.scalars(stmt.order_by(Task.priority, Task.created_at))).all()
        done = {t.id for t in tasks if t.state == TaskState.COMPLETED.value}
        out: list[Task] = []
        for t in tasks:
            if t.state not in (TaskState.PENDING.value, TaskState.READY.value,
                               TaskState.ASSIGNED.value, TaskState.BLOCKED.value):
                continue
            if any(d not in done for d in (t.depends_on or [])):
                continue
            out.append(t)
        s.expunge_all()
        return out


async def revive_blocked(project_id: str, run_id: str) -> int:
    """Un-block tasks whose dependencies are now satisfied (deps finished after they were parked)."""
    async with session_scope() as s:
        stmt = select(Task).where(Task.project_id == project_id, Task.state == TaskState.BLOCKED.value)
        if run_id:
            stmt = stmt.where(Task.run_id == run_id)
        blocked = (await s.scalars(stmt)).all()
        all_tasks = (await s.scalars(select(Task).where(Task.project_id == project_id))).all()
        done = {t.id for t in all_tasks if t.state == TaskState.COMPLETED.value}
        revived = 0
        for t in blocked:
            if any(d not in done for d in (t.depends_on or [])):
                continue
            if (t.escalation_reason or "").startswith("no agent"):
                continue          # a capability problem, not a dependency problem
            t.state = TaskState.ASSIGNED.value if t.assignee_agent_id else TaskState.PENDING.value
            t.escalation_reason = ""
            s.add(t)
            revived += 1
        return revived


async def org_tree(project_id: str) -> dict:
    async with session_scope() as s:
        project = await s.get(Project, project_id)
        if project is None:
            raise KeyError(project_id)
        depts = (await s.scalars(select(Department).where(Department.project_id == project_id))).all()
        squads = (await s.scalars(select(Squad).where(Squad.project_id == project_id))).all()
        agents = (await s.scalars(select(Agent).where(Agent.project_id == project_id))).all()
        task_counts = dict((await s.execute(
            select(Task.assignee_agent_id, func.count(Task.id)).where(
                Task.project_id == project_id,
                Task.state.in_(["assigned", "running", "ready", "pending"]))
            .group_by(Task.assignee_agent_id))).all())

    def agent_node(a: Agent) -> dict:
        return {
            "id": a.id, "kind": "agent", "name": a.name, "role": a.role, "grade": int(a.grade),
            "grade_label": Grade(int(a.grade)).label, "state": a.state, "score": a.score,
            "score_100": a.score_100, "success_rate": a.success_rate, "autonomy": a.autonomy,
            "model_tier": a.model_tier, "skills": list(a.responsibilities or []),
            "manager_id": a.manager_id, "department_id": a.department_id, "squad_id": a.squad_id,
            "open_tasks": int(task_counts.get(a.id, 0)),
            "spend_usd": round(a.spend_today_micros / 1e6, 4),
        }

    orch_id = (project.settings or {}).get("orchestrator_id")
    nodes = []
    for d in depts:
        d_squads = [sq for sq in squads if sq.department_id == d.id]
        nodes.append({
            "id": d.id, "kind": "department", "name": d.name, "mission": d.mission,
            "status": d.status, "head_agent_id": d.head_agent_id,
            "budget_usd": round(d.budget_envelope_micros / 1e6, 4),
            "spend_usd": round(d.spend_micros / 1e6, 4),
            "squads": [{"id": sq.id, "kind": "squad", "name": sq.name, "mission": sq.mission,
                        "lead_agent_id": sq.lead_agent_id, "status": sq.status} for sq in d_squads],
            "agents": [agent_node(a) for a in agents if a.department_id == d.id and a.state != "archived"],
        })
    return {
        "project": {"id": project.id, "name": project.name, "goal": project.goal,
                    "status": project.status, "stage": project.stage,
                    "budget_usd": project.budget_usd, "spend_usd": project.spend_usd},
        "orchestrator": agent_node(next((a for a in agents if a.id == orch_id), None)) if orch_id else None,
        "departments": nodes,
        "unassigned": [agent_node(a) for a in agents if not a.department_id and a.state != "archived"],
    }


async def recent_lessons(project_id: str, limit: int = 5) -> list[dict]:
    async with session_scope() as s:
        rows = (await s.scalars(select(BrainEntry).where(BrainEntry.project_id == project_id,
                                                         BrainEntry.kind == "lesson")
                                .order_by(desc(BrainEntry.created_at)).limit(limit))).all()
    return [{"title": r.title, "body": r.body, "created_at": r.created_at.isoformat()} for r in rows]


@dataclass
class HirePlan:  # reserved for the explicit hiring API (M3+): a dry-run of staff_gaps
    departments: list[dict] = field(default_factory=list)
    agents: list[dict] = field(default_factory=list)
    cost_estimate_micros: int = 0


def estimate_agent_cost(role: Role, effort: str = "M") -> int:
    tier = ROLE_TEMPLATES[role].base_grade
    return estimated_cost_micros(effort, "fast" if tier <= Grade.JUNIOR else "reasoning")
