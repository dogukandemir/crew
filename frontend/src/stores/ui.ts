/** UI-only state: drawers, dialogs, the notification tray, backend banner. */
import { create } from 'zustand';

export type DrawerKind = 'unit' | 'task' | 'agent' | 'command';

export interface DrawerTarget {
  kind: DrawerKind;
  id: string;
  name?: string;
}

interface UiState {
  /** Drawer selection is per tab, so two tabs can show different units. */
  drawers: Record<string, DrawerTarget>;
  openDrawer: (tabId: string, target: DrawerTarget) => void;
  closeDrawer: (tabId: string) => void;

  approvalsOpen: boolean;
  setApprovalsOpen: (open: boolean) => void;

  newProjectOpen: boolean;
  /** Which company the dialog is born under (ADR 0015): null = the user picks. */
  newProjectCompanyId: string | null;
  setNewProjectOpen: (open: boolean, companyId?: string | null) => void;

  /** The founding wizard (ADR 0015): the ONE way a company is created. */
  foundWizardOpen: boolean;
  setFoundWizardOpen: (open: boolean) => void;

  /** Backend-reachability banner, driven by React Query's error cache. */
  backendDown: boolean;
  backendDetail?: string;
  setBackendDown: (down: boolean, detail?: string) => void;

  toast: { kind: 'info' | 'error' | 'success'; message: string } | null;
  setToast: (toast: UiState['toast']) => void;
}

export const useUi = create<UiState>((set) => ({
  drawers: {},
  openDrawer: (tabId, target) =>
    set((s) => ({ drawers: { ...s.drawers, [tabId]: target } })),
  closeDrawer: (tabId) =>
    set((s) => {
      const next = { ...s.drawers };
      delete next[tabId];
      return { drawers: next };
    }),

  approvalsOpen: false,
  setApprovalsOpen: (approvalsOpen) => set({ approvalsOpen }),

  newProjectOpen: false,
  newProjectCompanyId: null,
  setNewProjectOpen: (newProjectOpen, companyId) =>
    set({ newProjectOpen, newProjectCompanyId: newProjectOpen ? companyId ?? null : null }),

  foundWizardOpen: false,
  setFoundWizardOpen: (foundWizardOpen) => set({ foundWizardOpen }),

  backendDown: false,
  backendDetail: undefined,
  setBackendDown: (backendDown, backendDetail) =>
    set((s) => (s.backendDown === backendDown && s.backendDetail === backendDetail ? s : { backendDown, backendDetail })),

  toast: null,
  setToast: (toast) => set({ toast }),
}));

