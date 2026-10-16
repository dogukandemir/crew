/**
 * The council, as the floor sees it.
 *
 * A council is the one form of work that is genuinely a MEETING: a panel of
 * agents gathered to decide something together (docs/02 §4). The floor reads it
 * straight off the event log, `council.convened` opens a sitting, members are
 * announced by their own `council.position` events, and a `decision.recorded`
 * afterwards closes it, because the log is where that truth already lives. No
 * second store, nothing to keep in sync.
 *
 * Membership from `council.position` and not from `select_panel`'s return value
 * on purpose: positions are events, and events are what the frontend actually
 * receives. The panel is whoever actually spoke.
 */
import type { EventRow } from '../api/types';

export interface LiveCouncil {
  id: string;
  question: string;
  /** The panel, sorted, seat order around the table comes from this array. */
  members: string[];
  since: number;
}

/**
 * How long a sitting can stay silent before the floor lets it go.
 *
 * A council that stopped speaking minutes ago is not a meeting any more, whatever
 * the log says, and it is the second net: it closes a sitting whose decision
 * event never arrived, which is exactly what a dev mock with re-stamped events
 * will do.
 */
const SILENCE_MS = 150_000;

const payloadOf = (e: EventRow): Record<string, unknown> =>
  e.payload && typeof e.payload === 'object' ? (e.payload as Record<string, unknown>) : {};

const tsOf = (e: EventRow): number => Date.parse(e.ts) || 0;

export function liveCouncil(events: readonly EventRow[], now: number): LiveCouncil | null {
  let started: EventRow | undefined;
  for (const e of events) {
    if (e.type !== 'council.convened') continue;
    if (!started || tsOf(e) > tsOf(started)) started = e;
  }
  if (!started) return null;

  const opening = payloadOf(started);
  const id = String(opening.session_id ?? '');
  if (!id) return null;
  const began = tsOf(started);

  // The convenor sits too, the orchestrator at the head of the table.
  const members = new Set<string>();
  if (started.agent_id) members.add(started.agent_id);

  let last = began;
  for (const e of events) {
    if (e.type === 'council.position') {
      const p = payloadOf(e);
      if (String(p.session_id ?? '') !== id) continue;
      const who = e.agent_id ?? (typeof p.agent_id === 'string' ? p.agent_id : null);
      if (who) members.add(who);
      last = Math.max(last, tsOf(e));
    }
    // A decision binds the sitting it followed. The event carries no session id,
    // so the rule is: a decision recorded at or after this council opened, in a
    // project whose log is the only log, is this council's.
    if (e.type === 'decision.recorded' && tsOf(e) >= began) return null;
  }

  if (members.size === 0) return null;
  if (now - last > SILENCE_MS) return null;
  return {
    id,
    question: String(opening.question ?? 'council'),
    members: [...members].sort(),
    since: began,
  };
}
