"""CrewAI execution: bounded work in crews, behind a swappable interface (ADR 0002)."""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from crew.core import events as ev
from crew.core.settings import settings
from crew.execution.models import router
from crew.execution.prompt import build_backstory, build_crewai_goal
from crew.execution.tools import ToolContext, build_crewai_tools

log = logging.getLogger("crew.runner")


@dataclass
class AgentSnapshot:
    """Thread-safe copy of an agent row (never share ORM instances across threads)."""

    id: str
    name: str
    role: str
    grade: int
    mission: str
    autonomy: str
    model_tier: str
    model_id: str
    token_cap_per_step: int
    tools: list[str] = field(default_factory=list)
    department_id: str | None = None
    department_name: str | None = None
    squad_id: str | None = None
    manager_name: str | None = None
    reports: list[str] = field(default_factory=list)
    skills: list[str] = field(default_factory=list)
    decision_style: str = "analytical"
    # Soul (ADR 0016): rides the system prompt's SOUL section and the backstory voice.
    soul: dict = field(default_factory=dict)

    @classmethod
    def from_agent(cls, a: Any, *, manager_name: str | None = None,
                   department_name: str | None = None, skills: list[str] | None = None) -> AgentSnapshot:
        return cls(
            id=a.id, name=a.name, role=a.role, grade=int(a.grade), mission=a.mission,
            autonomy=a.autonomy, model_tier=a.model_tier, model_id=a.model_id or "",
            token_cap_per_step=a.token_cap_per_step, tools=list(a.tools or []),
            department_id=a.department_id, department_name=department_name,
            squad_id=a.squad_id, manager_name=manager_name, skills=skills or [],
            soul=dict(a.soul or {}),
        )


@dataclass
class TaskSpec:
    id: str
    title: str
    description: str
    deliverable: str = ""
    acceptance_criteria: list[str] = field(default_factory=list)
    output_contract: dict = field(default_factory=dict)
    effort: str = "M"
    decision_constraints: list[str] = field(default_factory=list)
    steer: list[str] = field(default_factory=list)
    required_skills: list[str] = field(default_factory=list)


@dataclass
class ExecutionResult:
    ok: bool
    text: str = ""
    tokens_in: int = 0
    tokens_out: int = 0
    cost_micros: int = 0
    model: str = ""
    steps: int = 0
    error: str = ""
    tool_calls: int = 0
    tool_errors: int = 0
    escalation: str = ""

    @property
    def tool_error_rate(self) -> float:
        return round(self.tool_errors / self.tool_calls, 3) if self.tool_calls else 0.0


@dataclass
class ExecutionRequest:
    project_id: str
    run_id: str
    trace_id: str
    agent: AgentSnapshot
    task: TaskSpec
    system_prompt: str
    user_prompt: str
    workspace: Path
    artifacts: Path
    extra_steer: list[str] = field(default_factory=list)
    escalate: int = 0


class CrewRunner(Protocol):
    def run_task(self, req: ExecutionRequest) -> ExecutionResult: ...


