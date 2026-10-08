"""REST API — the contract in docs/11. Commands in, events out."""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import desc, func, select

from crew import CONTRACT_VERSION, __version__
from crew.api.auth import require_user
from crew.control import backlog, commands, company, onboarding, org
from crew.control.council import council
from crew.control.orchestrator import orchestrator
from crew.core import events as ev
from crew.core.brains import brain_service
from crew.core.db import session_scope
from crew.core.models import (
    Agent,
    AgentSkill,
    Approval,
    Artifact,
    AuditLog,
    Brain,
    BrainEntry,
    CouncilSession,
    Decision,
    Department,
    Event,
    Project,
    RewardEvent,
    Run,
    Squad,
    Task,
    VerificationResult,
    micros_to_usd,
)
from crew.core.reward import DEFAULT_WEIGHTS, leaderboard, reward_engine
from crew.core.security import (
    audit,
    budget,
    decide_approval,
    policy,
    vault,
    verify_audit_chain,
)
from crew.core.settings import settings
from crew.domain.catalog import ROLE_TEMPLATES, SKILLS, RoleSpec
from crew.domain.enums import Grade, Role
from crew.execution.models import router
from crew.execution.runner import select_runner
from crew.execution.tools import TOOLS, tools_for_agent

api = APIRouter(prefix="/api", dependencies=[Depends(require_user)])

# ── schemas ─────────────────────────────────────────────────────────────────────────


class Problem(BaseModel):
    type: str = "about:blank"
    title: str
    status: int
    detail: str = ""
    trace_id: str = ""


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    goal: str = ""
    description: str = ""
    budget_usd: float | None = None
    settings: dict | None = None


class CompanyCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    mission: str = ""
    budget_usd: float | None = None


class CompanyProjectBody(BaseModel):
    project_id: str


class CompanyChiefBody(BaseModel):
    function: str


class BoardItemCreate(BaseModel):
    kind: str = "story"
    title: str = Field(min_length=1, max_length=280)
    body: str = ""
    acceptance: list[str] = []
    parent_id: str | None = None
    department_id: str | None = None
    squad_id: str | None = None
    priority: int = 2
    severity: str = "normal"


class BoardItemPatch(BaseModel):
    state: str | None = None


class BoardSessionBody(BaseModel):
    topic: str = Field(min_length=1, max_length=280)
    options: list[str] | None = None


class BoardSeatBody(BaseModel):
    role: str = "board_member"


class CommandBody(BaseModel):
    text: str = Field(min_length=1, max_length=2000)


class OnboardingKeyBody(BaseModel):
    provider: str = "deepseek"
    key: str = Field(min_length=8, max_length=400)


class ProjectPatch(BaseModel):
    name: str | None = None
    goal: str | None = None
    description: str | None = None
    settings: dict | None = None


class RunCreate(BaseModel):
    goal: str = Field(min_length=3)
    mode: str = "autonomous"


class SteerBody(BaseModel):
    text: str
    target_kind: str = "project"
    target_id: str | None = None


class DepartmentCreate(BaseModel):
    name: str
    mission: str = ""
    budget_usd: float = 0.0
    capabilities: list[str] = Field(default_factory=list)


class SquadCreate(BaseModel):
    name: str
    mission: str = ""
    workstream: str = ""
    lead_agent_id: str | None = None


class HireBody(BaseModel):
    role: str = "worker"
    title: str | None = None
    grade: int | None = None
    mission: str | None = None
    skills: list[str] = Field(default_factory=list)
    department_id: str | None = None
    squad_id: str | None = None
    rationale: str = ""


class AgentPatch(BaseModel):
    mission: str | None = None
    tools: list[str] | None = None
    spend_cap_per_run_usd: float | None = None
    autonomy: str | None = None


class TransitionBody(BaseModel):
    reason: str = ""


class TaskCreate(BaseModel):
    title: str
    description: str = ""
    deliverable: str = ""
    acceptance_criteria: list[str] = Field(default_factory=list)
    required_skills: list[dict] = Field(default_factory=list)
    depends_on: list[str] = Field(default_factory=list)
    effort: str = "M"
    priority: int = 2


class CouncilCreate(BaseModel):
    question: str
    options: list[dict]
    criteria: list[str] = Field(default_factory=list)
    constraints: list[str] = Field(default_factory=list)
    task_id: str | None = None
    panel: list[str] = Field(default_factory=list)
    rounds: int = 1


class BrainWriteBody(BaseModel):
    brain_id: str
    kind: str = "fact"
    title: str
    body: str = ""
    importance: float = 0.5
    tags: list[str] = Field(default_factory=list)


class PromoteBody(BaseModel):
    to_brain_id: str
    rationale: str = ""


class SupersedeBody(BaseModel):
    new_entry_id: str
    reason: str = ""


class OverrideBody(BaseModel):
    reason: str


class ApprovalDecision(BaseModel):
    reason: str = ""
    ttl_minutes: int = 120


class SecretCreate(BaseModel):
    name: str
    value: str
    scope_kind: str = "project"
    scope_id: str = ""


class WeightsBody(BaseModel):
    weights: dict[str, float]


class AnswerBody(BaseModel):
    answers: list[str]
    confirm: bool = True


class LoginBody(BaseModel):
    email: str
    password: str


# ── helpers ─────────────────────────────────────────────────────────────────────────
def _problem(status: int, title: str, detail: str = "") -> HTTPException:
    return HTTPException(status_code=status, detail=f"{title}: {detail}" if detail else title)


async def _project_or_404(project_id: str) -> Project:
    async with session_scope() as s:
        p = await s.get(Project, project_id)
        if p is None:
            raise _problem(404, "project not found", project_id)
    return p


def task_dict(t: Task) -> dict:
    return {
        "id": t.id, "run_id": t.run_id, "project_id": t.project_id, "title": t.title,
        "description": t.description, "deliverable": t.deliverable, "state": t.state,
        "department_id": t.department_id, "squad_id": t.squad_id, "parent_id": t.parent_id,
        "required_skills": t.required_skills or [], "acceptance_criteria": t.acceptance_criteria or [],
        "depends_on": t.depends_on or [], "output_contract": t.output_contract or {},
        "effort": t.effort, "effort_weight": {"S": 1.0, "M": 1.6, "L": 2.6, "XL": 4.0}.get(t.effort, 1.6),
        "priority": t.priority, "assignee_agent_id": t.assignee_agent_id,
        "assignee_squad_id": t.assignee_squad_id, "attempts": t.attempts,
        "cost_usd": micros_to_usd(t.cost_micros), "tokens_in": t.tokens_in, "tokens_out": t.tokens_out,
        "escalated_to": t.escalated_to, "escalation_reason": t.escalation_reason,
        "created_at": t.created_at.isoformat(),
        "started_at": t.started_at.isoformat() if t.started_at else None,
        "ended_at": t.ended_at.isoformat() if t.ended_at else None,
    }


def _tenure_days(created: datetime | None) -> int:
    """Days since hire — SQLite hands back naive datetimes, and the math must not care
    (ADR 0014)."""
    if created is None:
        return 0
    if created.tzinfo is None:
        created = created.replace(tzinfo=UTC)
    return max(0, (datetime.now(UTC) - created).days)


