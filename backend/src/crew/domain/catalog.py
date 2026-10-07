"""Static catalogs: grade privileges, role templates, skill catalog (docs/04, docs/05 §5)."""

from __future__ import annotations

from dataclasses import dataclass, field

from crew.domain.enums import Autonomy, Capability, Grade, ModelTier, Role

# ── grade → privileges (docs/05 §5 "consequence table") ──────────────────────────────
# These numbers are the *defaults*; per-project overrides are allowed but the capability
# ceiling is a hard policy (docs/08 §4), never a prompt suggestion.

GRADE_LIMITS: dict[Grade, dict] = {
    Grade.TRAINEE:   {"tier": ModelTier.FAST,      "spend_run_usd": 0.10, "spend_day_usd": 0.50,  "tokens_step": 2_000,  "autonomy": Autonomy.SUPERVISED},
    Grade.JUNIOR:    {"tier": ModelTier.FAST,      "spend_run_usd": 0.50, "spend_day_usd": 2.00,  "tokens_step": 4_000,  "autonomy": Autonomy.SUPERVISED},
    Grade.MID:       {"tier": ModelTier.STANDARD,  "spend_run_usd": 1.50, "spend_day_usd": 6.00,  "tokens_step": 8_000,  "autonomy": Autonomy.BOUNDED},
    Grade.SENIOR:    {"tier": ModelTier.REASONING, "spend_run_usd": 5.00, "spend_day_usd": 20.00, "tokens_step": 16_000, "autonomy": Autonomy.BOUNDED},
    Grade.PRINCIPAL: {"tier": ModelTier.REASONING, "spend_run_usd": 15.00, "spend_day_usd": 60.00, "tokens_step": 32_000, "autonomy": Autonomy.AUTONOMOUS},
    Grade.CHIEF:     {"tier": ModelTier.REASONING, "spend_run_usd": 40.00, "spend_day_usd": 120.00, "tokens_step": 64_000, "autonomy": Autonomy.AUTONOMOUS},
}

# Capabilities a grade may *ever* hold. Grants are intersected with role grants.
GRADE_CAPABILITY_CEILING: dict[Grade, set[Capability]] = {
    Grade.TRAINEE: {Capability.BRAIN_READ, Capability.BRAIN_WRITE, Capability.COMMS_ASK,
                    Capability.COMMS_ESCALATE, Capability.ARTIFACT_PUBLISH, Capability.HUMAN_APPROVE},
    Grade.JUNIOR: {Capability.BRAIN_READ, Capability.BRAIN_WRITE, Capability.COMMS_ASK,
                   Capability.COMMS_ESCALATE, Capability.ARTIFACT_PUBLISH, Capability.HUMAN_APPROVE,
                   Capability.NET_SEARCH, Capability.NET_FETCH, Capability.FS_WORKSPACE,
                   Capability.CODE_PYTHON, Capability.DATA_SQL},
    Grade.MID: {Capability.BRAIN_READ, Capability.BRAIN_WRITE, Capability.COMMS_ASK,
                Capability.COMMS_ESCALATE, Capability.ARTIFACT_PUBLISH, Capability.HUMAN_APPROVE,
                Capability.NET_SEARCH, Capability.NET_FETCH, Capability.FS_WORKSPACE,
                Capability.CODE_PYTHON, Capability.DATA_SQL, Capability.GIT_LOCAL,
                Capability.SHELL_SANDBOX, Capability.BUDGET_REQUEST, Capability.COUNCIL_CONVENE},
    Grade.SENIOR: {Capability.BRAIN_READ, Capability.BRAIN_WRITE, Capability.COMMS_ASK,
                   Capability.COMMS_ESCALATE, Capability.ARTIFACT_PUBLISH, Capability.HUMAN_APPROVE,
                   Capability.NET_SEARCH, Capability.NET_FETCH, Capability.NET_POST,
                   Capability.FS_WORKSPACE, Capability.FS_DELETE, Capability.CODE_PYTHON,
                   Capability.DATA_SQL, Capability.GIT_LOCAL, Capability.SHELL_SANDBOX,
                   Capability.BUDGET_REQUEST, Capability.COUNCIL_CONVENE, Capability.ORG_HIRE,
                   Capability.ORG_FIRE, Capability.COMMS_REQUEST_DECISION},
    Grade.PRINCIPAL: set(Capability),  # everything except what is decider-only
    Grade.CHIEF: set(Capability),
}
# decider-only capability, never in a role grant by accident
for _g in (Grade.TRAINEE, Grade.JUNIOR, Grade.MID, Grade.SENIOR):
    GRADE_CAPABILITY_CEILING[_g] = GRADE_CAPABILITY_CEILING[_g] - {Capability.DECISION_BIND}