class CrewAICrewRunner:
    """Real execution through CrewAI. Synchronous by design: CrewAI owns the loop."""

    def run_task(self, req: ExecutionRequest) -> ExecutionResult:
        from crewai import Agent, Crew, Process, Task

        agent = req.agent
        llm = router.build_llm(agent, escalate=req.escalate)  # type: ignore[arg-type]
        from crew.execution.gateway import governed_llm

        choice = router.choice_for_agent(agent, escalate=req.escalate)  # type: ignore[arg-type]
        ctx = ToolContext(project_id=req.project_id, agent=agent, task_id=req.task.id,  # type: ignore[arg-type]
                          run_id=req.run_id, trace_id=req.trace_id, workspace=req.workspace,
                          artifacts=req.artifacts)

        def check_approval() -> None:
            if ctx.extra.get("pending_approval"):
                from crew.execution.tools import ToolApprovalPending

                raise ToolApprovalPending(ctx.extra["pending_approval"])

        llm = governed_llm(llm, req, model=choice.model, before_call=check_approval)
        tools = build_crewai_tools(ctx)
        steps = {"count": 0}

        def step_callback(step: Any) -> None:
            steps["count"] += 1
            text = _render(step)
            ev.emit_sync(
                type="agent.thought", project_id=req.project_id, run_id=req.run_id,
                task_id=req.task.id, agent_id=agent.id, trace_id=req.trace_id,
                title=f"{agent.name}: step {steps['count']}",
                summary=text[:300], payload={"step": steps["count"], "text": text[:1500]},
                actor=f"agent:{agent.id}",
            )

        def task_callback(output: Any) -> None:
            ev.emit_sync(
                type="task.step", project_id=req.project_id, run_id=req.run_id,
                task_id=req.task.id, agent_id=agent.id, trace_id=req.trace_id,
                title=f"{agent.name} finished the task step", summary=_render(output)[:300],
                payload={"text": _render(output)[:1500]}, actor=f"agent:{agent.id}",
            )

        def require_artifact(output: Any):
            from sqlalchemy import select

            from crew.core.db import session_scope
            from crew.core.models import Artifact
            from crew.execution.tools import run_on_loop

            async def published():
                async with session_scope() as s:
                    return await s.scalar(select(Artifact.id).where(
                        Artifact.task_id == req.task.id, Artifact.project_id == req.project_id).limit(1))

            if run_on_loop(published()):
                return True, output.raw
            return False, (
                "No artifact was published. You must actually call tools. Emit one Action and JSON Action Input, "
                "then STOP and wait for the tool result. Use fs_write to create workspace files and "
                "artifact_publish with name and source_path to publish an existing file. Never invent Observation results."
            )

        crew_agent = Agent(
            role=f"{agent.name}, {agent.role}",
            goal=build_crewai_goal(agent.mission, req.task.title),
            backstory=build_backstory(role=agent.role, department=agent.department_name,
                                      grade=agent.grade, soul=agent.soul or None),
            llm=llm,
            tools=tools,
            max_iter=max(3, min(24, steps_budget(req.task.effort))),
            max_retries=1,
            verbose=False,
            allow_delegation=False,
            max_tokens=agent.token_cap_per_step,
            step_callback=step_callback,
            use_system_prompt=True,
            # CrewAI ignores a lone system_template. Both markers preserve our
            # policy/context as well as CrewAI's tool schemas and call format.
            system_template=req.system_prompt + "\n\n{{ .System }}",
            prompt_template="{{ .Prompt }}",
        )
        crew_task = Task(
            name=req.task.id[:40],
            description=req.user_prompt,
            expected_output=req.task.deliverable or "A complete answer addressing each acceptance criterion.",
            agent=crew_agent,
            callback=task_callback,
            guardrail=require_artifact,
            guardrail_max_retries=1,
        )
        crew = Crew(agents=[crew_agent], tasks=[crew_task], process=Process.sequential,
                    verbose=False, memory=False, step_callback=step_callback,
                    task_callback=task_callback)
        try:
            result = crew.kickoff()
            text = _render(result)
            tokens_in, tokens_out, cost = llm.total_in, llm.total_out, llm.total_cost
            ok = bool(text and not str(result).lower().startswith("error"))
            return ExecutionResult(ok=ok, text=text, tokens_in=tokens_in, tokens_out=tokens_out,
                                   cost_micros=cost, model=choice.model, steps=steps["count"])
        except Exception as e:
            if ctx.extra.get("pending_approval"):
                return ExecutionResult(ok=False, error=str(ctx.extra["pending_approval"]),
                    escalation="approval_required", text="Waiting for operator approval",
                    cost_micros=llm.total_cost, tokens_in=llm.total_in, tokens_out=llm.total_out,
                    model=choice.model, steps=steps["count"])
            log.exception("crew execution failed")
            return ExecutionResult(ok=False, error=f"{type(e).__name__}: {e}",
                                   cost_micros=llm.total_cost, tokens_in=llm.total_in, tokens_out=llm.total_out,
                                   model=choice.model, steps=steps["count"],
                                   text=f"execution failed: {type(e).__name__}")


def steps_budget(effort: str) -> int:
    # A one-file writer needs a handful of steps, but a repo-scale audit has to read many files
    # before it can write a grounded deliverable: on 16 October a junior spent its whole
    # 10-step budget listing and grepping the product tree and never wrote the file its
    # acceptance criteria asked for, so every dependent task in the run hung on it.
    return {"S": 8, "M": 12, "L": 18, "XL": 24}.get(effort, 12)


def _usage(crew: Any, model: str) -> tuple[int, int, int]:
    metrics = getattr(crew, "usage_metrics", None)
    tin = int(getattr(metrics, "prompt_tokens", 0) or 0)
    tout = int(getattr(metrics, "completion_tokens", 0) or 0)
    cached = int(getattr(metrics, "cached_prompt_tokens", 0) or 0)
    return tin, tout, router.cost_micros(model, tin, tout, cached_in=cached)