async def agent_dict(a: Agent) -> dict:
    async with session_scope() as s:
        skills = (await s.execute(
            select(AgentSkill.skill_id, AgentSkill.proficiency, AgentSkill.evidence_count)
            .where(AgentSkill.agent_id == a.id))).all()
    return {
        "id": a.id, "project_id": a.project_id, "name": a.name, "role": a.role,
        "grade": int(a.grade), "grade_label": Grade(min(5, max(0, int(a.grade)))).label,
        "state": a.state, "mission": a.mission, "decision_style": a.decision_style,
        "autonomy": a.autonomy, "model_tier": a.model_tier,
        "model_id": a.model_id or router.model_for_tier(__import__("crew.domain.enums", fromlist=["ModelTier"]).ModelTier(a.model_tier)),
        "department_id": a.department_id, "squad_id": a.squad_id, "manager_id": a.manager_id,
        "brain_id": a.brain_id, "tools": a.tools or [], "skills": [
            {"skill_id": sid, "proficiency": round(float(p), 3), "evidence_count": int(c)} for sid, p, c in skills],
        "score": a.score, "score_100": a.score_100, "score_confidence": a.score_confidence,
        "success_rate": a.success_rate, "tasks_done": a.tasks_done, "tasks_failed": a.tasks_failed,
        "evidence_count": a.evidence_count, "penalty_count": a.penalty_count,
        "company_knowledge": round(float(a.company_knowledge or 0.0), 3),
        "tenure_days": _tenure_days(a.created_at),
        "current_task_id": a.current_task_id, "hire_rationale": a.hire_rationale,
        "spend_today_usd": micros_to_usd(a.spend_today_micros),
        "spend_cap_per_run_usd": micros_to_usd(a.spend_cap_per_run_micros),
        "spend_cap_per_day_usd": micros_to_usd(a.spend_cap_per_day_micros),
        "created_at": a.created_at.isoformat(),
        "archived_at": a.archived_at.isoformat() if a.archived_at else None,
        "last_active_at": a.last_active_at.isoformat() if a.last_active_at else None,
    }


def run_dict(r: Run) -> dict:
    return {
        "id": r.id, "project_id": r.project_id, "goal": r.goal, "stage": r.stage, "status": r.status,
        "mode": r.mode, "trace_id": r.trace_id, "goal_brief": r.goal_brief or {},
        "plan": r.plan or {}, "pending_questions": r.pending_questions or [],
        "cost_usd": micros_to_usd(r.cost_micros), "tokens_in": r.tokens_in, "tokens_out": r.tokens_out,
        "report": r.report or {}, "error": r.error,
        "started_at": r.started_at.isoformat(),
        "ended_at": r.ended_at.isoformat() if r.ended_at else None,
    }


# ── system & auth ───────────────────────────────────────────────────────────────────
@api.get("/health")
async def health() -> dict:
    from crew.core.db import ping

    return {"status": "ok" if await ping() else "degraded", "version": __version__,
            "contract": CONTRACT_VERSION, "env": settings.env, "auth_mode": settings.auth_mode,
            "server_time": datetime.now(UTC).isoformat()}


# ── first-run onboarding (ADR 0013): paste a provider key once ─────────────────────
@api.get("/onboarding/state")
async def get_onboarding_state() -> dict:
    return onboarding.state()


@api.post("/onboarding/key", status_code=201)
async def post_onboarding_key(body: OnboardingKeyBody,
                              user: dict = Depends(require_user)) -> dict:
    try:
        return await onboarding.save_provider_key(provider=body.provider, key=body.key,
                                                  actor=f"user:{user['id']}")
    except ValueError as e:
        raise _problem(400, str(e)) from e
    except PermissionError as e:
        raise _problem(400, str(e)) from e


@api.get("/system/status")
async def system_status() -> dict:
    from crew.core.db import ping

    async with session_scope() as s:
        events = int(await s.scalar(select(func.count(Event.id))) or 0)
        projects = int(await s.scalar(select(func.count(Project.id))) or 0)
    return {
        "db": await ping(), "projects": projects, "events": events,
        "models": router.available(), "offline_llm": settings.offline_llm,
        "tool_sandbox": settings.tool_sandbox, "max_concurrent_crews": settings.max_concurrent_crews,
        "vault": "configured" if settings.vault_key else "missing",
        "runner": type(select_runner()).__name__,
    }


@api.post("/system/kill", dependencies=[Depends(require_user)])
async def system_kill(user: dict = Depends(require_user)) -> dict:
    return await orchestrator.kill_all(actor=user["id"])


@api.post("/system/audit/verify")
async def audit_verify() -> dict:
    return await verify_audit_chain()


@api.get("/tools")
async def list_tools() -> dict:
    caps: dict[str, list[str]] = {}
    for name, spec in TOOLS.items():
        caps.setdefault(spec.capability.value, []).append(name)
    return {"capabilities": caps,
            "catalog": [{"id": s.id, "label": s.label, "category": s.category} for s in SKILLS],
            "roles": [{"role": r.value, "title": t.title, "base_grade": int(t.base_grade),
                       "skills": list(t.default_skills)} for r, t in ROLE_TEMPLATES.items()]}


@api.post("/auth/login")
async def auth_login(body: LoginBody) -> dict:
    from crew.api.auth import login as do_login

    return await do_login(email=body.email, password=body.password)


@api.get("/auth/me")
async def auth_me(user: dict = Depends(require_user)) -> dict:
    return user


# ── projects ────────────────────────────────────────────────────────────────────────
@api.get("/projects")
async def get_projects() -> dict:
    return {"items": await org.list_projects()}


@api.post("/projects", status_code=201)
async def post_project(body: ProjectCreate, user: dict = Depends(require_user)) -> dict:
    return await org.create_project(name=body.name, goal=body.goal, description=body.description,
                                    budget_usd=body.budget_usd, owner_id=user["id"],
                                    settings_patch=body.settings)


@api.get("/companies")
async def get_companies() -> dict:
    return {"items": await company.list_companies()}


@api.post("/companies", status_code=201)
async def post_company(body: CompanyCreate, user: dict = Depends(require_user)) -> dict:
    return await company.create_company(name=body.name, mission=body.mission,
                                        budget_usd=body.budget_usd, owner_id=user["id"])


@api.get("/companies/{company_id}")
async def get_company(company_id: str) -> dict:
    try:
        return await company.get_company(company_id)
    except KeyError as e:
        raise _problem(404, "company not found", company_id) from e


@api.post("/companies/{company_id}/projects", status_code=201)
async def post_company_project(company_id: str, body: CompanyProjectBody,
                               user: dict = Depends(require_user)) -> dict:
    try:
        return await company.attach_project(company_id=company_id, project_id=body.project_id)
    except KeyError as e:
        raise _problem(404, "company or project not found", str(e)) from e


@api.post("/companies/{company_id}/chiefs", status_code=201)
async def post_company_chief(company_id: str, body: CompanyChiefBody,
                             user: dict = Depends(require_user)) -> dict:
    try:
        return await company.hire_chief(company_id=company_id, function=body.function)
    except KeyError as e:
        raise _problem(404, "company not found", company_id) from e
    except ValueError as e:
        raise _problem(409, "cannot hire", str(e)) from e


@api.post("/companies/{company_id}/review")
async def post_company_review(company_id: str, user: dict = Depends(require_user)) -> dict:
    try:
        return await company.review(company_id=company_id, actor=f"user:{user['id']}")
    except KeyError as e:
        raise _problem(404, "company not found", company_id) from e


# ── governance: portfolio, board of directors, the HQ floor (ADR 0011) ─────────────
@api.get("/companies/{company_id}/hq")
async def get_company_hq(company_id: str) -> dict:
    try:
        return await company.hq(company_id=company_id)
    except KeyError as e:
        raise _problem(404, "company not found", company_id) from e


@api.get("/companies/{company_id}/portfolio")
async def get_company_portfolio(company_id: str) -> dict:
    try:
        return await company.portfolio(company_id=company_id)
    except KeyError as e:
        raise _problem(404, "company not found", company_id) from e


