/**
 * Hand-written types mirroring the frozen contract in `docs/11-api-and-event-contract.md`
 * and the data model in `docs/10-data-model.md`.
 *
 * Conventions (docs/11 §1):
 *  - ids are uuid7 strings
 *  - timestamps are UTC ISO-8601 (ms precision)
 *  - money is micro-USD integers: 1_240_000 === $1.24
 *
 * Contract version: 1. Additive fields are allowed at any time; the UI must not
 * assume a field is absent just because it is not listed here.
 */

export const CONTRACT_VERSION = 1;

// ─── Common ──────────────────────────────────────────────────────────────────

export type UnitKind =
  | 'project'
  | 'department'
  | 'squad'
  | 'agent'
  | 'task'
  | 'run'
  | 'decision'
  | 'council'
  | 'brain'
  | 'artifact';

/** Used for links everywhere (docs/11 §1). */
export interface UnitRef {
  kind: UnitKind;
  id: string;
  name: string;
}

/** Paged envelope (docs/11 §1). */
export interface Paged<T> {
  items: T[];
  next_cursor: string | null;
  total: number;
}

/** RFC 7807 problem document (docs/11 §1). */
export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  trace_id?: string;
  /** Additive: some errors carry structured extras (e.g. required_usd). */
  [key: string]: unknown;
}

/** Payload accepted by write endpoints (docs/11 §1, "Command envelope"). */
export interface CommandBody<P = unknown> {
  payload?: P;
  reason?: string;
  idempotency_key?: string;
}

export interface CommandAck {
  accepted: boolean;
  event_seq: number;
  unit: UnitRef;
}

// ─── System & auth ───────────────────────────────────────────────────────────

export interface Health {
  status: string;
  version: string;
  contract: number;
}

// ─── First-run onboarding (ADR 0013) ─────────────────────────────────────────

export interface OnboardingProvider {
  id: string;
  label: string;
  kind: 'key' | 'local';
  placeholder: string;
  hint: string;
  console: string;
  configured: boolean;
}

export interface OnboardingState {
  needed: boolean;
  /** The provider of the standard tier, when the key path can accept it. */
  provider: string | null;
  model: string;
  offline_llm: boolean;
  vault: string;
  /** The picker's roster (ADR 0013 revision): key providers + local Ollama. */
  providers?: OnboardingProvider[];
}

export interface OnboardingKeyResult {
  provider: string;
  verified: boolean;
  detail: string;
  tiers?: Record<string, string>;
}

export interface CurrentUser {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'operator' | 'viewer';
}

// ─── Projects, runs, settings ────────────────────────────────────────────────

export type ProjectStatus = 'active' | 'paused' | 'archived' | 'failed';

/** INTAKE → PLANNING → STAFFING → EXECUTING → VERIFYING → REWARDING → DONE (docs/03). */
export type Stage =
  | 'INTAKE'
  | 'PLANNING'
  | 'STAFFING'
  | 'EXECUTING'
  | 'VERIFYING'
  | 'REWARDING'
  | 'DONE'
  | 'FAILED';

export const STAGES: Stage[] = [
  'INTAKE',
  'PLANNING',
  'STAFFING',
  'EXECUTING',
  'VERIFYING',
  'REWARDING',
  'DONE',
];

export type BoardItemKind = 'epic' | 'feature' | 'story' | 'task' | 'bug';
export type BoardColumnKey = 'backlog' | 'ready' | 'in_progress' | 'review' | 'done' | 'blocked';

/** One card on the backlog board (ADR 0010). Promoted items derive `state` from their task. */
export interface BoardItem {
  id: string;
  kind: BoardItemKind;
  title: string;
  body?: string;
  state: BoardColumnKey;
  own_state?: string;
  severity: 'low' | 'normal' | 'high' | 'critical';
  priority: number;
  parent_id: string | null;
  department_id?: string | null;
  squad_id?: string | null;
  created_by: string;
  creator_name?: string | null;
  assignee_agent_id?: string | null;
  assignee_name?: string | null;
  task_id?: string | null;
  task_state?: string | null;
  attempts?: number;
  helpers: string[];
  acceptance?: string[];
  tags?: string[];
  created_at?: string;
  updated_at?: string;
}

