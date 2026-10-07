"""The run pipeline: intake → planning → staffing → dispatch → executing → verifying →
rewarding → learning → done (docs/03). Resumable, cancelable, event-emitting."""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime

from sqlalchemy import desc, select, update

from crew.control import gossip, inbox, org
from crew.control.council import council
from crew.control.verify import verifier
from crew.core import events as ev
from crew.core.brains import brain_service, render_context_pack, summarize_working_set
from crew.core.db import session_scope
from crew.core.models import Agent, AgentSkill, Event, Project, Run, Task
from crew.core.reward import reward_engine
from crew.core.security import BudgetExceeded, audit, budget
from crew.core.settings import settings
from crew.domain.enums import Role, RunStage, RunStatus, TaskState
from crew.execution.models import router
from crew.execution.prompt import build_system_prompt, build_task_prompt
from crew.execution.runner import (
    AgentSnapshot,
    ExecutionRequest,
    TaskSpec,
    estimated_cost_micros,
    select_runner,
)
from crew.execution.tools import tools_for_agent

log = logging.getLogger("crew.orchestrator")

MAX_WAVES = 60
MAX_TASK_ATTEMPTS = 3


class RunAborted(RuntimeError):
    pass


async def _emit_stage(run: Run, stage: RunStage, project_id: str, extra: dict | None = None) -> None:
    await ev.emit("run.stage.changed", project_id=project_id, run_id=run.id, severity="notice",
                  title=f"stage: {stage.value}", payload={"run_id": run.id, "stage": stage.value,
                                                          **(extra or {})},
                  actor="system:orchestrator")


