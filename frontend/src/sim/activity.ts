/**
 * Activity derivation (pure) — the bridge from the domain to the animation.
 *
 * Everything the office does is a projection of real state: the agent's own
 * state, the state of the task it currently holds, and the live event stream.
 * Nothing here is random or time-based theatre; if a character is typing, it is
 * because that agent holds a running task.
 *
 * Precedence is deliberate and documented in ACTIVITY_ORDER: something wrong
 * (blocked, escalated) outranks something active, which outranks something idle.
 */
import type { EventRow, OrgNode, Task, TaskState } from '../api/types';

export type ActivityKind =
  | 'offline'
  | 'blocked'
  | 'waiting'
  | 'celebrating'
  | 'walking'
  | 'tool'
  | 'talking'
  | 'typing'
  | 'thinking'
  | 'idle';

/** Higher = wins. Used for the bubble/pose when several signals are live. */
export const ACTIVITY_ORDER: ActivityKind[] = [
  'offline',
  'blocked',
  'waiting',
  'celebrating',
  'walking',
  'tool',
  'talking',
  'typing',
  'thinking',
  'idle',
];

export type WalkTarget = 'desk' | 'commons' | 'orchestrator' | 'peer';

export interface Activity {
  kind: ActivityKind;
  /** Emoji shown in the bubble above the character, if any. */
  bubble?: string;
  /** Human explanation, surfaced on the desk tooltip. */
  note: string;
  /** Where the character should be standing. */
  where: WalkTarget;
  /**
   * The colleague this activity is aimed at, when the harness named one. The
   * floor plan resolves the name to a desk, which is what lets a character walk
   * over and ask a question instead of miming it alone.
   */
  peerName?: string;
  /** ms timestamp of the event that drove this, when there was one. */
  at?: number;
}

/**
 * The colleague a message was addressed to.
 *
 * The harness writes `ask_colleague` as `agent.message` with a payload of
 * `{to, text, direction}`; a report goes `{direction: 'up'}`. Reading the name
 * out of the payload is what grounds "Ada walks over to Bo" in a real tool call
 * rather than in decoration. An unusable name is ignored, not guessed at.
 */
function peerNameOf(event: EventRow): string | undefined {
  const payload = event.payload;
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, unknown>;

  const to = record.to;
  if (typeof to === 'string') {
    const name = to.trim();
    if (name.length > 0 && name.length <= 40) return name;
  }
  // A message reported upward goes to whoever runs the floor.
  if (record.direction === 'up') return 'manager';
  return undefined;
}

/** Recency windows (ms). */
export const WINDOWS = {
  tool: 6_000,
  talk: 6_000,
  thought: 10_000,
  done: 7_000,
  approval: 90_000,
} as const;

const ACTIVE_TASK_STATES: TaskState[] = ['assigned', 'running', 'ready'];

export function currentTaskFor(agentId: string, tasks: Task[]): Task | undefined {
  const mine = tasks.filter((t) => t.assignee_agent_id === agentId);
  if (mine.length === 0) return undefined;
  const rank = (t: Task): number => {
    switch (t.state) {
      case 'escalated':
        return 0;
      case 'verifying':
        return 1;
      case 'blocked':
        return 2;
      case 'failed':
        return 3;
      case 'running':
        return 4;
      case 'assigned':
        return 5;
      case 'ready':
        return 6;
      case 'pending':
        return 7;
      default:
        return 8;
    }
  };
  return [...mine].sort((a, b) => rank(a) - rank(b))[0];
}

function newest(
  events: EventRow[],
  match: (e: EventRow) => boolean,
  withinMs: number,
  now: number,
): EventRow | undefined {
  let best: EventRow | undefined;
  let bestTs = -Infinity;
  for (const e of events) {
    if (!match(e)) continue;
    const ts = Date.parse(e.ts);
    if (Number.isNaN(ts) || now - ts > withinMs || ts < 0) continue;
    if (ts > bestTs) {
      bestTs = ts;
      best = e;
    }
  }
  return best;
}