GRADE_CAPABILITY_CEILING[Grade.PRINCIPAL] = set(Capability) - {Capability.GIT_PUSH}
GRADE_CAPABILITY_CEILING[Grade.CHIEF] = set(Capability)

# Capabilities that always need a human approval, regardless of grade (docs/08 §4).
ALWAYS_APPROVAL: set[Capability] = {Capability.NET_POST, Capability.FS_DELETE, Capability.GIT_PUSH}

# Roles that must never be run on a cheap model (docs/04 §2).
MIN_TIER_FOR_ROLE: dict[Role, ModelTier] = {
    Role.ORCHESTRATOR: ModelTier.REASONING,
    Role.CTO: ModelTier.REASONING,
    Role.CMO: ModelTier.REASONING,
    Role.CPO: ModelTier.REASONING,
    Role.COO: ModelTier.REASONING,
    Role.DECIDER: ModelTier.REASONING,
    Role.CRITIC: ModelTier.REASONING,
    Role.ARCHITECT: ModelTier.REASONING,
    Role.HEAD: ModelTier.REASONING,
    Role.SPECIALIST: ModelTier.REASONING,
}


@dataclass(frozen=True)
class RoleTemplate:
    role: Role
    title: str
    mission: str
    base_grade: Grade
    default_skills: tuple[str, ...]
    method: str                      # operating procedure injected into the prompt (docs/04 §1.4)
    default_capabilities: frozenset[Capability]


def _t(role: Role, title: str, mission: str, grade: Grade, skills: tuple[str, ...], method: str,
       caps: tuple[Capability, ...]) -> RoleTemplate:
    return RoleTemplate(role, title, mission, grade, skills, method, frozenset(caps))


_COMMS = (Capability.BRAIN_READ, Capability.BRAIN_WRITE, Capability.COMMS_ASK,
          Capability.COMMS_ESCALATE, Capability.ARTIFACT_PUBLISH, Capability.HUMAN_APPROVE)

# The executive tier owns a function: hire/fire inside it, chair its councils, guard its
# budget envelope, and say the function's delivery truth upward (ADR 0008).
_FUNCTION_CHIEF_CAPS = _COMMS + (Capability.ORG_HIRE, Capability.ORG_FIRE, Capability.COUNCIL_CONVENE,
                                 Capability.COMMS_REQUEST_DECISION, Capability.BUDGET_REQUEST,
                                 Capability.NET_SEARCH, Capability.NET_FETCH)

