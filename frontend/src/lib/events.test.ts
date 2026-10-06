import { describe, expect, it } from 'vitest';
import type { EventRow, WsFrame } from '../api/types';
import {
  dismissGaps,
  emptyEventLog,
  eventsFromFrame,
  filterEventRows,
  ingestEvents,
  namespaceOf,
  recordGap,
  resumeSeq,
  severityAtLeast,
} from './events';

function ev(seq: number, over: Partial<EventRow> = {}): EventRow {
  return {
    id: `evt-${seq}`,
    project_id: 'p1',
    seq,
    ts: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
    type: 'task.created',
    severity: 'info',
    title: `event ${seq}`,
    ...over,
  };
}

describe('event reducer', () => {
  it('starts empty with a zero cursor', () => {
    const s = emptyEventLog();
    expect(s.items).toEqual([]);
    expect(s.maxSeq).toBe(0);
    expect(resumeSeq(s)).toBe(0);
  });

  it('keeps events ascending by seq regardless of arrival order', () => {
    const s = ingestEvents(emptyEventLog(), [ev(3), ev(1), ev(2)]);
    expect(s.items.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(s.maxSeq).toBe(3);
  });

  it('dedupes replayed events (reconnect with since_seq re-sends a tail)', () => {
    const first = ingestEvents(emptyEventLog(), [ev(1), ev(2)]);
    const second = ingestEvents(first, [ev(2), ev(3)]);
    expect(second.items.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(second.maxSeq).toBe(3);
  });

  it('returns the same object identity when nothing changed', () => {
    const first = ingestEvents(emptyEventLog(), [ev(1)]);
    const second = ingestEvents(first, [ev(1)]);
    expect(second).toBe(first);
  });

  it('ignores malformed rows instead of throwing', () => {
    const bad = [{ seq: 0 } as EventRow, undefined as unknown as EventRow, ev(7)];
    const s = ingestEvents(emptyEventLog(), bad);
    expect(s.items.map((e) => e.seq)).toEqual([7]);
    expect(s.maxSeq).toBe(7);
  });

  it('caps the window by dropping the oldest and counting the evictions', () => {
    const batch = [1, 2, 3, 4, 5].map((n) => ev(n));
    const s = ingestEvents(emptyEventLog(), batch, 3);
    expect(s.items.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(s.dropped).toBe(2);
    expect(s.maxSeq).toBe(5);
  });

  it('accumulates evictions across batches', () => {
    let s = ingestEvents(emptyEventLog(), [ev(1), ev(2), ev(3)], 3);
    s = ingestEvents(s, [ev(4), ev(5)], 3);
    expect(s.items.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(s.dropped).toBe(2);
  });

  it('advances the cursor past a gap frame', () => {
    const s = recordGap(emptyEventLog(), { type: 'gap', from: 4100, to: 4120, reason: 'backpressure' });
    expect(s.gaps).toHaveLength(1);
    expect(s.gaps[0].reason).toBe('backpressure');
    expect(dismissGaps(s).gaps).toEqual([]);
  });

  it('caps the number of retained gap notices', () => {
    let s = emptyEventLog();
    for (let i = 0; i < 30; i += 1) {
      s = recordGap(s, { type: 'gap', from: i, to: i + 1, reason: 'backpressure' });
    }
    expect(s.gaps).toHaveLength(20);
    expect(s.gaps[s.gaps.length - 1].from).toBe(29);
  });

  it('marks the log truncated when the server truncated a payload', () => {
    const s = ingestEvents(emptyEventLog(), [ev(1, { truncated: true })]);
    expect(s.truncated).toBe(true);
  });
});

describe('frame decoding (docs/11 §3)', () => {
  it('extracts a single-event frame', () => {
    const frame: WsFrame = { type: 'event', seq: 5, event: ev(5) };
    expect(eventsFromFrame(frame).map((e) => e.seq)).toEqual([5]);
  });

  it('extracts a coalesced batch frame', () => {
    const frame: WsFrame = { type: 'events', events: [ev(5), ev(6)] };
    expect(eventsFromFrame(frame).map((e) => e.seq)).toEqual([5, 6]);
  });

  it('ignores frames that carry no events', () => {
    expect(eventsFromFrame({ type: 'pong', ts: 1 })).toEqual([]);
    expect(eventsFromFrame({ type: 'gap', from: 1, to: 2, reason: 'x' })).toEqual([]);
  });
});

describe('filtering', () => {
  const rows: EventRow[] = [
    ev(1, { type: 'task.created', severity: 'info', title: 'plan the launch', agent_id: 'a1' }),
    ev(2, { type: 'agent.tool.call', severity: 'debug', title: 'searching', agent_id: 'a2', task_id: 't9' }),
    ev(3, { type: 'agent.thought', severity: 'warning', title: 'cost rising', agent_id: 'a1' }),
    ev(4, { type: 'budget.exceeded', severity: 'critical', title: 'cap hit', actor: 'system' }),
  ];

  it('derives the namespace from the dotted type', () => {
    expect(namespaceOf('agent.tool.call')).toBe('agent');
    expect(namespaceOf('pong')).toBe('pong');
    expect(namespaceOf('')).toBe('');
  });

  it('orders severities', () => {
    expect(severityAtLeast('critical', 'warning')).toBe(true);
    expect(severityAtLeast('debug', 'warning')).toBe(false);
    expect(severityAtLeast('warning', 'warning')).toBe(true);
  });

  it('returns everything when no filter is set', () => {
    expect(filterEventRows(rows, {})).toHaveLength(4);
  });

  it('filters by namespace', () => {
    expect(filterEventRows(rows, { namespace: 'agent' }).map((e) => e.seq)).toEqual([2, 3]);
  });

  it('filters by minimum severity', () => {
    expect(filterEventRows(rows, { severity: 'warning' }).map((e) => e.seq)).toEqual([3, 4]);
    expect(filterEventRows(rows, { severity: 'critical' }).map((e) => e.seq)).toEqual([4]);
  });

  it('filters by agent and task scope', () => {
    expect(filterEventRows(rows, { agent_id: 'a1' }).map((e) => e.seq)).toEqual([1, 3]);
    expect(filterEventRows(rows, { task_id: 't9' }).map((e) => e.seq)).toEqual([2]);
  });

  it('filters by free text across type, title, summary and actor', () => {
    expect(filterEventRows(rows, { q: 'LAUNCH' }).map((e) => e.seq)).toEqual([1]);
    expect(filterEventRows(rows, { q: 'system' }).map((e) => e.seq)).toEqual([4]);
    expect(filterEventRows(rows, { q: 'task.' }).map((e) => e.seq)).toEqual([1]);
  });

  it('combines filters', () => {
    expect(filterEventRows(rows, { namespace: 'agent', severity: 'warning' }).map((e) => e.seq)).toEqual([3]);
    expect(filterEventRows(rows, { namespace: 'agent', q: 'nothing matches' })).toEqual([]);
  });
});