@api.post("/companies/{company_id}/allocate")
async def post_company_allocate(company_id: str, user: dict = Depends(require_user)) -> dict:
    try:
        return await company.allocate(company_id=company_id, actor=f"user:{user['id']}")
    except KeyError as e:
        raise _problem(404, "company not found", company_id) from e


@api.post("/companies/{company_id}/board-session", status_code=201)
async def post_board_session(company_id: str, body: BoardSessionBody,
                             user: dict = Depends(require_user)) -> dict:
    try:
        return await company.board_session(company_id=company_id, topic=body.topic,
                                           options=body.options, actor=f"user:{user['id']}")
    except KeyError as e:
        raise _problem(404, "company not found", company_id) from e


@api.post("/companies/{company_id}/board", status_code=201)
async def post_board_seat(company_id: str, body: BoardSeatBody,
                          user: dict = Depends(require_user)) -> dict:
    try:
        return await company.add_board_member(company_id=company_id, role=body.role)
    except KeyError as e:
        raise _problem(404, "company not found", company_id) from e
    except ValueError as e:
        raise _problem(422, "invalid seat", str(e)) from e


# ── the board (ADR 0010) ─────────────────────────────────────────────────────────────
@api.get("/projects/{project_id}/board")
async def get_board(project_id: str, department_id: str | None = None,
                    squad_id: str | None = None) -> dict:
    return await backlog.board(project_id=project_id, department_id=department_id,
                               squad_id=squad_id)


@api.post("/projects/{project_id}/board/items", status_code=201)
async def post_board_item(project_id: str, body: BoardItemCreate,
                          user: dict = Depends(require_user)) -> dict:
    try:
        return await backlog.create_item(project_id=project_id, kind=body.kind, title=body.title,
                                         body=body.body, acceptance=body.acceptance,
                                         parent_id=body.parent_id, department_id=body.department_id,
                                         squad_id=body.squad_id, priority=body.priority,
                                         severity=body.severity, created_by=f"user:{user['id']}",
                                         state="backlog")
    except ValueError as e:
        raise _problem(422, "invalid item", str(e)) from e


@api.patch("/board/items/{item_id}")
async def patch_board_item(item_id: str, body: BoardItemPatch,
                           user: dict = Depends(require_user)) -> dict:
    if not body.state:
        return {"id": item_id, "state": None, "note": "nothing to change"}
    try:
        return await backlog.move_item_by_id(item_id=item_id, state=body.state,
                                             actor=f"user:{user['id']}")
    except KeyError as e:
        raise _problem(404, "item not found", item_id) from e
    except ValueError as e:
        raise _problem(409, "cannot move", str(e)) from e


# ── the command desk (ADR 0012): the Captain writes, the orchestrator answers ──────
@api.post("/projects/{project_id}/commands", status_code=201)
async def post_command(project_id: str, body: CommandBody,
                       user: dict = Depends(require_user)) -> dict:
    project = await _project_or_404(project_id)
    try:
        return await commands.handle_command(project_id=project.id, text=body.text,
                                             actor=f"user:{user['id']}")
    except KeyError as e:
        raise _problem(404, "project not found", project_id) from e


@api.get("/projects/{project_id}/commands")
async def get_commands(project_id: str, limit: int = 60) -> dict:
    return await commands.transcript(project_id=project_id, limit=limit)


@api.get("/projects/{project_id}")
async def get_project(project_id: str) -> dict:
    try:
        return await org.get_project(project_id)
    except KeyError as e:
        raise _problem(404, "project not found", project_id) from e


@api.patch("/projects/{project_id}")
async def patch_project(project_id: str, body: ProjectPatch, user: dict = Depends(require_user)) -> dict:
    async with session_scope() as s:
        p = await s.get(Project, project_id)
        if p is None:
            raise _problem(404, "project not found", project_id)
        merged = dict(p.settings or {})
        if body.settings:
            merged.update(body.settings)
        if body.name:
            p.name = body.name
        if body.goal is not None:
            p.goal = body.goal
        if body.description is not None:
            p.description = body.description
        p.settings = merged
        s.add(p)
        out = org.serialize_project(p)
    await ev.emit("project.updated", project_id=project_id, title="project updated",
                  payload={"project_id": project_id, "fields": body.model_dump(exclude_none=True)},
                  actor=user["id"])
    return out


@api.post("/projects/{project_id}/pause")
async def pause_project(project_id: str, user: dict = Depends(require_user)) -> dict:
    return await orchestrator.pause_project(project_id, actor=user["id"])


@api.post("/projects/{project_id}/resume")
async def resume_project(project_id: str, user: dict = Depends(require_user)) -> dict:
    return await orchestrator.resume_project(project_id, actor=user["id"])


@api.post("/projects/{project_id}/kill")
async def kill_project(project_id: str, user: dict = Depends(require_user)) -> dict:
    return await orchestrator.kill(project_id, actor=user["id"])


@api.delete("/projects/{project_id}")
async def archive_project(project_id: str, user: dict = Depends(require_user)) -> dict:
    async with session_scope() as s:
        p = await s.get(Project, project_id)
        if p is None:
            raise _problem(404, "project not found", project_id)
        p.status = "archived"
        p.archived_at = datetime.now(UTC)
        s.add(p)
    await ev.emit("project.archived", project_id=project_id, severity="notice",
                  title="project archived", payload={"project_id": project_id}, actor=user["id"])
    await audit(actor_kind="user", actor_id=user["id"], action="project.archived",
                resource_kind="project", resource_id=project_id)
    return {"project_id": project_id, "status": "archived"}


@api.get("/projects/{project_id}/metrics")
async def project_metrics(project_id: str) -> dict:
    async with session_scope() as s:
        p = await s.get(Project, project_id)
        if p is None:
            raise _problem(404, "project not found", project_id)
        tasks = (await s.scalars(select(Task).where(Task.project_id == project_id))).all()
        agents = (await s.scalars(select(Agent).where(Agent.project_id == project_id,
                                                      Agent.state != "archived"))).all()
        cost_events = (await s.execute(
            select(func.coalesce(func.sum(Event.cost_micros), 0), func.count(Event.id))
            .where(Event.project_id == project_id))).first()
    done = [t for t in tasks if t.state == "completed"]
    failed = [t for t in tasks if t.state == "failed"]
    return {
        "project_id": project_id, "budget_usd": p.budget_usd, "spend_usd": p.spend_usd,
        "spend_ratio": round(p.spend_micros / p.budget_cap_micros, 4) if p.budget_cap_micros else 0.0,
        "tasks_total": len(tasks), "tasks_done": len(done), "tasks_failed": len(failed),
        "success_rate": round(len(done) / len(tasks), 3) if tasks else 0.0,
        "agents": len(agents), "cost_from_events_usd": micros_to_usd(int(cost_events[0] or 0)),
        "events": int(cost_events[1] or 0),
        "avg_task_cost_usd": micros_to_usd(int(sum(t.cost_micros for t in tasks) / len(tasks))) if tasks else 0.0,
    }


@api.get("/projects/{project_id}/report")
async def project_report(project_id: str) -> dict:
    async with session_scope() as s:
        run = await s.scalar(select(Run).where(Run.project_id == project_id)
                             .order_by(desc(Run.started_at)).limit(1))
    return run.report if run else {}


# ── runs ────────────────────────────────────────────────────────────────────────────
@api.post("/projects/{project_id}/runs", status_code=202)
async def start_run(project_id: str, body: RunCreate, user: dict = Depends(require_user)) -> dict:
    await _project_or_404(project_id)
    try:
        run = await orchestrator.start_run(project_id=project_id, goal=body.goal, mode=body.mode,
                                           actor=user["id"])
    except ValueError as e:
        raise _problem(409, "cannot start run", str(e)) from e
    asyncio.create_task(_drive(project_id, run["id"]))
    return {**run, "accepted": True}


