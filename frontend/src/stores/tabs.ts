/**
 * Tab strip store (docs/09 §1).
 *
 * A tab is `project_id + viewKey` so the same project can be open twice
 * (e.g. org chart and agent timeline side by side). Every tab keeps its own
 * internal route, filters and scroll position; switching tabs restores them.
 * The store is persisted so a reload keeps your workspace.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { EventQuery } from '../api/types';

export const WORKSPACE_TABS = [
  'overview',
  'org',
  'tasks',
  'agents',
  'brains',
  'rewards',
  'events',
  'settings',
] as const;

export type WorkspaceTab = (typeof WORKSPACE_TABS)[number];

export const WORKSPACE_TAB_LABEL: Record<WorkspaceTab, string> = {
  overview: 'Overview',
  org: 'Org',
  tasks: 'Tasks',
  agents: 'Agents',
  brains: 'Brains',
  rewards: 'Reward',
  events: 'Events',
  settings: 'Settings',
};

export interface TabFilters {
  taskState?: string;
  taskQuery?: string;
  agentDept?: string;
  agentQuery?: string;
  eventQuery?: EventQuery;
  rewardView?: 'leaderboard' | 'transitions';
}

export interface ProjectTab {
  /** `${projectId}::${viewKey}` */
  id: string;
  projectId: string;
  /** Discriminates two tabs on the same project. */
  viewKey: string;
  internalTab: WorkspaceTab;
  filters: TabFilters;
  scroll: number;
  /** Unread events / pending approvals badge. */
  badge: number;
}

export function tabKey(projectId: string, viewKey = 'main'): string {
  return `${projectId}::${viewKey}`;
}

interface TabsState {
  tabs: ProjectTab[];
  activeTabId: string | null;
  openTab: (projectId: string, viewKey?: string, internalTab?: WorkspaceTab) => string;
  closeTab: (id: string) => void;
  closeOthers: (id: string) => void;
  setActive: (id: string) => void;
  setInternalTab: (id: string, tab: WorkspaceTab) => void;
  setFilters: (id: string, patch: Partial<TabFilters>) => void;
  setScroll: (id: string, y: number) => void;
  setBadge: (id: string, value: number) => void;
  bumpBadge: (projectId: string, by?: number) => void;
  clearBadge: (id: string) => void;
  rename: (projectId: string, name: string) => void;
  /** Additive: display name cache so the strip renders before the list loads. */
  names: Record<string, string>;
  setName: (projectId: string, name: string) => void;
}

export const useTabs = create<TabsState>()(
  persist(
    (set, get) => ({
      tabs: [],
      activeTabId: null,
      names: {},

      openTab: (projectId, viewKey = 'main', internalTab = 'overview') => {
        const id = tabKey(projectId, viewKey);
        const existing = get().tabs.find((t) => t.id === id);
        if (existing) {
          set({ activeTabId: id });
          return id;
        }
        const tab: ProjectTab = {
          id,
          projectId,
          viewKey,
          internalTab,
          filters: {},
          scroll: 0,
          badge: 0,
        };
        set((s) => ({ tabs: [...s.tabs, tab], activeTabId: id }));
        return id;
      },

      closeTab: (id) =>
        set((s) => {
          const idx = s.tabs.findIndex((t) => t.id === id);
          if (idx === -1) return s;
          const tabs = s.tabs.filter((t) => t.id !== id);
          let activeTabId = s.activeTabId;
          if (s.activeTabId === id) {
            const next = tabs[idx] ?? tabs[idx - 1] ?? tabs[0];
            activeTabId = next ? next.id : null;
          }
          return { tabs, activeTabId };
        }),

      closeOthers: (id) =>
        set((s) => ({
          tabs: s.tabs.filter((t) => t.id === id),
          activeTabId: s.tabs.some((t) => t.id === id) ? id : s.activeTabId,
        })),

      setActive: (id) => set({ activeTabId: id }),

      setInternalTab: (id, internalTab) =>
        set((s) => ({
          tabs: s.tabs.map((t) => (t.id === id ? { ...t, internalTab } : t)),
        })),

      setFilters: (id, patch) =>
        set((s) => ({
          tabs: s.tabs.map((t) => (t.id === id ? { ...t, filters: { ...t.filters, ...patch } } : t)),
        })),

      setScroll: (id, y) =>
        set((s) => ({
          tabs: s.tabs.map((t) => (t.id === id ? { ...t, scroll: y } : t)),
        })),

      setBadge: (id, value) =>
        set((s) => ({
          tabs: s.tabs.map((t) => (t.id === id ? { ...t, badge: Math.max(0, value) } : t)),
        })),

      bumpBadge: (projectId, by = 1) =>
        set((s) => ({
          tabs: s.tabs.map((t) =>
            // Only the active tab is "seen"; background tabs accumulate.
            t.projectId === projectId && t.id !== s.activeTabId
              ? { ...t, badge: t.badge + by }
              : t,
          ),
        })),

      clearBadge: (id) =>
        set((s) => ({
          tabs: s.tabs.map((t) => (t.id === id ? { ...t, badge: 0 } : t)),
        })),

      rename: (projectId, name) =>
        set((s) => ({ names: { ...s.names, [projectId]: name } })),

      setName: (projectId, name) =>
        set((s) => ({ names: { ...s.names, [projectId]: name } })),
    }),
    {
      name: 'crew.tabs.v1',
      partialize: (s) => ({ tabs: s.tabs, activeTabId: s.activeTabId, names: s.names }),
    },
  ),
);

export function openProjectTab(projectId: string, viewKey?: string, internalTab?: WorkspaceTab): string {
  return useTabs.getState().openTab(projectId, viewKey, internalTab);
}

/** Distinct project ids that currently have a socket-worthy tab open. */
export function projectIdsOf(tabs: ProjectTab[]): string[] {
  return Array.from(new Set(tabs.map((t) => t.projectId)));
}
