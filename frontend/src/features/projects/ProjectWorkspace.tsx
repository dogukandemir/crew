import { useEffect, useRef } from 'react';
import { WORKSPACE_TABS, WORKSPACE_TAB_LABEL, useTabs, type ProjectTab } from '../../stores/tabs';
import { useUi } from '../../stores/ui';
import { TabBar } from '../../components/ui/Tabs';
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
import { BoardTab } from '../board/BoardTab';
import { cn } from '../../lib/cn';

/**
 * One project's workspace (docs/09 §2). Internal tabs live in the tab store so
 * switching outer tabs restores the exact view you left.
 */
export function ProjectWorkspace({ tab }: { tab: ProjectTab }) {
  const setInternalTab = useTabs((s) => s.setInternalTab);
  const clearBadge = useTabs((s) => s.clearBadge);
  const openApprovals = useUi((s) => s.setApprovalsOpen);
  const scrollRef = useRef<HTMLDivElement>(null);

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

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ProjectHeader projectId={tab.projectId} />
      <div className="flex items-center justify-between border-b border-slate-800/70 px-2">
        <TabBar
          tabs={WORKSPACE_TABS.map((id) => ({ id, label: WORKSPACE_TAB_LABEL[id] }))}
          value={tab.internalTab}
          onChange={(id) => setInternalTab(tab.id, id)}
        />
        <button
          type="button"
          onClick={() => openApprovals(true)}
          className="rounded px-2 py-1 text-[11px] text-amber-300/90 hover:bg-amber-950/40"
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
          tab.internalTab === 'office' ? 'overflow-hidden' : 'overflow-y-auto px-3 py-3',
        )}
      >
        <Panel tab={tab} />
      </div>
      <DrawerHost projectId={tab.projectId} tabId={tab.id} />
    </div>
  );
}

function Panel({ tab }: { tab: ProjectTab }) {
  switch (tab.internalTab) {
    case 'office':
      return <OfficeTab projectId={tab.projectId} tabId={tab.id} />;
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
      return <BrainsPanel projectId={tab.projectId} />;
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
