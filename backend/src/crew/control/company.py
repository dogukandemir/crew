"""The company layer (ADR 0009): a headquarters project whose agents run the portfolio.

A company IS a project row (kind='company') — that schema economy is the whole point:
its agents, budgets, brains and event stream are the machinery every project already
has, so governance needs nothing invented. Its working parts:

- the CEO (role `ceo`) is hired at bootstrap and chairs the portfolio;
- company chiefs (the ADR 0008 C-roles) join on demand and own functions across projects;
- a member project's orchestrator reports to the CEO once the project joins;
- a review reads every member project's numbers and writes ONE grounded directive into
  each member's stream — the orchestrator reads directives into its task prompts, so a
  directive is binding work, not a dashboard;
- the company brain (ADR 0015, `BrainScope.COMPANY`) is the umbrella memory: the mission
  seeds it, reviews and allocations land in it, and every member project's agents
  retrieve from it — one directive, available everywhere.

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
from crew.core.models import Agent, Brain, BrainEntry, Department, Event, Project, Task
from crew.domain.catalog import RoleSpec
from crew.domain.enums import BrainScope, Role

log = logging.getLogger(__name__)

STALE_DEFAULT_HOURS = 72
VERDICT_ORDER = ("on_track", "at_risk", "no_activity", "stop")

# Which function each company C-role speaks for (ADR 0011, one scope up from ADR 0008).
FUNCTION_OF_C_ROLE: dict[str, str] = {
    "cto": "technology", "cmo": "market", "cpo": "product", "coo": "operations",
    "cfo": "finance",
}

# How much each verdict weighs when the headroom is split (ADR 0011). A `stop` project
# gets weight 0: the call is exactly "no new money", not "a smaller envelope".
VERDICT_WEIGHT: dict[str, float] = {
    "on_track": 1.0, "no_activity": 0.5, "at_risk": 0.5, "stop": 0.0,
}


async def create_company(*, name: str, mission: str = "", budget_usd: float | None = None,
                         owner_id: str | None = None) -> dict:
    """Create the company (a kind='company' project) and hire its CEO."""
    return await org.create_project(name=name, goal=mission, budget_usd=budget_usd,
                                    owner_id=owner_id, kind="company")


async def found_company(*, name: str, mission: str = "", budget_usd: float | None = None,
                        owner_id: str | None = None, project_name: str, project_goal: str = "",
                        project_budget_usd: float | None = None) -> dict:
    """One breath (ADR 0015): the company, then its first project born UNDER it.

    The wizard's single call. The first run is started by the API layer (it owns the
    background driving), so this returns the rows that now exist — nothing is claimed
    that was not written."""
    company = await create_company(name=name, mission=mission, budget_usd=budget_usd,
                                   owner_id=owner_id)
    project = await org.create_project(name=project_name, goal=project_goal,
                                       budget_usd=project_budget_usd, owner_id=owner_id,
                                       company_id=company["id"])
    return {"company": company, "project": project}


async def brains_overview(company_id: str) -> dict:
    """The umbrella brain plus every member's memory index — one honest page (ADR 0015).

    The company brain is served with its entry count; members list their brains with
    per-brain counts so the UI can show WHERE knowledge lives without fetching every
    project's stream. Read-only by design: a member's memory is opened from its own tab."""
    async with session_scope() as s:
        company = await s.get(Project, company_id)
        if company is None or company.kind != "company":
            raise KeyError(company_id)
        members = (await s.scalars(select(Project).where(
            Project.company_id == company_id, Project.kind == "project"))).all()
        co_brains = (await s.scalars(select(Brain).where(
            Brain.project_id == company_id,
            Brain.scope == BrainScope.COMPANY.value))).all()
        co_counts = {bid: int(n) for bid, n in (await s.execute(
            select(BrainEntry.brain_id, func.count(BrainEntry.id))
            .where(BrainEntry.project_id == company_id).group_by(BrainEntry.brain_id))).all()}
        member_rows: list[dict] = []
        for m in members:
            brains = (await s.scalars(select(Brain).where(Brain.project_id == m.id))).all()
            counts = {bid: int(n) for bid, n in (await s.execute(
                select(BrainEntry.brain_id, func.count(BrainEntry.id))
                .where(BrainEntry.project_id == m.id).group_by(BrainEntry.brain_id))).all()}
            # Resolve owner names: "person · personal" is a database, a name
            # is an org — the same resolution list_brains does, one scope up.
            dept_names = {d.id: d.name for d in (await s.scalars(
                select(Department).where(Department.project_id == m.id))).all()}
            agent_names = {a.id: a.name for a in (await s.scalars(
                select(Agent).where(Agent.project_id == m.id))).all()}

            member_rows.append({
                "project_id": m.id, "name": m.name,
                "brains": [{"id": b.id, "scope": b.scope, "label": b.label,
                            "owner_name": _brain_owner_name(b.scope, b.owner_id, m.name,
                                                            dept_names, agent_names),
                            "entries": counts.get(b.id, 0)} for b in brains],
            })
    first = co_brains[0] if co_brains else None
    return {
        "company_id": company_id,
        "company_brain": ({"id": first.id, "label": first.label,
                           "entries": co_counts.get(first.id, 0)} if first else None),
        "members": member_rows,
    }


def _aware(ts: datetime) -> datetime:
    return ts.replace(tzinfo=UTC) if ts.tzinfo is None else ts


def _brain_owner_name(scope: str, owner_id: str, project_name: str,
                      dept_names: dict[str, str], agent_names: dict[str, str]) -> str:
    """A brain's human owner: the same resolution `list_brains` does."""
    if scope in ("company", "project"):
        return project_name
    if scope == "department":
        return dept_names.get(owner_id, "")
    return agent_names.get(owner_id, "")


