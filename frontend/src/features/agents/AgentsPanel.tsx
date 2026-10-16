import { useMemo, useState } from 'react';
import type { LeaderboardEntry, OrgNode } from '../../api/types';
import { Badge } from '../../components/ui/Badge';
import { Chip } from '../../components/ui/Chip';
import { Sparkline } from '../../components/ui/Sparkline';
import { DataTable, type Column, type SortState } from '../../components/ui/DataTable';
import { Button } from '../../components/ui/Button';
import { Field, Input, Select } from '../../components/ui/Field';
import { StatusDot, dotForState } from '../../components/ui/StatusDot';
import { EmptyState, SkeletonRows } from '../../components/ui/EmptyState';
import { PanelError } from '../../components/PanelError';
import { formatMicros, formatPercent } from '../../lib/format';
import { useLeaderboard, useOrg, useTasks } from '../../app/hooks';
import { useTabs } from '../../stores/tabs';
import { useUi } from '../../stores/ui';
import { flattenOrg, gradeLabel } from '../org/orgUtils';

interface AgentRow {
  id: string;
  name: string;
  role: string;
  grade?: number;
  state?: string;
  score?: number;
  cost?: number;
  successRate?: number;
  tasksDone?: number;
  skills: number;
  departmentId?: string | null;
  trend?: number[];
  currentTask?: string;
  lastActive?: string | null;
}

type View = 'all' | 'top' | 'at-risk';

