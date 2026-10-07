"""SQLAlchemy models — the projection of the event log (docs/10)."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from crew.core.db import Base


def uid() -> str:
    return uuid.uuid4().hex


def now() -> datetime:
    return datetime.now(UTC)


def usd_to_micros(v: float) -> int:
    return int(round(v * 1_000_000))


def micros_to_usd(v: int | None) -> float:
    return round((v or 0) / 1_000_000, 6)


# ── org ─────────────────────────────────────────────────────────────────────────────
class Project(Base):
    __tablename__ = "projects"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    name: Mapped[str] = mapped_column(String(200))
    slug: Mapped[str] = mapped_column(String(200), index=True)
    goal: Mapped[str] = mapped_column(Text, default="")
    description: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(20), default="active", index=True)
    # "project" | "company" — a company is a headquarters project whose agents run the
    # portfolio (ADR 0009); kind keeps companies out of the ordinary project lists.
    kind: Mapped[str] = mapped_column(String(16), default="project", index=True)
    company_id: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    stage: Mapped[str] = mapped_column(String(20), default="IDLE")
    owner_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    # Project settings live as a JSON document (see docs/10 §2 note): defaults in DEFAULT_SETTINGS.
    settings: Mapped[dict] = mapped_column(JSON, default=dict)
    budget_cap_micros: Mapped[int] = mapped_column(BigInteger, default=usd_to_micros(10.0))
    spend_micros: Mapped[int] = mapped_column(BigInteger, default=0)
    reserved_micros: Mapped[int] = mapped_column(BigInteger, default=0)
    tags: Mapped[list] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(default=now)
    updated_at: Mapped[datetime] = mapped_column(default=now, onupdate=now)
    archived_at: Mapped[datetime | None] = mapped_column(nullable=True)

    departments: Mapped[list[Department]] = relationship(back_populates="project", lazy="selectin")
    agents: Mapped[list[Agent]] = relationship(back_populates="project", lazy="selectin")

    @property
    def budget_usd(self) -> float:
        return micros_to_usd(self.budget_cap_micros)

    @property
    def spend_usd(self) -> float:
        return micros_to_usd(self.spend_micros)

    def setting(self, key: str, default: Any = None) -> Any:
        return (self.settings or {}).get(key, default)


class Department(Base):
    __tablename__ = "departments"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    mission: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(20), default="active", index=True)
    head_agent_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    budget_envelope_micros: Mapped[int] = mapped_column(BigInteger, default=0)
    spend_micros: Mapped[int] = mapped_column(BigInteger, default=0)
    capabilities: Mapped[list] = mapped_column(JSON, default=list)
    brain_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    charter: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(default=now)
    archived_at: Mapped[datetime | None] = mapped_column(nullable=True)

    project: Mapped[Project] = relationship(back_populates="departments")


class Squad(Base):
    __tablename__ = "squads"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    department_id: Mapped[str] = mapped_column(ForeignKey("departments.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    mission: Mapped[str] = mapped_column(Text, default="")
    workstream: Mapped[str] = mapped_column(String(200), default="")
    lead_agent_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="active", index=True)
    created_at: Mapped[datetime] = mapped_column(default=now)
    closed_at: Mapped[datetime | None] = mapped_column(nullable=True)


class Agent(Base):
    __tablename__ = "agents"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    department_id: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    squad_id: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    manager_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    name: Mapped[str] = mapped_column(String(200))
    role: Mapped[str] = mapped_column(String(30), index=True)
    grade: Mapped[int] = mapped_column(Integer, default=1)
    state: Mapped[str] = mapped_column(String(20), default="idle", index=True)
    mission: Mapped[str] = mapped_column(Text, default="")
    responsibilities: Mapped[list] = mapped_column(JSON, default=list)
    decision_style: Mapped[str] = mapped_column(String(40), default="analytical")
    autonomy: Mapped[str] = mapped_column(String(20), default="supervised")
    model_tier: Mapped[str] = mapped_column(String(20), default="fast")
    model_id: Mapped[str] = mapped_column(String(120), default="")
    token_cap_per_step: Mapped[int] = mapped_column(Integer, default=4000)
    spend_cap_per_run_micros: Mapped[int] = mapped_column(BigInteger, default=usd_to_micros(0.5))
    spend_cap_per_day_micros: Mapped[int] = mapped_column(BigInteger, default=usd_to_micros(2.0))
    spend_today_micros: Mapped[int] = mapped_column(BigInteger, default=0)
    score: Mapped[float] = mapped_column(Float, default=0.0)
    score_confidence: Mapped[float] = mapped_column(Float, default=0.0)
    evidence_count: Mapped[int] = mapped_column(Integer, default=0)
    success_rate: Mapped[float] = mapped_column(Float, default=0.0)
    tasks_done: Mapped[int] = mapped_column(Integer, default=0)
    tasks_failed: Mapped[int] = mapped_column(Integer, default=0)
    penalty_count: Mapped[int] = mapped_column(Integer, default=0)
    prompt_version: Mapped[int] = mapped_column(Integer, default=1)
    brain_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    tools: Mapped[list] = mapped_column(JSON, default=list)
    approval_rules: Mapped[dict] = mapped_column(JSON, default=dict)
    current_task_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    hire_rationale: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(default=now)
    archived_at: Mapped[datetime | None] = mapped_column(nullable=True)
    last_active_at: Mapped[datetime | None] = mapped_column(nullable=True)

    project: Mapped[Project] = relationship(back_populates="agents")

    @property
    def score_100(self) -> float:
        return round((self.score + 1) * 50, 1)


class Skill(Base):
    __tablename__ = "skills"

    id: Mapped[str] = mapped_column(String(60), primary_key=True)
    label: Mapped[str] = mapped_column(String(120))
    category: Mapped[str] = mapped_column(String(40))
    description: Mapped[str] = mapped_column(Text, default="")
    typical_tools: Mapped[list] = mapped_column(JSON, default=list)
    related: Mapped[list] = mapped_column(JSON, default=list)


class AgentSkill(Base):
    __tablename__ = "agent_skills"
    __table_args__ = (UniqueConstraint("agent_id", "skill_id", name="uq_agent_skill"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    agent_id: Mapped[str] = mapped_column(ForeignKey("agents.id", ondelete="CASCADE"), index=True)
    skill_id: Mapped[str] = mapped_column(ForeignKey("skills.id", ondelete="CASCADE"), index=True)
    proficiency: Mapped[float] = mapped_column(Float, default=0.5)
    evidence_count: Mapped[int] = mapped_column(Integer, default=0)
    last_used_at: Mapped[datetime | None] = mapped_column(nullable=True)


# ── work ────────────────────────────────────────────────────────────────────────────
class Run(Base):
    __tablename__ = "runs"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    goal: Mapped[str] = mapped_column(Text)
    mode: Mapped[str] = mapped_column(String(20), default="autonomous")
    goal_brief: Mapped[dict] = mapped_column(JSON, default=dict)
    plan: Mapped[dict] = mapped_column(JSON, default=dict)
    pending_questions: Mapped[list] = mapped_column(JSON, default=list)
    stage: Mapped[str] = mapped_column(String(20), default="INTAKE")
    status: Mapped[str] = mapped_column(String(30), default="running", index=True)
    trace_id: Mapped[str] = mapped_column(String(32), default=uid, index=True)
    cost_micros: Mapped[int] = mapped_column(BigInteger, default=0)
    tokens_in: Mapped[int] = mapped_column(BigInteger, default=0)
    tokens_out: Mapped[int] = mapped_column(BigInteger, default=0)
    report: Mapped[dict] = mapped_column(JSON, default=dict)
    error: Mapped[str] = mapped_column(Text, default="")
    triggered_by: Mapped[str] = mapped_column(String(20), default="user")
    started_at: Mapped[datetime] = mapped_column(default=now)
    ended_at: Mapped[datetime | None] = mapped_column(nullable=True)


class Task(Base):
    __tablename__ = "tasks"
    __table_args__ = (Index("ix_tasks_project_state", "project_id", "state"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    run_id: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    department_id: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    squad_id: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    parent_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    title: Mapped[str] = mapped_column(String(300))
    description: Mapped[str] = mapped_column(Text, default="")
    deliverable: Mapped[str] = mapped_column(Text, default="")
    required_skills: Mapped[list] = mapped_column(JSON, default=list)   # [{skill, weight}]
    acceptance_criteria: Mapped[list] = mapped_column(JSON, default=list)
    depends_on: Mapped[list] = mapped_column(JSON, default=list)
    output_contract: Mapped[dict] = mapped_column(JSON, default=dict)
    effort: Mapped[str] = mapped_column(String(2), default="M")
    priority: Mapped[int] = mapped_column(Integer, default=2)
    state: Mapped[str] = mapped_column(String(20), default="pending", index=True)
    assignee_agent_id: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    assignee_squad_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    cost_micros: Mapped[int] = mapped_column(BigInteger, default=0)
    tokens_in: Mapped[int] = mapped_column(BigInteger, default=0)
    tokens_out: Mapped[int] = mapped_column(BigInteger, default=0)
    result_text: Mapped[str] = mapped_column(Text, default="")
    result_ref: Mapped[str] = mapped_column(String(200), default="")
    escalated_to: Mapped[str | None] = mapped_column(String(32), nullable=True)
    escalation_reason: Mapped[str] = mapped_column(Text, default="")
    # colleagues who joined to help (ADR 0010): they are asked first when a retry needs
    # new hands, so joint work actually finishes together
    helpers: Mapped[list] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(default=now)
    started_at: Mapped[datetime | None] = mapped_column(nullable=True)
    ended_at: Mapped[datetime | None] = mapped_column(nullable=True)


class WorkItem(Base):
    """Backlog planning entity (ADR 0010): epic → feature → story, plus bugs.

    Not executable. Executable work stays in `tasks`; a READY story or bug is promoted
    into a real task by the orchestrator's board pass, and after that its board column
    is DERIVED from the task's state — the board cannot disagree with the engine.
    """

    __tablename__ = "work_items"
    __table_args__ = (Index("ix_work_items_project_state", "project_id", "state"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    department_id: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    squad_id: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    parent_id: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    kind: Mapped[str] = mapped_column(String(16), default="story", index=True)  # epic|feature|story|bug
    title: Mapped[str] = mapped_column(String(300))
    body: Mapped[str] = mapped_column(Text, default="")
    acceptance: Mapped[list] = mapped_column(JSON, default=list)
    state: Mapped[str] = mapped_column(String(20), default="backlog", index=True)
    priority: Mapped[int] = mapped_column(Integer, default=2)
    severity: Mapped[str] = mapped_column(String(16), default="normal")  # bugs: low|normal|high|critical
    created_by: Mapped[str] = mapped_column(String(60), default="user")  # agent id | user | system:planner
    assignee_agent_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    task_id: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    tags: Mapped[list] = mapped_column(JSON, default=list)
    source: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(default=now)
    updated_at: Mapped[datetime] = mapped_column(default=now, onupdate=now)


class Job(Base):
    __tablename__ = "jobs"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    project_id: Mapped[str] = mapped_column(String(32), index=True)
    task_id: Mapped[str] = mapped_column(String(32), index=True)
    state: Mapped[str] = mapped_column(String(20), default="queued", index=True)
    attempt: Mapped[int] = mapped_column(Integer, default=1)
    worker: Mapped[str] = mapped_column(String(60), default="")
    heartbeat_at: Mapped[datetime | None] = mapped_column(nullable=True)
    cancel_requested: Mapped[bool] = mapped_column(Boolean, default=False)
    error_class: Mapped[str] = mapped_column(String(40), default="")
    error_message: Mapped[str] = mapped_column(Text, default="")
    started_at: Mapped[datetime | None] = mapped_column(nullable=True)
    ended_at: Mapped[datetime | None] = mapped_column(nullable=True)


class VerificationResult(Base):
    __tablename__ = "verification_results"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    project_id: Mapped[str] = mapped_column(String(32), index=True)
    task_id: Mapped[str] = mapped_column(String(32), index=True)
    verdict: Mapped[str] = mapped_column(String(24))
    method: Mapped[str] = mapped_column(String(20))
    checks: Mapped[list] = mapped_column(JSON, default=list)
    rubric: Mapped[dict] = mapped_column(JSON, default=dict)
    evidence: Mapped[list] = mapped_column(JSON, default=list)
    confidence: Mapped[float] = mapped_column(Float, default=0.5)
    verifier_agent_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    created_at: Mapped[datetime] = mapped_column(default=now)


class RewardEvent(Base):
    __tablename__ = "reward_events"
    __table_args__ = (Index("ix_rewards_agent_ts", "agent_id", "created_at"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    project_id: Mapped[str] = mapped_column(String(32), index=True)
    run_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    task_id: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    agent_id: Mapped[str] = mapped_column(String(32), index=True)
    role_in_task: Mapped[str] = mapped_column(String(20))
    verdict: Mapped[str] = mapped_column(String(24))
    components: Mapped[dict] = mapped_column(JSON, default=dict)
    penalties: Mapped[list] = mapped_column(JSON, default=list)
    reward: Mapped[float] = mapped_column(Float, default=0.0)
    weight: Mapped[float] = mapped_column(Float, default=1.0)
    score_after: Mapped[float] = mapped_column(Float, default=0.0)
    grade_before: Mapped[int] = mapped_column(Integer, default=0)
    grade_after: Mapped[int] = mapped_column(Integer, default=0)
    note: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(default=now, index=True)


class Artifact(Base):
    __tablename__ = "artifacts"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    project_id: Mapped[str] = mapped_column(String(32), index=True)
    task_id: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    agent_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    kind: Mapped[str] = mapped_column(String(20), default="text")
    path: Mapped[str] = mapped_column(String(400), default="")
    mime: Mapped[str] = mapped_column(String(120), default="text/plain")
    bytes: Mapped[int] = mapped_column(Integer, default=0)
    sha256: Mapped[str] = mapped_column(String(64), default="")
    trust: Mapped[str] = mapped_column(String(24), default="internal")
    meta: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(default=now)


# ── memory ──────────────────────────────────────────────────────────────────────────
class Brain(Base):
    __tablename__ = "brains"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    project_id: Mapped[str] = mapped_column(String(32), index=True)
    scope: Mapped[str] = mapped_column(String(20))
    owner_id: Mapped[str] = mapped_column(String(32), default="")
    label: Mapped[str] = mapped_column(String(200), default="")
    created_at: Mapped[datetime] = mapped_column(default=now)


class BrainEntry(Base):
    __tablename__ = "brain_entries"
    __table_args__ = (Index("ix_brain_entries_brain_created", "brain_id", "created_at"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    project_id: Mapped[str] = mapped_column(String(32), index=True)
    brain_id: Mapped[str] = mapped_column(String(32), index=True)
    kind: Mapped[str] = mapped_column(String(20), default="fact")
    title: Mapped[str] = mapped_column(String(300))
    body: Mapped[str] = mapped_column(Text, default="")
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    source: Mapped[dict] = mapped_column(JSON, default=dict)
    trust: Mapped[str] = mapped_column(String(24), default="internal")
    importance: Mapped[float] = mapped_column(Float, default=0.5)
    tags: Mapped[list] = mapped_column(JSON, default=list)
    skill_ids: Mapped[list] = mapped_column(JSON, default=list)
    created_by: Mapped[str] = mapped_column(String(32), default="")
    created_at: Mapped[datetime] = mapped_column(default=now)
    last_used_at: Mapped[datetime | None] = mapped_column(nullable=True)
    use_count: Mapped[int] = mapped_column(Integer, default=0)
    decay_score: Mapped[float] = mapped_column(Float, default=1.0)
    superseded_by: Mapped[str | None] = mapped_column(String(32), nullable=True)
    archived_at: Mapped[datetime | None] = mapped_column(nullable=True)
    human_edited: Mapped[bool] = mapped_column(Boolean, default=False)


class BrainLink(Base):
    __tablename__ = "brain_links"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    project_id: Mapped[str] = mapped_column(String(32), index=True)
    from_entry_id: Mapped[str] = mapped_column(String(32), index=True)
    to_entry_id: Mapped[str] = mapped_column(String(32), index=True)
    relation: Mapped[str] = mapped_column(String(24))
    created_at: Mapped[datetime] = mapped_column(default=now)


# ── decisions ───────────────────────────────────────────────────────────────────────
class CouncilSession(Base):
    __tablename__ = "council_sessions"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    project_id: Mapped[str] = mapped_column(String(32), index=True)
    run_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    task_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    question: Mapped[str] = mapped_column(Text)
    options: Mapped[list] = mapped_column(JSON, default=list)
    criteria: Mapped[list] = mapped_column(JSON, default=list)
    constraints: Mapped[list] = mapped_column(JSON, default=list)
    panel: Mapped[list] = mapped_column(JSON, default=list)
    status: Mapped[str] = mapped_column(String(20), default="open")
    rounds: Mapped[int] = mapped_column(Integer, default=0)
    max_rounds: Mapped[int] = mapped_column(Integer, default=3)
    convened_by: Mapped[str] = mapped_column(String(32), default="")
    rationale: Mapped[str] = mapped_column(Text, default="")
    decision_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    created_at: Mapped[datetime] = mapped_column(default=now)
    closed_at: Mapped[datetime | None] = mapped_column(nullable=True)


class CouncilPosition(Base):
    __tablename__ = "council_positions"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    project_id: Mapped[str] = mapped_column(String(32), index=True)
    session_id: Mapped[str] = mapped_column(String(32), index=True)
    round: Mapped[int] = mapped_column(Integer, default=1)
    agent_id: Mapped[str] = mapped_column(String(32))
    option_id: Mapped[str] = mapped_column(String(40), default="")
    claim: Mapped[str] = mapped_column(Text, default="")
    reasoning: Mapped[str] = mapped_column(Text, default="")
    evidence: Mapped[list] = mapped_column(JSON, default=list)
    risks: Mapped[list] = mapped_column(JSON, default=list)
    confidence: Mapped[float] = mapped_column(Float, default=0.5)
    critique_of_position_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    created_at: Mapped[datetime] = mapped_column(default=now)


class Decision(Base):
    __tablename__ = "decisions"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    project_id: Mapped[str] = mapped_column(String(32), index=True)
    session_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    task_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    question: Mapped[str] = mapped_column(Text)
    chosen_option: Mapped[str] = mapped_column(String(40), default="")
    rationale: Mapped[str] = mapped_column(Text, default="")
    dissent: Mapped[list] = mapped_column(JSON, default=list)
    confidence: Mapped[float] = mapped_column(Float, default=0.5)
    reversibility: Mapped[str] = mapped_column(String(20), default="two_way")
    follow_ups: Mapped[list] = mapped_column(JSON, default=list)
    decider_agent_id: Mapped[str] = mapped_column(String(32), default="")
    overridden_by: Mapped[str | None] = mapped_column(String(32), nullable=True)
    override_reason: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(default=now)


# ── observability / governance ──────────────────────────────────────────────────────
class Event(Base):
    __tablename__ = "events"
    __table_args__ = (
        UniqueConstraint("project_id", "seq", name="uq_events_project_seq"),
        Index("ix_events_project_type_ts", "project_id", "type", "ts"),
        Index("ix_events_agent_ts", "agent_id", "ts"),
        Index("ix_events_trace_ts", "trace_id", "ts"),
        Index("ix_events_task_ts", "task_id", "ts"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    project_id: Mapped[str] = mapped_column(String(32), index=True)
    seq: Mapped[int] = mapped_column(BigInteger)
    ts: Mapped[datetime] = mapped_column(default=now, index=True)
    type: Mapped[str] = mapped_column(String(60), index=True)
    severity: Mapped[str] = mapped_column(String(12), default="info")
    title: Mapped[str] = mapped_column(String(300), default="")
    summary: Mapped[str] = mapped_column(Text, default="")
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    department_id: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    squad_id: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    agent_id: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    task_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    run_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    job_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    trace_id: Mapped[str] = mapped_column(String(32), default="", index=True)
    span_id: Mapped[str] = mapped_column(String(32), default="")
    parent_span_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    actor: Mapped[str] = mapped_column(String(80), default="system")
    cost_micros: Mapped[int] = mapped_column(BigInteger, default=0)
    tokens_in: Mapped[int] = mapped_column(BigInteger, default=0)
    tokens_out: Mapped[int] = mapped_column(BigInteger, default=0)
    duration_ms: Mapped[int] = mapped_column(Integer, default=0)


class BudgetLedger(Base):
    __tablename__ = "budget_ledger"
    __table_args__ = (UniqueConstraint("idempotency_key", name="uq_ledger_idem"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    project_id: Mapped[str] = mapped_column(String(32), index=True)
    scope_kind: Mapped[str] = mapped_column(String(20))
    scope_id: Mapped[str] = mapped_column(String(32))
    kind: Mapped[str] = mapped_column(String(20))
    amount_micros: Mapped[int] = mapped_column(BigInteger, default=0)
    ref: Mapped[str] = mapped_column(String(80), default="")
    note: Mapped[str] = mapped_column(Text, default="")
    idempotency_key: Mapped[str] = mapped_column(String(120), default=uid)
    ts: Mapped[datetime] = mapped_column(default=now, index=True)


class Approval(Base):
    __tablename__ = "approvals"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    project_id: Mapped[str] = mapped_column(String(32), index=True)
    task_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    agent_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    capability: Mapped[str] = mapped_column(String(40))
    request: Mapped[dict] = mapped_column(JSON, default=dict)
    state: Mapped[str] = mapped_column(String(20), default="pending", index=True)
    decided_by: Mapped[str | None] = mapped_column(String(32), nullable=True)
    decided_at: Mapped[datetime | None] = mapped_column(nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(nullable=True)
    reason: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(default=now)


class AuditLog(Base):
    __tablename__ = "audit_log"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    seq: Mapped[int] = mapped_column(BigInteger, default=0, index=True)
    ts: Mapped[datetime] = mapped_column(default=now)
    actor_kind: Mapped[str] = mapped_column(String(12), default="system")
    actor_id: Mapped[str] = mapped_column(String(40), default="")
    action: Mapped[str] = mapped_column(String(80))
    resource_kind: Mapped[str] = mapped_column(String(30), default="")
    resource_id: Mapped[str] = mapped_column(String(40), default="")
    outcome: Mapped[str] = mapped_column(String(20), default="ok")
    reason: Mapped[str] = mapped_column(Text, default="")
    trace_id: Mapped[str] = mapped_column(String(32), default="")
    prev_hash: Mapped[str] = mapped_column(String(64), default="")
    hash: Mapped[str] = mapped_column(String(64), default="")


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    email: Mapped[str] = mapped_column(String(200), unique=True)
    name: Mapped[str] = mapped_column(String(200), default="")
    password_hash: Mapped[str] = mapped_column(String(300), default="")
    role: Mapped[str] = mapped_column(String(20), default="admin")
    created_at: Mapped[datetime] = mapped_column(default=now)
    disabled_at: Mapped[datetime | None] = mapped_column(nullable=True)


class SessionToken(Base):
    __tablename__ = "sessions"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    user_id: Mapped[str] = mapped_column(String(32), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), index=True)
    issued_at: Mapped[datetime] = mapped_column(default=now)
    expires_at: Mapped[datetime] = mapped_column()
    revoked_at: Mapped[datetime | None] = mapped_column(nullable=True)
    ua: Mapped[str] = mapped_column(String(200), default="")
    ip: Mapped[str] = mapped_column(String(60), default="")


class Secret(Base):
    __tablename__ = "secrets"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    name: Mapped[str] = mapped_column(String(120), unique=True)
    scope_kind: Mapped[str] = mapped_column(String(20), default="project")
    scope_id: Mapped[str] = mapped_column(String(32), default="")
    ciphertext: Mapped[str] = mapped_column(Text)
    nonce: Mapped[str] = mapped_column(String(60))
    aad: Mapped[str] = mapped_column(String(200), default="")
    sha256: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[datetime] = mapped_column(default=now)
    rotated_at: Mapped[datetime | None] = mapped_column(nullable=True)
    last_used_at: Mapped[datetime | None] = mapped_column(nullable=True)


class SecretLease(Base):
    __tablename__ = "secret_leases"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    secret_id: Mapped[str] = mapped_column(String(32), index=True)
    agent_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    capability: Mapped[str] = mapped_column(String(40), default="")
    issued_at: Mapped[datetime] = mapped_column(default=now)
    expires_at: Mapped[datetime] = mapped_column()
    uses: Mapped[int] = mapped_column(Integer, default=0)
    max_uses: Mapped[int] = mapped_column(Integer, default=1)
    revoked_at: Mapped[datetime | None] = mapped_column(nullable=True)