export interface BoardColumn {
  key: BoardColumnKey;
  title: string;
  items: BoardItem[];
}

export interface Board {
  project_id: string;
  columns: BoardColumn[];
  filter: { department_id: string | null; squad_id: string | null };
}

export type CompanyVerdictName = 'on_track' | 'at_risk' | 'no_activity' | 'stop';

/** One director on the company's board (ADR 0011). */
export interface HqBoardSeat {
  id: string;
  name: string;
  role: 'chair' | 'board_member';
  grade?: number;
}

/** A C-level executive and the function they speak for. */
export interface HqExecutive {
  id: string;
  name: string;
  role: string;
  title: string;
  function: string;
}

export interface HqTeam {
  id: string;
  name: string;
  head_name?: string | null;
  agents: number;
}

/** A member project as the HQ floor shows it: verdict, books and its teams. */
export interface HqProject {
  id: string;
  name: string;
  status: string;
  verdict: CompanyVerdictName;
  directive?: string;
  spend_ratio: number;
  completed: number;
  failed: number;
  open_tasks: number;
  teams: HqTeam[];
  last_at?: string | null;
}

export interface HqActivity {
  type: string;
  at: string;
  project_id?: string;
  text?: string;
  summary?: string | null;
  payload?: Record<string, unknown>;
}

/** The whole company for one floor (GET /companies/{id}/hq). */
export interface Hq {
  company: {
    id: string;
    name: string;
    mission?: string;
    budget_usd: number;
    spend_usd: number;
    spend_ratio: number;
  };
  ceo: { id: string; name: string; grade?: number } | null;
  executives: HqExecutive[];
  board: HqBoardSeat[];
  projects: HqProject[];
  activity: HqActivity[];
}

export interface CompanyVerdict {
  project_id: string;
  name: string;
  verdict: CompanyVerdictName;
  directive: string;
  basis: Record<string, unknown>;
}

export interface CompanyLastReview {
  ts: string;
  projects: number;
  verdicts: CompanyVerdict[];
  counts?: Partial<Record<CompanyVerdictName, number>>;
}

/** The company layer (ADR 0009): a headquarters project holding the portfolio. */
export interface Company {
  id: string;
  name: string;
  mission: string;
  status: string;
  budget_usd: number;
  spend_usd: number;
  spend_ratio: number;
  ceo: { id: string; name: string; grade?: number } | null;
  roster: { id: string; name: string; role: string; grade: number }[];
  projects: { id: string; name: string; status: string; spend_ratio: number }[];
  last_review: CompanyLastReview | null;
}

export interface CompanyReview {
  company_id: string;
  verdicts: CompanyVerdict[];
  counts: Record<string, number>;
  review_event_id?: string;
}

export interface Project {
  id: string;
  name: string;
  slug?: string;
  goal: string;
  description?: string;
  status: ProjectStatus;
  stage: Stage;
  /** Additive (ADR 0009): companies are kind='company'; member projects carry company_id. */
  kind?: 'project' | 'company';
  company_id?: string | null;
  created_at: string;
  updated_at?: string;
  archived_at?: string | null;
  owner_id?: string;
  budget_cap_micros: number;
  spend_micros: number;
  currency?: string;
  tags?: string[];
  /** Additive: the detail endpoint returns the 1:1 settings row (docs/10 §2). */
  settings?: ProjectSettings;
  /** Additive rollups the list endpoint returns for the tab strip. */
  org_size?: number;
  tasks_done?: number;
  tasks_total?: number;
  success_rate?: number;
  pending_approvals?: number;
  badge?: number;
}

