import { useProjects } from '../../app/hooks';
import { useTabs, type ProjectTab } from '../../stores/tabs';
import { useConnection } from '../../stores/connection';
import { useUi } from '../../stores/ui';
import { cn } from '../../lib/cn';
import { StatusDot, dotForState, type DotState } from '../../components/ui/StatusDot';
import { formatMicros } from '../../lib/format';
import { groupKeyMaker, groupTabs } from './tabGroups';
import type { Project } from '../../api/types';

function tabDot(project: Project | undefined, socketState: string | undefined): DotState {
  if (socketState === 'disconnected' || socketState === 'reconnecting') return 'warning';
  if (!project) return 'idle';
  if (project.status === 'paused') return 'idle';
  if (project.status === 'failed') return 'danger';
  if (project.status === 'archived') return 'offline';
  if ((project.pending_approvals ?? 0) > 0) return 'warning';
  if (project.stage === 'DONE') return 'ok';
  return dotForState(project.stage === 'EXECUTING' ? 'running' : project.stage.toLowerCase());
}

function Tab({
  tab,
  name,
  parentName,
  project,
}: {
  tab: ProjectTab;
  name: string;
  parentName?: string;
  project?: Project;
}) {
  const activeTabId = useTabs((s) => s.activeTabId);
  const setActive = useTabs((s) => s.setActive);
  const closeTab = useTabs((s) => s.closeTab);
  const openTab = useTabs((s) => s.openTab);
  const socketState = useConnection((s) => s.byProject[tab.projectId]?.state);

  const homeOpen = useTabs(state => state.homeOpen);
  const active = !homeOpen && activeTabId === tab.id;
  const pending = project?.pending_approvals ?? 0;

  return (
    <div
      className={cn(
        'group flex max-w-[16rem] shrink-0 items-center gap-2 rounded-t-md border-x border-t px-2.5 py-1 text-xs',
        active
          ? 'border-slate-600/70 bg-slate-900 text-slate-100'
          : 'border-transparent bg-slate-950/40 text-slate-400 hover:bg-slate-900/60 hover:text-slate-200',
      )}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        tabIndex={active ? 0 : -1}
        data-tab-id={tab.id}
        onClick={() => setActive(tab.id)}
        onKeyDown={(event) => {
          // Roving focus within the tablist (pattern: components/ui/Tabs.tsx).
          if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const list = event.currentTarget.closest('[role="tablist"]');
          const buttons = list
            ? Array.from(list.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
            : [];
          const index = buttons.indexOf(event.currentTarget);
          if (index < 0) return;
          const next =
            event.key === 'ArrowRight'
              ? (index + 1) % buttons.length
              : event.key === 'ArrowLeft'
                ? (index + buttons.length - 1) % buttons.length
                : event.key === 'Home'
                  ? 0
                  : buttons.length - 1;
          const target = buttons[next];
          const targetId = target?.dataset.tabId;
          target?.focus();
          if (targetId) setActive(targetId);
        }}
        className="flex min-w-0 items-center gap-2"
        title={`${parentName ? `${parentName} › ` : ''}${name}${tab.viewKey !== 'main' ? ` · view ${tab.viewKey}` : ''}`}
      >
        <StatusDot state={tabDot(project, socketState)} pulse={active && socketState === 'connected'} />
        {/* A member tab shows its company one breadcrumb up (ADR 0015). */}
        {parentName && <span className="shrink-0 text-[10px] text-slate-600">⌂</span>}
        <span className="truncate">{name}</span>
        {tab.viewKey !== 'main' && <span className="text-[10px] text-slate-500">{tab.viewKey}</span>}
        {project && (
          <span className="shrink-0 tabular-nums text-[10px] text-slate-500">
            {formatMicros(project.spend_micros)}
          </span>
        )}
        {tab.badge > 0 && (
          <span className="shrink-0 rounded-full bg-emerald-600/80 px-1.5 text-[10px] font-semibold text-emerald-50">
            {tab.badge > 99 ? '99+' : tab.badge}
          </span>
        )}
        {pending > 0 && (
          <span
            className="shrink-0 rounded-full bg-amber-600/80 px-1.5 text-[10px] font-semibold text-amber-50"
            title={`${pending} pending approval${pending === 1 ? '' : 's'}`}
          >
            {pending}
          </span>
        )}
      </button>
      <button
        type="button"
        title="Open a second view of this project"
        aria-label="Open a second view"
        onClick={() => openTab(tab.projectId, `alt-${Date.now().toString(36)}`, 'agents')}
        className="hidden opacity-0 transition-opacity group-hover:opacity-100 hover:text-emerald-300 lg:inline"
      >
        ⧉
      </button>
      <button
        type="button"
        aria-label={`Close ${name}`}
        title="Close tab (the project keeps running)"
        onClick={() => closeTab(tab.id)}
        className="opacity-40 transition-opacity hover:opacity-100"
      >
        ✕
      </button>
    </div>
  );
}

export function TabStrip() {
  const tabs = useTabs((s) => s.tabs);
  const names = useTabs((s) => s.names);
  const projects = useProjects();
  const setNewProjectOpen = useUi((s) => s.setNewProjectOpen);

  const byId = new Map((projects.data?.items ?? []).map((p) => [p.id, p]));
  // Hierarchy in the strip (ADR 0015): members sit with their company, and a member
  // tab says which company it belongs to.
  const members = new Map((projects.data?.items ?? []).map((p) => [p.id, p.company_id ?? null]));
  const groupKeyOf = groupKeyMaker(members);
  const ordered = groupTabs(tabs, groupKeyOf);

  return (
    <div
      role="tablist"
      aria-label="Project tabs"
      className="flex items-end gap-0.5 overflow-x-auto border-b border-slate-700/60 bg-slate-950/60 px-2 pt-1"
    >
      {tabs.length === 0 && (
        <span className="px-2 py-1 text-xs text-slate-500">No project tabs open</span>
      )}
      {ordered.map((tab) => {
        const project = byId.get(tab.projectId);
        const name = project?.name ?? names[tab.projectId] ?? tab.projectId.slice(0, 8);
        const companyId = project?.company_id ?? null;
        const parentName = companyId
          ? byId.get(companyId)?.name ?? names[companyId]
          : undefined;
        return <Tab key={tab.id} tab={tab} name={name} parentName={parentName} project={project} />;
      })}
      <button
        type="button"
        onClick={() => setNewProjectOpen(true)}
        title="New project"
        aria-label="New project"
        className="mb-0.5 ml-1 rounded px-2 py-1 text-xs text-slate-500 hover:bg-slate-800/60 hover:text-slate-200"
      >
        ＋
      </button>
    </div>
  );
}
