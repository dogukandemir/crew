import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { ProgressBar } from '../../components/ui/Card';
import { SkeletonRows } from '../../components/ui/EmptyState';
import { PanelError } from '../../components/PanelError';
import { formatPercent, formatRelativeTime } from '../../lib/format';
import { useCompanyHq } from '../../app/hooks';
import { useTabs } from '../../stores/tabs';
import { useUi } from '../../stores/ui';
import { VERDICT_TONE } from './verdict';

/**
 * The company's portfolio (ADR 0015): every member project as a card — verdict,
 * books, teams — and the door to its office. New projects are born HERE, under the
 * company, so the report chain (orchestrator → CEO) exists from their first breath.
 * Everything shown cites the member's own stream; nothing is invented.
 */
export function CompanyProjects({ companyId }: { companyId: string }) {
  const hq = useCompanyHq(companyId);
  const openTab = useTabs((s) => s.openTab);
  const setNewProjectOpen = useUi((s) => s.setNewProjectOpen);

  if (hq.isLoading) return <SkeletonRows rows={3} />;
  if (hq.isError) return <PanelError error={hq.error} onRetry={() => void hq.refetch()} />;

  const d = hq.data;
  if (!d) return <SkeletonRows rows={3} />;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-medium text-slate-100">Portfolio</h2>
        <span className="text-[11px] text-slate-500">
          {d.projects.length} project{d.projects.length === 1 ? '' : 's'} under {d.company.name}
        </span>
        <span className="text-[11px] tabular-nums text-slate-400">
          ${d.company.spend_usd.toFixed(2)} / ${d.company.budget_usd.toFixed(2)} company budget
        </span>
        <Button
          size="xs"
          variant="primary"
          className="ml-auto"
          onClick={() => setNewProjectOpen(true, companyId)}
        >
          ＋ New project here
        </Button>
      </div>

      {d.projects.length === 0 && (
        <div className="rounded border border-dashed border-slate-700/70 p-6 text-center text-xs text-slate-500">
          No projects yet — every project born here reports up to {d.company.name}&apos;s CEO.
        </div>
      )}

      {d.projects.map((p) => (
        <div key={p.id} className="rounded-lg border border-slate-800 bg-slate-900/50 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => openTab(p.id, 'main', 'office')}
              className="text-sm font-medium text-slate-100 hover:text-emerald-300"
              title="Open this project's office"
            >
              {p.name}
            </button>
            <Badge tone={VERDICT_TONE[p.verdict]}>{p.verdict.replace('_', ' ')}</Badge>
            <span className="text-[11px] text-slate-500">{p.status}</span>
            {p.last_at && (
              <span className="text-[11px] text-slate-600">last activity {formatRelativeTime(p.last_at)}</span>
            )}
            <div className="ml-auto flex items-center gap-3 text-[11px] tabular-nums text-slate-400">
              <span title="tasks completed">✓ {p.completed}</span>
              <span title="tasks failed">✗ {p.failed}</span>
              <span title="open tasks">{p.open_tasks} open</span>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <div className="w-40" title={`spend ${formatPercent(p.spend_ratio)} of cap`}>
              <ProgressBar
                value={p.spend_ratio}
                tone={p.spend_ratio > 0.9 ? 'danger' : p.spend_ratio > 0.7 ? 'warning' : 'accent'}
                label="spend"
              />
            </div>
            <span className="text-[11px] tabular-nums text-slate-500">
              {formatPercent(p.spend_ratio)} of its cap
            </span>
            <div className="flex flex-wrap items-center gap-1">
              {p.teams.map((t) => (
                <span
                  key={t.id}
                  className="rounded border border-slate-700/60 px-1.5 py-0.5 text-[10px] text-slate-400"
                  title={`${t.name}${t.head_name ? ` — led by ${t.head_name}` : ''}`}
                >
                  {t.name}
                  {t.head_name ? ` · ${t.head_name}` : ''} · {t.agents}
                </span>
              ))}
            </div>
            <Button
              size="xs"
              variant="secondary"
              className="ml-auto"
              onClick={() => openTab(p.id, 'main', 'office')}
            >
              Open office →
            </Button>
          </div>
          {p.directive && <p className="mt-2 text-[11px] text-slate-500">directive: {p.directive}</p>}
        </div>
      ))}
    </div>
  );
}
