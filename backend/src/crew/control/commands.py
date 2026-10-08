"""The command desk (ADR 0012): the Captain writes, the orchestrator answers, the
company moves.

Natural language in; real actions out; every step on the record. The desk is
deterministic-first: a lexicon parser (Turkish + English) turns the message into a
typed command; only when it cannot — and only when a model is configured — does the
orchestrator's model get asked to interpret into the same strict schema. Offline it
says what it can and cannot understand; it never guesses a destructive act.

Attribution is the whole point: the Captain is this deployment's owner. Orders bind,
ideas are weighed, questions stay questions — and every line carries its source.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

from sqlalchemy import desc, select

from crew.control import org
from crew.core import events as ev
from crew.core.db import session_scope
from crew.core.models import Agent, Event, Project, Task
from crew.domain.catalog import RoleSpec
from crew.domain.enums import Role, TaskState

log = logging.getLogger(__name__)

DEFAULT_BREAK_MINUTES = 10
MAX_BREAK_MINUTES = 120
UNFIREABLE = (Role.ORCHESTRATOR.value, Role.CEO.value, Role.CHAIR.value,
              Role.BOARD_MEMBER.value)

# keyword → role template. The template's own skill profile does the matching (docs/04 §2).
_HIRE_MAP: list[tuple[tuple[str, ...], Role]] = [
    (("analist", "analyst", "veri", "data"), Role.ANALYST),
    (("muhendis", "engineer", "developer", "gelistirici", "kod", "coding"), Role.WORKER),
    (("arastirmaci", "researcher", "research", "arastir"), Role.ANALYST),
    (("tasarimci", "designer", "design", "tasarim"), Role.WORKER),
    (("yazar", "writer", "icerik", "content"), Role.WORKER),
]

_HELP = (
    "I can carry these out: status (\"durum ne?\", \"@Ada ne yapıyor?\") · assign "
    "(\"@Ada, raporu hazırla\") · reassign (\"@Ada'nın işini @Bo'ya devret\") · fire "
    "(\"@Marcus'u görevden al, sebep: …\") · break (\"herkese 15 dakika mola\", \"@Zoe 10 dk mola\") · "
    "goal (\"hedef: pazarlama planı çıkar\") · budget (\"bütçeyi 25$\" / \"bütçeyi %20 artır\") · "
    "hire (\"bir veri analisti işe al\"). Prefix a mode to set the tone: an order binds, "
    "\"bir fikrim var: …\" is weighed, a question just gets answered."
)


@dataclass
class Command:
    intent: str = "unparsed"          # status|assign|reassign|fire|break|goal|budget|hire|help
    mode: str = "order"               # order | idea | question
    mentions: list[str] = field(default_factory=list)   # agent ids, in text order
    everyone: bool = False
    clear_break: bool = False
    minutes: int | None = None
    amount_usd: float | None = None
    percent: float | None = None
    text: str = ""                    # cleaned remainder (title / goal / reason)
    confidence: float = 0.15
    note: str = ""


def _norm(s: str) -> str:
    out = (s.lower().replace("ı", "i").replace("ş", "s").replace("ğ", "g")
           .replace("ü", "u").replace("ö", "o").replace("ç", "c"))
    return re.sub(r"\s+", " ", out)


def _mentions(text: str, roster: list[dict]) -> tuple[list[str], list[str]]:
    """Resolve @tags (and bare first names) to agent ids, preserving text order.

    Returns (ids, unknown-tags). Ambiguity resolves to the FIRST match by name — the
    desk never guesses between two people silently; the reply names who it took.
    """
    tokens = [t.strip(" ,;:!?.…").strip() for t in re.findall(r"@([^\s,;:!?]+)", text)]
    tokens = [t.split("'")[0].split("’")[0] for t in tokens]  # Marcus'u → Marcus
    if not tokens:
        # no tags: look for roster first-names used as words (2+ letters)
        norm_text = _norm(text)
        tokens = [a["name"].split()[0] for a in roster
                  if len(a["name"].split()[0]) >= 2
                  and re.search(rf"\b{re.escape(_norm(a['name'].split()[0]))}\b", norm_text)]
    ids: list[str] = []
    unknown: list[str] = []
    for tok in tokens:
        nt = _norm(tok)
        hit = None
        for a in roster:
            name = _norm(a["name"])
            if name.startswith(nt) or any(w.startswith(nt) for w in name.split()):
                hit = a["id"]
                break
        if hit is None:
            if tok.isalpha():
                unknown.append(tok)
        elif hit not in ids:
            ids.append(hit)
    return ids, unknown


def parse_command(text: str, roster: list[dict]) -> Command:
    """Lexicon parse — pure, no DB, no clock. Turkish and English both welcome."""
    norm = _norm(text)
    ids, unknown = _mentions(text, roster)
    cleaned = re.sub(r"@\S+", " ", text).strip(" ,;:—-")
    cmd = Command(mentions=ids, text=cleaned, note=("unknown mentions: " + ", ".join(unknown))
                  if unknown else "")

    # tone: a question stays a question; a floating idea is weighed, not obeyed
    if text.strip().endswith("?") or "?" in text.strip()[:60]:
        cmd.mode = "question"
    if any(k in norm for k in ("fikir", "oneri", "dusuncem", "belki", "idea", "suggestion",
                               "i think", "maybe")):
        cmd.mode = "idea"

    m = re.search(r"(\d{1,3})\s*(dakika|dk|min|minutes|minute)", norm)
    if m:
        cmd.minutes = max(1, min(MAX_BREAK_MINUTES, int(m.group(1))))
    m = re.search(r"(?:yuzde\s*|%\s*)(\d{1,3})", norm)
    if not m:
        m = re.search(r"(\d{1,3})\s*(?:yuzde|percent|%)", norm)
    if m:
        cmd.percent = float(m.group(1))
    m = re.search(r"\$?\s*(\d+(?:[.,]\d+)?)\s*(?:dolar|usd|\$)", norm)
    if m:
        cmd.amount_usd = float(m.group(1).replace(",", "."))

    if any(k in norm for k in ("ne yapabilirsin", "yardim", "komutlar", "help",
                               "what can you")):
        cmd.intent, cmd.confidence = "help", 0.95
    elif any(k in norm for k in ("mola", "break", "dinlen")):
        cmd.intent, cmd.confidence = "break", 0.9
        cmd.everyone = any(k in norm for k in ("herkes", "herkese", "tum ", "all "))
        cmd.clear_break = any(k in norm for k in ("kaldir", "bitir", "iptal", "clear",
                                                  "end the"))
    elif any(k in norm for k in ("gorevden al", "kov", "isten cikar", "fire",
                                 "let go", "dismiss", "terminate")):
        cmd.intent, cmd.confidence = "fire", 0.9
    elif any(k in norm for k in ("devret", "devir", "aktar", "reassign", "transfer",
                                 "hand over")):
        cmd.intent, cmd.confidence = "reassign", 0.85
    elif any(k in norm for k in ("ise al", "hire", "alim")):
        cmd.intent, cmd.confidence = "hire", 0.85
    elif any(k in norm for k in ("butce", "budget")):
        cmd.intent, cmd.confidence = "budget", 0.9
    elif any(k in norm for k in ("hedef", "goal", "odaklan", "focus on")):
        cmd.intent, cmd.confidence = "goal", 0.85
    elif any(k in norm for k in ("durum", "status", "ne oldu", "neler oluyor",
                                 "what's up", "ne yapiyor", "nasil gidiyor")):
        cmd.intent, cmd.confidence = "status", 0.85
    elif any(k in norm for k in ("gorev ver", "gorev:", "assign", "hazirla", "hallet",
                                 "calis", "tamamla", "task for")) \
            or ("@" in text and ":" in text):
        cmd.intent, cmd.confidence = "assign", 0.8
    return cmd


async def _interpret_with_model(text: str, roster: list[dict]) -> Command | None:
    """Ask the orchestrator's model to turn the message into the same strict schema.
    Only called when the lexicon is not confident and a provider key exists."""
    from crew.control.council import _llm_json
    from crew.domain.enums import ModelTier

    names = ", ".join(a["name"] for a in roster)
    system = (
        "You are the command desk of an AI company. The human is the Captain, the owner. "
        "Interpret the Captain's message into JSON only: "
        '{"intent": "status|assign|reassign|fire|break|goal|budget|hire|help", '
        '"mode": "order|idea|question", "agents": [names present in the message, taken '
        'verbatim from the roster], "minutes": int|null, "amount_usd": number|null, '
        '"percent": number|null, "text": "the work/goal/reason text", "confidence": 0..1}'
    )
    raw = _llm_json(ModelTier.FAST, system, f"ROSTER: {names}\nMESSAGE: {text}")
    if not isinstance(raw, dict):
        return None
    intent = str(raw.get("intent", "unparsed"))
    if intent not in ("status", "assign", "reassign", "fire", "break", "goal", "budget",
                      "hire", "help"):
        return None
    by_name = {_norm(a["name"]): a["id"] for a in roster}
    ids = [by_name[_norm(str(n))] for n in (raw.get("agents") or [])
           if _norm(str(n)) in by_name]
    cmd = Command(intent=intent, mode=str(raw.get("mode", "order")) if raw.get("mode")
                  in ("order", "idea", "question") else "order",
                  mentions=ids, text=str(raw.get("text") or text)[:500])
    if raw.get("minutes"):
        cmd.minutes = max(1, min(MAX_BREAK_MINUTES, int(raw["minutes"])))
    if raw.get("amount_usd") is not None:
        cmd.amount_usd = float(raw["amount_usd"])
    if raw.get("percent") is not None:
        cmd.percent = float(raw["percent"])
    cmd.everyone = any(k in _norm(text) for k in ("herkes", "herkese", "all "))
    cmd.clear_break = False
    cmd.confidence = float(raw.get("confidence", 0.7))
    return cmd


def _emit_id(res: dict | None) -> str | None:
    if not isinstance(res, dict):
        return None
    return (res.get("event") or {}).get("id") or res.get("id")


async def handle_command(*, project_id: str, text: str, actor: str = "user") -> dict:
    """The orchestrator's desk: parse → (model fallback) → execute → reply. The message
    and the reply are both events; the actions are real service calls with their own
    events; the reply cites them."""
    text = text.strip()
    async with session_scope() as s:
        project = await s.get(Project, project_id)
        if project is None:
            raise KeyError(project_id)
        agents = (await s.scalars(select(Agent).where(Agent.project_id == project_id,
                                                      Agent.state != "archived"))).all()
        roster = [{"id": a.id, "name": a.name, "role": a.role, "state": a.state,
                   "break_until": a.break_until.isoformat() if a.break_until else None}
                  for a in agents]

    parsed = parse_command(text, roster)
    if parsed.confidence < 0.6:
        better = await _interpret_with_model(text, roster)
        if better is not None:
            parsed = better

    msg = await ev.emit("command.message", project_id=project_id, severity="notice",
                        title=f"the Captain: {text[:60]}", summary=text[:200],
                        payload={"text": text, "mode": parsed.mode,
                                 "mentions": parsed.mentions, "intent": parsed.intent},
                        actor=actor)

    ok = True
    actions: list[dict] = []
    try:
        reply, actions = await _execute(project_id=project_id, parsed=parsed,
                                        roster=roster, raw=text, actor=actor)
    except Exception as e:  # never a silent failure: the desk says what went wrong
        log.exception("command desk failed: %s", e)
        ok, reply = False, f"I couldn't carry that out: {e}"

    reply_ev = await ev.emit("command.reply", project_id=project_id, severity="notice",
                             title=f"the desk: {reply[:60]}", summary=reply[:200],
                             payload={"text": reply, "ok": ok, "mode": parsed.mode,
                                      "actions": actions},
                             actor="system:orchestrator")
    return {"message_id": _emit_id(msg), "reply_event_id": _emit_id(reply_ev),
            "reply": {"text": reply, "ok": ok, "mode": parsed.mode, "actions": actions}}


async def _execute(*, project_id: str, parsed: Command, roster: list[dict], raw: str,
                   actor: str) -> tuple[str, list[dict]]:
    intent = parsed.intent
    if intent == "help" or intent == "unparsed":
        return (_HELP, [])
    if intent == "status":
        return await _status(project_id, parsed, roster)
    if intent == "assign":
        return await _assign(project_id, parsed, roster, raw, actor)
    if intent == "reassign":
        return await _reassign(project_id, parsed, roster, actor)
    if intent == "fire":
        return await _fire(project_id, parsed, roster, actor)
    if intent == "break":
        return await _break(project_id, parsed, roster, actor)
    if intent == "goal":
        return await _goal(project_id, parsed, raw, actor)
    if intent == "budget":
        return await _budget(project_id, parsed, actor)
    if intent == "hire":
        return await _hire(project_id, parsed, raw, actor)
    return (_HELP, [])


def _name_of(roster: list[dict], agent_id: str) -> str:
    for a in roster:
        if a["id"] == agent_id:
            return a["name"]
    return agent_id


async def _status(project_id: str, parsed: Command, roster: list[dict]) -> tuple[str, list[dict]]:
    now = datetime.now(UTC)
    async with session_scope() as s:
        states = (await s.execute(select(Agent.state, Agent.break_until)
                                  .where(Agent.project_id == project_id))).all()
        tasks = (await s.scalars(select(Task).where(Task.project_id == project_id))).all()
        recent = (await s.scalars(select(Event).where(Event.project_id == project_id)
                                  .order_by(desc(Event.seq)).limit(5))).all()
    busy = sum(1 for st, _ in states if st == "busy")
    on_break = sum(1 for _, bu in states
                   if bu is not None and (bu.replace(tzinfo=UTC) if bu.tzinfo is None else bu) > now)
    open_tasks = [t for t in tasks if t.state not in ("completed", "failed", "aborted")]
    done = sum(1 for t in tasks if t.state == "completed")
    failed = sum(1 for t in tasks if t.state == "failed")
    if parsed.mentions:
        lines = []
        for aid in parsed.mentions:
            mine = [t for t in tasks if t.assignee_agent_id == aid]
            active = [t for t in mine if t.state not in ("completed", "failed", "aborted")]
            if active:
                t = active[0]
                lines.append(f"@{_name_of(roster, aid)}: {t.state} — “{t.title[:60]}”"
                             f" (attempt {t.attempts})")
            else:
                lines.append(f"@{_name_of(roster, aid)}: no open work right now "
                             f"({sum(1 for t in mine if t.state == 'completed')} done so far)")
        return (" | ".join(lines), [])
    latest = "; ".join(f"{e.type}" for e in recent)
    return (f"Company status: {len(states)} agents — {busy} busy, {on_break} on a break · "
            f"tasks: {len(open_tasks)} open, {done} done, {failed} failed · "
            f"latest on the record: {latest}", [])


async def _assign(project_id: str, parsed: Command, roster: list[dict], raw: str,
                  actor: str) -> tuple[str, list[dict]]:
    target = parsed.mentions[0] if parsed.mentions else None
    title = parsed.text[:200] or "Assignment from the command desk"
    async with session_scope() as s:
        agent = await s.get(Agent, target) if target else None
        task = Task(project_id=project_id, run_id=None,
                    department_id=agent.department_id if agent else None,
                    squad_id=agent.squad_id if agent else None,
                    title=title, description=raw,
                    deliverable="As the Captain described; verified the usual way.",
                    acceptance_criteria=["The assignment's outcome is delivered and verified"],
                    effort="M", priority=2,
                    state=TaskState.ASSIGNED.value if agent else TaskState.PENDING.value,
                    assignee_agent_id=agent.id if agent else None)
        s.add(task)
        await s.flush()
        tid = task.id
    actions: list[dict] = []
    created = await ev.emit("task.created", project_id=project_id, task_id=tid,
                            title=title[:80], payload={"task_id": tid, "title": title},
                            actor=actor)
    actions.append({"kind": "task.created", "event_id": _emit_id(created), "ref": tid})
    if agent:
        assigned = await ev.emit("task.assigned", project_id=project_id, task_id=tid,
                                 agent_id=agent.id, department_id=agent.department_id,
                                 squad_id=agent.squad_id,
                                 title=f"{agent.name} ← {title[:50]}",
                                 payload={"task_id": tid, "agent_id": agent.id,
                                          "via": "command desk"},
                                 actor=actor)
        actions.append({"kind": "task.assigned", "event_id": _emit_id(assigned),
                        "ref": agent.id})
        extra = ""
        if agent.break_until is not None:
            bu = agent.break_until.replace(tzinfo=UTC) if agent.break_until.tzinfo is None \
                else agent.break_until
            if bu > datetime.now(UTC):
                extra = f" (heads-up: {agent.name} is on a break until {bu:%H:%M} UTC)"
        return (f"On it: “{title[:80]}” is assigned to @{agent.name}. "
                f"It runs with the next wave.{extra}", actions)
    return (f"Noted: “{title[:80]}” is on the board. The engine will match the best "
            f"owner when a run is active — tag an agent to name one directly.", actions)


async def _active_task_of(s, agent_id: str) -> Task | None:
    return (await s.scalars(select(Task).where(
        Task.assignee_agent_id == agent_id,
        Task.state.notin_(("completed", "failed", "aborted")))
        .order_by(desc(Task.created_at)).limit(1))).first()


async def _reassign(project_id: str, parsed: Command, roster: list[dict],
                    actor: str) -> tuple[str, list[dict]]:
    if len(parsed.mentions) < 2:
        if len(parsed.mentions) == 1:
            return (f"Whose work should move to @{_name_of(roster, parsed.mentions[0])}? "
                    f"Name both: “@Ada's task goes to @{_name_of(roster, parsed.mentions[0])}”.", [])
        return ("I need two names: whose work, and the new owner — "
                "“@Ada's task goes to @Bo”.", [])
    from_agent, to_agent = parsed.mentions[0], parsed.mentions[1]
    async with session_scope() as s:
        task = await _active_task_of(s, from_agent)
        if task is None:
            return (f"@{_name_of(roster, from_agent)} has no open work to move.", [])
        mover = await s.get(Agent, to_agent)
        old = await s.get(Agent, from_agent)
        tid, title = task.id, task.title
        task.assignee_agent_id = to_agent
        task.assignee_squad_id = mover.squad_id if mover else None
        task.state = TaskState.ASSIGNED.value
        s.add(task)
        if old is not None and old.state == "busy":
            old.state = "idle"  # the old owner is freed; the new one claims at the wave
            s.add(old)
    event = await ev.emit("task.reassigned", project_id=project_id, task_id=tid,
                          agent_id=to_agent, severity="notice",
                          title=f"{_name_of(roster, from_agent)} → "
                                f"{_name_of(roster, to_agent)}: {title[:50]}",
                          payload={"task_id": tid, "to_agent_id": to_agent,
                                   "from_agent_id": from_agent},
                          actor=actor)
    return (f"Moved: “{title[:70]}” now belongs to @{_name_of(roster, to_agent)} "
            f"(was @{_name_of(roster, from_agent)}).", 
            [{"kind": "task.reassigned", "event_id": _emit_id(event), "ref": tid}])


async def _fire(project_id: str, parsed: Command, roster: list[dict],
                actor: str) -> tuple[str, list[dict]]:
    if not parsed.mentions:
        return ("Who should be let go? Tag them: “@Marcus'u görevden al”.", [])
    to_fire = parsed.mentions[0]
    entry = next((a for a in roster if a["id"] == to_fire), None)
    if entry is None:
        return ("I couldn't find that agent on the roster.", [])
    if entry["role"] in UNFIREABLE:
        return (f"@{entry['name']} holds an office the desk doesn't dismiss "
                f"({entry['role']}) — that decision belongs to the board.", [])
    reason = parsed.text or "the Captain's call"
    await org.layoff_agent(project_id=project_id, agent_id=to_fire, reason=reason[:300],
                           actor=actor)
    return (f"Done: @{entry['name']} is archived (reason: “{reason[:80]}”).", [])


async def _break(project_id: str, parsed: Command, roster: list[dict],
                 actor: str) -> tuple[str, list[dict]]:
    minutes = parsed.minutes or DEFAULT_BREAK_MINUTES
    if parsed.everyone:
        targets = [a for a in roster if a["role"] != Role.ORCHESTRATOR.value]
    elif parsed.mentions:
        targets = [a for a in roster if a["id"] in parsed.mentions]
    elif parsed.clear_break:
        # "end the breaks" with no names: whoever is actually on one
        targets = [a for a in roster if a.get("break_until")]
    else:
        return ("A break for whom? Tag someone (“@Zoe 10 dk mola”) or say "
                "“herkese 15 dakika mola”.", [])
    if not targets:
        if parsed.clear_break:
            return ("Nobody is on a break.", [])
        return ("That name isn't on the roster — no break was set.", [])
    until = datetime.now(UTC) + timedelta(minutes=minutes)
    async with session_scope() as s:
        for a in targets:
            row = await s.get(Agent, a["id"])
            if row is None:
                continue
            row.break_until = None if parsed.clear_break else until
            s.add(row)
    actions: list[dict] = []
    if not parsed.clear_break:
        for a in targets:
            event = await ev.emit("agent.break.started", project_id=project_id,
                                  agent_id=a["id"], severity="notice",
                                  title=f"{a['name']} is on a break until {until:%H:%M} UTC",
                                  payload={"agent_id": a["id"], "until": until.isoformat(),
                                           "minutes": minutes},
                                  actor=actor)
            actions.append({"kind": "agent.break.started", "event_id": _emit_id(event),
                            "ref": a["id"]})
    names = ", ".join(f"@{a['name']}" for a in targets)
    if parsed.clear_break:
        return (f"Breaks cleared for {names}.", actions)
    return (f"{names} on a break for {minutes} minutes (no new assignments until then; "
            f"work already in their hands finishes first).", actions)


async def _goal(project_id: str, parsed: Command, raw: str, actor: str) -> tuple[str, list[dict]]:
    from crew.control.orchestrator import orchestrator

    goal = parsed.text[:300] or raw[:300]
    run = await orchestrator.start_run(project_id=project_id, goal=goal, actor=actor)
    rid = (run or {}).get("id") or (run or {}).get("run_id")
    return (f"Run started: “{goal[:90]}”. Planning begins on the next tick.",
            [{"kind": "run.started", "event_id": None, "ref": rid}] if rid else [])


async def _budget(project_id: str, parsed: Command, actor: str) -> tuple[str, list[dict]]:
    from crew.core.security import audit

    async with session_scope() as s:
        project = await s.get(Project, project_id)
        old_cap = project.budget_cap_micros
    if parsed.amount_usd is not None:
        new_cap = int(parsed.amount_usd * 1_000_000)
    elif parsed.percent is not None:
        new_cap = int(old_cap * (1 + parsed.percent / 100.0))
    else:
        return ("Give me a number: “bütçeyi 25$” or “bütçeyi %20 artır”.", [])
    new_cap = max(new_cap, 0)
    async with session_scope() as s:
        project = await s.get(Project, project_id)
        project.budget_cap_micros = new_cap
        s.add(project)
    await audit(actor_kind="user", actor_id=actor, action="budget.updated",
                resource_kind="project", resource_id=project_id,
                reason=f"cap ${old_cap / 1_000_000:.2f} → ${new_cap / 1_000_000:.2f}")
    return (f"Budget set: ${old_cap / 1_000_000:.2f} → ${new_cap / 1_000_000:.2f} "
            f"(what's already spent stays spent).", [])


async def _hire(project_id: str, parsed: Command, raw: str, actor: str) -> tuple[str, list[dict]]:
    norm = _norm(raw)
    role = None
    for keys, r in _HIRE_MAP:
        if any(k in norm for k in keys):
            role = r
            break
    if role is None:
        return ("I can hire an analyst, an engineer, a researcher, a designer or a "
                "writer — say which (“bir veri analisti işe al”).", [])
    spec = RoleSpec.from_template(role, mission=f"hired by the Captain: {raw[:100]}")
    agent = await org.hire_agent(project_id=project_id, spec=spec,
                                 rationale=f"the Captain's hire: {raw[:100]}", actor=actor)
    return (f"Hired: {agent['name']} ({role.value}). They'll be matched work on the "
            f"next run.", [{"kind": "agent.hired", "event_id": None, "ref": agent["id"]}])


async def transcript(*, project_id: str, limit: int = 60) -> dict:
    """The desk's history, straight from the record — user and orchestrator turns."""
    async with session_scope() as s:
        rows = (await s.scalars(select(Event).where(
            Event.project_id == project_id,
            Event.type.in_(("command.message", "command.reply")))
            .order_by(Event.seq.desc()).limit(max(2, min(200, limit))))).all()
    out = []
    for e in reversed(rows):
        p = e.payload or {}
        ts = e.ts.replace(tzinfo=UTC) if e.ts is not None and e.ts.tzinfo is None else e.ts
        out.append({"id": e.id, "role": "captain" if e.type == "command.message"
                    else "orchestrator", "text": str(p.get("text", "")),
                    "mode": p.get("mode"), "ok": p.get("ok"),
                    "actions": p.get("actions") or [], "mentions": p.get("mentions") or [],
                    "at": ts.isoformat() if ts else None})
    return {"messages": out}