ROLE_TEMPLATES: dict[Role, RoleTemplate] = {
    Role.ORCHESTRATOR: _t(
        Role.ORCHESTRATOR, "Orchestrator",
        "Own the project goal: decompose it, staff it, allocate budget, arbitrate and settle rewards.",
        Grade.PRINCIPAL, ("strategic-planning", "decomposition", "resource-allocation", "delegation"),
        "Break goals into workstreams with explicit acceptance criteria. Hire only for real capability "
        "gaps. Never do IC work yourself; delegate. Escalate to the user for one-way-door decisions.",
        _COMMS + (Capability.ORG_HIRE, Capability.ORG_FIRE, Capability.COUNCIL_CONVENE,
                  Capability.COMMS_REQUEST_DECISION, Capability.BUDGET_REQUEST, Capability.BRAIN_READ),
    ),
    Role.CTO: _t(
        Role.CTO, "Chief Technology Officer",
        "Own the technology function across every engineering, data and security unit: standards, "
        "technical councils and delivery truth.",
        Grade.CHIEF, ("domain-leadership", "system-design", "tradeoff-analysis"),
        "Chair the function's decisions instead of doing its work. Keep the technical standard in the "
        "function brain, arbitrate between departments before the orchestrator has to, and report the "
        "function's delivery truth upward — never a rosier version of it.",
        _FUNCTION_CHIEF_CAPS,
    ),
    Role.CMO: _t(
        Role.CMO, "Chief Marketing Officer",
        "Own the market function: positioning, demand and the quality of market evidence across the "
        "research and business units.",
        Grade.CHIEF, ("domain-leadership", "market-research", "evidence-synthesis"),
        "Chair the function's decisions instead of doing its work. Hold the market evidence to one "
        "standard across units, settle positioning conflicts between departments, and report the "
        "function's truth upward — including what the data refuses to support.",
        _FUNCTION_CHIEF_CAPS,
    ),
    Role.CPO: _t(
        Role.CPO, "Chief Product Officer",
        "Own the product function: what gets built and why, across the design, content and media units.",
        Grade.CHIEF, ("domain-leadership", "interface-design", "planning"),
        "Chair the function's decisions instead of doing its work. Keep one product story across units, "
        "kill ideas with a reason before they cost a quarter, and report what the function actually "
        "shipped versus what it said it would.",
        _FUNCTION_CHIEF_CAPS,
    ),
    Role.COO: _t(
        Role.COO, "Chief Operating Officer",
        "Own operations: delivery discipline, support and process across the operations-facing units.",
        Grade.CHIEF, ("domain-leadership", "quality-assurance", "planning"),
        "Chair the function's decisions instead of doing its work. Own the operating cadence, keep "
        "quality and support from trading blame, and report the function's bottlenecks upward with "
        "names and numbers.",
        _FUNCTION_CHIEF_CAPS,
    ),
    Role.HEAD: _t(
        Role.HEAD, "Department Head",
        "Own the department mission: staff it, set the quality bar, deliver its share of the plan.",
        Grade.SENIOR, ("domain-leadership", "staffing", "quality-assurance", "planning"),
        "Plan within your mission, staff squads from your roster, review before hand-off, and report "
        "blockers upward immediately rather than working around them.",
        _COMMS + (Capability.ORG_HIRE, Capability.ORG_FIRE, Capability.COUNCIL_CONVENE,
                  Capability.BUDGET_REQUEST, Capability.NET_SEARCH, Capability.NET_FETCH),
    ),
    Role.LEAD: _t(
        Role.LEAD, "Squad Lead",
        "Sequence the squad's work, unblock it, integrate its deliverables.",
        Grade.SENIOR, ("task-sequencing", "integration", "coordination"),
        "Keep the critical path moving; assign the smallest sufficient agent to each task; "
        "integrate and sanity-check outputs before marking complete.",
        _COMMS + (Capability.FS_WORKSPACE, Capability.COUNCIL_CONVENE, Capability.BUDGET_REQUEST),
    ),
    Role.WORKER: _t(
        Role.WORKER, "Specialist Worker",
        "Execute assigned tasks to their acceptance criteria.",
        Grade.JUNIOR, (),
        "Do exactly the assigned task. State assumptions explicitly. Cite evidence for claims. "
        "If blocked, escalate with what you tried instead of guessing.",
        _COMMS + (Capability.NET_SEARCH, Capability.NET_FETCH, Capability.FS_WORKSPACE,
                  Capability.CODE_PYTHON),
    ),
    Role.SPECIALIST: _t(
        Role.SPECIALIST, "Specialist",
        "Provide deep domain expertise on demand.",
        Grade.SENIOR, (),
        "Answer within your domain with concrete, actionable specifics. Flag uncertainty "
        "explicitly; refuse to opine outside your domain.",
        _COMMS + (Capability.NET_SEARCH, Capability.NET_FETCH, Capability.COUNCIL_CONVENE),
    ),
    Role.CRITIC: _t(
        Role.CRITIC, "Critic",
        "Attack deliverables and proposals; find what is wrong before reality does.",
        Grade.SENIOR, ("critical-review", "risk-analysis", "verification"),
        "Attack the strongest version of the work, not a straw man. Every objection must name a "
        "concrete failure mode and a cheaper alternative. Approve only what you cannot break.",
        _COMMS + (Capability.NET_SEARCH, Capability.NET_FETCH),
    ),
    Role.ANALYST: _t(
        Role.ANALYST, "Analyst",
        "Gather, verify and synthesise evidence.",
        Grade.MID, ("web-research", "evidence-synthesis", "source-evaluation"),
        "Source before claim. Prefer primary sources. Record provenance for everything you assert "
        "so a verifier can re-check it.",
        _COMMS + (Capability.NET_SEARCH, Capability.NET_FETCH, Capability.DATA_SQL),
    ),
    Role.ARCHITECT: _t(
        Role.ARCHITECT, "Architect",
        "Design structure and interfaces; own technical coherence.",
        Grade.PRINCIPAL, ("system-design", "interface-design", "tradeoff-analysis"),
        "Produce designs as decision-ready options with explicit trade-offs and a recommendation. "
        "Name the interfaces and the invariants they must hold.",
        _COMMS + (Capability.COUNCIL_CONVENE, Capability.FS_WORKSPACE, Capability.GIT_LOCAL),
    ),
    Role.DECIDER: _t(
        Role.DECIDER, "Chief Decision Officer",
        "Issue the binding ruling on contested decisions.",
        Grade.PRINCIPAL, ("decision-making", "tradeoff-analysis", "risk-analysis"),
        "Weigh the evidence pack, not the loudest voice. Preserve dissent, state your confidence, "
        "and say what evidence would change your mind.",
        _COMMS + (Capability.DECISION_BIND, Capability.COMMS_REQUEST_DECISION),
    ),
    Role.EVALUATOR: _t(
        Role.EVALUATOR, "Evaluator",
        "Independently judge deliverables against acceptance criteria.",
        Grade.SENIOR, ("verification", "rubric-scoring", "critical-review"),
        "Judge the artifact, never the narrative. Score each criterion individually with cited "
        "evidence; 'unverified' is an acceptable and honest verdict.",
        _COMMS + (Capability.NET_SEARCH, Capability.NET_FETCH, Capability.DATA_SQL),
    ),
    Role.LIBRARIAN: _t(
        Role.LIBRARIAN, "Librarian",
        "Curate the brains: extract lessons, promote insight, prune what misleads.",
        Grade.MID, ("knowledge-management", "summarisation", "evidence-synthesis"),
        "Only generalise what has at least two independent instances or a Head's endorsement. "
        "Never delete: supersede with a reason and preserve provenance.",
        _COMMS + (Capability.BRAIN_WRITE,),
    ),
}


