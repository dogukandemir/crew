import { useEffect, useRef } from 'react';
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
import { TabBar } from '../../components/ui/Tabs';
import { Skeleton } from '../../components/ui/EmptyState';
import { ProjectHeader } from './ProjectHeader';
import { Overview } from '../overview/Overview';
import { OrgPanel } from '../org/OrgPanel';
import { TasksPanel } from '../tasks/TasksPanel';
import { AgentsPanel } from '../agents/AgentsPanel';
import { BrainsPanel } from '../brains/BrainsPanel';
import { RewardsPanel } from '../rewards/RewardsPanel';
import { EventsPanel } from '../events/EventsPanel';
import { SettingsPanel } from './SettingsPanel';
import { DrawerHost } from './DrawerHost';
import { OfficeTab } from '../office/OfficeTab';
import { HqTab } from '../hq/HqTab';
import { CompanyProjects } from '../hq/CompanyProjects';
import { CompanyBrains } from '../hq/CompanyBrains';
import { BoardTab } from '../board/BoardTab';
import { cn } from '../../lib/cn';

/**
 * One workspace (docs/09 §2, ADR 0015): the internal tabs follow the tab's SCOPE —
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
      <div className="flex items-center justify-between border-b border-slate-800/70 px-2">
        {project.data ? (
          <TabBar
            tabs={allowed.map((id) => ({ id, label: WORKSPACE_TAB_LABEL[id] }))}
            value={current}
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
        className={cn(
          'min-h-0 flex-1',
          // The office owns its own canvas and panning; the data panels scroll.
          current === 'office' ? 'overflow-hidden' : 'overflow-y-auto px-3 py-3',
        )}
      >
        {project.data ? (
          <Panel tab={tab} current={current} kind={project.data.kind} />
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