async def _review_payload(s, company_id: str) -> dict | None:
    row = await s.scalar(select(Event).where(Event.project_id == company_id,
                                             Event.type == "company.review.recorded")
                         .order_by(desc(Event.seq)).limit(1))
    if row is None:
        return None
    return {"ts": _aware(row.ts).isoformat(), **{k: v for k, v in (row.payload or {}).items()}}


async def _member_stats(s, m: Project, stale_hours: int) -> dict:
    """One member's numbers, read from its own stream — the only lens the review,
    the portfolio and the HQ floor all share."""
    completed = int(await s.scalar(select(func.count(Event.id)).where(
        Event.project_id == m.id, Event.type == "task.completed")) or 0)
    failed = int(await s.scalar(select(func.count(Event.id)).where(
        Event.project_id == m.id, Event.type == "task.failed")) or 0)
    open_tasks = int(await s.scalar(select(func.count(Task.id)).where(
        Task.project_id == m.id,
        Task.state.in_(["assigned", "running", "ready", "pending"]))) or 0)
    last = await s.scalar(select(Event.ts).where(Event.project_id == m.id)
                          .order_by(Event.seq.desc()).limit(1))
    return {"id": m.id, "name": m.name, "completed": completed, "failed": failed,
            "open_tasks": open_tasks,
            "ratio": (m.spend_micros / m.budget_cap_micros) if m.budget_cap_micros else 0.0,
            "cap_micros": m.budget_cap_micros, "spend_micros": m.spend_micros,
            "last_ts": last, "stale_hours": stale_hours}


def _verdict_of(st: dict, now: datetime) -> tuple[str, str, str, dict]:
    """One member's verdict from its own numbers. Deterministic on purpose: every line
    cites the numbers it came from; an LLM garnish can come later, a lie cannot.
    Shared by review() and portfolio() so the two can never disagree (ADR 0011)."""
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
    elif st["completed"] == 0 and st["failed"] == 0:
        # Nothing has EVER finished here: "on track" is a guess with no
        # completed work to stand on. If a run is in flight, say that; if nothing is,
        # say THAT — both sentences cite the record.
        verdict, severity = "no_activity", "notice"
        line = (f"first run in flight: {st['open_tasks']} task(s) underway, nothing completed yet"
                if st["open_tasks"] else
                "nothing on the record yet — start a run, or archive it if the goal moved on")
    elif st["last_ts"] is None or (now - _aware(st["last_ts"])) > timedelta(hours=st["stale_hours"]):
        verdict, severity = "no_activity", "notice"
        line = (f"status check: nothing on the record for {st['stale_hours'] // 24}d — "
                f"resume it or archive it")
    else:
        verdict, severity = "on_track", "info"
        line = (f"keep going: {st['ratio']:.0%} of the budget used, {st['completed']} completed "
                f"so far")
    basis = {"spend_ratio": round(st["ratio"], 4), "completed": st["completed"],
             "failed": st["failed"], "attempted": attempted,
             "open_tasks": st.get("open_tasks", 0),
             "cap_micros": st["cap_micros"], "stale_hours": st["stale_hours"]}
    return verdict, severity, line, basis