export interface ActivityInput {
  agent: OrgNode;
  task?: Task;
  /** This agent's events (any order). */
  events: EventRow[];
  now: number;
  /** True while the character is still walking in from the door. */
  arriving?: boolean;
}

export function deriveActivity({ agent, task, events, now, arriving }: ActivityInput): Activity {
  const state = agent.state ?? 'idle';

  if (state === 'archived' || state === 'suspended') {
    return { kind: 'offline', note: state === 'archived' ? 'archived' : 'suspended', where: 'desk' };
  }

  if (arriving) {
    return { kind: 'walking', bubble: '👋', note: 'just hired — walking to their desk', where: 'desk' };
  }

  // 1. Something is wrong and a human/orchestrator may be needed.
  if (task?.state === 'escalated') {
    return {
      kind: 'blocked',
      bubble: '❗',
      note: task.escalation_reason
        ? `escalated: ${task.escalation_reason}`
        : `escalated: ${task.title}`,
      where: 'orchestrator',
      at: task.ended_at ? Date.parse(task.ended_at) : undefined,
    };
  }
  if (task?.state === 'blocked') {
    return { kind: 'blocked', bubble: '⏳', note: `blocked on dependencies: ${task.title}`, where: 'desk' };
  }
  if (task?.state === 'failed') {
    return { kind: 'blocked', bubble: '⛔', note: `task failed: ${task.title}`, where: 'desk' };
  }

  const approval = newest(events, (e) => e.type === 'policy.approval.requested', WINDOWS.approval, now);
  if (approval) {
    return {
      kind: 'waiting',
      bubble: '⚑',
      note: 'waiting on an approval',
      where: 'desk',
      at: Date.parse(approval.ts),
    };
  }

  // 2. Something just finished — visible payoff.
  const done = newest(events, (e) => e.type === 'task.completed', WINDOWS.done, now);
  if (done) {
    return { kind: 'celebrating', bubble: '✅', note: `finished: ${done.title}`, where: 'desk', at: Date.parse(done.ts) };
  }

  // 3. Verification happens at the shared table, not at the desk.
  if (task?.state === 'verifying') {
    return { kind: 'walking', note: `at the review table: ${task.title}`, where: 'commons' };
  }

  // 4. What is the agent doing right this second?
  const tool = newest(events, (e) => e.type.startsWith('agent.tool.call'), WINDOWS.tool, now);
  if (tool) {
    return { kind: 'tool', bubble: '🔧', note: `${tool.title}`, where: 'desk', at: Date.parse(tool.ts) };
  }

  const talk = newest(
    events,
    (e) => e.type === 'agent.message' || e.type === 'agent.delegated' || e.type === 'agent.escalated',
    WINDOWS.talk,
    now,
  );
  if (talk) {
    const peerName = peerNameOf(talk);
    return {
      kind: 'talking',
      bubble: '💬',
      note: talk.title,
      where: peerName ? 'peer' : 'desk',
      peerName,
      at: Date.parse(talk.ts),
    };
  }

  if (task && ACTIVE_TASK_STATES.includes(task.state)) {
    return { kind: 'typing', note: `working on: ${task.title}`, where: 'desk' };
  }

  const thought = newest(events, (e) => e.type === 'agent.thought', WINDOWS.thought, now);
  if (thought) {
    return { kind: 'thinking', bubble: '💭', note: thought.title, where: 'desk', at: Date.parse(thought.ts) };
  }

  return { kind: 'idle', note: 'idle — no work assigned', where: 'desk' };
}

/** Status-dot colour key for a room nameplate / department filter chip. */
export function activityTone(kind: ActivityKind): 'ok' | 'busy' | 'warning' | 'danger' | 'idle' {
  switch (kind) {
    case 'blocked':
    case 'waiting':
      return 'danger';
    case 'tool':
    case 'talking':
    case 'typing':
    case 'walking':
      return 'busy';
    case 'celebrating':
      return 'ok';
    case 'offline':
      return 'idle';
    default:
      return 'idle';
  }
}