async def _drive(project_id: str, run_id: str) -> None:
    try:
        await orchestrator.advance(run_id)
    except Exception as e:  # a run failure must be visible, not silent
        import logging

        logging.getLogger("crew.api").exception("run %s failed", run_id)
        await ev.emit("run.failed", project_id=project_id, run_id=run_id, severity="error",
                      title="run failed with an internal error", summary=str(e)[:300],
                      payload={"run_id": run_id, "error": f"{type(e).__name__}: {e}"},
                      actor="system:orchestrator")


@api.get("/projects/{project_id}/runs")
async def list_runs(project_id: str) -> dict:
    async with session_scope() as s:
        rows = (await s.scalars(select(Run).where(Run.project_id == project_id)
                                .order_by(desc(Run.started_at)).limit(50))).all()
    return {"items": [run_dict(r) for r in rows]}


@api.get("/runs/{run_id}")
async def get_run(run_id: str) -> dict:
    async with session_scope() as s:
        r = await s.get(Run, run_id)
        if r is None:
            raise _problem(404, "run not found", run_id)
    return run_dict(r)


@api.post("/runs/{run_id}/answer")
async def answer_run(run_id: str, body: AnswerBody, user: dict = Depends(require_user)) -> dict:
    async with session_scope() as s:
        r = await s.get(Run, run_id)
        if r is None:
            raise _problem(404, "run not found", run_id)
        r.goal_brief = {**(r.goal_brief or {}), "answers": body.answers}
        questions = list(r.pending_questions or [])
        r.pending_questions = []
        r.status = "running"
        if body.answers and questions:
            r.goal = r.goal + "\n\nClarifications: " + "; ".join(
                f"{q} → {a}" for q, a in zip(questions, body.answers, strict=False))
        s.add(r)
        project_id = r.project_id
    await ev.emit("run.clarification.answered", project_id=project_id, run_id=run_id, severity="notice",
                  title="clarifications received", payload={"run_id": run_id, "answers": body.answers},
                  actor=user["id"])
    asyncio.create_task(_drive(project_id, run_id))
    return {"run_id": run_id, "status": "running"}


@api.post("/runs/{run_id}/steer")
async def steer_run(run_id: str, body: SteerBody, user: dict = Depends(require_user)) -> dict:
    async with session_scope() as s:
        r = await s.get(Run, run_id)
        if r is None:
            raise _problem(404, "run not found", run_id)
        project_id = r.project_id
    return await orchestrator.steer(project_id=project_id, text=body.text,
                                    target_kind=body.target_kind or "run",
                                    target_id=body.target_id or run_id, actor=user["id"])


@api.post("/runs/{run_id}/cancel")
async def cancel_run(run_id: str, user: dict = Depends(require_user)) -> dict:
    async with session_scope() as s:
        r = await s.get(Run, run_id)
        if r is None:
            raise _problem(404, "run not found", run_id)
        r.status = "aborted"
        r.ended_at = datetime.now(UTC)
        s.add(r)
        project_id = r.project_id
    await ev.emit("run.aborted", project_id=project_id, run_id=run_id, severity="warning",
                  title="run cancelled", payload={"run_id": run_id}, actor=user["id"])
    return {"run_id": run_id, "status": "aborted"}


@api.get("/runs/{run_id}/dossier")
async def run_dossier(run_id: str) -> dict:
    async with session_scope() as s:
        r = await s.get(Run, run_id)
        if r is None:
            raise _problem(404, "run not found", run_id)
        tasks = (await s.scalars(select(Task).where(Task.run_id == run_id))).all()
        rewards = (await s.scalars(select(RewardEvent).where(RewardEvent.run_id == run_id))).all()
        events = (await s.scalars(select(Event).where(Event.run_id == run_id)
                                  .order_by(Event.seq).limit(5000))).all()
    return {"run": run_dict(r), "tasks": [task_dict(t) for t in tasks],
            "rewards": [{"agent_id": x.agent_id, "role": x.role_in_task, "reward": x.reward,
                         "verdict": x.verdict, "components": x.components} for x in rewards],
            "events": [ev.event_to_dict(e) for e in events]}


# ── org ─────────────────────────────────────────────────────────────────────────────
@api.get("/projects/{project_id}/org")
async def get_org(project_id: str) -> dict:
    try:
        return await org.org_tree(project_id)
    except KeyError as e:
        raise _problem(404, "project not found", project_id) from e


@api.post("/projects/{project_id}/departments", status_code=201)
async def post_department(project_id: str, body: DepartmentCreate, user: dict = Depends(require_user)) -> dict:
    await _project_or_404(project_id)
    try:
        return await org.create_department(project_id=project_id, name=body.name, mission=body.mission,
                                           budget_usd=body.budget_usd, capabilities=body.capabilities,
                                           actor=user["id"])
    except ValueError as e:
        raise _problem(409, "cannot create department", str(e)) from e


@api.get("/departments/{department_id}")
async def get_department(department_id: str) -> dict:
    async with session_scope() as s:
        d = await s.get(Department, department_id)
        if d is None:
            raise _problem(404, "department not found", department_id)
        agents = (await s.scalars(select(Agent).where(Agent.department_id == department_id,
                                                      Agent.state != "archived"))).all()
        tasks = (await s.scalars(select(Task).where(Task.department_id == department_id))).all()
    done = [t for t in tasks if t.state == "completed"]
    return {"id": d.id, "project_id": d.project_id, "name": d.name, "mission": d.mission,
            "status": d.status, "head_agent_id": d.head_agent_id, "brain_id": d.brain_id,
            "charter": d.charter or {},
            "budget_usd": micros_to_usd(d.budget_envelope_micros), "spend_usd": micros_to_usd(d.spend_micros),
            "roster": [await agent_dict(a) for a in agents],
            "kpis": {"tasks_total": len(tasks), "tasks_done": len(done),
                     "success_rate": round(len(done) / len(tasks), 3) if tasks else 0.0,
                     "avg_cost_usd": micros_to_usd(int(sum(t.cost_micros for t in tasks) / len(tasks))) if tasks else 0.0}}


@api.patch("/departments/{department_id}")
async def patch_department(department_id: str, body: dict, user: dict = Depends(require_user)) -> dict:
    async with session_scope() as s:
        d = await s.get(Department, department_id)
        if d is None:
            raise _problem(404, "department not found", department_id)
        if "mission" in body:
            d.mission = str(body["mission"])
        if "budget_usd" in body:
            d.budget_envelope_micros = int(float(body["budget_usd"]) * 1_000_000)
        if "capabilities" in body:
            d.capabilities = list(body["capabilities"])
        s.add(d)
        out = {"id": d.id, "mission": d.mission, "budget_usd": micros_to_usd(d.budget_envelope_micros),
               "capabilities": d.capabilities}
    await audit(actor_kind="user", actor_id=user["id"], action="department.updated",
                resource_kind="department", resource_id=department_id, reason=json.dumps(body)[:200])
    return out


@api.post("/departments/{department_id}/archive")
async def archive_department(department_id: str, user: dict = Depends(require_user)) -> dict:
    async with session_scope() as s:
        d = await s.get(Department, department_id)
        if d is None:
            raise _problem(404, "department not found", department_id)
        d.status = "archived"
        d.archived_at = datetime.now(UTC)
        s.add(d)
        project_id = d.project_id
    await ev.emit("org.department.archived", project_id=project_id, department_id=department_id,
                  severity="notice", title=f"department archived: {d.name}",
                  payload={"department_id": department_id}, actor=user["id"])
    return {"department_id": department_id, "status": "archived"}


