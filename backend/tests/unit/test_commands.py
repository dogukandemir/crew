"""ADR 0012: the command desk — the Captain writes, the orchestrator answers, the
company moves. Lexicon parse, execution against real services, and the transcript."""

from __future__ import annotations

import pytest
from sqlalchemy import select

from crew.control import commands, org
from crew.core.db import session_scope
from crew.core.models import Agent, Event, Project, Run, Task
from crew.domain.enums import TaskState

ROSTER = [
    {"id": "a1", "name": "Ada Lovelace", "role": "worker", "state": "idle"},
    {"id": "a2", "name": "Nils", "role": "worker", "state": "idle"},
    {"id": "a3", "name": "Marcus", "role": "coo", "state": "idle"},
]


async def _agent(s, project_id: str, name: str, *, role: str = "worker", **kw) -> Agent:
    a = Agent(project_id=project_id, name=name, role=role, grade=1,
              state=kw.pop("state", "idle"), autonomy="autonomous", mission="x", **kw)
    s.add(a)
    await s.flush()
    return a


# ── the lexicon (pure) ──────────────────────────────────────────────────────────────

def test_parse_turkish_assignment_routes_to_the_named_agent():
    c = commands.parse_command("@Ada, pazarlama raporunu hazırla", ROSTER)
    assert c.intent == "assign" and c.mentions == ["a1"]


def test_parse_break_for_everyone_with_minutes():
    c = commands.parse_command("herkese 15 dakika mola ver", ROSTER)
    assert c.intent == "break" and c.everyone and c.minutes == 15
    clear = commands.parse_command("molayı kaldır", ROSTER)
    assert clear.intent == "break" and clear.clear_break


def test_parse_fire_carries_the_reason_text():
    c = commands.parse_command("@Marcus'u görevden al, sebep: sürekli hata", ROSTER)
    assert c.intent == "fire" and c.mentions == ["a3"] and "sebep" in c.text


def test_parse_reassign_needs_both_names():
    c = commands.parse_command("@Ada'nın işini @Nils'e devret", ROSTER)
    assert c.intent == "reassign" and c.mentions == ["a1", "a2"]


def test_parse_question_mode_for_status():
    c = commands.parse_command("@Ada ne yapıyor?", ROSTER)
    assert c.intent == "status" and c.mode == "question" and c.mentions == ["a1"]


def test_parse_idea_mode_is_weighed_not_ordered():
    c = commands.parse_command("bir fikrim var: belki raporu haftaya alırız", ROSTER)
    assert c.mode == "idea"


def test_parse_unknown_stays_unparsed_with_low_confidence():
    c = commands.parse_command("bugün hava çok güzel", ROSTER)
    assert c.intent == "unparsed" and c.confidence < 0.6


# ── execution against the real services ─────────────────────────────────────────────

@pytest.mark.asyncio
async def test_assign_creates_a_task_and_ties_it_to_the_named_agent(bound_loop, project):
    async with session_scope() as s:
        ada = await _agent(s, project["id"], "Ada", department_id=None)
        ada_id = ada.id
    out = await commands.handle_command(project_id=project["id"],
                                        text="@Ada, aylık özeti hazırla",
                                        actor="user:tester")
    assert out["reply"]["ok"] is True and "Ada" in out["reply"]["text"]
    async with session_scope() as s:
        t = (await s.scalars(select(Task).where(Task.project_id == project["id"]))).all()
        evs = (await s.scalars(select(Event).where(
            Event.project_id == project["id"],
            Event.type.in_(("command.message", "command.reply", "task.created",
                            "task.assigned"))))).all()
    task = next(x for x in t if x.assignee_agent_id == ada_id)
    assert task.state == TaskState.ASSIGNED.value and task.run_id is None
    assert {e.type for e in evs} >= {"command.message", "command.reply", "task.created",
                                     "task.assigned"}


@pytest.mark.asyncio
async def test_break_parks_matching_and_clears(bound_loop, project):
    async with session_scope() as s:
        ida = await _agent(s, project["id"], "Ida")
        ida_id = ida.id
    out = await commands.handle_command(project_id=project["id"],
                                        text="herkese 20 dakika mola", actor="user:t")
    assert out["reply"]["ok"] is True
    async with session_scope() as s:
        row = await s.get(Agent, ida_id)
        broke = (await s.scalars(select(Event).where(Event.project_id == project["id"],
                                                     Event.type == "agent.break.started"))).all()
    assert row.break_until is not None and broke

    # a fresh pending task cannot find this agent — it parks instead of running badly
    async with session_scope() as s:
        s.add(Task(project_id=project["id"], run_id="r-break", title="t2", state="pending"))
    n = await org.assign_tasks(project_id=project["id"], run_id="r-break")
    async with session_scope() as s:
        t2 = (await s.scalars(select(Task).where(Task.run_id == "r-break"))).all()
    assert n == 0 and t2[0].state == TaskState.BLOCKED.value

    out2 = await commands.handle_command(project_id=project["id"], text="molayı kaldır",
                                         actor="user:t")
    assert out2["reply"]["ok"] is True
    async with session_scope() as s:
        row = await s.get(Agent, ida_id)
    assert row.break_until is None