async def _board_list(s, company_id: str) -> list[dict]:
    rows = (await s.scalars(select(Agent).where(
        Agent.project_id == company_id,
        Agent.role.in_((Role.CHAIR.value, Role.BOARD_MEMBER.value)),
        Agent.state != "archived").order_by(Agent.role))).all()
    return [{"id": a.id, "name": a.name, "role": a.role, "grade": a.grade} for a in rows]


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
        "board": await _board_list(s, c.id),
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
        stats = [await _member_stats(s, m, stale_hours) for m in members]

    now = datetime.now(UTC)
    verdicts: list[dict] = []
    for st in stats:
        verdict, severity, line, basis = _verdict_of(st, now)
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
        brain_id = await brain_service.ensure_company_brain(company_id)
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


# ── portfolio governance (ADR 0011) ─────────────────────────────────────────────────

async def portfolio(company_id: str) -> dict:
    """The C-level's view before the money moves: each member's verdict, the share of the
    company's headroom its record justifies, and its priority rank. Deterministic — every
    line cites the numbers it came from, and a `stop` project funds nothing new."""
    async with session_scope() as s:
        company = await s.get(Project, company_id)
        if company is None or company.kind != "company":
            raise KeyError(company_id)
        stale_hours = int((company.settings or {}).get("review_stale_hours", STALE_DEFAULT_HOURS))
        members = (await s.scalars(select(Project).where(Project.company_id == company_id,
                                                         Project.kind == "project"))).all()
        stats = [await _member_stats(s, m, stale_hours) for m in members]
        cap, spend = company.budget_cap_micros, company.spend_micros

    now = datetime.now(UTC)
    rows: list[dict] = []
    for st in stats:
        verdict, severity, line, basis = _verdict_of(st, now)
        attempted = st["completed"] + st["failed"]
        # no record yet → neutral, not zero: an unproven project is not a bad one
        success = (st["completed"] / attempted) if attempted else 0.6
        raw = (0.3 + 0.7 * success) * VERDICT_WEIGHT.get(verdict, 0.5)
        rows.append({"project_id": st["id"], "name": st["name"], "verdict": verdict,
                     "severity": severity, "directive": line, "basis": basis,
                     "weight": round(raw, 4), "success_rate": round(success, 4),
                     "spend_micros": st["spend_micros"], "cap_micros": st["cap_micros"]})

    total_weight = sum(r["weight"] for r in rows) or 1.0
    headroom = max(0, cap - spend)
    for r in rows:
        r["share"] = round(r["weight"] / total_weight, 4)
        r["new_cap_micros"] = r["spend_micros"] + int(headroom * r["share"])
    rows.sort(key=lambda r: (-r["weight"], r["name"]))
    for i, r in enumerate(rows, start=1):
        r["priority"] = i
    return {"company_id": company_id, "cap_micros": cap, "spend_micros": spend,
            "headroom_micros": headroom, "projects": rows,
            "method": "cap_i = spend_i + share_i of company headroom; share by "
                      "(0.3 + 0.7·success) × verdict weight; a stop verdict funds nothing new"}