@api.post("/departments/{department_id}/squads", status_code=201)
async def post_squad(department_id: str, body: SquadCreate, user: dict = Depends(require_user)) -> dict:
    async with session_scope() as s:
        d = await s.get(Department, department_id)
        if d is None:
            raise _problem(404, "department not found", department_id)
        project_id = d.project_id
    return await org.create_squad(project_id=project_id, department_id=department_id, name=body.name,
                                  mission=body.mission, workstream=body.workstream,
                                  lead_agent_id=body.lead_agent_id, actor=user["id"])


@api.post("/squads/{squad_id}/close")
async def close_squad(squad_id: str, body: dict | None = None, user: dict = Depends(require_user)) -> dict:
    async with session_scope() as s:
        sq = await s.get(Squad, squad_id)
        if sq is None:
            raise _problem(404, "squad not found", squad_id)
        sq.status = "closed"
        sq.closed_at = datetime.now(UTC)
        s.add(sq)
        agents = (await s.scalars(select(Agent).where(Agent.squad_id == squad_id))).all()
        for a in agents:
            a.squad_id = None
            s.add(a)
        project_id = sq.project_id
    await ev.emit("org.squad.disbanded", project_id=project_id, squad_id=squad_id, severity="notice",
                  title=f"squad disbanded: {sq.name}", payload={"squad_id": squad_id,
                                                               "reassigned": len(agents)},
                  actor=user["id"])
    return {"squad_id": squad_id, "status": "closed", "agents_reassigned": len(agents)}


@api.post("/projects/{project_id}/agents", status_code=201)
async def hire(project_id: str, body: HireBody, user: dict = Depends(require_user)) -> dict:
    await _project_or_404(project_id)
    try:
        role = Role(body.role)
    except ValueError as e:
        raise _problem(422, "unknown role", body.role) from e
    spec = RoleSpec.from_template(role, grade=Grade(body.grade) if body.grade is not None else None,
                                  skills=body.skills or None, mission=body.mission, title=body.title,
                                  rationale=body.rationale or "manual hire")
    try:
        return await org.hire_agent(project_id=project_id, spec=spec, department_id=body.department_id,
                                    squad_id=body.squad_id, rationale=body.rationale or "manual hire",
                                    actor=user["id"])
    except ValueError as e:
        raise _problem(409, "cannot hire", str(e)) from e


@api.get("/agents/{agent_id}")
async def get_agent(agent_id: str) -> dict:
    async with session_scope() as s:
        a = await s.get(Agent, agent_id)
        if a is None:
            raise _problem(404, "agent not found", agent_id)
    return await agent_dict(a)


@api.patch("/agents/{agent_id}")
async def patch_agent(agent_id: str, body: AgentPatch, user: dict = Depends(require_user)) -> dict:
    async with session_scope() as s:
        a = await s.get(Agent, agent_id)
        if a is None:
            raise _problem(404, "agent not found", agent_id)
        if body.mission is not None:
            a.mission = body.mission
        if body.tools is not None:
            a.tools = list(body.tools)
        if body.autonomy is not None:
            a.autonomy = body.autonomy
        if body.spend_cap_per_run_usd is not None:
            a.spend_cap_per_run_micros = int(body.spend_cap_per_run_usd * 1_000_000)
        s.add(a)
        out = await agent_dict(a)
    await audit(actor_kind="user", actor_id=user["id"], action="agent.updated", resource_kind="agent",
                resource_id=agent_id, reason=json.dumps(body.model_dump(exclude_none=True))[:200])
    return out


async def _transition(agent_id: str, body: TransitionBody, kind: str, user: dict) -> dict:
    async with session_scope() as s:
        a = await s.get(Agent, agent_id)
        if a is None:
            raise _problem(404, "agent not found", agent_id)
        before = int(a.grade)
        if kind == "promote":
            a.grade = min(5, before + 1)
        elif kind == "demote":
            a.grade = max(0, before - 1)
        elif kind == "probation":
            a.state = "probation"
        reward_engine.apply_grade_limits_pure(a)
        s.add(a)
        project_id, after, name = a.project_id, int(a.grade), a.name
    event_type = {"promote": "org.agent.promoted", "demote": "org.agent.demoted",
                  "probation": "org.agent.probation"}[kind]
    await ev.emit(event_type, project_id=project_id, agent_id=agent_id, severity="notice",
                  title=f"manual {kind}: {name}", summary=body.reason,
                  payload={"agent_id": agent_id, "grade_before": before, "grade_after": after,
                           "reason": body.reason, "actor": user["id"], "manual": True},
                  actor=user["id"])
    await audit(actor_kind="user", actor_id=user["id"], action=f"agent.{kind}",
                resource_kind="agent", resource_id=agent_id, reason=body.reason[:200])
    return {"agent_id": agent_id, "kind": kind, "grade_before": before, "grade_after": after}


@api.post("/agents/{agent_id}/promote")
async def promote(agent_id: str, body: TransitionBody, user: dict = Depends(require_user)) -> dict:
    return await _transition(agent_id, body, "promote", user)


@api.post("/agents/{agent_id}/demote")
async def demote(agent_id: str, body: TransitionBody, user: dict = Depends(require_user)) -> dict:
    return await _transition(agent_id, body, "demote", user)


@api.post("/agents/{agent_id}/probation")
async def probation(agent_id: str, body: TransitionBody, user: dict = Depends(require_user)) -> dict:
    return await _transition(agent_id, body, "probation", user)


@api.post("/agents/{agent_id}/fire")
async def fire(agent_id: str, body: TransitionBody, user: dict = Depends(require_user)) -> dict:
    async with session_scope() as s:
        a = await s.get(Agent, agent_id)
        if a is None:
            raise _problem(404, "agent not found", agent_id)
        project_id = a.project_id
    try:
        await org.layoff_agent(project_id=project_id, agent_id=agent_id, reason=body.reason,
                               actor=user["id"])
    except ValueError as e:
        raise _problem(409, "cannot fire", str(e)) from e
    return {"agent_id": agent_id, "state": "archived"}


@api.post("/agents/{agent_id}/message")
async def message_agent(agent_id: str, body: SteerBody, user: dict = Depends(require_user)) -> dict:
    async with session_scope() as s:
        a = await s.get(Agent, agent_id)
        if a is None:
            raise _problem(404, "agent not found", agent_id)
        project_id = a.project_id
    return await orchestrator.steer(project_id=project_id, text=body.text, target_kind="agent",
                                    target_id=agent_id, actor=user["id"])


# ── tasks ───────────────────────────────────────────────────────────────────────────
@api.get("/projects/{project_id}/tasks")
async def list_tasks(project_id: str, state: str | None = None, department_id: str | None = None,
                     squad_id: str | None = None, agent_id: str | None = None, run_id: str | None = None,
                     limit: int = Query(200, le=1000)) -> dict:
    async with session_scope() as s:
        stmt = select(Task).where(Task.project_id == project_id)
        if state:
            stmt = stmt.where(Task.state.in_(state.split(",")))
        if department_id:
            stmt = stmt.where(Task.department_id == department_id)
        if squad_id:
            stmt = stmt.where(Task.squad_id == squad_id)
        if agent_id:
            stmt = stmt.where(Task.assignee_agent_id == agent_id)
        if run_id:
            stmt = stmt.where(Task.run_id == run_id)
        rows = (await s.scalars(stmt.order_by(Task.priority, desc(Task.created_at)).limit(limit))).all()
    return {"items": [task_dict(t) for t in rows]}