export function AgentsPanel({ projectId, tabId }: { projectId: string; tabId: string }) {
  const org = useOrg(projectId);
  const leaderboard = useLeaderboard(projectId);
  const tasks = useTasks(projectId);
  const tab = useTabs((s) => s.tabs.find((t) => t.id === tabId));
  const setFilters = useTabs((s) => s.setFilters);
  const openDrawer = useUi((s) => s.openDrawer);

  const [sort, setSort] = useState<SortState>({ key: 'score', dir: 'desc' });
  const [view, setView] = useState<View>('all');

  const deptFilter = tab?.filters.agentDept ?? '';
  const search = tab?.filters.agentQuery ?? '';

  const departments = useMemo(
    () => flattenOrg(org.data?.root).filter((n) => n.kind === 'department'),
    [org.data],
  );

  const rows = useMemo<AgentRow[]>(() => {
    const agents = flattenOrg(org.data?.root).filter((n) => n.kind === 'agent');
    const lb = new Map<string, LeaderboardEntry>(
      // Join on the canonical id; `agent_id` rides along as an additive alias (review 2026-10-14).
      (leaderboard.data?.items ?? []).map((e) => [e.agent_id ?? e.id, e]),
    );
    const taskItems = tasks.data?.items ?? [];

    const merged: AgentRow[] = agents.map((a: OrgNode) => {
      const entry = lb.get(a.id);
      const current = taskItems.find(
        (t) =>
          t.assignee_agent_id === a.id &&
          ['assigned', 'running', 'verifying', 'escalated'].includes(t.state),
      );
      return {
        id: a.id,
        name: a.name,
        role: a.role ?? entry?.role ?? 'n/a',
        grade: a.grade ?? entry?.grade,
        state: a.state,
        score: a.score ?? entry?.score,
        cost: a.spend_micros ?? a.cost_micros ?? entry?.cost_micros,
        successRate: a.success_rate ?? entry?.success_rate,
        tasksDone: a.tasks_done ?? entry?.tasks_done,
        skills: (a as OrgNode & { skills?: unknown[] }).skills?.length ?? 0,
        departmentId: a.department_id,
        trend: entry?.score_trend,
        currentTask: current?.title,
        lastActive: null,
      };
    });

    return merged;
  }, [org.data, leaderboard.data, tasks.data]);

  const filtered = useMemo(() => {
    let out = rows;
    if (deptFilter) out = out.filter((r) => r.departmentId === deptFilter);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      out = out.filter((r) => `${r.name} ${r.role}`.toLowerCase().includes(q));
    }
    if (view === 'at-risk') {
      out = out.filter((r) => (r.score ?? 1) < 0.5 || r.state === 'probation' || r.state === 'suspended');
    } else if (view === 'top') {
      out = [...out].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 10);
    }
    return out;
  }, [rows, deptFilter, search, view]);

  const columns = useMemo<Array<Column<AgentRow>>>(
    () => [
      {
        key: 'name',
        header: 'Agent',
        render: (r) => (
          <span className="flex items-center gap-1.5">
            <StatusDot state={dotForState(r.state)} />
            <span className="truncate font-medium text-slate-100">{r.name}</span>
          </span>
        ),
        sortValue: (r) => r.name,
      },
      { key: 'role', header: 'Role', render: (r) => <span className="text-slate-300">{r.role}</span>, sortValue: (r) => r.role },
      {
        key: 'grade',
        header: 'Grade',
        width: '4rem',
        align: 'center',
        render: (r) =>
          r.grade === undefined ? 'n/a' : (
            <Badge tone="accent" title={gradeLabel(r.grade)}>
              {`G${r.grade}`}
            </Badge>
          ),
        sortValue: (r) => r.grade ?? -1,
      },
      {
        key: 'score',
        header: (
          <span title="Reputation 0–1, earned from verified work only, it gates model tier, spend limits and seniority.">
            Score
          </span>
        ),
        width: '11rem',
        render: (r) => (
          <span className="flex items-center gap-2">
            <span
              className="tabular-nums text-slate-100"
              title="Reputation 0–1, earned from verified work only"
            >
              {r.score === undefined ? 'n/a' : r.score.toFixed(3)}
            </span>
            <Sparkline values={r.trend} width={64} height={18} />
          </span>
        ),
        sortValue: (r) => r.score ?? -1,
      },
      {
        key: 'state',
        header: 'State',
        width: '5.5rem',
        render: (r) => <Badge tone={r.state === 'busy' ? 'info' : r.state === 'probation' ? 'warning' : 'muted'}>{r.state ?? 'n/a'}</Badge>,
        sortValue: (r) => r.state ?? '',
      },
      {
        key: 'task',
        header: 'Current task',
        render: (r) => <span className="block max-w-[16rem] truncate text-slate-400">{r.currentTask ?? 'n/a'}</span>,
      },
      {
        key: 'cost',
        header: 'Cost',
        width: '5.5rem',
        align: 'right',
        render: (r) => <span className="tabular-nums">{r.cost === undefined ? 'n/a' : formatMicros(r.cost)}</span>,
        sortValue: (r) => r.cost ?? 0,
      },
      {
        key: 'success',
        header: 'Success',
        width: '5.5rem',
        align: 'right',
        render: (r) => {
          if (!r.tasksDone) {
            // no work yet is not a 0% success rate, say nothing rather than something wrong
            return (
              <span className="text-slate-500" title="No completed tasks yet">
              ,
              </span>
            );
          }
          return (
            <span className="tabular-nums">
              {r.successRate === undefined ? 'n/a' : formatPercent(r.successRate)}
            </span>
          );
        },
        sortValue: (r) => (r.tasksDone ? r.successRate ?? -1 : -1),
      },
    ],
    [],
  );

  if (org.isLoading) return <SkeletonRows rows={6} />;
  if (org.isError) return <PanelError error={org.error} onRetry={() => void org.refetch()} label="Agent roster" />;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="search" className="w-44">
          <Input
            value={search}
            onChange={(e) => setFilters(tabId, { agentQuery: e.target.value || undefined })}
            placeholder="name or role"
            className="h-7 text-xs"
          />
        </Field>
        <Field label="department" className="w-44">
          <Select
            value={deptFilter}
            onChange={(e) => setFilters(tabId, { agentDept: e.target.value || undefined })}
            className="h-7 text-xs"
          >
            <option value="">all departments</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex items-center gap-1 pb-0.5">
          {(['all', 'top', 'at-risk'] as View[]).map((v) => (
            <Chip key={v} tone={v === 'at-risk' ? 'danger' : 'neutral'} selected={view === v} onClick={() => setView(v)}>
              {v === 'at-risk' ? 'at risk' : v}
            </Chip>
          ))}
        </div>
        <span className="ml-auto text-[11px] tabular-nums text-slate-500">{filtered.length} agents</span>
        <Button size="xs" variant="ghost" onClick={() => void org.refetch()}>
          refresh
        </Button>
      </div>

      {leaderboard.isError && (
        <p className="text-[11px] text-amber-300/80">
          Score trends unavailable ({leaderboard.error instanceof Error ? leaderboard.error.message : 'leaderboard failed'}).
        </p>
      )}

      <DataTable
        columns={columns}
        rows={filtered}
        rowKey={(r) => r.id}
        sort={sort}
        onSortChange={setSort}
        loading={org.isLoading}
        onRowClick={(r) => openDrawer(tabId, { kind: 'agent', id: r.id, name: r.name })}
        empty={
          <EmptyState
            title="No agents"
            description="Nobody has been hired yet. Start a run, the orchestrator derives the capability requirements from the goal and builds the org, or hire someone manually from the Org tab."
          />
        }
      />
      <p className="text-[11px] text-slate-500">
        Names, roles and grades come from the live org tree; scores are reputation earned from
        verified work only. Per-day spend and last-active live in the agent drawer.
      </p>
    </div>
  );
}
