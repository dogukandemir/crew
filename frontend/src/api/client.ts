/**
 * The single typed API client (docs/11-api-and-event-contract.md).
 *
 * Everything the UI knows about the backend goes through here. No component
 * calls `fetch` directly. Errors are normalized into `ApiError` carrying the
 * RFC 7807 problem document and a stable `code` the UI can branch on
 * (docs/11 §4).
 */
import type {
  Agent,
  Approval,
  Artifact,
  AuditEntry,
  Brain,
  BrainEntry,
  BrainSearchHit,
  CommandAck,
  CommandBody,
  CouncilSession,
  CurrentUser,
  Decision,
  Department,
  EgressView,
  EventFilters,
  EventRow,
  Health,
  LeaderboardEntry,
  Paged,
  Problem,
  Project,
  ProjectMetrics,
  ProjectSettings,
  RewardEvent,
  RewardTransition,
  Run,
  Squad,
  SystemStatus,
  Task,
  ToolCatalogueEntry,
  UnitRef,
} from './types';
import { CONTRACT_VERSION } from './types';

export const API_BASE: string = (
  import.meta.env.VITE_API_BASE ?? 'http://127.0.0.1:8787'
).replace(/\/+$/, '');

const AUTH_TOKEN: string | undefined = import.meta.env.VITE_AUTH_TOKEN || undefined;

/** Derived WS origin for `ws://…/ws/projects/{id}` (docs/11 §3). */
export function wsBase(): string {
  return API_BASE.replace(/^http/, 'ws');
}

/** `https://crew/errors/budget-exceeded` → `budget_exceeded` (docs/11 §4). */
export function problemCode(problem: Problem | null | undefined): string {
  if (!problem) return 'unknown_error';
  const raw = problem.type ?? '';
  const last = raw.split('/').pop() ?? '';
  const code = last.trim().replace(/-/g, '_') || `http_${problem.status}`;
  return code;
}

export class ApiError extends Error {
  readonly status: number;
  readonly problem: Problem | null;
  readonly code: string;
  /** True when the request never reached the server (offline, DNS, CORS). */
  readonly network: boolean;

  constructor(opts: {
    status: number;
    problem: Problem | null;
    code: string;
    message: string;
    network?: boolean;
  }) {
    super(opts.message);
    this.name = 'ApiError';
    this.status = opts.status;
    this.problem = opts.problem;
    this.code = opts.code;
    this.network = opts.network ?? false;
  }
}

export function isBackendUnreachable(err: unknown): boolean {
  return err instanceof ApiError && (err.network || err.status === 0 || err.status >= 502);
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | null | undefined>;
  signal?: AbortSignal;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = new URL(API_BASE + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, query, signal } = opts;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (AUTH_TOKEN) headers['Authorization'] = `Bearer ${AUTH_TOKEN}`;

  let res: Response;
  try {
    res = await fetch(buildUrl(path, query), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
      // REST auth is `Authorization: Bearer` (docs/11) — sending credentials on
      // every call would make the browser reject responses from a backend whose
      // CORS origin is not an exact echo, so we keep the default `same-origin`.
      credentials: 'same-origin',
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError({
      status: 0,
      problem: null,
      code: 'backend_unreachable',
      message: `Cannot reach the Crew backend at ${API_BASE}.`,
      network: true,
    });
  }

  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!res.ok) {
    const problem =
      parsed && typeof parsed === 'object' && 'title' in (parsed as object)
        ? (parsed as Problem)
        : null;
    const code = problemCode(problem) || `http_${res.status}`;
    throw new ApiError({
      status: res.status,
      problem,
      code: problem ? code : `http_${res.status}`,
      message: problem?.title ?? `${method} ${path} failed with ${res.status}`,
    });
  }

  const parsed0 = parsed as unknown;

  // Contract drift guard (docs/11 §5: "additive fields are allowed any time",
  // so the UI must not assume a field is *present* either). A paged endpoint
  // that omits the envelope tail would otherwise surface as "undefined" in
  // counters; fill the tail in from what the response actually carries.
  if (parsed0 && typeof parsed0 === 'object' && Array.isArray((parsed0 as Paged<unknown>).items)) {
    const page = parsed0 as Paged<unknown>;
    if (typeof page.total !== 'number') page.total = page.items.length;
    if (page.next_cursor === undefined) page.next_cursor = null;
  }

  return parsed0 as T;
}

/** Assemble the write-op body from docs/11 §1 (command envelope). */
function cmdBody(payload?: unknown, reason?: string): CommandBody {
  const body: CommandBody = {};
  if (payload !== undefined) body.payload = payload;
  if (reason) body.reason = reason;
  return body;
}