@api.post("/projects/{project_id}/tasks", status_code=201)
async def create_task(project_id: str, body: TaskCreate, user: dict = Depends(require_user)) -> dict:
    await _project_or_404(project_id)
    if not body.acceptance_criteria:
        raise _problem(422, "validation_error", "acceptance_criteria are mandatory (docs/03 §3)")
    async with session_scope() as s:
        t = Task(project_id=project_id, title=body.title, description=body.description,
                 deliverable=body.deliverable, acceptance_criteria=body.acceptance_criteria,
                 required_skills=body.required_skills, depends_on=body.depends_on,
                 effort=body.effort, priority=body.priority, state="pending")
        s.add(t)
        await s.flush()
        tid = t.id
    await ev.emit("task.created", project_id=project_id, task_id=tid, title=f"task created: {body.title[:60]}",
                  payload={"task_id": tid, "title": body.title, "manual": True}, actor=user["id"])
    return {"task_id": tid, "state": "pending"}


@api.get("/tasks/{task_id}")
async def get_task(task_id: str) -> dict:
    async with session_scope() as s:
        t = await s.get(Task, task_id)
        if t is None:
            raise _problem(404, "task not found", task_id)
        ver = (await s.scalars(select(VerificationResult).where(VerificationResult.task_id == task_id)
                               .order_by(desc(VerificationResult.created_at)).limit(1))).all()
        rewards = (await s.scalars(select(RewardEvent).where(RewardEvent.task_id == task_id))).all()
        arts = (await s.scalars(select(Artifact).where(Artifact.task_id == task_id))).all()
        out = task_dict(t)
        out["result_text"] = t.result_text
        out["verification"] = ([{"verdict": v.verdict, "method": v.method, "checks": v.checks,
                                 "rubric": v.rubric, "confidence": v.confidence,
                                 "created_at": v.created_at.isoformat()} for v in ver] or [None])[0]
        out["rewards"] = [{"agent_id": r.agent_id, "role": r.role_in_task, "reward": r.reward,
                           "verdict": r.verdict, "components": r.components} for r in rewards]
        out["artifacts"] = [{"id": a.id, "path": a.path, "bytes": a.bytes, "sha256": a.sha256,
                            "kind": a.kind} for a in arts]
    return out


@api.get("/tasks/{task_id}/artifacts")
async def task_artifacts(task_id: str) -> dict:
    async with session_scope() as s:
        arts = (await s.scalars(select(Artifact).where(Artifact.task_id == task_id))).all()
    return {"items": [{"id": a.id, "path": a.path, "bytes": a.bytes, "sha256": a.sha256} for a in arts]}


async def _task_control(task_id: str, action: str, user: dict, body: dict | None = None) -> dict:
    body = body or {}
    async with session_scope() as s:
        t = await s.get(Task, task_id)
        if t is None:
            raise _problem(404, "task not found", task_id)
        project_id = t.project_id
        if action == "retry":
            t.state = "assigned" if t.assignee_agent_id else "pending"
            t.attempts = 0
            t.escalation_reason = "manual retry"
        elif action == "cancel":
            t.state = "aborted"
            t.escalation_reason = body.get("reason", "manually cancelled")
        elif action == "reassign":
            t.assignee_agent_id = body.get("agent_id")
            t.state = "assigned"
        elif action == "escalate":
            t.state = "escalated"
            t.escalation_reason = body.get("reason", "manually escalated")
        s.add(t)
        out = task_dict(t)
    await ev.emit(f"task.{action}", project_id=project_id, task_id=task_id, severity="notice",
                  title=f"task {action}", summary=out.get("escalation_reason", ""),
                  payload={"task_id": task_id, "action": action}, actor=user["id"])
    return out


@api.post("/tasks/{task_id}/retry")
async def retry_task(task_id: str, user: dict = Depends(require_user)) -> dict:
    return await _task_control(task_id, "retry", user)


@api.post("/tasks/{task_id}/cancel")
async def cancel_task(task_id: str, body: dict | None = None, user: dict = Depends(require_user)) -> dict:
    return await _task_control(task_id, "cancel", user, body)


@api.post("/tasks/{task_id}/reassign")
async def reassign_task(task_id: str, body: dict, user: dict = Depends(require_user)) -> dict:
    return await _task_control(task_id, "reassign", user, body)


@api.post("/tasks/{task_id}/escalate")
async def escalate_task(task_id: str, body: dict | None = None, user: dict = Depends(require_user)) -> dict:
    return await _task_control(task_id, "escalate", user, body)


@api.post("/tasks/{task_id}/steer")
async def steer_task(task_id: str, body: SteerBody, user: dict = Depends(require_user)) -> dict:
    async with session_scope() as s:
        t = await s.get(Task, task_id)
        if t is None:
            raise _problem(404, "task not found", task_id)
        project_id = t.project_id
    return await orchestrator.steer(project_id=project_id, text=body.text, target_kind="task",
                                    target_id=task_id, actor=user["id"])


# ── council & decisions ─────────────────────────────────────────────────────────────
@api.post("/projects/{project_id}/councils", status_code=201)
async def convene(project_id: str, body: CouncilCreate, user: dict = Depends(require_user)) -> dict:
    project = await _project_or_404(project_id)
    try:
        out = await council.convene(project=project, question=body.question, options=body.options,
                                    criteria=body.criteria or None, constraints=body.constraints,
                                    task_id=body.task_id, panel=body.panel or None,
                                    convened_by=user["id"], rationale="manual convene")
    except ValueError as e:
        raise _problem(422, "validation_error", str(e)) from e
    if body.rounds > 0:
        await council.run_round(project_id=project_id, session_id=out["session_id"])
    return out


@api.get("/councils/{session_id}")
async def get_council(session_id: str) -> dict:
    try:
        return await council.get_session(session_id=session_id)
    except KeyError as e:
        raise _problem(404, "council not found", session_id) from e


@api.post("/councils/{session_id}/round")
async def council_round(session_id: str, user: dict = Depends(require_user)) -> dict:
    async with session_scope() as s:
        sess = await s.get(CouncilSession, session_id)
        if sess is None:
            raise _problem(404, "council not found", session_id)
        project_id = sess.project_id
    positions = await council.run_round(project_id=project_id, session_id=session_id)
    return {"session_id": session_id, "positions": positions}


@api.post("/councils/{session_id}/decide")
async def council_decide(session_id: str, user: dict = Depends(require_user)) -> dict:
    async with session_scope() as s:
        sess = await s.get(CouncilSession, session_id)
        if sess is None:
            raise _problem(404, "council not found", session_id)
        project = await s.get(Project, sess.project_id)
    out = await council.decide(project=project, session_id=session_id, actor=user["id"])
    return {"session_id": out.session_id, "decision_id": out.decision_id,
            "chosen_option": out.chosen_option, "rationale": out.rationale,
            "confidence": out.confidence}


@api.get("/decisions")
async def list_decisions(project_id: str = Query(...)) -> dict:
    async with session_scope() as s:
        rows = (await s.scalars(select(Decision).where(Decision.project_id == project_id)
                                .order_by(desc(Decision.created_at)))).all()
    return {"items": [{"id": d.id, "session_id": d.session_id, "task_id": d.task_id,
                       "question": d.question, "chosen_option": d.chosen_option,
                       "rationale": d.rationale, "dissent": d.dissent, "confidence": d.confidence,
                       "reversibility": d.reversibility, "follow_ups": d.follow_ups,
                       "decider_agent_id": d.decider_agent_id,
                       "overridden_by": d.overridden_by, "override_reason": d.override_reason,
                       "created_at": d.created_at.isoformat()} for d in rows]}