export interface ProjectSettings {
  project_id?: string;
  autonomous_intake: boolean;
  require_goal_confirmation: boolean;
  require_human_verification: boolean;
  max_agents: number;
  max_departments: number;
  max_senior_ratio: number;
  auto_hire: boolean;
  layoff_idle_days: number;
  budget_warning_pct?: number;
  reward_weights?: Record<string, number>;
  council_policy?: Record<string, unknown>;
  egress_allow?: string[];
  tool_policy?: Record<string, unknown>;
  model_tiers?: Record<string, string>;
  retention?: Record<string, unknown>;
  notify?: Record<string, unknown>;
}

export type RunStatus = 'running' | 'paused' | 'completed' | 'failed' | 'aborted';

export interface Run {
  id: string;
  project_id: string;
  goal: string;
  goal_brief?: Record<string, unknown>;
  plan?: Record<string, unknown>;
  stage: Stage;
  status: RunStatus;
  started_at: string;
  ended_at?: string | null;
  trace_id?: string;
  cost_micros: number;
  tokens_in: number;
  tokens_out: number;
  triggered_by?: 'user' | 'schedule';
  report?: RunReport | null;
}

export interface RunReport {
  deliverables?: UnitRef[];
  verification_summary?: string;
  lessons?: string[];
  cost_micros?: number;
  [key: string]: unknown;
}

export interface ProjectMetrics {
  scope?: Record<string, string | null>;
  cost_usd?: number;
  cost_micros?: number;
  tokens_in?: number;
  tokens_out?: number;
  tokens?: number;
  task_success_rate?: number;
  success_rate?: number;
  rework_rate?: number;
  escalation_rate?: number;
  avg_task_latency_ms?: number;
  tool_error_rate?: number;
  verification_confidence?: number;
  hire_rate?: number;
  layoff_rate?: number;
  injection_attempts_blocked?: number;
  tasks_total?: number;
  tasks_done?: number;
  [key: string]: unknown;
}

// ─── Org ─────────────────────────────────────────────────────────────────────

export type UnitState =
  | 'idle'
  | 'busy'
  | 'probation'
  | 'suspended'
  | 'archived'
  | 'active';

export type Grade = 0 | 1 | 2 | 3 | 4 | 5;

export interface OrgNode {
  id: string;
  kind: 'project' | 'department' | 'squad' | 'agent';
  name: string;
  role?: string;
  grade?: Grade;
  state?: UnitState;
  score?: number;
  score_confidence?: number;
  cost_micros?: number;
  spend_micros?: number;
  budget_envelope_micros?: number;
  open_tasks?: number;
  tasks_total?: number;
  tasks_done?: number;
  success_rate?: number;
  department_id?: string | null;
  squad_id?: string | null;
  manager_id?: string | null;
  head_agent_id?: string | null;
  lead_agent_id?: string | null;
  mission?: string;
  children?: OrgNode[];
}

export interface OrgTree {
  root: OrgNode;
  /** Additive: flat list of every unit, for lookups. */
  nodes?: OrgNode[];
  generated_at?: string;
}

export type AgentState = 'idle' | 'busy' | 'probation' | 'suspended' | 'archived';
export type Autonomy = 'supervised' | 'bounded' | 'autonomous';

export interface Agent {
  id: string;
  project_id: string;
  department_id: string | null;
  squad_id?: string | null;
  manager_id?: string | null;
  name: string;
  role: string;
  grade: Grade;
  state: AgentState;
  mission?: string;
  responsibilities?: string[];
  decision_style?: string;
  autonomy?: Autonomy;
  model_tier?: string;
  model_id?: string;
  token_cap_per_step?: number;
  spend_cap_per_run_micros?: number;
  spend_cap_per_day_micros?: number;
  spend_today_micros?: number;
  score: number;
  score_confidence?: number;
  evidence_count?: number;
  success_rate?: number;
  tasks_done?: number;
  tasks_failed?: number;
  penalty_count?: number;
  /** Growth (ADR 0014): company-specific familiarity 0..1, and days since the hire. */
  company_knowledge?: number;
  tenure_days?: number;
  prompt_version?: string;
  brain_id?: string | null;
  tools?: string[];
  approval_rules?: Record<string, unknown>;
  created_at?: string;
  archived_at?: string | null;
  last_active_at?: string | null;
  skills?: AgentSkill[];
  /** Additive trend series the API may attach for sparklines. */
  score_trend?: number[];
}

