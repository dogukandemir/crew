import { useEffect, useMemo, type ReactNode } from 'react';
import { CrewSocket } from '../lib/socket';
import { projectIdsOf, useTabs } from '../stores/tabs';
import { useEventLog } from '../stores/eventLog';
import { useConnection } from '../stores/connection';

/**
 * Owns one CrewSocket per open project (docs/09 §1: "each tab keeps its own
 * socket subscription"). Sockets are created when a project first gets a tab
 * and torn down when its last tab closes.
 */
const registry = new Map<string, CrewSocket>();

export function useProjectSocket(projectId: string | null | undefined): CrewSocket | undefined {
  return projectId ? registry.get(projectId) : undefined;
}

export function SocketProvider({ children }: { children: ReactNode }) {
  const tabs = useTabs((s) => s.tabs);
  const key = useMemo(() => projectIdsOf(tabs).sort().join(','), [tabs]);

  useEffect(() => {
    const wanted = key ? key.split(',') : [];

    for (const id of wanted) {
      if (registry.has(id)) continue;
      const sock = new CrewSocket(id);
      sock.subscribe({
        onState: (state, detail) => useConnection.getState().setStatus(id, state, detail),
        onHello: (hello) => useConnection.getState().setHello(id, hello),
        onEvents: (events) => {
          useEventLog.getState().ingest(id, events);
          useTabs.getState().bumpBadge(id, events.length);
          const last = events[events.length - 1];
          if (last) useConnection.getState().bumpSeq(id, last.seq);
        },
        onGap: (gap) => useEventLog.getState().gap(id, gap),
        onStage: (frame) => useConnection.getState().setStage(id, frame),
        onMetrics: (frame) => useConnection.getState().setMetrics(id, frame),
      });
      registry.set(id, sock);
    }

    for (const [id, sock] of Array.from(registry.entries())) {
      if (!wanted.includes(id)) {
        sock.stop();
        registry.delete(id);
        useConnection.getState().clear(id);
      }
    }
  }, [key]);

  return <>{children}</>;
}

/** Test/teardown helper. */
export function stopAllSockets(): void {
  for (const [id, sock] of registry) {
    sock.stop();
    registry.delete(id);
  }
}