async def allocate(*, company_id: str, actor: str = "system") -> dict:
    """The CEO's portfolio call: rank the members by their record and write the caps.
    A `stop` verdict lands its cap exactly on what the project has already spent —
    the decision is "no new money", and the ledger says so."""
    view = await portfolio(company_id=company_id)
    allocations: list[dict] = []
    async with session_scope() as s:
        company = await s.get(Project, company_id)
        if company is None or company.kind != "company":
            raise KeyError(company_id)
        ceo_id = (company.settings or {}).get("ceo_id")
        for r in view["projects"]:
            m = await s.get(Project, r["project_id"])
            if m is None:
                continue
            old_cap = m.budget_cap_micros
            m.budget_cap_micros = r["new_cap_micros"]
            s.add(m)
            allocations.append({**r, "old_cap_micros": old_cap})
    await ev.emit("company.allocation.decided", project_id=company_id, agent_id=ceo_id,
                  severity="notice",
                  title=f"portfolio allocation: {len(allocations)} projects ranked",
                  summary=" · ".join(
                      f"{a['name']}: #{a['priority']} → ${a['new_cap_micros'] / 1_000_000:.2f}"
                      for a in allocations) or "no member projects",
                  payload={"company_id": company_id,
                           "allocations": [{k: a[k] for k in (
                               "project_id", "name", "priority", "verdict", "share",
                               "old_cap_micros", "new_cap_micros")} for a in allocations],
                           "headroom_micros": view["headroom_micros"],
                           "method": view["method"]},
                  actor=f"agent:{ceo_id}" if ceo_id else actor)
    try:
        brain_id = await brain_service.ensure_company_brain(company_id)
        await brain_service.write(
            project_id=company_id, brain_id=brain_id, kind="decision",
            title=f"Portfolio allocation ({len(allocations)} projects)",
            body="; ".join(f"{a['name']}: priority {a['priority']}, "
                           f"${a['new_cap_micros'] / 1_000_000:.2f} cap ({a['verdict']})"
                           for a in allocations) or "no member projects",
            source={"via": "company.allocate"}, importance=0.8, tags=["allocation", "portfolio"])
    except Exception:
        log.exception("allocation brain write failed")
    return {"company_id": company_id, "projects": allocations,
            "headroom_micros": view["headroom_micros"], "method": view["method"]}


async def add_board_member(*, company_id: str, role: str = "board_member") -> dict:
    """Seat another director: a new owners' seat, or a re-seated chair."""
    if role not in ("chair", "board_member"):
        raise ValueError(f"unknown board role: {role}")
    async with session_scope() as s:
        company = await s.get(Project, company_id)
        if company is None or company.kind != "company":
            raise KeyError(company_id)
    seat = await org.hire_agent(project_id=company_id, spec=RoleSpec.from_template(Role(role)),
                                rationale="a new owners' seat at the table", actor="user")
    async with session_scope() as s:
        row = await s.get(Project, company_id)
        settings = dict(row.settings or {})
        if role == "chair":
            settings["chair_id"] = seat["id"]
        else:
            board = list(settings.get("board_ids") or [])
            board.append(seat["id"])
            settings["board_ids"] = board
        row.settings = settings
        s.add(row)
    await ev.emit("board.seated", project_id=company_id, agent_id=seat["id"], severity="notice",
                  title=f"board seat: {seat['name']} ({role.replace('_', ' ')})",
                  payload={"company_id": company_id, "role": role, "agent_id": seat["id"]},
                  actor="user")
    return seat


async def board_session(*, company_id: str, topic: str,
                        options: list[str] | None = None, actor: str = "user") -> dict:
    """Convene the board of directors: the chair, the seated members and the CEO around
    one topic. Runs on the ordinary council machinery — one ledger, one decision log."""
    from crew.control.council import council

    async with session_scope() as s:
        company = await s.get(Project, company_id)
        if company is None or company.kind != "company":
            raise KeyError(company_id)
        ceo_id = (company.settings or {}).get("ceo_id")
        board = (await s.scalars(select(Agent).where(
            Agent.project_id == company_id,
            Agent.role.in_((Role.CHAIR.value, Role.BOARD_MEMBER.value)),
            Agent.state != "archived"))).all()
        panel = [a.id for a in board] + ([ceo_id] if ceo_id else [])
        names = [a.name for a in board]

    opts = [{"id": f"opt{i}", "text": t} for i, t in enumerate(
        options or ["approve the plan as recorded", "hold it: revise before funding"], start=1)]
    result = await council.convene(
        project=company, question=topic, options=opts,
        criteria=["fiduciary duty", "evidence", "portfolio risk"],
        panel=panel, convened_by=f"agent:{ceo_id}" if ceo_id else actor,
        rationale="a board session called over the portfolio")
    await ev.emit("board.convened", project_id=company_id, severity="notice",
                  title=f"board session: {topic[:60]}",
                  payload={"session_id": result["session_id"], "topic": topic, "members": names},
                  actor=actor)
    return {**result, "panel": panel, "members": names}


