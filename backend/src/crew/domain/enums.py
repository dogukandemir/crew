"""Domain vocabulary: enums used across the whole system (docs/00 §6)."""

from __future__ import annotations

from enum import IntEnum, StrEnum


class Grade(IntEnum):
    """Agent seniority. Ordering matters: privileges grow with the index (docs/04 §2)."""

    TRAINEE = 0
    JUNIOR = 1
    MID = 2
    SENIOR = 3
    PRINCIPAL = 4
    CHIEF = 5

    @property
    def label(self) -> str:
        return self.name.capitalize()


class Role(StrEnum):
    ORCHESTRATOR = "orchestrator"
    # The company layer (ADR 0009): the portfolio chair, living in the company project.
    CEO = "ceo"
    # The executive tier (ADR 0008): one chief per function, between orchestrator and heads.
    CTO = "cto"
    CMO = "cmo"
    CPO = "cpo"
    COO = "coo"
    HEAD = "head"
    LEAD = "lead"
    WORKER = "worker"
    SPECIALIST = "specialist"
    CRITIC = "critic"
    ANALYST = "analyst"
    ARCHITECT = "architect"
    DECIDER = "decider"
    EVALUATOR = "evaluator"
    LIBRARIAN = "librarian"


class AgentState(StrEnum):
    IDLE = "idle"
    BUSY = "busy"
    PROBATION = "probation"
    SUSPENDED = "suspended"
    ARCHIVED = "archived"


class Autonomy(StrEnum):
    SUPERVISED = "supervised"
    BOUNDED = "bounded"
    AUTONOMOUS = "autonomous"


class ModelTier(StrEnum):
    REASONING = "reasoning"
    STANDARD = "standard"
    FAST = "fast"
    EMBED = "embed"


class ProjectStatus(StrEnum):
    ACTIVE = "active"
    PAUSED = "paused"
    ARCHIVED = "archived"


class RunStage(StrEnum):
    INTAKE = "INTAKE"
    PLANNING = "PLANNING"
    STAFFING = "STAFFING"
    DISPATCH = "DISPATCH"
    EXECUTING = "EXECUTING"
    VERIFYING = "VERIFYING"
    REWARDING = "REWARDING"
    LEARNING = "LEARNING"
    DONE = "DONE"


class RunStatus(StrEnum):
    RUNNING = "running"
    PAUSED = "paused"
    COMPLETED = "completed"
    FAILED = "failed"
    ABORTED = "aborted"
    PENDING_CONFIRMATION = "pending_confirmation"
    PENDING_CLARIFICATION = "pending_clarification"
    PAUSED_BUDGET = "paused_budget"


class TaskState(StrEnum):
    PENDING = "pending"
    BLOCKED = "blocked"
    READY = "ready"
    ASSIGNED = "assigned"
    RUNNING = "running"
    VERIFYING = "verifying"
    COMPLETED = "completed"
    FAILED = "failed"
    ABORTED = "aborted"
    ESCALATED = "escalated"

    @property
    def terminal(self) -> bool:
        return self in (TaskState.COMPLETED, TaskState.FAILED, TaskState.ABORTED)


class JobState(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    SUSPENDED = "suspended"
    DONE = "done"
    FAILED = "failed"
    CANCELLED = "cancelled"


class Verdict(StrEnum):
    PASS = "pass"
    PASS_WITH_NOTES = "pass_with_notes"
    FAIL = "fail"
    INCONCLUSIVE = "inconclusive"


class VerifyMethod(StrEnum):
    DETERMINISTIC = "deterministic"
    CONTRACT = "contract"
    EVALUATOR = "evaluator"
    PEER = "peer"
    HUMAN = "human"


class RewardRole(StrEnum):
    PRODUCER = "producer"
    LEAD = "lead"
    HEAD = "head"
    VERIFIER = "verifier"
    ORCHESTRATOR = "orchestrator"


class PolicyOutcome(StrEnum):
    ALLOW = "allow"
    DENY = "deny"
    REQUIRE_APPROVAL = "require_approval"


class Capability(StrEnum):
    """Capabilities are the unit of tool grants (docs/04 §4, docs/08 §4)."""

    BRAIN_READ = "brain.read"
    BRAIN_WRITE = "brain.write"
    COMMS_ASK = "comms.ask"
    COMMS_ESCALATE = "comms.escalate"
    COMMS_REQUEST_DECISION = "comms.request_decision"
    BOARD_WRITE = "board.write"
    NET_SEARCH = "net.search"
    NET_FETCH = "net.fetch"
    NET_POST = "net.post"
    FS_WORKSPACE = "fs.workspace"
    FS_DELETE = "fs.delete"
    SHELL_SANDBOX = "shell.sandbox"
    CODE_PYTHON = "code.python"
    GIT_LOCAL = "git.local"
    GIT_PUSH = "git.push"
    DATA_SQL = "data.sql"
    ARTIFACT_PUBLISH = "artifact.publish"
    BUDGET_REQUEST = "budget.request"
    ORG_HIRE = "org.hire"
    ORG_FIRE = "org.fire"
    COUNCIL_CONVENE = "council.convene"
    DECISION_BIND = "decision.bind"
    HUMAN_APPROVE = "human.approve"


class DecisionKind(StrEnum):
    ONE_WAY = "one_way"
    TWO_WAY = "two_way"


class EventSeverity(StrEnum):
    DEBUG = "debug"
    INFO = "info"
    NOTICE = "notice"
    WARNING = "warning"
    ERROR = "error"
    CRITICAL = "critical"


class BrainScope(StrEnum):
    PROJECT = "project"
    DEPARTMENT = "department"
    AGENT = "agent"


class BrainKind(StrEnum):
    FACT = "fact"
    PROCEDURE = "procedure"
    DECISION = "decision"
    ARTIFACT_REF = "artifact_ref"
    LESSON = "lesson"
    GLOSSARY = "glossary"


class Trust(StrEnum):
    INTERNAL = "internal"
    VERIFIED = "verified"
    UNVERIFIED = "unverified"
    UNTRUSTED_EXTERNAL = "untrusted_external"


class Effort(StrEnum):
    S = "S"
    M = "M"
    L = "L"
    XL = "XL"

    @property
    def weight(self) -> float:
        return {"S": 1.0, "M": 1.6, "L": 2.6, "XL": 4.0}[self.value]


class CouncilStatus(StrEnum):
    OPEN = "open"
    DECIDING = "deciding"
    CLOSED = "closed"


class ApprovalState(StrEnum):
    PENDING = "pending"
    GRANTED = "granted"
    DENIED = "denied"
    EXPIRED = "expired"
