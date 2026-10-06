/**
 * The scene boundary (framework glue).
 *
 * This is the single seam between "the domain" and "something that draws it".
 * Today it composes pure functions from `src/sim` in the browser. When the
 * office runs in the cloud, the *same* composition moves to a scene worker and
 * this hook becomes a subscription to a `SceneState` stream instead — nothing in
 * the renderer changes. See docs/13.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { EventRow, Task } from '../api/types';
import { useOrg, useTasks } from './hooks';
import { selectEventLog, useEventLog } from '../stores/eventLog';
import { buildOffice, type Office } from '../sim/floorplan';
import { currentTaskFor, deriveActivity, type Activity } from '../sim/activity';
import { computeTargets, type Target } from '../sim/targets';
import { projectScene, type SceneState } from '../sim/scene';

/** How far back an event still counts as "happening now". */
const EVENT_LOOKBACK_MS = 120_000;
/** How long someone stays "just arrived" after walking in. */
const ARRIVAL_MS = 3200;

export interface SceneFrame {
  office: Office;
  scene: SceneState;
  activities: Record<string, Activity>;
  targets: Record<string, Target>;
  tasks: Task[] | undefined;
  now: number;
  isLoading: boolean;
  error: unknown;
  refetch: () => void;
}

/** A clock that ticks, so time-based activities age out. */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function useSceneFrame(projectId: string, showArchived = false): SceneFrame {
  const org = useOrg(projectId);
  const tasksQuery = useTasks(projectId);
  const log = useEventLog(selectEventLog(projectId));
  const now = useNow(1000);

  const office = useMemo(() => buildOffice(org.data?.root, { showArchived }), [org.data, showArchived]);
  const visibleIds = useMemo(() => Object.keys(office.deskOf).sort(), [office]);
  const tasks = tasksQuery.data?.items;

  const recentByAgent = useMemo(() => {
    const cutoff = now - EVENT_LOOKBACK_MS;
    const map = new Map<string, EventRow[]>();
    for (const e of log.items) {
      if (!e.agent_id) continue;
      const ts = Date.parse(e.ts);
      if (Number.isNaN(ts) || ts < cutoff) continue;
      const bucket = map.get(e.agent_id);
      if (bucket) bucket.push(e);
      else map.set(e.agent_id, [e]);
    }
    return map;
  }, [log.items, now]);

  const activities = useMemo(() => {
    const out: Record<string, Activity> = {};
    const list = tasks ?? [];
    for (const id of visibleIds) {
      const agent = office.agentOf[id];
      if (!agent) continue;
      out[id] = deriveActivity({
        agent,
        task: currentTaskFor(id, list),
        events: recentByAgent.get(id) ?? [],
        now,
      });
    }
    return out;
  }, [visibleIds, office, tasks, recentByAgent, now]);

  // Bookkeeping the pure layer deliberately does not own: how long someone has
  // been idle, and who just walked in. Mutating the ref inside the memo is
  // idempotent for a given `now`, which is what keeps it safe under StrictMode.
  const idleSince = useRef<Map<string, number>>(new Map());
  const arrivals = useRef<Map<string, number>>(new Map());

  const { targets, scene } = useMemo(() => {
    const list = tasks ?? [];
    const idle = idleSince.current;
    for (const [id, activity] of Object.entries(activities)) {
      if (activity.kind === 'idle') {
        if (!idle.has(id)) idle.set(id, now);
      } else {
        idle.delete(id);
      }
    }

    const arriving = new Set<string>();
    let arrived = false;
    for (const [id, at] of arrivals.current) {
      if (now - at < ARRIVAL_MS) arriving.add(id);
      else {
        arrivals.current.delete(id);
        arrived = true;
      }
    }
    void arrived;

    const computed = computeTargets({
      office,
      activities,
      tasks: list,
      now,
      idleSince: idle,
      arriving,
    });
    return {
      targets: computed,
      scene: projectScene({ projectId, office, activities, targets: computed, tasks: list, now }),
    };
  }, [office, activities, tasks, now, projectId]);

  return {
    office,
    scene,
    activities,
    targets,
    tasks,
    now,
    isLoading: org.isLoading || tasksQuery.isLoading,
    error: org.error ?? tasksQuery.error,
    refetch: () => {
      void org.refetch();
      void tasksQuery.refetch();
    },
  };
}
