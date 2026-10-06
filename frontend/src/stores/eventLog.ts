/**
 * Normalized event cache keyed by project (docs/09 §4: "the socket provider
 * pushes into a normalized cache keyed by scope").
 *
 * All writes funnel through the pure reducer in `lib/events.ts`.
 */
import { create } from 'zustand';
import type { EventRow, WsGap } from '../api/types';
import {
  DEFAULT_EVENT_CAP,
  emptyEventLog,
  ingestEvents,
  recordGap,
  dismissGaps,
  type EventLogState,
} from '../lib/events';

interface EventLogStore {
  logs: Record<string, EventLogState>;
  ingest: (projectId: string, events: EventRow[]) => void;
  gap: (projectId: string, gap: WsGap) => void;
  reset: (projectId: string) => void;
  dismissGaps: (projectId: string) => void;
  cap: number;
}

export const useEventLog = create<EventLogStore>((set, get) => ({
  logs: {},
  cap: DEFAULT_EVENT_CAP,

  ingest: (projectId, events) =>
    set((s) => {
      const prev = s.logs[projectId] ?? emptyEventLog();
      const next = ingestEvents(prev, events, get().cap);
      if (next === prev) return s;
      return { logs: { ...s.logs, [projectId]: next } };
    }),

  gap: (projectId, gap) =>
    set((s) => {
      const prev = s.logs[projectId] ?? emptyEventLog();
      return { logs: { ...s.logs, [projectId]: recordGap(prev, gap) } };
    }),

  reset: (projectId) =>
    set((s) => ({
      logs: { ...s.logs, [projectId]: emptyEventLog() },
    })),

  dismissGaps: (projectId) =>
    set((s) => {
      const prev = s.logs[projectId];
      if (!prev) return s;
      return { logs: { ...s.logs, [projectId]: dismissGaps(prev) } };
    }),
}));

/** Frozen identity so selectors never return a fresh object per call. */
const EMPTY_LOG: EventLogState = Object.freeze(emptyEventLog());

export function selectEventLog(projectId: string | null | undefined) {
  return (s: EventLogStore): EventLogState => (projectId && s.logs[projectId]) || EMPTY_LOG;
}
