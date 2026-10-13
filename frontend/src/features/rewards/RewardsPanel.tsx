import { useMemo, useState } from 'react';
import type { LeaderboardEntry, RewardTransition } from '../../api/types';
import { Badge } from '../../components/ui/Badge';
import { Chip } from '../../components/ui/Chip';
import { Sparkline } from '../../components/ui/Sparkline';
import { DataTable, type Column, type SortState } from '../../components/ui/DataTable';
import { EmptyState, SkeletonRows } from '../../components/ui/EmptyState';
import { PanelError } from '../../components/PanelError';
import { formatMicros, formatPercent, formatRelativeTime } from '../../lib/format';
import { useLeaderboard, useRewardTransitions } from '../../app/hooks';
import { useUi } from '../../stores/ui';

const KIND_TONE = {
  promotion: 'success',
  hire: 'info',
  probation: 'warning',
  demotion: 'danger',
  layoff: 'danger',
} as const;

/** Rewards (docs/09 §2.7): leaderboard + grade-transition log. */
export function RewardsPanel({ projectId, tabId }: { projectId: string; tabId: string }) {
  const [view, setView] = useState<'leaderboard' | 'transitions'>('leaderboard');
  const leaderboard = useLeaderboard(projectId);
  const transitions = useRewardTransitions(projectId);
  const [sort, setSort] = useState<SortState>({ key: 'score', dir: 'desc' });
  const openDrawer = useUi((s) => s.openDrawer);

  const rows: LeaderboardEntry[] = useMemo(
    () =>
      (leaderboard.data?.items ?? []).map((e, i) => ({ ...e, rank: e.rank ?? i + 1 })),
    [leaderboard.data],
  );

  const columns = useMemo<Array<Column<LeaderboardEntry>>>(
    () => [
      {
        key: 'rank',
        header: '#',
        width: '2.5rem',
        align: 'right',
        render: (e) => <span className="tabular-nums text-slate-500">{e.rank}</span>,
        sortValue: (e) => e.rank ?? 0,
      },
      {
        key: 'name',
        header: 'Agent',
        render: (e) => <span className="font-medium text-slate-100">{e.name}</span>,
        sortValue: (e) => e.name,
      },
      { key: 'role', header: 'Role', render: (e) => <span className="text-slate-300">{e.role ?? '—'}</span>, sortValue: (e) => e.role ?? '' },
      {
        key: 'grade',
        header: 'Grade',
        width: '4rem',
        align: 'center',
        render: (e) => (e.grade === undefined ? '—' : <Badge tone="accent">G{e.grade}</Badge>),
        sortValue: (e) => e.grade ?? -1,
      },
      {
        key: 'score',
        header: 'Score',
        width: '11rem',
        render: (e) => (
          <span className="flex items-center gap-2">
            <span className="tabular-nums text-slate-100">{e.score.toFixed(3)}</span>
            <Sparkline values={e.score_trend} width={64} height={18} />
          </span>
        ),
        sortValue: (e) => e.score,
      },
      {
        key: 'success',
        header: 'Success',
        width: '5.5rem',
        align: 'right',
        render: (e) => (
          <span className="tabular-nums" title={!(e.tasks_done ?? 0) ? 'No completed tasks yet' : undefined}>
            {!(e.tasks_done ?? 0) || e.success_rate === undefined ? '—' : formatPercent(e.success_rate)}
          </span>
        ),
        sortValue: (e) => e.success_rate ?? -1,
      },
      {
        key: 'cost',
        header: 'Cost',
        width: '5.5rem',
        align: 'right',
        render: (e) => <span className="tabular-nums">{e.cost_micros === undefined ? '—' : formatMicros(e.cost_micros)}</span>,
        sortValue: (e) => e.cost_micros ?? 0,
      },
    ],
    [],
  );

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1">
        <Chip selected={view === 'leaderboard'} onClick={() => setView('leaderboard')}>
          leaderboard
        </Chip>
        <Chip selected={view === 'transitions'} onClick={() => setView('transitions')}>
          grade transitions {transitions.data ? `(${transitions.data.total})` : ''}
        </Chip>
      </div>

      {view === 'leaderboard' && (
        <>
          {leaderboard.isLoading && <SkeletonRows rows={6} />}
          {leaderboard.isError && (
            <PanelError error={leaderboard.error} onRetry={() => void leaderboard.refetch()} label="Leaderboard" />
          )}
          {leaderboard.isSuccess && (
            <DataTable
              columns={columns}
              rows={rows}
              rowKey={(e) => e.agent_id ?? e.id}
              sort={sort}
              onSortChange={setSort}
              onRowClick={(e) => openDrawer(tabId, { kind: 'agent', id: e.agent_id ?? e.id, name: e.name })}
              empty={
                <EmptyState
                  title="No scores yet"
                  description="Reputation is earned on verified outcomes. Once a task passes verification, reward events roll up into this leaderboard."
                />
              }
            />
          )}
          <p className="text-[11px] text-slate-500">
            Reputation gates model tier, spend limits and seniority. Click a row for its full ledger.
          </p>
        </>
      )}

      {view === 'transitions' && (
        <>
          {transitions.isLoading && <SkeletonRows rows={5} />}
          {transitions.isError && (
            <PanelError
              error={transitions.error}
              onRetry={() => void transitions.refetch()}
              label="Transition log"
            />
          )}
          {transitions.isSuccess && transitions.data.items.length === 0 && (
            <EmptyState
              title="No grade changes"
              description="Promotions, probations, demotions and layoffs appear here with the rule that fired."
            />
          )}
          {transitions.isSuccess && transitions.data.items.length > 0 && (
            <ul className="divide-y divide-slate-800/70 overflow-hidden rounded-lg border border-slate-700/60 text-xs">
              {transitions.data.items.map((t: RewardTransition) => (
                <li key={t.id} className="flex items-center gap-2 px-2.5 py-1.5">
                  <Badge tone={KIND_TONE[t.kind] ?? 'neutral'}>{t.kind}</Badge>
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left text-slate-200 hover:text-emerald-300"
                    onClick={() => openDrawer(tabId, { kind: 'agent', id: t.agent_id, name: t.agent_name })}
                  >
                    {t.agent_name ?? t.agent_id.slice(0, 8)}
                  </button>
                  <span className="tabular-nums text-slate-400">
                    G{t.from_grade ?? '—'} → G{t.to_grade ?? '—'}
                  </span>
                  {t.score_after !== undefined && (
                    <span className="tabular-nums text-slate-500">score {t.score_after.toFixed(3)}</span>
                  )}
                  {t.rule && <span className="truncate text-slate-500" title={t.rule}>rule: {t.rule}</span>}
                  <span className="shrink-0 text-slate-500">{formatRelativeTime(t.created_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
