import { useEffect, useMemo, type ReactNode } from 'react';
import { api } from '../api/client';
import { CrewSocket } from '../lib/socket';
import {
  hasSocket,
  registerSocket,
  socketEntries,
  unregisterSocket,
} from '../lib/socketRegistry';
import { projectIdsOf, useTabs } from '../stores/tabs';
import { useEventLog } from '../stores/eventLog';
import { useConnection } from '../stores/connection';

/**
 * Owns one CrewSocket per open project (docs/09 §1: "each tab keeps its own
 * socket subscription"). Sockets are created when a project first gets a tab
 * and torn down when its last tab closes.
 *
 * This module must export the component and nothing else: `@vitejs/plugin-react`
 * only hot-swaps a file when every export is a component, otherwise every edit
 * forces a full page reload. The socket registry lives in `lib/socketRegistry.ts`
 * and the `useProjectSocket` accessor in `app/useProjectSocket.ts` for that reason.
 */
export function SocketProvider({ children }: { children: ReactNode }) {
  const tabs = useTabs((s) => s.tabs);
  const key = useMemo(() => projectIdsOf(tabs).sort().join(','), [tabs]);

  useEffect(() => {
    const wanted = key ? key.split(',') : [];

    for (const id of wanted) {
      if (hasSocket(id)) continue;
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
      registerSocket(id, sock);

      // The socket carries the live tail; the REST log backfills the history a
      // newly opened project missed, so the ticker and firehose are never
      // misleadingly empty. Failures are silent here — a dead backend is
      // already reported by the reachability banner and every panel's own state.
      void api
        .listEvents(id, { limit: 500 })
        .then((page) => {
          if (page.items?.length) useEventLog.getState().ingest(id, page.items);
        })
        .catch(() => undefined);
    }

    for (const [id, sock] of socketEntries()) {
      if (!wanted.includes(id)) {
        sock.stop();
        unregisterSocket(id);
        useConnection.getState().clear(id);
      }
    }

    // The socket carries the live tail; where there is no socket, this slow poll of
    // the latest page IS the live tail. One page every ten seconds, ingested through
    // the same reducer (which dedupes), so it is a no-op where the socket already
    // delivers — and where it does not, a log frozen at page-open is precisely what
    // makes live features look broken: activity hangs off it, and so does a council
    // summoning a meeting room forty seconds in.
    const polls = wanted.map((id) =>
      window.setInterval(() => {
        void api
          .listEvents(id, { limit: 200 })
          .then((page) => {
            if (page.items?.length) useEventLog.getState().ingest(id, page.items);
          })
          .catch(() => undefined);
      }, 10_000),
    );
    return () => polls.forEach((t) => window.clearInterval(t));
  }, [key]);

  return <>{children}</>;
}