@api.post("/decisions/{decision_id}/override")
async def override_decision(decision_id: str, body: OverrideBody, user: dict = Depends(require_user)) -> dict:
    async with session_scope() as s:
        d = await s.get(Decision, decision_id)
        if d is None:
            raise _problem(404, "decision not found", decision_id)
        d.overridden_by, d.override_reason = user["id"], body.reason
        s.add(d)
        project_id = d.project_id
    await ev.emit("decision.overridden", project_id=project_id, severity="warning",
                  title="decision overridden", summary=body.reason,
                  payload={"decision_id": decision_id, "reason": body.reason,
                           "question": d.question, "chosen_option": d.chosen_option},
                  actor=user["id"])
    await audit(actor_kind="user", actor_id=user["id"], action="decision.overridden",
                resource_kind="decision", resource_id=decision_id, reason=body.reason[:200])
    return {"decision_id": decision_id, "overridden_by": user["id"]}


# ── brains ──────────────────────────────────────────────────────────────────────────
@api.get("/projects/{project_id}/brains")
async def list_brains(project_id: str) -> dict:
    return {"items": await brain_service.list_brains(project_id)}


@api.get("/brains/{brain_id}/entries")
async def brain_entries(brain_id: str, q: str | None = None, kind: str | None = None,
                        limit: int = Query(100, le=500)) -> dict:
    async with session_scope() as s:
        b = await s.get(Brain, brain_id)
        if b is None:
            raise _problem(404, "brain not found", brain_id)
        if q:
            hits = await brain_service.search(project_id=b.project_id, brain_ids=[brain_id], query=q,
                                             top_k=limit, kinds=[kind] if kind else None)
            return {"items": hits}
        stmt = select(BrainEntry).where(BrainEntry.brain_id == brain_id)
        if kind:
            stmt = stmt.where(BrainEntry.kind == kind)
        rows = (await s.scalars(stmt.order_by(desc(BrainEntry.created_at)).limit(limit))).all()
    return {"items": [brain_service._serialize(r) for r in rows]}


@api.post("/brains/{brain_id}/entries", status_code=201)
async def write_entry(brain_id: str, body: BrainWriteBody, user: dict = Depends(require_user)) -> dict:
    async with session_scope() as s:
        b = await s.get(Brain, brain_id)
        if b is None:
            raise _problem(404, "brain not found", brain_id)
        project_id = b.project_id
    return await brain_service.write(project_id=project_id, brain_id=brain_id, kind=body.kind,
                                     title=body.title, body=body.body, importance=body.importance,
                                     tags=body.tags, source={"actor": "user", "user_id": user["id"]})


@api.get("/entries/{entry_id}")
async def get_entry(entry_id: str) -> dict:
    async with session_scope() as s:
        e = await s.get(BrainEntry, entry_id)
        if e is None:
            raise _problem(404, "entry not found", entry_id)
        links = (await s.scalars(select(__import__("crew.core.models", fromlist=["BrainLink"]).BrainLink)
                                 .where((__import__("crew.core.models", fromlist=["BrainLink"]).BrainLink.from_entry_id == entry_id) |
                                        (__import__("crew.core.models", fromlist=["BrainLink"]).BrainLink.to_entry_id == entry_id)))).all()
    return {**brain_service._serialize(e),
            "links": [{"from": ln.from_entry_id, "to": ln.to_entry_id, "relation": ln.relation}
                      for ln in links]}


@api.post("/entries/{entry_id}/promote")
async def promote_entry(entry_id: str, body: PromoteBody, user: dict = Depends(require_user)) -> dict:
    async with session_scope() as s:
        e = await s.get(BrainEntry, entry_id)
        if e is None:
            raise _problem(404, "entry not found", entry_id)
        project_id = e.project_id
    try:
        return await brain_service.promote(project_id=project_id, entry_id=entry_id,
                                           to_brain_id=body.to_brain_id, actor=None,
                                           rationale=body.rationale or "manual promotion")
    except PermissionError as e:
        raise _problem(403, "policy_denied", str(e)) from e


@api.post("/entries/{entry_id}/supersede")
async def supersede_entry(entry_id: str, body: SupersedeBody, user: dict = Depends(require_user)) -> dict:
    async with session_scope() as s:
        e = await s.get(BrainEntry, entry_id)
        if e is None:
            raise _problem(404, "entry not found", entry_id)
        project_id = e.project_id
    await brain_service.supersede(project_id=project_id, old_id=entry_id, new_id=body.new_entry_id,
                                  reason=body.reason)
    return {"entry_id": entry_id, "superseded_by": body.new_entry_id}


@api.post("/projects/{project_id}/brains/search")
async def brain_search(project_id: str, body: dict) -> dict:
    ids = body.get("brain_ids")
    if not ids:
        ids = [b["id"] for b in await brain_service.list_brains(project_id)]
    hits = await brain_service.search(project_id=project_id, brain_ids=ids,
                                      query=str(body.get("query", "")),
                                      top_k=int(body.get("top_k", 8)))
    return {"items": hits}


# ── rewards ─────────────────────────────────────────────────────────────────────────
@api.get("/projects/{project_id}/leaderboard")
async def get_leaderboard(project_id: str) -> dict:
    return {"items": await leaderboard(project_id)}


@api.get("/agents/{agent_id}/rewards")
async def agent_rewards(agent_id: str, limit: int = Query(100, le=1000)) -> dict:
    async with session_scope() as s:
        rows = (await s.scalars(select(RewardEvent).where(RewardEvent.agent_id == agent_id)
                                .order_by(desc(RewardEvent.created_at)).limit(limit))).all()
        a = await s.get(Agent, agent_id)
    return {"items": [{"id": r.id, "task_id": r.task_id, "role": r.role_in_task, "verdict": r.verdict,
                       "reward": r.reward, "score_after": r.score_after, "components": r.components,
                       "penalties": r.penalties, "note": r.note,
                       "created_at": r.created_at.isoformat()} for r in rows],
            "score": a.score if a else None,
            "recomputed": await reward_engine.recompute(project_id=a.project_id, agent_id=agent_id) if a else None}


@api.get("/projects/{project_id}/reward-transitions")
async def reward_transitions(project_id: str) -> dict:
    async with session_scope() as s:
        rows = (await s.scalars(select(RewardEvent).where(RewardEvent.project_id == project_id,
                                                          RewardEvent.grade_after != RewardEvent.grade_before)
                                .order_by(desc(RewardEvent.created_at)).limit(100))).all()
    return {"items": [{"agent_id": r.agent_id, "grade_before": r.grade_before, "grade_after": r.grade_after,
                       "reward": r.reward, "verdict": r.verdict, "created_at": r.created_at.isoformat()}
                      for r in rows]}


@api.put("/projects/{project_id}/reward-weights")
async def put_weights(project_id: str, body: WeightsBody, user: dict = Depends(require_user)) -> dict:
    async with session_scope() as s:
        p = await s.get(Project, project_id)
        if p is None:
            raise _problem(404, "project not found", project_id)
        p.settings = {**(p.settings or {}), "reward_weights": body.weights}
        s.add(p)
    await audit(actor_kind="user", actor_id=user["id"], action="reward.weights_changed",
                resource_kind="project", resource_id=project_id, reason=json.dumps(body.weights))
    return {"weights": body.weights, "defaults": DEFAULT_WEIGHTS}


