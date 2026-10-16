import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import {
  WORKSPACE_TAB_LABEL,
  defaultWorkspaceTab,
  useTabs,
  workspaceTabsFor,
  type ProjectTab,
  type WorkspaceTab,
} from '../../stores/tabs';
import { useUi } from '../../stores/ui';
import { useProject } from '../../app/hooks';
import { WorkspaceNavigation } from './WorkspaceNavigation';
import { Skeleton } from '../../components/ui/EmptyState';
import { ProjectHeader } from './ProjectHeader';
import { RunSummary } from './RunSummary';
const Overview = lazy(() => import('../overview/Overview').then(m => ({ default: m.Overview })));
const OrgPanel = lazy(() => import('../org/OrgPanel').then(m => ({ default: m.OrgPanel })));
const TasksPanel = lazy(() => import('../tasks/TasksPanel').then(m => ({ default: m.TasksPanel })));
const AgentsPanel = lazy(() => import('../agents/AgentsPanel').then(m => ({ default: m.AgentsPanel })));
const BrainsPanel = lazy(() => import('../brains/BrainsPanel').then(m => ({ default: m.BrainsPanel })));
const RewardsPanel = lazy(() => import('../rewards/RewardsPanel').then(m => ({ default: m.RewardsPanel })));
const EventsPanel = lazy(() => import('../events/EventsPanel').then(m => ({ default: m.EventsPanel })));
const SettingsPanel = lazy(() => import('./SettingsPanel').then(m => ({ default: m.SettingsPanel })));
import { DrawerHost } from './DrawerHost';
const OfficeTab = lazy(() => import('../office/OfficeTab').then(m => ({ default: m.OfficeTab })));
const HqTab = lazy(() => import('../hq/HqTab').then(m => ({ default: m.HqTab })));
const CompanyProjects = lazy(() => import('../hq/CompanyProjects').then(m => ({ default: m.CompanyProjects })));
const CompanyBrains = lazy(() => import('../hq/CompanyBrains').then(m => ({ default: m.CompanyBrains })));
const BoardTab = lazy(() => import('../board/BoardTab').then(m => ({ default: m.BoardTab })));
import { DeliverablesPanel } from '../deliverables/DeliverablesPanel';
import { cn } from '../../lib/cn';
import { PanelError } from '../../components/PanelError';

/**
 * One workspace (docs/09 §2, ADR 0015): the internal tabs follow the tab's SCOPE,
 * a company shows HQ/Projects/Brains/Events/Settings, a member project shows its
 * office and working views (no HQ; the company is one breadcrumb up). Internal tabs
 * live in the tab store so switching outer tabs restores the exact view you left.
 */