# ── skill catalog (docs/04 §3) ────────────────────────────────────────────────────────
@dataclass(frozen=True)
class Skill:
    id: str
    label: str
    category: str
    description: str
    typical_tools: tuple[Capability, ...] = ()
    related: tuple[str, ...] = ()


def _s(_id: str, label: str, category: str, desc: str, tools: tuple[Capability, ...] = (), rel: tuple[str, ...] = ()) -> Skill:
    return Skill(_id, label, category, desc, tools, rel)


SKILLS: tuple[Skill, ...] = (
    # strategy / org
    _s("strategic-planning", "Strategic planning", "org", "Turn goals into workstreams and acceptance criteria."),
    _s("decomposition", "Decomposition", "org", "Split work into independently verifiable tasks."),
    _s("resource-allocation", "Resource allocation", "org", "Decide who does what, with what budget."),
    _s("delegation", "Delegation", "org", "Brief others well enough to hand work off."),
    _s("staffing", "Staffing", "org", "Match capabilities to work; hire and lay off."),
    _s("domain-leadership", "Domain leadership", "org", "Set direction and quality bar in a function."),
    _s("task-sequencing", "Task sequencing", "org", "Order work to keep the critical path moving."),
    _s("coordination", "Coordination", "org", "Keep a team unblocked and in sync."),
    _s("integration", "Integration", "org", "Combine parts into a coherent whole."),
    _s("quality-assurance", "Quality assurance", "org", "Enforce the bar before hand-off."),
    _s("planning", "Planning", "org", "Make plans that survive contact with reality."),
    # research / analysis
    _s("web-research", "Web research", "research", "Find and navigate sources on the web.",
       (Capability.NET_SEARCH, Capability.NET_FETCH), ("source-evaluation",)),
    _s("source-evaluation", "Source evaluation", "research", "Judge source credibility and recency."),
    _s("evidence-synthesis", "Evidence synthesis", "research", "Combine sources into defensible conclusions."),
    _s("data-analysis", "Data analysis", "data", "Answer questions from data.", (Capability.DATA_SQL, Capability.CODE_PYTHON)),
    _s("sql-design", "SQL design", "data", "Design schemas and queries.", (Capability.DATA_SQL,)),
    _s("statistics", "Statistics", "data", "Quantify uncertainty correctly.", (Capability.CODE_PYTHON,)),
    _s("market-research", "Market research", "research", "Competitors, pricing, demand.",
       (Capability.NET_SEARCH, Capability.NET_FETCH), ("web-research",)),
    # engineering
    _s("python", "Python", "engineering", "Write correct, idiomatic Python.", (Capability.CODE_PYTHON, Capability.SHELL_SANDBOX)),
    _s("typescript", "TypeScript", "engineering", "Write typed front-end/Node code.", (Capability.SHELL_SANDBOX,)),
    _s("csharp", "C# / .NET", "engineering", "Write .NET services.", (Capability.SHELL_SANDBOX,)),
    _s("api-design", "API design", "engineering", "Design REST/WS contracts that survive change.", (), ("system-design",)),
    _s("system-design", "System design", "engineering", "Decompose systems; name interfaces and invariants.",
       (), ("api-design", "tradeoff-analysis")),
    _s("interface-design", "Interface design", "engineering", "Define module boundaries.", (), ("system-design",)),
    _s("tradeoff-analysis", "Trade-off analysis", "engineering", "Compare options on explicit criteria."),
    _s("unit-testing", "Unit testing", "engineering", "Prove behaviour with fast tests.", (Capability.CODE_PYTHON,)),
    _s("integration-testing", "Integration testing", "engineering", "Prove components work together.", (Capability.CODE_PYTHON,)),
    _s("debugging", "Debugging", "engineering", "Find root causes, not symptoms.", (Capability.CODE_PYTHON, Capability.SHELL_SANDBOX)),
    _s("refactoring", "Refactoring", "engineering", "Improve structure without changing behaviour.", (Capability.CODE_PYTHON,)),
    _s("devops", "DevOps", "engineering", "Build, ship and operate services.", (Capability.SHELL_SANDBOX, Capability.GIT_LOCAL)),
    _s("git-workflow", "Git workflow", "engineering", "Branch, commit, review, merge.", (Capability.GIT_LOCAL,)),
    _s("docker", "Containers", "engineering", "Package and run services reproducibly.", (Capability.SHELL_SANDBOX,)),
    _s("database-design", "Database design", "data", "Model persistent state.", (), ("sql-design",)),
    _s("performance-optimisation", "Performance", "engineering", "Make things measurably faster.", (Capability.CODE_PYTHON,)),
    # security
    _s("security-review", "Security review", "security", "Find exploitable weaknesses."),
    _s("threat-modelling", "Threat modelling", "security", "Enumerate adversaries and vectors."),
    _s("prompt-injection-defense", "Injection defence", "security", "Recognise and resist injected instructions."),
    _s("secrets-management", "Secrets management", "security", "Handle credentials without leaking them."),
    _s("compliance", "Compliance", "security", "Meet legal/policy constraints."),
    # creative / content
    _s("copywriting", "Copywriting", "content", "Write persuasive, clear prose."),
    _s("technical-writing", "Technical writing", "content", "Explain precisely for a specific reader."),
    _s("editing", "Editing", "content", "Cut, tighten, correct."),
    _s("storytelling", "Storytelling", "content", "Structure narrative for attention and retention."),
    _s("seo", "SEO", "content", "Rank in search without gaming it."),
    _s("video-editing", "Video editing", "media", "Cut and assemble video.", (Capability.FS_WORKSPACE,)),
    _s("image-generation", "Image generation", "media", "Produce or edit images."),
    _s("audio-production", "Audio production", "media", "Voice, music, mixing."),
    _s("design-thinking", "Design thinking", "design", "Frame problems from the user's side."),
    _s("ui-design", "UI design", "design", "Interface layout, hierarchy, states."),
    _s("ux-research", "UX research", "design", "Learn what users actually need."),
    # business
    _s("pricing", "Pricing", "business", "Set and defend price points."),
    _s("monetisation", "Monetisation", "business", "Turn attention/product into revenue."),
    _s("unit-economics", "Unit economics", "business", "Cost per output vs. revenue per output."),
    _s("growth", "Growth", "business", "Acquire and retain users."),
    _s("legal-review", "Legal review", "business", "Spot legal exposure."),
    _s("finance-modelling", "Finance modelling", "business", "Numbers that hold up."),
    # meta
    _s("verification", "Verification", "meta", "Prove or refute a claim from artifacts."),
    _s("rubric-scoring", "Rubric scoring", "meta", "Score consistently against criteria."),
    _s("critical-review", "Critical review", "meta", "Find the flaw in any plan or output."),
    _s("risk-analysis", "Risk analysis", "meta", "Identify what can go wrong and how badly."),
    _s("knowledge-management", "Knowledge management", "meta", "Keep memory accurate and useful."),
    _s("summarisation", "Summarisation", "meta", "Compress without losing the load-bearing parts."),
    _s("decision-making", "Decision making", "meta", "Choose under uncertainty and own it."),
)

