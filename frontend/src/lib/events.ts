/**
 * Pure event-log reducer for the firehose (docs/09 §2.8, docs/11 §3).
 *
 * The socket hands raw frames here; this module owns:
 *  - dedupe by `seq` (a reconnect replays `since_seq`, so duplicates are normal),
 *  - monotonic ordering (seq ascending),
 *  - a bounded window (drop the oldest, count what was dropped),
 *  - gap notices ("N events skipped", never lie),
 *  - client-side filtering for the Events panel.
 */
import type {
  EventFilters,
  EventQuery,
  EventRow,
  Severity,
  WsFrame,
  WsGap,
} from '../api/types';

export const DEFAULT_EVENT_CAP = 5000;
const MAX_GAP_NOTICES = 20;

export const SEVERITY_RANK: Record<Severity, number> = {
  debug: 0,
  info: 1,
  notice: 2,
  warning: 3,
  error: 4,
  critical: 5,
};

export interface EventLogState {
  /** Ascending by `seq`. */
  items: EventRow[];
  /** Highest `seq` observed, the resume cursor (docs/11 §3). */
  maxSeq: number;
  gaps: WsGap[];
  /** Events evicted from the in-memory window. */
  dropped: number;
  /** Server-reported truncation of an oversized frame. */
  truncated: boolean;
}

export function emptyEventLog(): EventLogState {
  return { items: [], maxSeq: 0, gaps: [], dropped: 0, truncated: false };
}

function isUsableEvent(e: unknown): e is EventRow {
  return (
    !!e &&
    typeof e === 'object' &&
    typeof (e as EventRow).seq === 'number' &&
    (e as EventRow).seq > 0
  );
}

/**
 * Merge a batch of events into the log. Returns the same object identity when
 * nothing changed (so React/zustand subscribers do not re-render on replay).
 */
export function ingestEvents(
  state: EventLogState,
  incoming: EventRow[] | null | undefined,
  cap: number = DEFAULT_EVENT_CAP,
): EventLogState {
  if (!incoming || incoming.length === 0) return state;

  const bySeq = new Map<number, EventRow>();
  for (const e of state.items) bySeq.set(e.seq, e);

  let added = 0;
  let maxSeq = state.maxSeq;
  let truncated = state.truncated;

  for (const e of incoming) {
    if (!isUsableEvent(e)) continue;
    if (!bySeq.has(e.seq)) added += 1;
    bySeq.set(e.seq, e);
    if (e.seq > maxSeq) maxSeq = e.seq;
    if (e.truncated) truncated = true;
  }

  if (added === 0 && maxSeq === state.maxSeq && truncated === state.truncated) {
    return state;
  }

  const items = Array.from(bySeq.values()).sort((a, b) => a.seq - b.seq);
  let dropped = state.dropped;
  let window = items;
  if (items.length > cap) {
    const overflow = items.length - cap;
    dropped += overflow;
    window = items.slice(overflow);
  }

  return { items: window, maxSeq, gaps: state.gaps, dropped, truncated };
}

export function recordGap(state: EventLogState, gap: WsGap): EventLogState {
  const gaps = [...state.gaps, gap].slice(-MAX_GAP_NOTICES);
  return { ...state, gaps };
}

export function dismissGaps(state: EventLogState): EventLogState {
  if (state.gaps.length === 0) return state;
  return { ...state, gaps: [] };
}

/** The `seq` a fresh socket should resume from (docs/11 §3). */
export function resumeSeq(state: EventLogState): number {
  return state.maxSeq;
}

/** Pull events out of any server frame that carries them. */
export function eventsFromFrame(frame: WsFrame): EventRow[] {
  if (frame.type === 'event') return [frame.event].filter(isUsableEvent);
  if (frame.type === 'events') return (frame.events ?? []).filter(isUsableEvent);
  return [];
}

/** "task.completed" → "task". */
export function namespaceOf(type: string): string {
  if (!type) return '';
  const idx = type.indexOf('.');
  return idx === -1 ? type : type.slice(0, idx);
}

export function severityAtLeast(severity: Severity, min: Severity): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[min];
}

/** Client-side firehose filter (docs/09 §2.8). */
export function filterEventRows(items: EventRow[], query: EventQuery = {}): EventRow[] {
  const q = query.q?.trim().toLowerCase();
  const need = query.severity ? SEVERITY_RANK[query.severity] : 0;
  const hasFilter =
    !!q || !!query.namespace || !!query.severity || !!query.agent_id || !!query.task_id || !!query.since;
  if (!hasFilter) return items;

  return items.filter((e) => {
    if (query.namespace && namespaceOf(e.type) !== query.namespace) return false;
    if (query.severity && SEVERITY_RANK[e.severity] < need) return false;
    if (query.agent_id && e.agent_id !== query.agent_id) return false;
    if (query.task_id && e.task_id !== query.task_id) return false;
    if (query.since && e.ts < query.since) return false;
    if (q) {
      const hay = `${e.type} ${e.title} ${e.summary ?? ''} ${e.actor ?? ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/** Server-side subscribe filters, narrowed from a client query (docs/11 §3). */
export function toServerFilters(query: EventQuery): EventFilters {
  const filters: EventFilters = {};
  if (query.namespace) filters.types = [`${query.namespace}.*`];
  if (query.severity) filters.severity_min = query.severity;
  if (query.agent_id || query.task_id) {
    filters.scope = {
      agent_id: query.agent_id ?? null,
      task_id: query.task_id ?? null,
    };
  }
  return filters;
}