@pytest.mark.asyncio
async def test_fire_archives_and_cannot_touch_the_engine(bound_loop, project):
    async with session_scope() as s:
        marcus = await _agent(s, project["id"], "Marcus")
        eng = await _agent(s, project["id"], "Onyx", role="orchestrator")
        marcus_id, eng_id = marcus.id, eng.id
    out = await commands.handle_command(project_id=project["id"],
                                        text="@Marcus'u görevden al, sebep: tekrarlayan hata",
                                        actor="user:t")
    assert out["reply"]["ok"] is True and "archived" in out["reply"]["text"]
    refuse = await commands.handle_command(project_id=project["id"],
                                           text="@Onyx'i görevden al", actor="user:t")
    assert refuse["reply"]["ok"] is True and "board" in refuse["reply"]["text"]
    async with session_scope() as s:
        assert (await s.get(Agent, marcus_id)).state == "archived"
        assert (await s.get(Agent, eng_id)).state != "archived"


@pytest.mark.asyncio
async def test_reassign_moves_the_task_and_frees_the_old_owner(bound_loop, project):
    async with session_scope() as s:
        ada = await _agent(s, project["id"], "Ada", state="busy")
        bo = await _agent(s, project["id"], "Bo")
        t = Task(project_id=project["id"], run_id="r-re", title="the report",
                 state=TaskState.RUNNING.value, assignee_agent_id=ada.id)
        s.add(t)
        await s.flush()
        ada_id, bo_id, tid = ada.id, bo.id, t.id
    out = await commands.handle_command(project_id=project["id"],
                                        text="@Ada'nın işini @Bo'ya devret", actor="user:t")
    assert out["reply"]["ok"] is True and "Bo" in out["reply"]["text"]
    async with session_scope() as s:
        t2 = await s.get(Task, tid)
        ada2 = await s.get(Agent, ada_id)
        moved = (await s.scalars(select(Event).where(Event.type == "task.reassigned",
                                                     Event.project_id == project["id"]))).all()
    assert t2.assignee_agent_id == bo_id and ada2.state == "idle"
    assert moved and moved[0].payload["to_agent_id"] == bo_id


@pytest.mark.asyncio
async def test_budget_command_writes_the_cap(bound_loop, project):
    out = await commands.handle_command(project_id=project["id"],
                                        text="bütçeyi 25$ yap", actor="user:t")
    assert out["reply"]["ok"] is True
    async with session_scope() as s:
        p = await s.get(Project, project["id"])
    assert p.budget_cap_micros == 25_000_000


@pytest.mark.asyncio
async def test_goal_command_starts_a_run(bound_loop, project):
    out = await commands.handle_command(project_id=project["id"],
                                        text="hedef: Q4 kampanyasını planla", actor="user:t")
    assert out["reply"]["ok"] is True and "Run started" in out["reply"]["text"]
    async with session_scope() as s:
        runs = (await s.scalars(select(Run).where(Run.project_id == project["id"]))).all()
    assert runs and "Q4" in runs[-1].goal


@pytest.mark.asyncio
async def test_transcript_reads_back_the_exchange(bound_loop, project):
    await commands.handle_command(project_id=project["id"], text="durum ne?",
                                  actor="user:t")
    t = await commands.transcript(project_id=project["id"])
    roles = [m["role"] for m in t["messages"]]
    assert "captain" in roles and "orchestrator" in roles
    reply = [m for m in t["messages"] if m["role"] == "orchestrator"][-1]
    assert reply["ok"] is True and reply["text"]


@pytest.mark.asyncio
async def test_an_order_reaches_the_prompt_of_the_tagged_agent(bound_loop, project):
    from crew.control.orchestrator import orchestrator

    async with session_scope() as s:
        ada = await _agent(s, project["id"], "Ada")
        other = await _agent(s, project["id"], "Silas")
        ada_id, other_id = ada.id, other.id
    await commands.handle_command(project_id=project["id"],
                                  text="@Ada, özet tablosunu hazırla", actor="user:t")
    mine = await orchestrator._captain_notes(project["id"], ada_id)
    theirs = await orchestrator._captain_notes(project["id"], other_id)
    assert any("binding" in m and "özet tablosunu" in m for m in mine)
    assert theirs == [], "an addressed order does not leak to the whole floor"


@pytest.mark.asyncio
async def test_only_landed_words_bind_the_floor(bound_loop, project):
    """ADR 0012 honesty at the prompt boundary: the record keeps every turn, but only
    the Captain's words whose desk answer says they landed become directives."""
    from crew.control.orchestrator import orchestrator

    async with session_scope() as s:
        ada = await _agent(s, project["id"], "Ada")
        eng = await _agent(s, project["id"], "Onyx", role="orchestrator")
        ada_id, eng_id = ada.id, eng.id
    # an unparsed sentence, a refused dismissal, an answered question — all recorded:
    await commands.handle_command(project_id=project["id"], text="bugün hava çok güzel",
                                  actor="user:t")
    await commands.handle_command(project_id=project["id"], text="@Onyx'i görevden al",
                                  actor="user:t")
    await commands.handle_command(project_id=project["id"], text="durum ne?", actor="user:t")
    assert await orchestrator._captain_notes(project["id"], ada_id) == []
    assert await orchestrator._captain_notes(project["id"], eng_id) == []
    # a landed order binds its addressee
    await commands.handle_command(project_id=project["id"],
                                  text="@Ada, satış özetini hazırla", actor="user:t")
    mine = await orchestrator._captain_notes(project["id"], ada_id)
    assert any("binding" in m and "satış özetini" in m for m in mine)