export interface AgentSkill {
  skill_id: string;
  label?: string;
  proficiency: number;
  evidence_count?: number;
  last_used_at?: string | null;
}

export interface Department {
  id: string;
  project_id: string;
  name: string;
  mission?: string;
  status: 'active' | 'idle' | 'archived';
  head_agent_id?: string | null;
  budget_envelope_micros?: number;
  spend_micros?: number;
  capabilities?: string[];
  brain_id?: string | null;
  created_at?: string;
  archived_at?: string | null;
  roster?: Agent[];
  kpis?: ProjectMetrics;
}

export interface Squad {
  id: string;
  project_id: string;
  department_id: string;
  name: string;
  mission?: string;
  lead_agent_id?: string | null;
  status?: string;
  workstream?: string;
  created_at?: string;
  closed_at?: string | null;
}

// ─── Tasks ───────────────────────────────────────────────────────────────────

export type TaskState =
  | 'pending'
  | 'blocked'
  | 'ready'
  | 'assigned'
  | 'running'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'aborted'
  | 'escalated';

export type Effort = 'S' | 'M' | 'L' | 'XL';

export interface Task {
  id: string;
  run_id?: string | null;
  project_id: string;
  department_id?: string | null;
  squad_id?: string | null;
  parent_id?: string | null;
  title: string;
  description?: string;
  deliverable?: string;
  required_skills?: string[];
  acceptance_criteria?: string[];
  depends_on?: string[];
  output_contract?: Record<string, unknown>;
  effort?: Effort;
  priority?: number;
  state: TaskState;
  assignee_agent_id?: string | null;
  assignee_squad_id?: string | null;
  attempts?: number;
  cost_micros?: number;
  tokens_in?: number;
  tokens_out?: number;
  result_ref?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
  escalated_to?: string | null;
  escalation_reason?: string | null;
  // detail-only (GET /api/tasks/{id})
  verification?: VerificationResult | null;
  rewards?: RewardEvent[];
  artifacts?: Artifact[];
}

export interface Job {
  id: string;
  task_id: string;
  project_id: string;
  state: 'queued' | 'running' | 'suspended' | 'done' | 'failed' | 'cancelled';
  attempt?: number;
  worker?: string;
  heartbeat_at?: string | null;
  cancel_requested?: boolean;
  error_class?: string | null;
  error_message?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
}

export type Verdict = 'pass' | 'pass_with_notes' | 'fail' | 'inconclusive';

export interface VerificationResult {
  id: string;
  task_id: string;
  verdict: Verdict;
  method: 'deterministic' | 'contract' | 'evaluator' | 'peer' | 'human';
  checks?: Array<{ name: string; ok: boolean; detail?: string }>;
  rubric?: Record<string, unknown>;
  evidence?: unknown;
  confidence?: number;
  verifier_agent_id?: string | null;
  created_at: string;
}

export interface Artifact {
  id: string;
  project_id: string;
  task_id?: string | null;
  agent_id?: string | null;
  kind: 'file' | 'text' | 'json' | 'url' | 'image';
  path?: string;
  mime?: string;
  bytes?: number;
  sha256?: string;
  trust?: string;
  created_at: string;
  meta?: Record<string, unknown>;
}

// ─── Rewards ─────────────────────────────────────────────────────────────────

export interface RewardEvent {
  id: string;
  project_id: string;
  run_id?: string | null;
  task_id?: string | null;
  agent_id: string;
  role_in_task?: 'producer' | 'lead' | 'head' | 'verifier' | 'orchestrator';
  verdict?: string;
  components?: Record<string, number>;
  penalties?: Record<string, number>;
  reward: number;
  score_after?: number;
  grade_before?: Grade;
  grade_after?: Grade;
  created_at: string;
}

