import { useProjects } from '../../app/hooks';
import { useTabs } from '../../stores/tabs';
import { useUi } from '../../stores/ui';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { EmptyState, SkeletonRows } from '../../components/ui/EmptyState';
import { PanelError } from '../../components/PanelError';
import { formatMicros } from '../../lib/format';

const STATUS_TONE = {
  active: 'success',
  paused: 'warning',
  archived: 'muted',
  failed: 'danger',
} as const;

/** Shown when no project tab is open — the empty state teaches (docs/09 §4). */
export function WelcomeScreen() {
  const projects = useProjects();
  const openTab = useTabs((s) => s.openTab);
  const setNewProjectOpen = useUi((s) => s.setNewProjectOpen);

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="text-lg font-semibold text-slate-100">Crew control room</h1>
      <p className="mt-1 text-sm text-slate-400">
        Open a project tab to watch its org form itself, execute, verify and pay out rewards. Each tab keeps
        its own route, filters and scroll position.
      </p>

      <div className="mt-5 flex items-center justify-between">
        <h2 className="text-sm font-medium text-slate-300">Projects</h2>
        <Button variant="primary" size="sm" onClick={() => setNewProjectOpen(true)}>
          ＋ New project
        </Button>
      </div>

      <div className="mt-3">
        {projects.isLoading && <SkeletonRows rows={4} />}
        {projects.isError && (
          <PanelError error={projects.error} onRetry={() => void projects.refetch()} label="Project list" />
        )}
        {projects.isSuccess && projects.data.items.length === 0 && (
          <EmptyState
            title="No projects yet"
            description="Name a project and state a goal — the orchestrator works out which skills are needed and hires the people it doesn't have."
            action={
              <Button variant="primary" size="sm" onClick={() => setNewProjectOpen(true)}>
                Create the first project
              </Button>
            }
          />
        )}
        {projects.isSuccess && projects.data.items.length > 0 && (
          <ul className="divide-y divide-slate-800/70 overflow-hidden rounded-lg border border-slate-700/60">
            {projects.data.items.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => openTab(p.id, 'main', 'overview')}
                >
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-slate-100">{p.name}</span>
                    <Badge tone={STATUS_TONE[p.status] ?? 'neutral'}>{p.status}</Badge>
                    <Badge tone="info">{p.stage}</Badge>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-slate-500">{p.goal}</p>
                </button>
                <div className="shrink-0 text-right text-[11px] tabular-nums text-slate-400">
                  {formatMicros(p.spend_micros)}
                  <span className="text-slate-600"> / {formatMicros(p.budget_cap_micros)}</span>
                </div>
                <Button size="xs" onClick={() => openTab(p.id, 'main', 'overview')}>
                  Open
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
