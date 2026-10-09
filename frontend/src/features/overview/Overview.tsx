import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '../../api/client';
import { Button } from '../../components/ui/Button';
import { Badge, severityTone } from '../../components/ui/Badge';
import { Card, StatCard } from '../../components/ui/Card';
import { Modal } from '../../components/ui/Drawer';
import { Field, Select, Textarea } from '../../components/ui/Field';
import { EmptyState, SkeletonRows } from '../../components/ui/EmptyState';
import { PanelError } from '../../components/PanelError';
import { formatClock, formatMicros, formatPercent, formatRelativeTime } from '../../lib/format';
import {
  useApprovals,
  useOrg,
  useProject,
  useProjectMetrics,
  useTasks,
} from '../../app/hooks';
import { selectEventLog, useEventLog } from '../../stores/eventLog';
import { useUi } from '../../stores/ui';
import { flattenOrg, orgCounts } from '../org/orgUtils';

/** Mission control (docs/09 §2.1). */
export function Overview({ projectId, tabId }: { projectId: string; tabId: string }) {
  const project = useProject(projectId);
  const metrics = useProjectMetrics(projectId);
  const tasks = useTasks(projectId);
  const org = useOrg(projectId);
  const approvals = useApprovals(projectId, 'pending');
  const log = useEventLog(selectEventLog(projectId));
  const openDrawer = useUi((s) => s.openDrawer);

  const units = useMemo(() => flattenOrg(org.data?.root), [org.data]);
  const counts = useMemo(() => orgCounts(units), [units]);

  const taskItems = tasks.data?.items ?? [];
  const done = taskItems.filter((t) => t.state === 'completed').length;
  const total = tasks.data?.total ?? taskItems.length;
  const pending = approvals.data?.items.length ?? project.data?.pending_approvals ?? 0;

  const successRate =
    metrics.data?.task_success_rate ?? metrics.data?.success_rate ?? project.data?.success_rate;
  const spend = project.data?.spend_micros ?? metrics.data?.cost_micros ?? 0;
  const cap = project.data?.budget_cap_micros ?? 0;

  const recent = log.items.slice(-50).reverse();

  // Cumulative burn by event — real data, straight off the firehose.
  const burn = useMemo(() => {
    let cum = 0;
    return log.items
      .filter((e) => (e.cost_micros ?? 0) > 0)
      .slice(-200)
      .map((e) => {
        cum += e.cost_micros ?? 0;
        return { seq: e.seq, usd: Number((cum / 1_000_000).toFixed(4)) };
      });
  }, [log.items]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <StatCard
          label="Tasks"
          value={`${done}/${total || '—'}`}
          hint={total ? formatPercent(total ? done / total : 0) + ' complete' : 'no plan yet'}
          tone={total > 0 && done === total ? 'success' : 'neutral'}
        />
        <StatCard
          label="Org size"
          value={counts.agent || '—'}
          hint={`${counts.department} dept · ${counts.squad} squad`}
        />
        <StatCard
          label="Spend"
          value={formatMicros(spend)}
          hint={`of ${formatMicros(cap)}`}
          tone={cap > 0 && spend / cap > 0.9 ? 'danger' : cap > 0 && spend / cap > 0.7 ? 'warning' : 'neutral'}
        />
        <StatCard
          label="Success rate"
          value={successRate !== undefined ? formatPercent(successRate) : '—'}
          tone={successRate !== undefined && successRate >= 0.8 ? 'success' : 'neutral'}
        />
        <StatCard
          label="Pending approvals"
          value={pending}
          tone={pending > 0 ? 'warning' : 'neutral'}
          hint={pending > 0 ? 'need you' : 'nothing waiting'}
        />
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <Card
          title="Start a run"
          subtitle="The orchestrator plans, staffs and executes."
          className="lg:col-span-1"
        >
          <StartRunForm projectId={projectId} defaultGoal={project.data?.goal ?? ''} />
        </Card>

        <Card title="Budget burn" subtitle="Cumulative cost by event seq (live)" className="lg:col-span-2">
          {burn.length < 2 ? (
            <p className="py-6 text-center text-xs text-slate-500">
              No spend events yet — the chart fills as the org works.
            </p>
          ) : (
            <div className="h-40">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={burn} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="burnFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#34d399" stopOpacity={0.5} />
                      <stop offset="100%" stopColor="#34d399" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="seq" hide />
                  <YAxis
                    width={54}
                    tick={{ fill: '#64748b', fontSize: 10 }}
                    tickFormatter={(v: number) =>
                      v !== 0 && Math.abs(v) < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`}
                  />
                  <Tooltip
                    contentStyle={{ background: '#0f172a', border: '1px solid #334155', fontSize: 11 }}
                    formatter={(v: number) => [`$${v.toFixed(4)}`, 'cumulative']}
                    labelFormatter={(l) => `seq ${l}`}
                  />
                  <Area type="monotone" dataKey="usd" stroke="#34d399" fill="url(#burnFill)" strokeWidth={1.5} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>
      </div>

      <Card
        title="Activity"
        subtitle={`${recent.length} recent events — click a row to jump to its unit`}
        actions={
          <span className="text-[11px] text-slate-500">
            stream {log.maxSeq > 0 ? `@ seq ${log.maxSeq}` : 'idle'}
          </span>
        }
      >
        {recent.length === 0 ? (
          <EmptyState
            title="Nothing has happened yet"
            description="Start a run and the whole org's thinking appears here, event by event."
          />
        ) : (
          <ul className="max-h-72 divide-y divide-slate-800/60 overflow-y-auto">
            {recent.map((e) => (
              <li key={e.id}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-1 py-1 text-left text-xs hover:bg-slate-800/40"
                  onClick={() => {
                    if (e.agent_id) openDrawer(tabId, { kind: 'agent', id: e.agent_id });
                    else if (e.task_id) openDrawer(tabId, { kind: 'task', id: e.task_id });
                  }}
                >
                  <span className="shrink-0 font-mono text-[10px] text-slate-500">{formatClock(e.ts)}</span>
                  <Badge tone={severityTone(e.severity)}>{e.type}</Badge>
                  <span className="min-w-0 flex-1 truncate text-slate-300">{e.title}</span>
                  {e.actor && <span className="shrink-0 text-[10px] text-slate-500">{e.actor}</span>}
                  {typeof e.cost_micros === 'number' && e.cost_micros > 0 && (
                    <span className="shrink-0 tabular-nums text-[10px] text-slate-500">
                      {formatMicros(e.cost_micros)}
                    </span>
                  )}
                  <span className="shrink-0 text-[10px] text-slate-600">{formatRelativeTime(e.ts)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {tasks.isLoading && <SkeletonRows rows={3} />}
      {metrics.isError && <PanelError error={metrics.error} label="Metrics" />}
    </div>
  );
}

function StartRunForm({ projectId, defaultGoal }: { projectId: string; defaultGoal: string }) {
  const [goal, setGoal] = useState(defaultGoal);
  const [mode, setMode] = useState<'interactive' | 'autonomous'>('interactive');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [skipAsk, setSkipAsk] = useState(false);
  const qc = useQueryClient();
  const setToast = useUi((s) => s.setToast);
  const project = useProject(projectId);
  const tasks = useTasks(projectId);
  const items = tasks.data?.items ?? [];
  const done = items.filter((t) => t.state === 'completed').length;
  const total = tasks.data?.total ?? items.length;
  const stage = project.data?.stage ?? 'IDLE';
  const runActive = !['IDLE', 'DONE', ''].includes(stage);
  const needsConfirm = !skipAsk && (runActive || done > 0);

  const start = useMutation({
    mutationFn: () => api.startRun(projectId, { goal: goal.trim() || defaultGoal, mode }),
    onSuccess: () => {
      setToast({ kind: 'success', message: 'Run accepted — watching the event stream.' });
      void qc.invalidateQueries({ queryKey: ['project', projectId] });
    },
    onError: (err) => setToast({ kind: 'error', message: String(err) }),
  });

  return (
    <>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (needsConfirm) {
            setConfirmOpen(true);   // a fresh run re-plans from scratch — say so first
            return;
          }
          start.mutate();
        }}
      >
        <Field label="Goal">
          <Textarea value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="What should the org achieve?" />
        </Field>
        <Field
          label="Mode"
          hint={
            mode === 'autonomous'
              ? 'Runs without asking you for confirmation.'
              : 'Pauses for your confirmation at key gates.'
          }
        >
          <Select value={mode} onChange={(e) => setMode(e.target.value as 'interactive' | 'autonomous')}>
            <option value="interactive">interactive</option>
            <option value="autonomous">autonomous</option>
          </Select>
        </Field>
        <Button type="submit" variant="primary" loading={start.isPending} disabled={!(goal.trim() || defaultGoal)}>
          ▶ Start run
        </Button>
        <ProgressHint projectId={projectId} />
      </form>
      <Modal
        open={confirmOpen}
        title={runActive ? 'A run is already in progress' : 'Start a new run?'}
        onClose={() => setConfirmOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={start.isPending}
              onClick={() => {
                setConfirmOpen(false);
                start.mutate();
              }}
            >
              Start anyway
            </Button>
          </>
        }
      >
        <p className="text-xs text-slate-400">
          {runActive
            ? `The project is at stage ${stage}.`
            : `A previous pass already completed ${done} of ${total} tasks.`}
        </p>
        <p className="mt-2 text-sm text-slate-300">
          A new run <span className="text-slate-100">re-plans the goal from scratch</span> — it does not
          continue the previous run and will redo (and re-charge) equivalent work. If you want the org to
          build on what it already made, edit the goal first.
        </p>
        <label className="mt-3 flex items-center gap-2 text-xs text-slate-400">
          <input
            type="checkbox"
            checked={skipAsk}
            onChange={(e) => setSkipAsk(e.target.checked)}
            className="accent-emerald-500"
          />
          Don't ask again this session
        </label>
      </Modal>
    </>
  );
}

function ProgressHint({ projectId }: { projectId: string }) {
  const tasks = useTasks(projectId);
  const project = useProject(projectId);
  const items = tasks.data?.items ?? [];
  const total = tasks.data?.total ?? items.length;
  if (total === 0) return null;
  const done = items.filter((t) => t.state === 'completed').length;
  return (
    <div className="pt-1">
      <div className="mb-1 text-[11px] text-slate-500">
        previous run: {done}/{total} tasks · stage {project.data?.stage ?? '—'}
      </div>
    </div>
  );
}