export interface LeaderboardEntry {
  rank?: number;
  agent_id: string;
  name: string;
  role?: string;
  grade?: Grade;
  score: number;
  score_confidence?: number;
  cost_micros?: number;
  success_rate?: number;
  tasks_done?: number;
  score_trend?: number[];
}

export interface RewardTransition {
  id: string;
  agent_id: string;
  agent_name?: string;
  from_grade?: Grade;
  to_grade?: Grade;
  kind: 'promotion' | 'probation' | 'demotion' | 'layoff' | 'hire';
  rule?: string;
  reason?: string;
  score_after?: number;
  created_at: string;
}

// ─── Events ──────────────────────────────────────────────────────────────────

export type Severity = 'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical';

export const SEVERITIES: Severity[] = [
  'debug',
  'info',
  'notice',
  'warning',
  'error',
  'critical',
];

export interface EventRow {
  id: string;
  project_id: string;
  seq: number;
  ts: string;
  type: string;
  severity: Severity;
  title: string;
  summary?: string;
  payload?: unknown;
  department_id?: string | null;
  squad_id?: string | null;
  agent_id?: string | null;
  task_id?: string | null;
  run_id?: string | null;
  job_id?: string | null;
  trace_id?: string | null;
  span_id?: string | null;
  parent_span_id?: string | null;
  actor?: string;
  cost_micros?: number;
  tokens_in?: number;
  tokens_out?: number;
  duration_ms?: number;
  /** Additive: set when the server had to truncate an oversized frame. */
  truncated?: boolean;
  ref?: string;
}

// ─── Brains ──────────────────────────────────────────────────────────────────

export interface Brain {
  id: string;
  project_id: string;
  scope: 'project' | 'department' | 'agent';
  owner_id?: string | null;
  created_at?: string;
  entry_count?: number;
  last_activity_at?: string | null;
  children?: Brain[];
}

export type EntryKind =
  | 'fact'
  | 'procedure'
  | 'decision'
  | 'artifact_ref'
  | 'lesson'
  | 'glossary';

export interface BrainEntry {
  id: string;
  brain_id: string;
  kind: EntryKind;
  title: string;
  body?: string;
  payload?: unknown;
  source?: { run_id?: string; task_id?: string; agent_id?: string; url?: string } | null;
  trust?: number;
  importance?: number;
  tags?: string[];
  skill_ids?: string[];
  created_at: string;
  last_used_at?: string | null;
  use_count?: number;
  decay_score?: number;
  superseded_by?: string | null;
  archived_at?: string | null;
  human_edited?: boolean;
}

export interface BrainSearchHit {
  entry: BrainEntry;
  score: number;
  breakdown?: Record<string, number>;
}

// ─── Council & decisions ─────────────────────────────────────────────────────

export interface CouncilPosition {
  id: string;
  session_id: string;
  round: number;
  agent_id: string;
  option_id: string;
  claim: string;
  reasoning?: string;
  evidence?: unknown;
  risks?: string[];
  confidence?: number;
  critique_of_position_id?: string | null;
}

export interface CouncilSession {
  id: string;
  project_id: string;
  task_id?: string | null;
  question: string;
  options?: Array<{ id: string; label: string; [k: string]: unknown }>;
  criteria?: string[];
  constraints?: unknown;
  status: 'open' | 'deciding' | 'closed';
  rounds: number;
  max_rounds?: number;
  convened_by?: string;
  convened_at: string;
  closed_at?: string | null;
  decision_id?: string | null;
  positions?: CouncilPosition[];
}

export interface Decision {
  id: string;
  project_id: string;
  session_id?: string | null;
  task_id?: string | null;
  question: string;
  chosen_option: string;
  rationale?: string;
  dissent?: unknown;
  confidence?: number;
  reversibility?: 'one_way' | 'two_way';
  follow_ups?: unknown;
  decider_agent_id?: string | null;
  created_at: string;
  overridden_by?: string | null;
  override_reason?: string | null;
}

