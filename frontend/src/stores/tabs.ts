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

/** Every internal tab id. Each scope picks its own subset (ADR 0015): a member
 * project's views and the company's views are different jobs. */
export const WORKSPACE_TABS = [
  'hq',
  'projects',
  'office',
  'overview',
  'org',
  'tasks',
  'board',
  'deliverables',
  'agents',
  'brains',
  'rewards',
  'events',
  'settings',
] as const;

export type WorkspaceTab = (typeof WORKSPACE_TABS)[number];

/** A member project's views: no HQ — the company lives one level up, reached by the
 * breadcrumb; governance stays on the company's floor. */
export const PROJECT_TABS: readonly WorkspaceTab[] = [
  'office',
  'overview',
  'org',
  'tasks',
  'board',
  'deliverables',
  'agents',
  'brains',
  'rewards',
  'events',
  'settings',
];

/** The company's own views: the floor, the portfolio, the deliverables rollup, the
 * umbrella memory, company events and settings. Office/Org/Tasks/Brains-of-work/rewards
 * belong to members. */
export const COMPANY_TABS: readonly WorkspaceTab[] = [
  'hq',
  'projects',
  'deliverables',
  'brains',
  'events',
  'settings',
];

export function workspaceTabsFor(kind: string | null | undefined): readonly WorkspaceTab[] {
  return kind === 'company' ? COMPANY_TABS : PROJECT_TABS;
}

/** Where a tab lands when its remembered view is not in scope (ADR 0015) — e.g. a
 * member project that still has 'hq' persisted from before the restructure. */
export function defaultWorkspaceTab(kind: string | null | undefined): WorkspaceTab {
  return kind === 'company' ? 'hq' : 'office';
}

export const WORKSPACE_TAB_LABEL: Record<WorkspaceTab, string> = {
  hq: 'HQ',
  projects: 'Projects',
  office: 'Office',
  overview: 'Overview',
  org: 'Team structure',
  tasks: 'Tasks',
  board: 'Board',
  deliverables: 'Deliverables',
  agents: 'Agents',
  brains: 'Memory',
  rewards: 'Growth & scores',
  events: 'Events',
  settings: 'Settings',
};

export interface TabFilters {
  taskRun?: 'latest' | 'all';
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
  homeOpen: boolean;
  goHome: () => void;
  tabs: ProjectTab[];
  activeTabId: string | null;
  openTab: (projectId: string, viewKey?: string, internalTab?: WorkspaceTab) => string;
  closeTab: (id: string) => void;
  setActive: (id: string) => void;
  setInternalTab: (id: string, tab: WorkspaceTab) => void;
  setFilters: (id: string, patch: Partial<TabFilters>) => void;
  setScroll: (id: string, y: number) => void;
  bumpBadge: (projectId: string, by?: number) => void;
  clearBadge: (id: string) => void;
  rename: (projectId: string, name: string) => void;
  /** Additive: display name cache so the strip renders before the list loads. */
  names: Record<string, string>;
}

export const useTabs = create<TabsState>()(
  persist(
    (set, get) => ({
      tabs: [],
      activeTabId: null,
      homeOpen: false,
      goHome: () => set({ homeOpen: true }),
      names: {},

      openTab: (projectId, viewKey = 'main', internalTab = 'office') => {
        const id = tabKey(projectId, viewKey);
        const existing = get().tabs.find((t) => t.id === id);
        if (existing) {
          set({ activeTabId: id, homeOpen: false });
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
        set((s) => ({ tabs: [...s.tabs, tab], activeTabId: id, homeOpen: false }));
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

      setActive: (id) => set({ activeTabId: id, homeOpen: false }),

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

      bumpBadge: (projectId, by = 1) =>
        set((s) => ({
          tabs: s.tabs.map((t) =>
            // Only the active tab is "seen"; background tabs accumulate.
            t.projectId === projectId && (s.homeOpen || t.id !== s.activeTabId)
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
    }),
    {
      name: 'crew.tabs.v1',
      partialize: (s) => ({ tabs: s.tabs, activeTabId: s.activeTabId, names: s.names, homeOpen: s.homeOpen }),
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
