import { useMemo, useState } from 'react';
import type { Task, TaskState } from '../../api/types';
import { Badge, type Tone } from '../../components/ui/Badge';
import { Chip } from '../../components/ui/Chip';
import { DataTable, type Column, type SortState } from '../../components/ui/DataTable';
import { Button } from '../../components/ui/Button';
import { Field, Select, Unknown } from '../../components/ui/Field';
import { EmptyState } from '../../components/ui/EmptyState';
import { PanelError } from '../../components/PanelError';
import { formatMicros } from '../../lib/format';
import { useOrg, useProject, useTasks } from '../../app/hooks';
import { flattenOrg } from '../org/orgUtils';
import { useTabs } from '../../stores/tabs';
import { useUi } from '../../stores/ui';

const STATE_TONE: Record<TaskState, Tone> = {
  pending: 'muted',
  blocked: 'warning',
  ready: 'info',
  assigned: 'info',
  running: 'accent',
  verifying: 'warning',
  completed: 'success',
  failed: 'danger',
  aborted: 'muted',
  escalated: 'danger',
};

const STATES: TaskState[] = [
  'pending',
  'blocked',
  'ready',
  'assigned',
  'running',
  'verifying',
  'completed',
  'failed',
  'aborted',
  'escalated',
];

export function TasksPanel({ projectId, tabId }: { projectId: string; tabId: string }) {
  const tab = useTabs((s) => s.tabs.find((t) => t.id === tabId));
  const setFilters = useTabs((s) => s.setFilters);
  const setInternalTab = useTabs((s) => s.setInternalTab);
  const openDrawer = useUi((s) => s.openDrawer);

  const stateFilter = tab?.filters.taskState ?? '';
  const runScope = tab?.filters.taskRun ?? 'latest';
  const project = useProject(projectId);
  const [sort, setSort] = useState<SortState>({ key: 'state', dir: 'asc' });

  const tasks = useTasks(projectId, { state: stateFilter || undefined,
    run: runScope === 'latest' ? project.data?.latest_run_id ?? undefined : undefined });
  const rows = tasks.data?.items ?? [];

  // the roster turns raw ids into names — a table of agent ids reads like machine output
  const org = useOrg(projectId);
  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const u of flattenOrg(org.data?.root)) m.set(u.id, u.name);
    return m;
  }, [org.data]);

  const columns = useMemo<Array<Column<Task>>>(
    () => [
      {
        key: 'title',
        header: 'Task',
        render: (t) => (
          <span className="block max-w-[22rem] truncate" title={t.description ?? t.title}>
            {t.title}
          </span>
        ),
        sortValue: (t) => t.title,
      },
      {
        key: 'state',
        header: 'State',
        width: '8.5rem',
        render: (t) => <Badge tone={STATE_TONE[t.state] ?? 'neutral'}>{t.state}</Badge>,
        sortValue: (t) => STATES.indexOf(t.state),
      },
      {
        key: 'assignee',
        header: 'Assignee',
        width: '9rem',
        render: (t) => {
          if (t.assignee_agent_id) {
            const nm = nameById.get(t.assignee_agent_id);
            return (
              <span className="text-[11px] text-slate-300" title={t.assignee_agent_id}>
                {nm ?? 'Agent unavailable'}
              </span>
            );
          }
          if (t.assignee_squad_id) {
            return (
              <span className="text-[11px] text-slate-400">
                {nameById.get(t.assignee_squad_id) ?? 'squad'}
              </span>
            );
          }
          return <Unknown />;
        },
        sortValue: (t) => nameById.get(t.assignee_agent_id ?? '') ?? t.assignee_agent_id ?? '',
      },
      {
        key: 'effort',
        header: 'Effort',
        width: '4.5rem',
        align: 'center',
        render: (t) => (t.effort ? <Badge tone="muted">{t.effort}</Badge> : <Unknown />),
        sortValue: (t) => ({ S: 0, M: 1, L: 2, XL: 3 })[t.effort ?? 'M'] ?? 9,
      },
      {
        key: 'cost',
        header: 'Est. cost',
        width: '5.5rem',
        align: 'right',
        render: (t) => (
          <span className="tabular-nums">{t.cost_micros === undefined ? '—' : formatMicros(t.cost_micros)}</span>
        ),
        sortValue: (t) => t.cost_micros ?? 0,
      },
      {
        key: 'attempts',
        header: 'Attempts',
        width: '5.5rem',
        align: 'right',
        render: (t) => <span className="tabular-nums">{t.attempts ?? '—'}</span>,
        sortValue: (t) => t.attempts ?? 0,
      },
      {
        key: 'verification',
        header: 'Verification',
        width: '7rem',
        render: (t) =>
          t.verification?.verdict ? (
            <Badge tone={t.verification.verdict === 'pass' ? 'success' : t.verification.verdict === 'fail' ? 'danger' : 'warning'}>
              {t.verification.verdict}
            </Badge>
          ) : (
            <Unknown title="Open the task to read its verdict" />
          ),
      },
    ],
    [nameById],
  );

  if (tasks.isError) {
    return <PanelError error={tasks.error} onRetry={() => void tasks.refetch()} label="Task list" />;
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        {project.data?.latest_run_id && <Field label="Run" className="w-40">
          <Select aria-label="Task run" value={runScope} onChange={event => setFilters(tabId, { taskRun: event.target.value as 'latest' | 'all' })}>
            <option value="latest">Latest run</option><option value="all">All runs</option>
          </Select>
        </Field>}
        <Field label="state" className="w-40">
          <Select
            value={stateFilter}
            onChange={(e) => setFilters(tabId, { taskState: e.target.value || undefined })}
            className="h-7 text-xs"
          >
            <option value="">all states</option>
            {STATES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex flex-wrap items-center gap-1">
          {(['running', 'verifying', 'blocked', 'escalated'] as TaskState[]).map((s) => (
            <Chip
              key={s}
              tone={STATE_TONE[s]}
              selected={stateFilter === s}
              onClick={() => setFilters(tabId, { taskState: stateFilter === s ? undefined : s })}
            >
              {s}
            </Chip>
          ))}
        </div>
        <span className="ml-auto text-[11px] text-slate-500 tabular-nums">
          {rows.length} tasks shown
        </span>
        <Button size="xs" variant="ghost" onClick={() => void tasks.refetch()}>
          refresh
        </Button>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(t) => t.id}
        sort={sort}
        onSortChange={setSort}
        loading={tasks.isLoading}
        onRowClick={(t) => openDrawer(tabId, { kind: 'task', id: t.id, name: t.title })}
        empty={
          <EmptyState
            title={stateFilter ? 'No matching tasks' : 'No tasks yet'}
            description={stateFilter ? 'Choose All states to see the other tasks in this view.' : 'Start a run from Overview. Your company manager will turn the goal into a plan and assign tasks to the team.'}
            action={
              <Button size="sm" variant="primary" onClick={() => stateFilter ? setFilters(tabId, { taskState: undefined }) : setInternalTab(tabId, 'overview')}>
                {stateFilter ? 'Clear state filter' : 'Go to Overview'}
              </Button>
            }
          />
        }
      />
    </div>
  );
}