export function ProjectWorkspace({ tab }: { tab: ProjectTab }) {
  const setInternalTab = useTabs((s) => s.setInternalTab);
  const clearBadge = useTabs((s) => s.clearBadge);
  const openApprovals = useUi((s) => s.setApprovalsOpen);
  const scrollRef = useRef<HTMLDivElement>(null);
  const project = useProject(tab.projectId);
  const [flash, setFlash] = useState(false);
  const flashTimer = useRef<number | undefined>(undefined);

  // The run-summary action must be VISIBLE even when its target tab is already the
  // current one: scroll the panel to the top and flash it once, whatever it was.
  const goto = useCallback(
    (id: WorkspaceTab) => {
      setInternalTab(tab.id, id);
      const el = scrollRef.current;
      if (el) el.scrollTop = 0;
      requestAnimationFrame(() => {
        const again = scrollRef.current;
        if (again) again.scrollTop = 0;
      });
      setFlash(true);
      if (flashTimer.current) window.clearTimeout(flashTimer.current);
      flashTimer.current = window.setTimeout(() => setFlash(false), 950);
    },
    [setInternalTab, tab.id],
  );

  // Restore the scroll position captured for this tab.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = tab.scroll;
    const onScroll = () => useTabs.getState().setScroll(tab.id, el.scrollTop);
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
    // The workspace is keyed by tab.id, so this runs once per tab activation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id]);

  useEffect(() => {
    clearBadge(tab.id);
  }, [tab.id, clearBadge]);

  const kind = project.data?.kind;
  const allowed = workspaceTabsFor(kind);
  // Scope guard (ADR 0015): a remembered view that no longer belongs to this kind
  // (e.g. 'hq' persisted on a member project) lands on the scope's default instead
  // of rendering a dead panel.
  const current: WorkspaceTab = allowed.includes(tab.internalTab)
    ? tab.internalTab
    : defaultWorkspaceTab(kind);

  // Heal the store once the kind is known, so reopening the tab lands in-scope.
  useEffect(() => {
    if (project.data && tab.internalTab !== current) setInternalTab(tab.id, current);
  }, [project.data, tab.internalTab, current, setInternalTab, tab.id]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ProjectHeader projectId={tab.projectId} />
      {project.data && project.data.kind !== 'company' && <RunSummary project={project.data} navigate={goto} />}
      <div className="flex items-center justify-between border-b border-slate-800/70 px-2">
        {project.data ? (
          <WorkspaceNavigation
            allowed={allowed}
            current={current}
            onChange={(id) => setInternalTab(tab.id, id)}
          />
        ) : (
          <div className="min-w-0 flex-1 py-2">
            <Skeleton className="h-5 w-72 max-w-full" />
          </div>
        )}
        <button
          type="button"
          onClick={() => openApprovals(true)}
          className="shrink-0 rounded px-2 py-1 text-[11px] text-amber-300/90 hover:bg-amber-950/40"
          title="Open the approval tray"
        >
          ⚑ approvals
        </button>
      </div>
      <div
        ref={scrollRef}
        role="tabpanel" aria-label={WORKSPACE_TAB_LABEL[current]}
        className={cn(
          'min-h-0 flex-1',
          // The office owns its own canvas and panning; the data panels scroll.
          current === 'office' || current === 'hq' ? 'overflow-y-auto' : 'overflow-y-auto px-3 py-3',
          flash && 'crew-flash',
        )}
      >
        {project.isError ? <PanelError error={project.error} onRetry={() => void project.refetch()} label="Project" /> : project.data ? (
          <Suspense fallback={<p className="p-4" role="status">Loading view…</p>}><Panel tab={tab} current={current} kind={project.data.kind} /></Suspense>
        ) : (
          <div className="space-y-2 pt-1">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        )}
      </div>
      <DrawerHost projectId={tab.projectId} tabId={tab.id} />
    </div>
  );
}

function Panel({
  tab,
  current,
  kind,
}: {
  tab: ProjectTab;
  current: WorkspaceTab;
  kind?: 'project' | 'company';
}) {
  switch (current) {
    case 'office':
      return <OfficeTab projectId={tab.projectId} tabId={tab.id} />;
    case 'hq':
      return <HqTab companyId={tab.projectId} />;
    case 'projects':
      return <CompanyProjects companyId={tab.projectId} />;
    case 'overview':
      return <Overview projectId={tab.projectId} tabId={tab.id} />;
    case 'org':
      return <OrgPanel projectId={tab.projectId} tabId={tab.id} />;
    case 'tasks':
      return <TasksPanel projectId={tab.projectId} tabId={tab.id} />;
    case 'board':
      return <BoardTab projectId={tab.projectId} />;
    case 'deliverables':
      return kind === 'company' ? (
        <DeliverablesPanel scope="company" id={tab.projectId} tabId={tab.id} />
      ) : (
        <DeliverablesPanel scope="project" id={tab.projectId} tabId={tab.id} />
      );
    case 'agents':
      return <AgentsPanel projectId={tab.projectId} tabId={tab.id} />;
    case 'brains':
      // Company scope gets the umbrella page; a member gets its own four levels
      // (with a link up to the company brain).
      return kind === 'company' ? (
        <CompanyBrains companyId={tab.projectId} />
      ) : (
        <BrainsPanel projectId={tab.projectId} />
      );
    case 'rewards':
      return <RewardsPanel projectId={tab.projectId} tabId={tab.id} />;
    case 'events':
      return <EventsPanel projectId={tab.projectId} tabId={tab.id} />;
    case 'settings':
      return <SettingsPanel projectId={tab.projectId} />;
    default:
      return null;
  }
}