class Orchestrator:
    def __init__(self) -> None:
        self.runner = select_runner()
        self._running: set[str] = set()

    # ── public API ─────────────────────────────────────────────────────────────
    async def start_run(self, *, project_id: str, goal: str, mode: str = "autonomous",
                        actor: str = "user") -> dict:
        async with session_scope() as s:
            project = await s.get(Project, project_id)
            if project is None:
                raise KeyError(project_id)
            if project.status == "paused":
                raise ValueError("project is paused")
        run = Run(project_id=project_id, goal=goal, mode=mode, stage=RunStage.INTAKE.value,
                  status=RunStatus.RUNNING.value)
        async with session_scope() as s:
            s.add(run)
        await ev.emit("run.started", project_id=project_id, run_id=run.id, severity="notice",
                      title=f"run started: {goal[:70]}", summary=goal,
                      payload={"run_id": run.id, "goal": goal, "mode": mode}, actor=actor)
        await audit(actor_kind="user", actor_id=actor, action="run.started", resource_kind="run",
                    resource_id=run.id, reason=goal[:200])
        return {"id": run.id, "goal": goal, "stage": run.stage, "status": run.status}

    async def advance(self, run_id: str) -> dict:
        """Run the pipeline to a terminal or paused state. Safe to call on an existing run."""
        if run_id in self._running:
            return {"run_id": run_id, "status": "already_running"}
        self._running.add(run_id)
        try:
            return await self._advance(run_id)
        finally:
            self._running.discard(run_id)

    async def _advance(self, run_id: str) -> dict:
        while True:
            async with session_scope() as s:
                run = await s.get(Run, run_id)
                if run is None:
                    raise KeyError(run_id)
                project = await s.get(Project, run.project_id)
                stage, status = RunStage(run.stage), run.status
            if status in (RunStatus.COMPLETED.value, RunStatus.FAILED.value, RunStatus.ABORTED.value):
                return {"run_id": run_id, "status": status, "stage": stage.value}
            if status in (RunStatus.PAUSED.value, RunStatus.PENDING_CONFIRMATION.value,
                          RunStatus.PENDING_CLARIFICATION.value, RunStatus.PAUSED_BUDGET.value):
                return {"run_id": run_id, "status": status, "stage": stage.value}
            if budget.breaker_open(run.project_id):
                await self._set_run(run_id, stage=stage.value, status=RunStatus.PAUSED_BUDGET.value)
                return {"run_id": run_id, "status": RunStatus.PAUSED_BUDGET.value, "stage": stage.value}

            if stage is RunStage.INTAKE:
                nxt = await self._intake(run, project)
            elif stage is RunStage.PLANNING:
                nxt = await self._plan(run, project)
            elif stage is RunStage.STAFFING:
                nxt = await self._staff(run, project)
            elif stage in (RunStage.DISPATCH, RunStage.EXECUTING, RunStage.VERIFYING, RunStage.REWARDING):
                nxt = await self._execute(run, project)
            elif stage is RunStage.LEARNING:
                nxt = await self._learn(run, project)
            else:
                nxt = RunStage.DONE
            await self._set_run(run_id, stage=(nxt or RunStage.DONE).value)

    async def _set_run(self, run_id: str, *, stage: str | None = None, status: str | None = None,
                       report: dict | None = None, error: str | None = None) -> None:
        async with session_scope() as s:
            run = await s.get(Run, run_id)
            if run is None:
                return
            if stage is not None:
                run.stage = stage
            if status is not None:
                run.status = status
                if status in (RunStatus.COMPLETED.value, RunStatus.FAILED.value, RunStatus.ABORTED.value):
                    run.ended_at = datetime.now(UTC)
            if report is not None:
                run.report = report
            if error is not None:
                run.error = error
            s.add(run)

    # ── stages ─────────────────────────────────────────────────────────────────
    async def _intake(self, run: Run, project: Project) -> RunStage:
        brief = {
            "goal": run.goal,
            "interpretation": run.goal.strip(),
            "assumptions": ["No hidden stakeholder: the goal text is the requirement",
                            "Outbound publication is not part of this run"],
            "success_criteria": ["The goal is satisfied by a verifiable artifact",
                                 "Evidence is cited for factual claims"],
            "questions": [],
        }
        if not project.setting("autonomous_intake", True):
            brief["questions"] = [
                "What does 'done' look like for this goal?",
                "Any hard constraints (budget, deadline, tools to avoid)?",
            ]
            async with session_scope() as s:
                r = await s.get(Run, run.id)
                r.goal_brief, r.pending_questions = brief, brief["questions"]
                s.add(r)
            await ev.emit("run.clarification.requested", project_id=project.id, run_id=run.id,
                          severity="notice", title="clarification needed",
                          payload={"run_id": run.id, "questions": brief["questions"]},
                          actor="system:orchestrator")
            await self._set_run(run.id, status=RunStatus.PENDING_CLARIFICATION.value)
            return RunStage.INTAKE
        async with session_scope() as s:
            r = await s.get(Run, run.id)
            r.goal_brief = brief
            s.add(r)
        if project.setting("require_goal_confirmation", False):
            await self._set_run(run.id, status=RunStatus.PENDING_CONFIRMATION.value)
            await ev.emit("run.confirmation.requested", project_id=project.id, run_id=run.id,
                          severity="notice", title="goal confirmation required",
                          payload={"run_id": run.id, "brief": brief}, actor="system:orchestrator")
            return RunStage.INTAKE
        await _emit_stage(run, RunStage.PLANNING, project.id)
        return RunStage.PLANNING

    async def _plan(self, run: Run, project: Project) -> RunStage:
        goal = run.goal
        plan = await org.plan_run(project=project, goal=goal)
        await org.persist_plan(project_id=project.id, run_id=run.id, plan=plan)
        async with session_scope() as s:
            r = await s.get(Run, run.id)
            r.plan = plan.to_dict()
            s.add(r)
        total_est = 0
        async with session_scope() as s:
            tasks = (await s.scalars(select(Task).where(Task.run_id == run.id))).all()
        for t in tasks:
            total_est += estimated_cost_micros(t.effort, "fast")
        await ev.emit("run.planned", project_id=project.id, run_id=run.id, severity="notice",
                      title=f"plan: {len(plan.tasks)} tasks ({plan.source})",
                      payload={"run_id": run.id, "tasks": len(plan.tasks), "source": plan.source,
                               "estimated_cost_usd": round(total_est / 1e6, 4),
                               "success_criteria": plan.success_criteria,
                               "assumptions": plan.assumptions},
                      actor="system:orchestrator")
        available = await budget.available_micros(project.id)
        if total_est > available:
            await ev.emit("budget.warning", project_id=project.id, run_id=run.id, severity="warning",
                          title="plan exceeds remaining budget",
                          payload={"estimated_micros": total_est, "available_micros": available},
                          actor="system:orchestrator")
        await _emit_stage(run, RunStage.STAFFING, project.id)
        return RunStage.STAFFING

    async def _staff(self, run: Run, project: Project) -> RunStage:
        async with session_scope() as s:
            tasks = (await s.scalars(select(Task).where(Task.run_id == run.id))).all()
            orchestrator_id = (project.settings or {}).get("orchestrator_id")
        needed = org.required_skill_weights(list(tasks))
        gaps = await org.capability_gaps(project.id, needed)
        if gaps and project.setting("auto_hire", True):
            created = await org.staff_gaps(project=project, gaps=gaps, run_id=run.id,
                                           trace_id=run.trace_id, orchestrator_id=orchestrator_id)
            await ev.emit("org.staffed", project_id=project.id, run_id=run.id, severity="notice",
                          title=f"org grew: +{len(created)} unit(s) for {len(gaps)} skill gap(s)",
                          payload={"run_id": run.id, "gaps": gaps,
                                   "created": [{"kind": c.get("kind"), "name": c.get("name")} for c in created]},
                          actor="system:orchestrator")
        elif gaps:
            await ev.emit("org.staffing.skipped", project_id=project.id, run_id=run.id, severity="warning",
                          title="auto-hire disabled; gaps remain", payload={"run_id": run.id, "gaps": gaps},
                          actor="system:orchestrator")
        assigned = await org.assign_tasks(project_id=project.id, run_id=run.id)
        await _emit_stage(run, RunStage.EXECUTING, project.id, {"assigned": assigned})
        return RunStage.EXECUTING

    async def _execute(self, run: Run, project: Project) -> RunStage:
        sem = asyncio.Semaphore(max(1, settings.max_concurrent_crews))
        for _wave in range(MAX_WAVES):
            if budget.breaker_open(project.id):
                await self._set_run(run.id, status=RunStatus.PAUSED_BUDGET.value)
                return RunStage.EXECUTING
            async with session_scope() as s:
                r = await s.get(Run, run.id)
                if r.status == RunStatus.PAUSED.value or r.stage == RunStage.DONE.value:
                    return RunStage(r.stage)
            # heal any stale `busy` from a crashed task before scheduling this wave
            await self._reap_occupancy(project.id)
            # and serve any decision requests agents filed mid-task (docs/17 batch 2)
            await self._service_decisions(project)
            tasks = await org.ready_tasks(project.id, run.id)
            runnable = [t for t in tasks if t.state == TaskState.ASSIGNED.value and t.assignee_agent_id]
            if not runnable:
                # dependents whose dependencies just finished, or tasks that were parked for
                # lack of an assignee before hiring caught up
                revived = await org.revive_blocked(project.id, run.id)
                if not revived:
                    assigned_now = await org.assign_tasks(project_id=project.id, run_id=run.id)
                    if not assigned_now:
                        break
                continue
            await asyncio.gather(*[self._run_task(run, project, t.id, sem) for t in runnable])
            # tasks that failed and still have attempts left go back to the queue
            await self._requeue_retries(run)
            # and the office talks about what actually happened (docs/17 batch 2)
            await gossip.office_chatter(project.id)
        async with session_scope() as s:
            tasks = (await s.scalars(select(Task).where(Task.run_id == run.id))).all()
        pending = [t for t in tasks if t.state not in (TaskState.COMPLETED.value, TaskState.FAILED.value,
                                                      TaskState.ABORTED.value)]
        for t in pending:
            if t.state == TaskState.BLOCKED.value:
                continue
            async with session_scope() as s:
                row = await s.get(Task, t.id)
                row.state = TaskState.FAILED.value
                row.escalation_reason = row.escalation_reason or "not completed within the run"
                s.add(row)
        await gossip.office_chatter(project.id)
        await self._reap_occupancy(project.id)
        await _emit_stage(run, RunStage.LEARNING, project.id)
        return RunStage.LEARNING

    async def _requeue_retries(self, run: Run) -> None:
        async with session_scope() as s:
            failed = (await s.scalars(select(Task).where(Task.run_id == run.id,
                                                         Task.state == TaskState.FAILED.value))).all()
            for t in failed:
                if t.attempts < MAX_TASK_ATTEMPTS and t.state == TaskState.FAILED.value:
                    t.state = TaskState.ASSIGNED.value
                    t.escalation_reason = f"retry {t.attempts}"
                    # the ladder's first rung (docs/03 §5): the FIRST failure goes back to
                    # the producer's Lead, who re-plans it — rather than watching the same
                    # worker fail the same way again.
                    if t.attempts == 1 and t.assignee_agent_id:
                        worker = await s.get(Agent, t.assignee_agent_id)
                        lead = (await s.get(Agent, worker.manager_id)
                                if worker is not None and worker.manager_id else None)
                        if (lead is not None and lead.role == Role.LEAD.value
                                and lead.state not in ("archived", "suspended")):
                            t.assignee_agent_id = lead.id
                            t.assignee_squad_id = lead.squad_id
                            t.escalation_reason = f"retry {t.attempts} — lead re-plans"
                            await ev.emit("task.escalated", project_id=run.project_id, run_id=run.id,
                                          task_id=t.id, agent_id=lead.id, severity="warning",
                                          title=f"lead re-plans: {t.title[:50]}",
                                          payload={"task_id": t.id, "reason": "lead re-plans",
                                                   "rung": 1, "lead_id": lead.id},
                                          actor="system:orchestrator")
                    s.add(t)

    async def _run_task(self, run: Run, project: Project, task_id: str,
                        sem: asyncio.Semaphore) -> None:
        async with sem:
            async with session_scope() as s:
                task = await s.get(Task, task_id)
                if task is None or task.state != TaskState.ASSIGNED.value:
                    return
                agent = await s.get(Agent, task.assignee_agent_id) if task.assignee_agent_id else None
                if agent is None:
                    task.state = TaskState.BLOCKED.value
                    task.escalation_reason = "no assignee"
                    s.add(task)
                    return
                # One agent, one task at a time. The claim is an atomic conditional UPDATE
                # on purpose: a read-then-write would race its sibling coroutine in the
                # same wave. `busy` is what org.assign_tasks filters on — nothing used to
                # set it, so the filter never bit and one agent could be handed several
                # concurrent tasks (docs/17 batch 1).
                claimed = await s.execute(update(Agent)
                                          .where(Agent.id == agent.id,
                                                 Agent.state.in_(("idle", "probation")))
                                          .values(state="busy"))
                if claimed.rowcount == 0:
                    # somebody else holds them: leave the task assigned; the next wave
                    # picks it up once its holder is done.
                    return
                dept = None
                if agent.department_id:
                    from crew.core.models import Department

                    dept = await s.get(Department, agent.department_id)
                skills = (await s.execute(select(AgentSkill.skill_id).where(AgentSkill.agent_id == agent.id))).all()
                manager = await s.get(Agent, agent.manager_id) if agent.manager_id else None
                snapshot = AgentSnapshot.from_agent(agent, manager_name=manager.name if manager else None,
                                                    department_name=dept.name if dept else None,
                                                    skills=[r[0] for r in skills])
                task_spec = TaskSpec(
                    id=task.id, title=task.title, description=task.description, deliverable=task.deliverable,
                    acceptance_criteria=list(task.acceptance_criteria or []),
                    output_contract=task.output_contract or {}, effort=task.effort,
                    required_skills=[r.get("skill", "") for r in (task.required_skills or [])],
                )
                task.state = TaskState.RUNNING.value
                task.started_at = datetime.now(UTC)
                task.attempts += 1
                attempts = task.attempts
                s.add(task)

            trace_id = run.trace_id
            await ev.emit("task.started", project_id=project.id, run_id=run.id, task_id=task_id,
                          agent_id=snapshot.id, department_id=snapshot.department_id,
                          squad_id=snapshot.squad_id, trace_id=trace_id,
                          title=f"{snapshot.name} started: {task_spec.title[:50]}",
                          payload={"task_id": task_id, "agent_id": snapshot.id, "attempt": attempts,
                                   "model": router.choice_for_agent(snapshot).model},  # type: ignore[arg-type]
                          actor=f"agent:{snapshot.id}")

            # context pack from the three-level brain (docs/06)
            query = f"{task_spec.title} {task_spec.description[:400]}"
            try:
                hits = await brain_service.context_pack(project_id=project.id, agent=agent, query=query)
            except Exception:
                hits = []
            context_pack = render_context_pack(hits)
            steer = await self._steering(project.id, task_id, snapshot.id)
            colleague_messages = await self._inbox_notes(project.id, snapshot.id)
            decisions = await council.decision_constraints(project_id=project.id)

            bundle = build_system_prompt(
                name=snapshot.name, role=snapshot.role, grade=snapshot.grade, mission=snapshot.mission,
                autonomy=snapshot.autonomy, manager=snapshot.manager_name,
                capabilities=snapshot.tools, skills=snapshot.skills,
                tool_names=tools_for_agent(snapshot),  # type: ignore[arg-type]
                context_pack=context_pack, department=snapshot.department_name,
            )
            user_prompt = build_task_prompt(
                title=task_spec.title, description=task_spec.description, deliverable=task_spec.deliverable,
                acceptance_criteria=task_spec.acceptance_criteria, output_contract=task_spec.output_contract,
                effort=task_spec.effort, decision_constraints=decisions[:5], steer=steer,
                colleague_messages=colleague_messages,
            )
            bundle.user = user_prompt

            req = ExecutionRequest(
                project_id=project.id, run_id=run.id, trace_id=trace_id, agent=snapshot, task=task_spec,
                system_prompt=bundle.system, user_prompt=user_prompt,
                workspace=settings.workspace_dir(project.id),
                artifacts=settings.artifacts_dir(project.id),
                escalate=attempts - 1,
            )
            reservation = router.estimate_step_reservation(snapshot)  # type: ignore[arg-type]
            try:
                await budget.reserve(project.id, amount_micros=reservation, scope_kind="agent",
                                     scope_id=snapshot.id, ref=task_id,
                                     idempotency_key=f"reserve:{task_id}:{attempts}")
            except BudgetExceeded as e:
                async with session_scope() as s:
                    row = await s.get(Task, task_id)
                    row.state = TaskState.FAILED.value
                    row.escalation_reason = "budget_exceeded"
                    s.add(row)
                await ev.emit("budget.exceeded", project_id=project.id, run_id=run.id, task_id=task_id,
                              agent_id=snapshot.id, severity="error",
                              title="budget exceeded — task refused",
                              summary=str(e), payload={"scope_kind": "agent", "scope_id": snapshot.id,
                                                       "needed_micros": e.needed_micros,
                                                       "available_micros": e.available_micros},
                              actor="system:budget")
                await self._free_agent(snapshot.id)
                return

            started = asyncio.get_event_loop().time()
            result = await asyncio.to_thread(self.runner.run_task, req)
            elapsed_ms = int((asyncio.get_event_loop().time() - started) * 1000)
            await budget.settle(project.id, reserved_micros=reservation, actual_micros=result.cost_micros,
                                scope_kind="agent", scope_id=snapshot.id, ref=task_id,
                                idempotency_key=f"settle:{task_id}:{attempts}")
            await self._record_task_result(run, project, task_id, snapshot, result, elapsed_ms,
                                           route=router.choice_for_agent(snapshot).model, attempts=attempts)  # type: ignore[arg-type]
            await self._verify_and_reward(run, project, task_id, result, attempts)
            await self._free_agent(snapshot.id)

    async def _inbox_notes(self, project_id: str, agent_id: str) -> list[str]:
        """Colleague traffic for this agent's prompt: open questions to answer and answers
        that arrived for it (docs/17 batch 2 — without this the inbox exists but nobody
        ever reads it, which would be the same defect in a new suit)."""
        notes: list[str] = []
        try:
            open_qs = await inbox.open_questions(project_id, agent_id)
            answers = await inbox.replies_for(project_id, agent_id)
        except Exception:
            log.exception("inbox read failed")
            return notes
        for q in open_qs[:4]:
            notes.append(f"{q['from']} asks you (answer_to='{q['id']}'): {q['text'][:300]} — answer "
                         f"with reply_colleague(agent='{q['from']}', answer_to='{q['id']}', text=...)")
        for a in answers[:4]:
            notes.append(f"{a['from']} answered your question: {a['text'][:300]}")
        return notes

    async def _service_decisions(self, project: Project) -> int:
        """Serve collected questions AND surfaced concerns (docs/17 batches 2, 4).

        Agent requests: `request_decision` promised "the orchestrator will convene a
        council" with nothing behind it; a collected question becomes a real session here.
        Office concerns: a `gossip.surfaced` topic gets a question of its own with
        topic-shaped options — a rumour enough people repeat reaches the agenda, and
        either outcome binds following work through council.decision_constraints."""
        concern_options: dict[str, list[dict]] = {
            "budget": [
                {"id": "tighten", "label": "Tighten spend now: smaller reservations and cheap models until the run lands"},
                {"id": "continue", "label": "Continue as planned; the ledger and the breaker are already in force"},
            ],
            "failing_work": [
                {"id": "investigate", "label": "Put a senior pair on the failing work before its next attempt"},
                {"id": "ladder", "label": "Leave it to the failure ladder and the council it already calls"},
            ],
            "blocked_work": [
                {"id": "staff", "label": "Staff the missing skills the blocked tasks need"},
                {"id": "descope", "label": "Reduce scope so the blocked work can move with who is here"},
            ],
            "struggling_agent": [
                {"id": "support", "label": "Pair them with their lead and lighten the queue"},
                {"id": "engine", "label": "Leave it to the reward engine's probation and grade rules"},
            ],
        }
        async with session_scope() as s:
            requests = (await s.scalars(select(Event).where(Event.project_id == project.id,
                                                            Event.type == "council.requested")
                                        .order_by(Event.seq.desc()).limit(20))).all()
            convenes = (await s.scalars(select(Event).where(Event.project_id == project.id,
                                                            Event.type == "council.convened")
                                        .order_by(Event.seq.desc()).limit(50))).all()
            surfaced = (await s.scalars(select(Event).where(Event.project_id == project.id,
                                                            Event.type == "gossip.surfaced")
                                        .order_by(Event.seq.desc()).limit(20))).all()
        seen = {" ".join(str((e.payload or {}).get("question", "")).split()).lower() for e in convenes}
        candidates: list[dict] = []
        for r in requests:
            question = " ".join(str((r.payload or {}).get("question", "")).split())
            options = [o for o in ((r.payload or {}).get("options") or []) if isinstance(o, dict)]
            if len(options) < 2:
                options = [{"id": "proceed", "label": "Proceed as questioned"},
                           {"id": "hold", "label": "Hold and keep the current default"}]
            candidates.append({"question": question, "options": options, "task_id": r.task_id,
                               "run_id": r.run_id, "event_id": r.id,
                               "why": f"requested by agent {r.agent_id} on task {r.task_id}"})
        # the office's own agenda: a surfaced concern gets topic-shaped options, so the
        # debate is about what to DO, not about whether the complaint is real.
        for c in surfaced:
            topic = str((c.payload or {}).get("topic", "")).strip()
            if not topic:
                continue
            candidates.append({
                "question": f"Concern surfaced by the office: {topic}",
                "options": concern_options.get(topic) or [
                    {"id": "act", "label": "Act on the concern with a named owner"},
                    {"id": "hold", "label": "Keep going; the record is enough for now"},
                ],
                "task_id": c.task_id, "run_id": c.run_id, "event_id": c.id,
                "why": (f"gossip.surfaced ({topic}); mouths={(c.payload or {}).get('mouths')}; "
                        f"basis={(c.payload or {}).get('basis')}"),
            })
        served = 0
        for cand in candidates:
            if served >= 2:
                break
            question = str(cand["question"])
            if not question or question.lower() in seen:
                continue
            try:
                session = await council.convene(
                    project=project, question=question, options=cand["options"],
                    task_id=cand["task_id"], run_id=cand["run_id"],
                    convened_by="system:orchestrator", rationale=str(cand["why"]))
                await council.run_round(project_id=project.id, session_id=session["session_id"])
                seen.add(question.lower())
                served += 1
                try:
                    await council.decide(project=project, session_id=session["session_id"])
                except Exception:
                    log.exception("council decide failed for %s", cand["event_id"])
            except Exception:
                log.exception("council convene failed for %s", cand["event_id"])
        return served

    async def _free_agent(self, agent_id: str) -> None:
        """A finished task releases its agent (the inverse of the claim in _run_task)."""
        async with session_scope() as s:
            a = await s.get(Agent, agent_id)
            if a is not None and a.state == "busy":
                a.state = "idle"
                s.add(a)

    async def _reap_occupancy(self, project_id: str) -> None:
        """The safety net: any agent marked busy with no task RUNNING is freed.

        An exception between claim and release must not quietly remove somebody from
        every future assignment — this runs at the head of every wave, so the fleet
        heals itself within one tick.
        """
        async with session_scope() as s:
            busy = (await s.scalars(select(Agent).where(Agent.project_id == project_id,
                                                        Agent.state == "busy"))).all()
            if not busy:
                return
            running = set((await s.scalars(select(Task.assignee_agent_id).where(
                Task.assignee_agent_id.in_([a.id for a in busy]),
                Task.state == TaskState.RUNNING.value))).all())
            for a in busy:
                if a.id not in running:
                    a.state = "idle"
                    s.add(a)

    async def _record_task_result(self, run: Run, project: Project, task_id: str, snapshot: AgentSnapshot,
                                  result, elapsed_ms: int, route: str, attempts: int) -> None:
        text = result.text or ""
        clean, redactions = _redact(text)
        async with session_scope() as s:
            row = await s.get(Task, task_id)
            row.cost_micros += result.cost_micros
            row.tokens_in += result.tokens_in
            row.tokens_out += result.tokens_out
            row.result_text = clean[:20000]
            row.ended_at = datetime.now(UTC)
            if not result.ok:
                row.state = TaskState.FAILED.value
                row.escalation_reason = result.error or "execution failed"
            else:
                row.state = TaskState.VERIFYING.value
            s.add(row)
            r = await s.get(Run, run.id)
            r.cost_micros += result.cost_micros
            r.tokens_in += result.tokens_in
            r.tokens_out += result.tokens_out
            s.add(r)
        await ev.emit("llm.response", project_id=project.id, run_id=run.id, task_id=task_id,
                      agent_id=snapshot.id, trace_id=run.trace_id,
                      title=f"{route} · {result.tokens_in}+{result.tokens_out} tokens",
                      summary=f"${result.cost_micros / 1e6:.4f} · {elapsed_ms} ms · {result.steps} steps",
                      payload={"model": route, "tokens_in": result.tokens_in, "tokens_out": result.tokens_out,
                               "steps": result.steps, "tool_calls": result.tool_calls},
                      cost_micros=result.cost_micros, tokens_in=result.tokens_in,
                      tokens_out=result.tokens_out, duration_ms=elapsed_ms,
                      actor=f"agent:{snapshot.id}")
        if redactions:
            log.warning("redacted %s secret occurrence(s) from task %s output", redactions, task_id)

    async def _verify_and_reward(self, run: Run, project: Project, task_id: str, result, attempts: int) -> None:
        async with session_scope() as s:
            task = await s.get(Task, task_id)
            producer = await s.get(Agent, task.assignee_agent_id) if task.assignee_agent_id else None
            lead = await s.get(Agent, producer.manager_id) if producer and producer.manager_id else None
            head = await s.get(Agent, lead.manager_id) if lead and lead.manager_id else None
            orchestrator_id = (project.settings or {}).get("orchestrator_id")
            verifier_agent = await verifier.pick_verifier(project_id=project.id, producer=producer)
            effort, attempts_n = task.effort, task.attempts

        if not result.ok:
            outcome = await verifier.verify_task(project_id=project.id, task=task, result_text="",
                                                 verifier=verifier_agent)
        else:
            outcome = await verifier.verify_task(project_id=project.id, task=task,
                                                 result_text=task.result_text, verifier=verifier_agent)

        async with session_scope() as s:
            row = await s.get(Task, task_id)
            if outcome.passed:
                row.state = TaskState.COMPLETED.value
                row.ended_at = datetime.now(UTC)
            else:
                row.state = TaskState.FAILED.value
                row.escalation_reason = f"verification {outcome.verdict.value}"
                row.ended_at = datetime.now(UTC)
            s.add(row)

        settled = await reward_engine.settle_task(
            project_id=project.id, task=task, verdict=outcome.verdict.value, quality=outcome.quality,
            retries=max(0, attempts_n - 1), est_cost_micros=estimated_cost_micros(effort, "fast"),
            verifier_id=outcome.verifier_agent_id, lead_id=lead.id if lead else None,
            head_id=head.id if head else None, orchestrator_id=orchestrator_id,
            weights=(project.setting("reward_weights", {}) or {}),
            verifier_contradiction=outcome.contradiction,
            tool_error_rate=result.tool_error_rate,
        )
        if producer is not None and outcome.passed:
            skill_ids = [r.get("skill") for r in ([] if not result else [])] or []
            async with session_scope() as s:
                t = await s.get(Task, task_id)
                skill_ids = [r.get("skill") for r in (t.required_skills or []) if r.get("skill")]
            await reward_engine.adjust_skills(agent_id=producer.id, skill_ids=skill_ids,
                                              reward=_producer_reward(settled))

        await ev.emit("task.completed" if outcome.passed else "task.failed",
                      project_id=project.id, run_id=run.id, task_id=task_id,
                      agent_id=producer.id if producer else None, department_id=task.department_id,
                      squad_id=task.squad_id, severity="info" if outcome.passed else "warning",
                      title=("completed: " if outcome.passed else "failed: ") + task.title[:60],
                      summary=f"verdict={outcome.verdict.value} quality={outcome.quality:.2f} "
                              f"rewards={len(settled)}",
                      payload={"task_id": task_id, "verdict": outcome.verdict.value,
                               "quality": outcome.quality, "verifier": outcome.verifier_agent_id,
                               "rewards": settled},
                      cost_micros=0, actor=f"agent:{producer.id}" if producer else "system")

        # failure escalation ladder (docs/03 §5)
        if not outcome.passed:
            if attempts_n >= MAX_TASK_ATTEMPTS:
                await self._escalate_failed_task(run, project, task_id, outcome.verdict.value)
            else:
                await ev.emit("task.escalated", project_id=project.id, run_id=run.id, task_id=task_id,
                              severity="warning", title=f"retry scheduled for {task.title[:50]}",
                              payload={"task_id": task_id,
                                       "reason": f"verification {outcome.verdict.value}; retry {attempts_n}",
                                       "ladder": "lead→head→orchestrator"},
                              actor="system:orchestrator")

    async def _escalate_failed_task(self, run: Run, project: Project, task_id: str, reason: str) -> None:
        """Two or more failures → convene a council and bind the outcome as a constraint."""
        async with session_scope() as s:
            task = await s.get(Task, task_id)
        options = [
            {"id": "retry_more_budget", "label": "Retry with a higher model tier and a larger budget"},
            {"id": "reduce_scope", "label": "Reduce the task to a smaller, verifiable deliverable"},
            {"id": "abort_task", "label": "Abandon the task and record why"},
        ]
        session = await council.convene(
            project=project, question=f"Task keeps failing verification: {task.title}\n"
                                      f"Acceptance criteria: {task.acceptance_criteria}",
            options=options, criteria=["correctness", "cost", "time"], task_id=task_id, run_id=run.id,
            convened_by="system:orchestrator", rationale=reason,
        )
        await council.run_round(project_id=project.id, session_id=session["session_id"])
        outcome = await council.decide(project=project, session_id=session["session_id"])
        async with session_scope() as s:
            row = await s.get(Task, task_id)
            if outcome.chosen_option == "retry_more_budget":
                row.state = TaskState.ASSIGNED.value
                row.attempts = 0
                row.escalation_reason = "council: retry with more budget"
            elif outcome.chosen_option == "reduce_scope":
                row.acceptance_criteria = (row.acceptance_criteria or [])[:1] or ["A partial deliverable exists"]
                row.state = TaskState.ASSIGNED.value
                row.attempts = 0
                row.escalation_reason = "council: scope reduced"
            else:
                row.state = TaskState.ABORTED.value
                row.escalation_reason = f"council: {outcome.chosen_option}"
            s.add(row)

    async def _steering(self, project_id: str, task_id: str, agent_id: str) -> list[str]:
        async with session_scope() as s:
            rows = (await s.scalars(select(Event).where(Event.project_id == project_id,
                                                       Event.type == "user.steering")
                                    .order_by(desc(Event.seq)).limit(20))).all()
        out = []
        for r in rows:
            p = r.payload or {}
            if p.get("task_id") in (None, task_id) or p.get("agent_id") in (None, agent_id):
                out.append(str(p.get("text", ""))[:400])
        return [t for t in out if t][:3]

    async def _learn(self, run: Run, project: Project) -> RunStage:
        async with session_scope() as s:
            tasks = (await s.scalars(select(Task).where(Task.run_id == run.id))).all()
            agents = (await s.scalars(select(Agent).where(Agent.project_id == project.id))).all()
            r = await s.get(Run, run.id)
        done = [t for t in tasks if t.state == TaskState.COMPLETED.value]
        failed = [t for t in tasks if t.state in (TaskState.FAILED.value, TaskState.ABORTED.value)]
        summary = {
            "goal": run.goal,
            "delivered": [{"task": t.title, "deliverable": t.deliverable,
                           "result": summarize_working_set(t.result_text, 600)} for t in done],
            "not_delivered": [{"task": t.title, "reason": t.escalation_reason} for t in failed],
            "cost_usd": round(r.cost_micros / 1e6, 4),
            "tokens": {"in": r.tokens_in, "out": r.tokens_out},
            "agents_used": [{"name": a.name, "role": a.role, "grade": int(a.grade),
                             "score": a.score, "tasks_done": a.tasks_done} for a in agents
                            if a.state != "archived"],
            "lessons": [],
        }
        # librarian step: promote generalisable lessons into the department brains (docs/06 §4)
        lessons: list[dict] = []
        for t in tasks:
            if not t.assignee_agent_id:
                continue
            async with session_scope() as s:
                a = await s.get(Agent, t.assignee_agent_id)
            if a is None:
                continue
            if t.state == TaskState.COMPLETED.value:
                lessons.append({
                    "agent_id": a.id, "department_id": a.department_id,
                    "title": f"Worked: {t.title[:60]}",
                    "body": f"Approach that passed verification for '{t.title}'. "
                            f"Effort {t.effort}; cost ${t.cost_micros / 1e6:.4f}. "
                            f"Acceptance criteria met: {len(t.acceptance_criteria or [])}. "
                            f"Reusable when the same shape of task recurs.",
                    "importance": 0.6,
                })
            elif t.escalation_reason:
                lessons.append({
                    "agent_id": a.id, "department_id": a.department_id,
                    "title": f"Pitfall: {t.title[:60]}",
                    "body": f"Task failed verification: {t.escalation_reason}. "
                            f"Check this before repeating the same approach.",
                    "importance": 0.7,
                })
        for lesson in lessons[:12]:
            try:
                brain_id = None
                if lesson["department_id"]:
                    from crew.core.models import Department

                    async with session_scope() as s:
                        d = await s.get(Department, lesson["department_id"])
                        brain_id = d.brain_id if d else None
                if not brain_id:
                    brain_id = (project.settings or {}).get("project_brain_id")
                if not brain_id:
                    continue
                entry = await brain_service.write(
                    project_id=project.id, brain_id=brain_id, title=lesson["title"],
                    body=lesson["body"], kind="lesson",
                    source={"run_id": run.id, "agent_id": lesson["agent_id"]},
                    actor=None, importance=lesson["importance"], tags=["learned", run.id[:8]],
                )
                summary["lessons"].append(entry["title"])
            except Exception as e:  # learning must never break a run
                log.warning("lesson write failed: %s", e)

        async with session_scope() as s:
            r = await s.get(Run, run.id)
            r.report = summary
            r.status = RunStatus.COMPLETED.value if done else RunStatus.FAILED.value
            r.stage = RunStage.DONE.value
            r.ended_at = datetime.now(UTC)
            s.add(r)
        await ev.emit("run.completed", project_id=project.id, run_id=run.id,
                      severity="notice" if done else "error",
                      title=f"run {'completed' if done else 'failed'}: {len(done)}/{len(tasks)} tasks",
                      summary=f"${summary['cost_usd']:.4f} spent",
                      payload={"run_id": run.id, "tasks_done": len(done), "tasks_failed": len(failed),
                               "cost_usd": summary["cost_usd"], "lessons": len(summary["lessons"])},
                      actor="system:orchestrator")
        await audit(actor_kind="system", actor_id="orchestrator", action="run.completed",
                    resource_kind="run", resource_id=run.id,
                    reason=f"{len(done)}/{len(tasks)} tasks, ${summary['cost_usd']:.4f}")
        return RunStage.DONE

    # ── controls ───────────────────────────────────────────────────────────────
    async def pause_project(self, project_id: str, *, actor: str = "user") -> dict:
        async with session_scope() as s:
            p = await s.get(Project, project_id)
            if p is None:
                raise KeyError(project_id)
            p.status = "paused"
            s.add(p)
        await ev.emit("project.paused", project_id=project_id, severity="notice",
                      title="project paused", payload={"project_id": project_id}, actor=actor)
        await audit(actor_kind="user", actor_id=actor, action="project.paused",
                    resource_kind="project", resource_id=project_id)
        return {"project_id": project_id, "status": "paused"}

    async def resume_project(self, project_id: str, *, actor: str = "user") -> dict:
        async with session_scope() as s:
            p = await s.get(Project, project_id)
            if p is None:
                raise KeyError(project_id)
            p.status = "active"
            s.add(p)
        budget.close_breaker(project_id)
        await ev.emit("project.resumed", project_id=project_id, severity="notice",
                      title="project resumed", payload={"project_id": project_id}, actor=actor)
        return {"project_id": project_id, "status": "active"}

    async def kill(self, project_id: str, *, actor: str = "user") -> dict:
        budget.open_breaker(project_id)
        async with session_scope() as s:
            runs = (await s.scalars(select(Run).where(Run.project_id == project_id,
                                                      Run.status == RunStatus.RUNNING.value))).all()
            for r in runs:
                r.status = RunStatus.ABORTED.value
                r.ended_at = datetime.now(UTC)
                s.add(r)
        for r in runs:
            await ev.emit("run.aborted", project_id=project_id, run_id=r.id, severity="critical",
                          title="run aborted by kill switch", payload={"run_id": r.id}, actor=actor)
        await audit(actor_kind="user", actor_id=actor, action="system.kill", resource_kind="project",
                    resource_id=project_id, reason=f"aborted {len(runs)} run(s)")
        return {"project_id": project_id, "aborted_runs": len(runs)}

    async def kill_all(self, *, actor: str = "user") -> dict:
        async with session_scope() as s:
            ids = (await s.scalars(select(Project.id).where(Project.status != "archived"))).all()
        killed = 0
        for pid in ids:
            res = await self.kill(pid, actor=actor)
            killed += res["aborted_runs"]
        return {"projects": len(ids), "aborted_runs": killed}

    async def steer(self, *, project_id: str, text: str, target_kind: str = "project",
                    target_id: str | None = None, actor: str = "user") -> dict:
        payload = {"target_kind": target_kind, "text": text, "target_id": target_id,
                   "task_id": target_id if target_kind == "task" else None,
                   "agent_id": target_id if target_kind == "agent" else None}
        await ev.emit("user.steering", project_id=project_id, severity="notice",
                      title=f"steering ({target_kind}): {text[:60]}", summary=text, payload=payload,
                      agent_id=target_id if target_kind == "agent" else None,
                      task_id=target_id if target_kind == "task" else None, actor=actor)
        return {"accepted": True, "target_kind": target_kind, "target_id": target_id}


def _producer_reward(settled: list[dict]) -> float:
    for s in settled:
        if s.get("role") == "producer":
            return float(s.get("reward", 0.0))
    return 0.0


def _redact(text: str) -> tuple[str, int]:
    from crew.core.security import redactor

    return redactor.redact(text)


orchestrator = Orchestrator()