@api.post("/projects/{project_id}/reward-preview")
async def reward_preview(project_id: str, body: WeightsBody) -> dict:
    from crew.core.reward import compute_reward

    async with session_scope() as s:
        rows = (await s.scalars(select(RewardEvent).where(RewardEvent.project_id == project_id)
                                .order_by(desc(RewardEvent.created_at)).limit(50))).all()
        tasks = {t.id: t for t in (await s.scalars(select(Task).where(Task.id.in_(
            [r.task_id for r in rows if r.task_id] or [""])))).all()}
    out = []
    for r in rows:
        t = tasks.get(r.task_id or "")
        if r.role_in_task != "producer" or t is None:
            continue
        value, components = compute_reward(
            verdict=r.verdict, quality=float((r.components or {}).get("quality", 0.5)),
            est_cost_micros=0, act_cost_micros=t.cost_micros, retries=t.attempts - 1,
            penalties=r.penalties or [], weights=body.weights)
        out.append({"task_id": r.task_id, "old_reward": r.reward, "new_reward": value,
                    "components": components})
    return {"preview": out, "count": len(out)}


# ── events & traces ─────────────────────────────────────────────────────────────────
@api.get("/projects/{project_id}/events")
async def get_events(project_id: str, from_seq: int = 0, to_seq: int | None = None,
                     type: str | None = None, agent_id: str | None = None, task_id: str | None = None,
                     severity_min: str | None = None, limit: int = Query(500, le=5000)) -> dict:
    async with session_scope() as s:
        stmt = select(Event).where(Event.project_id == project_id, Event.seq > from_seq)
        if to_seq:
            stmt = stmt.where(Event.seq <= to_seq)
        if type:
            if type.endswith("*"):
                stmt = stmt.where(Event.type.like(type.replace("*", "%")))
            else:
                stmt = stmt.where(Event.type.in_(type.split(",")))
        if agent_id:
            stmt = stmt.where(Event.agent_id == agent_id)
        if task_id:
            stmt = stmt.where(Event.task_id == task_id)
        rows = (await s.scalars(stmt.order_by(Event.seq).limit(limit))).all()
    out = [ev.event_to_dict(e) for e in rows]
    if severity_min:
        order = ["debug", "info", "notice", "warning", "error", "critical"]
        out = [e for e in out if order.index(e["severity"]) >= order.index(severity_min)]
    return {"items": out, "seq_head": out[-1]["seq"] if out else from_seq}


@api.get("/traces/{trace_id}")
async def get_trace(trace_id: str) -> dict:
    async with session_scope() as s:
        rows = (await s.scalars(select(Event).where(Event.trace_id == trace_id)
                                .order_by(Event.seq).limit(5000))).all()
    return {"trace_id": trace_id, "spans": [
        {"seq": e.seq, "type": e.type, "ts": e.ts.isoformat(), "span_id": e.span_id,
         "parent_span_id": e.parent_span_id, "title": e.title, "agent_id": e.agent_id,
         "task_id": e.task_id, "cost_micros": e.cost_micros, "duration_ms": e.duration_ms}
        for e in rows]}


@api.get("/projects/{project_id}/agents/{agent_id}/context")
async def agent_context(project_id: str, agent_id: str, query: str = "") -> dict:
    async with session_scope() as s:
        a = await s.get(Agent, agent_id)
        if a is None:
            raise _problem(404, "agent not found", agent_id)
        recent = await s.scalar(select(Task).where(Task.assignee_agent_id == agent_id)
                                .order_by(desc(Task.created_at)).limit(1))
    q = query or (recent.title if recent else (a.mission or a.role))
    hits = await brain_service.context_pack(project_id=project_id, agent=a, query=q)
    return {"agent_id": agent_id, "query": q, "pack": hits,
            "rendered_tokens_approx": len(
                __import__("crew.control.verify", fromlist=["x"]) and
                __import__("crew.core.brains", fromlist=["render_context_pack"]).render_context_pack(hits).split()),
            "tools": tools_for_agent(a)}


# ── approvals, policy, secrets ──────────────────────────────────────────────────────
@api.get("/projects/{project_id}/approvals")
async def list_approvals(project_id: str, state: str | None = None) -> dict:
    async with session_scope() as s:
        stmt = select(Approval).where(Approval.project_id == project_id)
        if state:
            stmt = stmt.where(Approval.state == state)
        rows = (await s.scalars(stmt.order_by(desc(Approval.created_at)).limit(200))).all()
    return {"items": [{"id": a.id, "capability": a.capability, "state": a.state,
                       "agent_id": a.agent_id, "task_id": a.task_id, "request": a.request,
                       "reason": a.reason, "created_at": a.created_at.isoformat(),
                       "decided_at": a.decided_at.isoformat() if a.decided_at else None,
                       "expires_at": a.expires_at.isoformat() if a.expires_at else None} for a in rows]}


@api.post("/approvals/{approval_id}/grant")
async def grant_approval(approval_id: str, body: ApprovalDecision, user: dict = Depends(require_user)) -> dict:
    row = await decide_approval(approval_id, grant=True, decided_by=user["id"], reason=body.reason)
    if row is None:
        raise _problem(409, "approval is not pending", approval_id)
    await ev.emit("policy.approval.granted", project_id=row.project_id, agent_id=row.agent_id,
                  task_id=row.task_id, severity="notice", title=f"approved: {row.capability}",
                  payload={"capability": row.capability, "approval_id": approval_id}, actor=user["id"])
    return {"approval_id": approval_id, "state": "granted"}


@api.post("/approvals/{approval_id}/deny")
async def deny_approval(approval_id: str, body: ApprovalDecision, user: dict = Depends(require_user)) -> dict:
    row = await decide_approval(approval_id, grant=False, decided_by=user["id"], reason=body.reason)
    if row is None:
        raise _problem(409, "approval is not pending", approval_id)
    await ev.emit("policy.approval.denied", project_id=row.project_id, agent_id=row.agent_id,
                  task_id=row.task_id, severity="warning", title=f"denied: {row.capability}",
                  payload={"capability": row.capability, "approval_id": approval_id},
                  actor=user["id"])
    return {"approval_id": approval_id, "state": "denied"}


@api.get("/projects/{project_id}/audit")
async def get_audit(project_id: str, limit: int = Query(200, le=1000)) -> dict:
    async with session_scope() as s:
        rows = (await s.scalars(select(AuditLog).order_by(desc(AuditLog.seq)).limit(limit))).all()
    return {"items": [{"seq": r.seq, "ts": r.ts.isoformat(), "actor_kind": r.actor_kind,
                       "actor_id": r.actor_id, "action": r.action, "resource_kind": r.resource_kind,
                       "resource_id": r.resource_id, "outcome": r.outcome, "reason": r.reason,
                       "hash": r.hash[:16]} for r in rows]}


@api.get("/secrets")
async def list_secrets() -> dict:
    return {"items": await vault.list_handles()}


@api.post("/secrets", status_code=201)
async def create_secret(body: SecretCreate, user: dict = Depends(require_user)) -> dict:
    sid = await vault.create(body.name, body.value, scope_kind=body.scope_kind, scope_id=body.scope_id,
                             actor=user["id"])
    return {"id": sid, "name": body.name, "stored": True}


@api.get("/projects/{project_id}/egress")
async def get_egress(project_id: str) -> dict:
    p = await _project_or_404(project_id)
    async with session_scope() as s:
        blocked = (await s.scalars(select(Event).where(Event.project_id == project_id,
                                                       Event.type == "security.egress.blocked")
                                   .order_by(desc(Event.seq)).limit(50))).all()
    return {"allowlist": policy.allowed_egress(p),
            "extra": p.setting("egress_allow", []),
            "blocked_attempts": [{"ts": e.ts.isoformat(), "payload": e.payload} for e in blocked]}


@api.get("/projects/{project_id}/budget/ledger")
async def budget_ledger(project_id: str) -> dict:
    return await budget.reconcile(project_id)