// ─── Approvals, policy, admin ────────────────────────────────────────────────

export interface Approval {
  id: string;
  project_id: string;
  task_id?: string | null;
  agent_id?: string | null;
  capability: string;
  request?: Record<string, unknown>;
  state: 'pending' | 'granted' | 'denied' | 'expired';
  decided_by?: string | null;
  decided_at?: string | null;
  expires_at?: string | null;
  reason?: string | null;
  created_at?: string;
}

export interface AuditEntry {
  id: string;
  seq: number;
  ts: string;
  actor_kind: 'user' | 'agent' | 'system';
  actor_id: string;
  action: string;
  resource_kind?: string;
  resource_id?: string;
  outcome?: string;
  reason?: string | null;
  trace_id?: string | null;
  prev_hash?: string;
  hash?: string;
}

export interface EgressView {
  allow: string[];
  blocked?: Array<{ host: string; ts: string; agent_id?: string; reason?: string }>;
}

export interface ToolCatalogueEntry {
  name: string;
  capability?: string;
  enabled: boolean;
  description?: string;
}

// ─── WebSocket frames (docs/11 §3) ───────────────────────────────────────────

export interface WsHello {
  type: 'hello';
  project_id: string;
  seq_head: number;
  contract: number;
  server_time: string;
}

export interface WsEvent {
  type: 'event';
  seq: number;
  event: EventRow;
}

export interface WsEvents {
  type: 'events';
  events: EventRow[];
}

export interface WsGap {
  type: 'gap';
  from: number;
  to: number;
  reason: string;
}

export interface WsReplayComplete {
  type: 'replay.complete';
  up_to: number;
}

export interface WsStage {
  type: 'stage';
  run_id: string;
  stage: Stage;
  progress?: { done: number; total: number };
}

export interface WsMetrics {
  type: 'metrics';
  scope: Record<string, string | null>;
  metrics: ProjectMetrics;
}

export interface WsPong {
  type: 'pong';
  ts: number;
}

export interface WsError {
  type: 'error';
  code: string;
  detail?: string;
}

export type WsFrame =
  | WsHello
  | WsEvent
  | WsEvents
  | WsGap
  | WsReplayComplete
  | WsStage
  | WsMetrics
  | WsPong
  | WsError;

export interface WsSubscribe {
  action: 'subscribe';
  filters?: EventFilters;
  since_seq?: number;
}

export interface WsUnsubscribe {
  action: 'unsubscribe';
}

export interface WsPing {
  action: 'ping';
  ts: number;
}

export interface WsSteer {
  action: 'steer';
  target: UnitRef;
  text: string;
}

export type WsClientFrame = WsSubscribe | WsUnsubscribe | WsPing | WsSteer;

// ─── Filtering ───────────────────────────────────────────────────────────────

export interface EventFilters {
  scope?: {
    department_id?: string | null;
    squad_id?: string | null;
    agent_id?: string | null;
    task_id?: string | null;
  };
  types?: string[];
  severity_min?: Severity;
}

/** Client-side firehose filter (docs/09 §2.8). */
export interface EventQuery {
  q?: string;
  namespace?: string;
  severity?: Severity;
  agent_id?: string;
  task_id?: string;
  since?: string;
}

// ─── The command desk (ADR 0012) ─────────────────────────────────────────────

export interface CommandAction {
  kind: string;
  event_id?: string | null;
  ref?: string | null;
}

/** One turn in the desk's transcript, straight from the record. */
export interface CommandMessage {
  id: string;
  role: 'captain' | 'orchestrator';
  text: string;
  mode?: string | null;
  ok?: boolean | null;
  actions: CommandAction[];
  mentions: string[];
  at?: string | null;
}

export interface CommandReply {
  text: string;
  ok: boolean;
  mode: string;
  actions: CommandAction[];
}

export interface CommandPostResult {
  message_id?: string | null;
  reply_event_id?: string | null;
  reply: CommandReply;
}