async def hq(company_id: str) -> dict:
    """The whole company on one floor (ADR 0011): the executive suites and the board
    room, each member project's pod with its teams, and the governance activity the
    scene animates from — all read from the record, none of it invented."""
    from crew.domain.catalog import ROLE_TEMPLATES

    async with session_scope() as s:
        company = await s.get(Project, company_id)
        if company is None or company.kind != "company":
            raise KeyError(company_id)
        core = await _company_core(s, company)
        stale_hours = int((company.settings or {}).get("review_stale_hours", STALE_DEFAULT_HOURS))
        members = (await s.scalars(select(Project).where(Project.company_id == company_id,
                                                         Project.kind == "project"))).all()
        projects: list[dict] = []
        for m in members:
            st = await _member_stats(s, m, stale_hours)
            verdict, _severity, line, _basis = _verdict_of(st, datetime.now(UTC))
            depts = (await s.scalars(select(Department).where(
                Department.project_id == m.id, Department.status == "active"))).all()
            teams = []
            for d in depts:
                head = await s.get(Agent, d.head_agent_id) if d.head_agent_id else None
                count = int(await s.scalar(select(func.count(Agent.id)).where(
                    Agent.department_id == d.id, Agent.state != "archived")) or 0)
                teams.append({"id": d.id, "name": d.name,
                              "head_name": head.name if head else None, "agents": count})
            open_tasks = int(await s.scalar(select(func.count(Task.id)).where(
                Task.project_id == m.id,
                Task.state.notin_(("completed", "failed", "aborted")))) or 0)
            projects.append({"id": m.id, "name": m.name, "status": m.status, "verdict": verdict,
                             "directive": line, "spend_ratio": round(st["ratio"], 4),
                             "completed": st["completed"], "failed": st["failed"],
                             "open_tasks": open_tasks, "teams": teams,
                             "last_at": _aware(st["last_ts"]).isoformat() if st["last_ts"] else None})
        activity_ids = [company.id] + [m.id for m in members]
        rows = (await s.scalars(select(Event).where(
            Event.project_id.in_(activity_ids),
            Event.type.in_(("board.convened", "board.seated", "company.allocation.decided",
                            "company.directive", "company.review.recorded",
                            "council.convened", "council.position", "decision.recorded",
                            "company.project.joined")),
        ).order_by(Event.seq.desc()).limit(60))).all()
        activity = [{"type": e.type, "at": _aware(e.ts).isoformat(), "project_id": e.project_id,
                     "text": e.title, "summary": e.summary,
                     "payload": {k: v for k, v in (e.payload or {}).items()
                                 if k in ("topic", "session_id", "verdict", "project_id",
                                          "directive", "members", "role", "agent_id")}}
                    for e in rows]

    executives: list[dict] = []
    if core["ceo"]:
        executives.append({"id": core["ceo"]["id"], "name": core["ceo"]["name"], "role": "ceo",
                           "title": ROLE_TEMPLATES[Role.CEO].title, "function": "executive"})
    for r in core["roster"]:
        if r["role"] == Role.CEO.value:
            continue
        try:
            role = Role(r["role"])
            title = ROLE_TEMPLATES[role].title
        except (ValueError, KeyError):
            title = r["role"]
        executives.append({"id": r["id"], "name": r["name"], "role": r["role"], "title": title,
                           "function": FUNCTION_OF_C_ROLE.get(r["role"], "executive")})
    return {"company": {"id": core["id"], "name": core["name"], "mission": core["mission"],
                        "budget_usd": core["budget_usd"], "spend_usd": core["spend_usd"],
                        "spend_ratio": core["spend_ratio"], "last_review": core["last_review"]},
            "ceo": core["ceo"], "executives": executives, "board": core["board"],
            "projects": projects, "activity": activity}
