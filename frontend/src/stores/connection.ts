/**
 * Live connection state per project (docs/09 §1 status dot, docs/11 §3).
 * Populated by the socket provider; read by the tab strip and the header.
 */
import { create } from 'zustand';
import type { WsHello, WsMetrics, WsStage } from '../api/types';
import type { ConnectionState } from '../lib/socket';

export interface ProjectConnection {
  state: ConnectionState;
  detail?: string;
  seqHead: number;
  contract?: number;
  replaying: boolean;
  stage?: WsStage;
  metrics?: WsMetrics;
  lastFrameAt?: number;
}

const initial: ProjectConnection = {
  state: 'idle',
  seqHead: 0,
  replaying: false,
};

interface ConnectionStore {
  byProject: Record<string, ProjectConnection>;
  setStatus: (projectId: string, state: ConnectionState, detail?: string) => void;
  setHello: (projectId: string, hello: WsHello) => void;
  setStage: (projectId: string, stage: WsStage) => void;
  setMetrics: (projectId: string, metrics: WsMetrics) => void;
  setReplaying: (projectId: string, replaying: boolean) => void;
  bumpSeq: (projectId: string, seq: number) => void;
  clear: (projectId: string) => void;
}

export const useConnection = create<ConnectionStore>((set) => ({
  byProject: {},

  setStatus: (projectId, state, detail) =>
    set((s) => {
      const prev = s.byProject[projectId] ?? initial;
      return {
        byProject: {
          ...s.byProject,
          [projectId]: { ...prev, state, detail, lastFrameAt: Date.now() },
        },
      };
    }),

  setHello: (projectId, hello) =>
    set((s) => {
      const prev = s.byProject[projectId] ?? initial;
      return {
        byProject: {
          ...s.byProject,
          [projectId]: {
            ...prev,
            seqHead: Math.max(prev.seqHead, hello.seq_head),
            contract: hello.contract,
          },
        },
      };
    }),

  setStage: (projectId, stage) =>
    set((s) => {
      const prev = s.byProject[projectId] ?? initial;
      return { byProject: { ...s.byProject, [projectId]: { ...prev, stage } } };
    }),

  setMetrics: (projectId, metrics) =>
    set((s) => {
      const prev = s.byProject[projectId] ?? initial;
      return { byProject: { ...s.byProject, [projectId]: { ...prev, metrics } } };
    }),

  setReplaying: (projectId, replaying) =>
    set((s) => {
      const prev = s.byProject[projectId] ?? initial;
      return { byProject: { ...s.byProject, [projectId]: { ...prev, replaying } } };
    }),

  bumpSeq: (projectId, seq) =>
    set((s) => {
      const prev = s.byProject[projectId] ?? initial;
      if (seq <= prev.seqHead) return s;
      return { byProject: { ...s.byProject, [projectId]: { ...prev, seqHead: seq } } };
    }),

  clear: (projectId) =>
    set((s) => {
      const next = { ...s.byProject };
      delete next[projectId];
      return { byProject: next };
    }),
}));

export function selectConnection(projectId: string | null | undefined) {
  return (s: ConnectionStore): ProjectConnection =>
    (projectId && s.byProject[projectId]) || initial;
}

/** Shared mapping: a project is "needs attention" when it has pending asks. */
export function attentionLevel(
  pendingApprovals: number,
  connection: ConnectionState,
): 'ok' | 'attention' | 'down' {
  if (connection === 'disconnected' || connection === 'reconnecting') return 'attention';
  if (pendingApprovals > 0) return 'attention';
  return 'ok';
}
