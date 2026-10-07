"""The company layer (ADR 0009): a headquarters project whose agents run the portfolio.

A company IS a project row (kind='company') — that schema economy is the whole point:
its agents, budgets, brains and event stream are the machinery every project already
has, so governance needs nothing invented. Its working parts:

- the CEO (role `ceo`) is hired at bootstrap and chairs the portfolio;
- company chiefs (the ADR 0008 C-roles) join on demand and own functions across projects;
- a member project's orchestrator reports to the CEO once the project joins;
- a review reads every member project's numbers and writes ONE grounded directive into
  each member's stream — the orchestrator reads directives into its task prompts, so a
  directive is binding work, not a dashboard.

The review is deliberately deterministic for now: every line cites the numbers it came
from (spend ratio, completed, failed). An LLM garnish can come later; a lie cannot.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta

from sqlalchemy import desc, func, select

from crew.control import org
from crew.core import events as ev
from crew.core.brains import brain_service
from crew.core.db import session_scope
from crew.core.models import Agent, Event, Project
from crew.domain.catalog import RoleSpec
from crew.domain.enums import Role

log = logging.getLogger(__name__)

STALE_DEFAULT_HOURS = 72
VERDICT_ORDER = ("on_track", "at_risk", "no_activity", "stop")


async def create_company(*, name: str, mission: str = "", budget_usd: float | None = None,
                         owner_id: str | None = None) -> dict:
    """Create the company (a kind='company' project) and hire its CEO."""
    return await org.create_project(name=name, goal=mission, budget_usd=budget_usd,
                                    owner_id=owner_id, kind="company")


def _aware(ts: datetime) -> datetime:
    return ts.replace(tzinfo=UTC) if ts.tzinfo is None else ts


async def _review_payload(s, company_id: str) -> dict | None:
    row = await s.scalar(select(Event).where(Event.project_id == company_id,
                                             Event.type == "company.review.recorded")
                         .order_by(desc(Event.seq)).limit(1))
    if row is None:
        return None
    return {"ts": _aware(row.ts).isoformat(), **{k: v for k, v in (row.payload or {}).items()}}


async def _company_core(s, c: Project) -> dict:
    ceo_id = (c.settings or {}).get("ceo_id")
    ceo = await s.get(Agent, ceo_id) if ceo_id else None
    roster = (await s.scalars(select(Agent).where(
        Agent.project_id == c.id,
        Agent.role.in_((Role.CEO.value, Role.CTO.value, Role.CMO.value, Role.CPO.value, Role.COO.value)),
        Agent.state != "archived"))).all()
    members = (await s.scalars(select(Project).where(Project.company_id == c.id,
                                                     Project.kind == "project"))).all()
    return {
        "id": c.id, "name": c.name, "mission": c.goal, "status": c.status,
        "budget_usd": c.budget_usd, "spend_usd": c.spend_usd,
        "spend_ratio": round(c.spend_micros / c.budget_cap_micros, 4) if c.budget_cap_micros else 0.0,
        "ceo": ({"id": ceo.id, "name": ceo.name, "grade": ceo.grade} if ceo else None),
        "roster": [{"id": a.id, "name": a.name, "role": a.role, "grade": a.grade} for a in roster],
        "projects": [{"id": m.id, "name": m.name, "status": m.status,
                      "spend_ratio": round(m.spend_micros / m.budget_cap_micros, 4)
                      if m.budget_cap_micros else 0.0} for m in members],
        "last_review": await _review_payload(s, c.id),
    }


async def list_companies() -> list[dict]:
    async with session_scope() as s:
        rows = (await s.scalars(select(Project).where(Project.kind == "company")
                                .order_by(desc(Project.created_at)))).all()
        return [await _company_core(s, c) for c in rows]


async def get_company(company_id: str) -> dict:
    async with session_scope() as s:
        c = await s.get(Project, company_id)
        if c is None or c.kind != "company":
            raise KeyError(company_id)
        return await _company_core(s, c)


async def attach_project(*, company_id: str, project_id: str) -> dict:
    """A project joins the company: the report chain gains a top — orchestrator → CEO."""
    async with session_scope() as s:
        company = await s.get(Project, company_id)
        project = await s.get(Project, project_id)
        if company is None or company.kind != "company":
            raise KeyError(company_id)
        if project is None or project.kind != "project":
            raise KeyError(project_id)
        project.company_id = company_id
        s.add(project)
        ceo_id = (company.settings or {}).get("ceo_id")
        orch_id = (project.settings or {}).get("orchestrator_id")
        orch = await s.get(Agent, orch_id) if orch_id else None
        if orch is not None and ceo_id:
            orch.manager_id = ceo_id  # the chain: orchestrator → CEO
            s.add(orch)
        name = project.name
    await ev.emit("company.project.joined", project_id=company_id, agent_id=ceo_id, severity="notice",
                  title=f"joined the company: {name}",
                  summary=f"{name} now reports up through the CEO",
                  payload={"company_id": company_id, "project_id": project_id},
                  actor="user")
    return {"company_id": company_id, "project_id": project_id, "orchestrator_id": orch_id,
            "ceo_id": ceo_id}


async def hire_chief(*, company_id: str, function: str) -> dict:
    """Add a company-scope function chief (the ADR 0008 roles, one scope up)."""
    from crew.control.org import C_ROLE_OF_FUNCTION, FUNCTION_TITLE

    role = C_ROLE_OF_FUNCTION.get(function)
    if role is None:
        raise ValueError(f"unknown function: {function}")
    async with session_scope() as s:
        company = await s.get(Project, company_id)
        if company is None or company.kind != "company":
            raise KeyError(company_id)
        ceo_id = (company.settings or {}).get("ceo_id")
        existing = await s.scalar(select(Agent.id).where(Agent.project_id == company_id,
                                                         Agent.role == role.value,
                                                         Agent.state != "archived").limit(1))
    if existing:
        raise ValueError(f"the {function} function already has its chief")
    chief = await org.hire_agent(
        project_id=company_id,
        spec=RoleSpec.from_template(role,
                                    mission=f"Chief of the {FUNCTION_TITLE[function]} function across the portfolio"),
        manager_id=ceo_id, rationale=f"the portfolio needs a {role.value} chair", actor="user")
    return chief


async def review(*, company_id: str, actor: str = "system") -> dict:
    """Read every member project's books; write one grounded directive into each stream."""
    async with session_scope() as s:
        company = await s.get(Project, company_id)
        if company is None or company.kind != "company":
            raise KeyError(company_id)
        ceo_id = (company.settings or {}).get("ceo_id")
        stale_hours = int((company.settings or {}).get("review_stale_hours", STALE_DEFAULT_HOURS))
        members = (await s.scalars(select(Project).where(Project.company_id == company_id,
                                                          Project.kind == "project"))).all()
        stats = []
        for m in members:
            completed = int(await s.scalar(select(func.count(Event.id)).where(
                Event.project_id == m.id, Event.type == "task.completed")) or 0)
            failed = int(await s.scalar(select(func.count(Event.id)).where(
                Event.project_id == m.id, Event.type == "task.failed")) or 0)
            last = await s.scalar(select(Event.ts).where(Event.project_id == m.id)
                                  .order_by(Event.seq.desc()).limit(1))
            stats.append({"id": m.id, "name": m.name, "completed": completed, "failed": failed,
                          "ratio": (m.spend_micros / m.budget_cap_micros) if m.budget_cap_micros else 0.0,
                          "cap_micros": m.budget_cap_micros, "last_ts": last})

    now = datetime.now(UTC)
    verdicts: list[dict] = []
    for st in stats:
        attempted = st["completed"] + st["failed"]
        if st["ratio"] >= 0.95:
            verdict, severity = "stop", "error"
            line = (f"stop and fold: {st['ratio']:.0%} of the budget is spent with "
                    f"{st['completed']} completed — no new spend without a fresh rationale")
        elif attempted >= 3 and st["failed"] / attempted >= 0.5:
            verdict, severity = "at_risk", "warning"
            line = (f"quality alarm: {st['failed']} of {attempted} tasks failed — put a senior pair "
                    f"on the recurring failure before the next attempt")
        elif st["ratio"] >= 0.8:
            verdict, severity = "at_risk", "warning"
            line = (f"tighten: {st['ratio']:.0%} of the budget is used — shrink reservations and "
                    f"cheap models until the run lands")
        elif st["last_ts"] is None or (now - _aware(st["last_ts"])) > timedelta(hours=stale_hours):
            verdict, severity = "no_activity", "notice"
            line = (f"status check: nothing on the record for {stale_hours // 24}d — "
                    f"resume it or archive it")
        else:
            verdict, severity = "on_track", "info"
            line = (f"keep going: {st['ratio']:.0%} of the budget used, {st['completed']} completed "
                    f"so far")
        basis = {"spend_ratio": round(st["ratio"], 4), "completed": st["completed"],
                 "failed": st["failed"], "attempted": attempted,
                 "cap_micros": st["cap_micros"], "stale_hours": stale_hours}
        verdicts.append({"project_id": st["id"], "name": st["name"], "verdict": verdict,
                         "directive": line, "basis": basis})
        await ev.emit("company.directive", project_id=st["id"], agent_id=ceo_id, severity=severity,
                      title=f"company directive: {verdict} — {st['name']}",
                      summary=line,
                      payload={"company_id": company_id, "directive": line, "verdict": verdict,
                               "basis": basis},
                      actor=f"agent:{ceo_id}" if ceo_id else actor)

    counts = {v: sum(1 for x in verdicts if x["verdict"] == v) for v in VERDICT_ORDER}
    recorded = await ev.emit("company.review.recorded", project_id=company_id, agent_id=ceo_id,
                             severity="notice", title=f"portfolio review: {len(verdicts)} projects",
                             summary=" · ".join(f"{k}: {n}" for k, n in counts.items() if n) or "no member projects",
                             payload={"company_id": company_id, "projects": len(verdicts),
                                      "verdicts": verdicts, "counts": counts},
                             actor=f"agent:{ceo_id}" if ceo_id else actor)
    try:
        brain_id = await brain_service.ensure_project_brain(company_id)
        await brain_service.write(project_id=company_id, brain_id=brain_id, kind="lesson",
                                  title=f"Portfolio review: {len(verdicts)} projects",
                                  body="; ".join(f"{v['name']}: {v['verdict']}" for v in verdicts)
                                  or "no member projects",
                                  source={"via": "company.review", "review_id": recorded.get("id")},
                                  importance=0.7, tags=["review", "portfolio"])
    except Exception:
        log.exception("company review brain write failed")
    return {"company_id": company_id, "verdicts": verdicts, "counts": counts,
            "review_event_id": recorded.get("id")}