export const api = {
  /** Absolute path for a UnitRef link (docs/09 §3 "one-click depth"). */
  unitPath(ref: UnitRef): string {
    switch (ref.kind) {
      case 'agent':
        return `agents/${ref.id}`;
      case 'task':
        return `tasks/${ref.id}`;
      case 'department':
      case 'squad':
        return `org/${ref.id}`;
      default:
        return `overview`;
    }
  },

  // ── System & auth ──────────────────────────────────────────────────────────
  health: () => request<Health>('/api/health'),
  systemStatus: () => request<SystemStatus>('/api/system/status'),
  killAll: (confirm: boolean) =>
    request<CommandAck>('/api/system/kill', { method: 'POST', body: { confirm } }),
  login: (email: string, password: string) =>
    request<{ access_token: string; refresh_token?: string }>('/api/auth/login', {
      method: 'POST',
      body: { email, password },
    }),
  refresh: () => request<{ access_token: string }>('/api/auth/refresh', { method: 'POST' }),
  logout: () => request<null>('/api/auth/logout', { method: 'POST' }),
  me: () => request<CurrentUser>('/api/auth/me'),

  // ── Projects ───────────────────────────────────────────────────────────────
  listProjects: () => request<Paged<Project>>('/api/projects'),
  createProject: (input: {
    name: string;
    goal: string;
    budget_cap_usd?: number;
    settings?: Partial<ProjectSettings>;
  }) => request<Project>('/api/projects', { method: 'POST', body: input }),
  getProject: (id: string) => request<Project>(`/api/projects/${id}`),
  patchProject: (id: string, patch: Partial<Project> & { settings?: Partial<ProjectSettings> }) =>
    request<Project>(`/api/projects/${id}`, { method: 'PATCH', body: patch }),
  pauseProject: (id: string) =>
    request<CommandAck>(`/api/projects/${id}/pause`, { method: 'POST', body: cmdBody() }),
  resumeProject: (id: string) =>
    request<CommandAck>(`/api/projects/${id}/resume`, { method: 'POST', body: cmdBody() }),
  killProject: (id: string, reason?: string) =>
    request<CommandAck>(`/api/projects/${id}/kill`, {
      method: 'POST',
      body: cmdBody(undefined, reason),
    }),
  archiveProject: (id: string) =>
    request<CommandAck>(`/api/projects/${id}`, { method: 'DELETE' }),
  projectMetrics: (id: string) => request<ProjectMetrics>(`/api/projects/${id}/metrics`),
  projectReport: (id: string) => request<Record<string, unknown>>(`/api/projects/${id}/report`),

  // ── Runs & goals ───────────────────────────────────────────────────────────
  startRun: (id: string, input: { goal: string; mode: 'interactive' | 'autonomous' }) =>
    request<CommandAck>(`/api/projects/${id}/runs`, { method: 'POST', body: input }),
  listRuns: (id: string) => request<Paged<Run>>(`/api/projects/${id}/runs`),
  getRun: (runId: string) => request<Run>(`/api/runs/${runId}`),
  answerRun: (runId: string, answers: unknown) =>
    request<CommandAck>(`/api/runs/${runId}/answer`, { method: 'POST', body: cmdBody(answers) }),
  steerRun: (runId: string, text: string) =>
    request<CommandAck>(`/api/runs/${runId}/steer`, { method: 'POST', body: cmdBody({ text }) }),
  cancelRun: (runId: string) =>
    request<CommandAck>(`/api/runs/${runId}/cancel`, { method: 'POST', body: cmdBody() }),

  // ── Org ────────────────────────────────────────────────────────────────────
  getOrg: (id: string) => request<import('./types').OrgTree>(`/api/projects/${id}/org`),
  createDepartment: (
    id: string,
    input: { name: string; mission?: string; budget_usd?: number },
  ) => request<Department>(`/api/projects/${id}/departments`, { method: 'POST', body: input }),
  getDepartment: (deptId: string) => request<Department>(`/api/departments/${deptId}`),
  patchDepartment: (
    deptId: string,
    patch: { mission?: string; budget_usd?: number; capabilities?: string[] },
  ) => request<Department>(`/api/departments/${deptId}`, { method: 'PATCH', body: patch }),
  archiveDepartment: (deptId: string) =>
    request<CommandAck>(`/api/departments/${deptId}/archive`, { method: 'POST', body: cmdBody() }),
  createSquad: (
    deptId: string,
    input: { name: string; mission?: string; lead_agent_id?: string },
  ) => request<Squad>(`/api/departments/${deptId}/squads`, { method: 'POST', body: input }),
  closeSquad: (squadId: string, reassignTo?: string) =>
    request<CommandAck>(`/api/squads/${squadId}/close`, {
      method: 'POST',
      body: cmdBody({ reassign_to: reassignTo }),
    }),
  hireAgent: (
    id: string,
    input: { role: string; grade?: number; department_id?: string; skills?: string[]; mission?: string },
  ) => request<Agent>(`/api/projects/${id}/agents`, { method: 'POST', body: input }),
  getAgent: (agentId: string) => request<Agent>(`/api/agents/${agentId}`),
  patchAgent: (agentId: string, patch: Partial<Agent>) =>
    request<Agent>(`/api/agents/${agentId}`, { method: 'PATCH', body: patch }),
  promoteAgent: (agentId: string, reason: string) =>
    request<CommandAck>(`/api/agents/${agentId}/promote`, {
      method: 'POST',
      body: cmdBody(undefined, reason),
    }),
  demoteAgent: (agentId: string, reason: string) =>
    request<CommandAck>(`/api/agents/${agentId}/demote`, {
      method: 'POST',
      body: cmdBody(undefined, reason),
    }),
  probationAgent: (agentId: string, reason: string) =>
    request<CommandAck>(`/api/agents/${agentId}/probation`, {
      method: 'POST',
      body: cmdBody(undefined, reason),
    }),
  fireAgent: (agentId: string, reason?: string) =>
    request<CommandAck>(`/api/agents/${agentId}/fire`, {
      method: 'POST',
      body: cmdBody(undefined, reason),
    }),
  messageAgent: (agentId: string, text: string) =>
    request<CommandAck>(`/api/agents/${agentId}/message`, { method: 'POST', body: cmdBody({ text }) }),

  // ── Tasks ──────────────────────────────────────────────────────────────────
  listTasks: (
    id: string,
    filter?: { state?: string; dept?: string; squad?: string; agent?: string; run?: string },
  ) => request<Paged<Task>>(`/api/projects/${id}/tasks`, { query: filter }),
  createTask: (
    id: string,
    input: {
      title: string;
      description?: string;
      acceptance_criteria?: string[];
      required_skills?: string[];
      depends_on?: string[];
    },
  ) => request<Task>(`/api/projects/${id}/tasks`, { method: 'POST', body: input }),
  getTask: (taskId: string) => request<Task>(`/api/tasks/${taskId}`),
  retryTask: (taskId: string, reason?: string) =>
    request<CommandAck>(`/api/tasks/${taskId}/retry`, { method: 'POST', body: cmdBody(undefined, reason) }),
  cancelTask: (taskId: string, reason?: string) =>
    request<CommandAck>(`/api/tasks/${taskId}/cancel`, { method: 'POST', body: cmdBody(undefined, reason) }),
  reassignTask: (taskId: string, agentId: string, reason?: string) =>
    request<CommandAck>(`/api/tasks/${taskId}/reassign`, {
      method: 'POST',
      body: cmdBody({ assignee_agent_id: agentId }, reason),
    }),
  escalateTask: (taskId: string, reason: string) =>
    request<CommandAck>(`/api/tasks/${taskId}/escalate`, { method: 'POST', body: cmdBody(undefined, reason) }),
  listTaskArtifacts: (taskId: string) =>
    request<Paged<Artifact>>(`/api/tasks/${taskId}/artifacts`),

  // ── Council & decisions ────────────────────────────────────────────────────
  conveneCouncil: (
    id: string,
    input: { question: string; options: string[]; criteria?: string[]; panel?: string[] },
  ) => request<CouncilSession>(`/api/projects/${id}/councils`, { method: 'POST', body: input }),
  getCouncil: (councilId: string) => request<CouncilSession>(`/api/councils/${councilId}`),
  councilRound: (councilId: string) =>
    request<CommandAck>(`/api/councils/${councilId}/round`, { method: 'POST', body: cmdBody() }),
  councilDecide: (councilId: string) =>
    request<CommandAck>(`/api/councils/${councilId}/decide`, { method: 'POST', body: cmdBody() }),
  listDecisions: (projectId: string) =>
    request<Paged<Decision>>('/api/decisions', { query: { project_id: projectId } }),
  overrideDecision: (decisionId: string, reason: string) =>
    request<CommandAck>(`/api/decisions/${decisionId}/override`, {
      method: 'POST',
      body: cmdBody(undefined, reason),
    }),

  // ── Brains ─────────────────────────────────────────────────────────────────
  listBrains: (id: string) => request<Brain[]>(`/api/projects/${id}/brains`),
  listBrainEntries: (
    brainId: string,
    filter?: { kind?: string; tag?: string; q?: string; cursor?: string },
  ) => request<Paged<BrainEntry>>(`/api/brains/${brainId}/entries`, { query: filter }),
  createBrainEntry: (
    brainId: string,
    input: { kind: string; title: string; body?: string; tags?: string[] },
  ) => request<BrainEntry>(`/api/brains/${brainId}/entries`, { method: 'POST', body: input }),
  getEntry: (entryId: string) =>
    request<BrainEntry & { links?: unknown[]; history?: unknown[] }>(`/api/entries/${entryId}`),
  supersedeEntry: (entryId: string, newEntryId: string, reason: string) =>
    request<CommandAck>(`/api/entries/${entryId}/supersede`, {
      method: 'POST',
      body: cmdBody({ new_entry_id: newEntryId, reason }),
    }),
  promoteEntry: (entryId: string, toBrainId: string, rationale: string) =>
    request<CommandAck>(`/api/entries/${entryId}/promote`, {
      method: 'POST',
      body: cmdBody({ to_brain_id: toBrainId, rationale }),
    }),
  searchBrains: (id: string, query: string) =>
    request<{ hits: BrainSearchHit[] }>(`/api/projects/${id}/brains/search`, {
      method: 'POST',
      body: { query },
    }),

  // ── Rewards ────────────────────────────────────────────────────────────────
  leaderboard: (id: string) =>
    request<Paged<LeaderboardEntry>>(`/api/projects/${id}/leaderboard`),
  agentRewards: (agentId: string) =>
    request<Paged<RewardEvent>>(`/api/agents/${agentId}/rewards`),
  rewardTransitions: (id: string) =>
    request<Paged<RewardTransition>>(`/api/projects/${id}/reward-transitions`),
  updateRewardWeights: (id: string, weights: Record<string, number>) =>
    request<CommandAck>(`/api/projects/${id}/reward-weights`, { method: 'PUT', body: weights }),
  rewardPreview: (id: string, weights: Record<string, number>) =>
    request<ProjectMetrics>(`/api/projects/${id}/reward-preview`, {
      method: 'POST',
      body: { weights },
    }),

  // ── Events & observability ─────────────────────────────────────────────────
  listEvents: (
    id: string,
    filter?: {
      from_seq?: number;
      to_seq?: number;
      type?: string;
      scope?: string;
      severity?: string;
      limit?: number;
      cursor?: string;
    },
  ) => request<Paged<EventRow>>(`/api/projects/${id}/events`, { query: filter }),
  getTrace: (traceId: string) => request<unknown>(`/api/traces/${traceId}`),
  getRunDossier: (runId: string) => request<unknown>(`/api/runs/${runId}/dossier`),
  getAgentContext: (projectId: string, agentId: string) =>
    request<unknown>(`/api/projects/${projectId}/agents/${agentId}/context`),

  // ── Approvals, policy, admin ───────────────────────────────────────────────
  listApprovals: (id: string, state?: string) =>
    request<Paged<Approval>>(`/api/projects/${id}/approvals`, { query: { state } }),
  grantApproval: (approvalId: string, reason?: string, ttlMinutes?: number) =>
    request<CommandAck>(`/api/approvals/${approvalId}/grant`, {
      method: 'POST',
      body: cmdBody({ reason, ttl_minutes: ttlMinutes }),
    }),
  denyApproval: (approvalId: string, reason?: string) =>
    request<CommandAck>(`/api/approvals/${approvalId}/deny`, {
      method: 'POST',
      body: cmdBody({ reason }),
    }),
  listAudit: (id: string, cursor?: string) =>
    request<Paged<AuditEntry>>(`/api/projects/${id}/audit`, { query: { cursor } }),
  verifyAudit: () =>
    request<{ ok: boolean; broken_at?: number }>('/api/system/audit/verify', { method: 'POST' }),
  listSecrets: () => request<Paged<{ id: string; name: string; scope_kind?: string }>>('/api/secrets'),
  createSecret: (name: string, value: string, scope: string) =>
    request<{ id: string; name: string }>('/api/secrets', {
      method: 'POST',
      body: { name, value, scope },
    }),
  rotateSecret: (secretId: string, value: string) =>
    request<null>(`/api/secrets/${secretId}/rotate`, { method: 'POST', body: { value } }),
  listTools: () => request<Paged<ToolCatalogueEntry>>('/api/tools'),
  getEgress: (id: string) => request<EgressView>(`/api/projects/${id}/egress`),
  backup: () => request<{ path: string }>('/api/system/backup', { method: 'POST' }),
  restore: (path: string) =>
    request<null>('/api/system/restore', { method: 'POST', body: { path } }),

  // ── WS support ─────────────────────────────────────────────────────────────
  wsUrl(projectId: string, sinceSeq: number): string {
    const url = new URL(`${wsBase()}/ws/projects/${projectId}`);
    url.searchParams.set('since_seq', String(sinceSeq ?? 0));
    if (AUTH_TOKEN) url.searchParams.set('token', AUTH_TOKEN);
    return url.toString();
  },

  contract: CONTRACT_VERSION,
} as const;

export type Api = typeof api;

/** Convenience export so callers can `import { api, ApiError } from '@/api/client'`. */
export default api;