SKILLS_BY_ID: dict[str, Skill] = {s.id: s for s in SKILLS}


def skills_for_keywords(text: str, limit: int = 8) -> list[str]:
    """Cheap keyword→skill mapping used as a fallback when no LLM is available."""
    low = text.lower()
    hits: list[str] = []
    for s in SKILLS:
        if s.id.replace("-", " ") in low or s.label.lower() in low:
            hits.append(s.id)
    if not hits:
        # token overlap heuristic
        words = {w for w in low.replace(",", " ").split() if len(w) > 3}
        scored = [(len(words & set(s.id.replace("-", " ").split())), s.id) for s in SKILLS]
        hits = [sid for score, sid in sorted(scored, reverse=True) if score > 0][:limit]
    return hits[:limit] or ["web-research", "critical-review"]


@dataclass
class RoleSpec:
    """A concrete, hireable role instance produced by the HiringService (docs/02 §5)."""

    title: str
    role: Role
    mission: str
    grade: Grade
    skills: list[str] = field(default_factory=list)
    capabilities: list[Capability] = field(default_factory=list)
    department_hint: str | None = None
    rationale: str = ""

    @classmethod
    def from_template(cls, role: Role, *, grade: Grade | None = None, skills: list[str] | None = None,
                      mission: str | None = None, title: str | None = None, rationale: str = "") -> RoleSpec:
        t = ROLE_TEMPLATES[role]
        caps = sorted(t.default_capabilities, key=lambda c: c.value)
        return cls(
            title=title or t.title,
            role=role,
            mission=mission or t.mission,
            grade=grade or t.base_grade,
            skills=list(skills if skills is not None else t.default_skills),
            capabilities=list(caps),
            rationale=rationale,
        )