def _render(value: Any) -> str:
    if value is None:
        return ""
    for attr in ("raw", "output", "text", "content"):
        v = getattr(value, attr, None)
        if isinstance(v, str) and v.strip():
            return v
    if hasattr(value, "model_dump"):
        try:
            return json.dumps(value.model_dump(), default=str)[:20000]
        except Exception:
            pass
    return str(value)[:20000]


class FakeCrewRunner:
    """Deterministic runner for tests and offline mode (ADR 0002)."""

    def __init__(self, *, fail: bool = False, quality: str = "good") -> None:
        self.fail = fail
        self.quality = quality

    def run_task(self, req: ExecutionRequest) -> ExecutionResult:
        text = (
            f"[offline runner] {req.agent.name} ({req.agent.role}, grade {req.agent.grade}) "
            f"handled '{req.task.title}'.\n\n"
            + "\n".join(f"- criterion {i + 1}: addressed: {c}" for i, c in enumerate(req.task.acceptance_criteria))
            + f"\n\nDeliverable: {req.task.deliverable or 'answer'} (offline simulated result)."
        )
        ev.emit_sync(type="agent.thought", project_id=req.project_id, run_id=req.run_id,
                     task_id=req.task.id, agent_id=req.agent.id, trace_id=req.trace_id,
                     title=f"{req.agent.name}: offline plan", summary="simulated reasoning step",
                     payload={"text": "offline"}, actor=f"agent:{req.agent.id}")
        ev.emit_sync(type="agent.tool.call", project_id=req.project_id, run_id=req.run_id,
                     task_id=req.task.id, agent_id=req.agent.id, trace_id=req.trace_id,
                     title="tool: brain_search", payload={"tool": "brain_search", "args": {"query": req.task.title}},
                     actor=f"agent:{req.agent.id}")
        # The offline runner still produces a REAL deliverable file: the deliverables
        # surface (company / department / agent scopes) must not be empty in offline
        # mode, and a demo that points at a file which does not exist would lie.
        if not self.fail and req.artifacts is not None:
            try:
                self._publish_deliverable(req, text)
            except OSError as exc:  # never fail the simulated task over a file hiccup
                text += f"\n\n(deliverable file could not be written: {exc})"
        tokens_in, tokens_out = 0, 0
        model = f"offline/{req.agent.model_tier}"
        return ExecutionResult(
            ok=not self.fail,
            text="" if self.fail else text,
            error="simulated failure" if self.fail else "",
            tokens_in=tokens_in, tokens_out=tokens_out,
            cost_micros=0,
            model=model, steps=2, tool_calls=1, tool_errors=0,
        )

    @staticmethod
    def _deliverable_name(title: str) -> str:
        import re
        slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:60]
        return f"{slug or 'deliverable'}.md"

    def _publish_deliverable(self, req: ExecutionRequest, text: str) -> None:
        import hashlib

        from crew.execution.tools import run_on_loop
        name = self._deliverable_name(req.task.title)
        root = req.artifacts / (req.task.id or "task")
        root.mkdir(parents=True, exist_ok=True)
        p = root / name
        body = f"# {req.task.title}\n\n{text}\n"
        # Byte-exact write: text mode would turn \n into \r\n on Windows and the
        # recorded sha256/bytes would then describe a file that does not exist.
        p.write_bytes(body.encode("utf-8"))
        digest = hashlib.sha256(body.encode()).hexdigest()

        async def _record() -> None:
            from crew.core.db import session_scope
            from crew.core.models import Artifact

            async with session_scope() as s:
                s.add(Artifact(project_id=req.project_id, task_id=req.task.id,
                               agent_id=req.agent.id, kind="file", path=str(p),
                               mime="text/markdown", bytes=len(body.encode()),
                               sha256=digest, meta={"name": name}))

        run_on_loop(_record())


def select_runner() -> CrewRunner:
    if settings.offline_llm:
        return FakeCrewRunner()
    return CrewAICrewRunner()


def estimated_cost_micros(effort: str, tier: str) -> int:
    """Pre-flight estimate used by the planner and the budget guard."""
    tokens_in = {"S": 3_000, "M": 8_000, "L": 20_000, "XL": 40_000}.get(effort, 8_000)
    model = router.model_for_tier(__import__("crew.domain.enums", fromlist=["ModelTier"]).ModelTier(tier))
    return router.estimate_cost_micros(model, tokens_in)
