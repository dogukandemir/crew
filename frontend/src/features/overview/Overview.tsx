import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { TooltipValueType } from 'recharts';
import { api } from '../../api/client';
import { Button } from '../../components/ui/Button';
import { Badge, severityTone } from '../../components/ui/Badge';
import { Card, StatCard } from '../../components/ui/Card';
import { Modal } from '../../components/ui/Drawer';
import { Field, Select, Textarea } from '../../components/ui/Field';
import { EmptyState, SkeletonRows } from '../../components/ui/EmptyState';
import { PanelError } from '../../components/PanelError';
import { formatClockUtc, formatMicros, formatPercent, formatRelativeTime } from '../../lib/format';
import { useNow } from '../../lib/useNow';
import {
  useApprovals,
  useOnboardingState,
  useOrg,
  useProject,
  useProjectMetrics,
  useRuns,
  useTasks,
} from '../../app/hooks';
import { selectEventLog, useEventLog } from '../../stores/eventLog';
import { useUi } from '../../stores/ui';
import { flattenOrg, orgCounts } from '../org/orgUtils';
import { latestRunTasks } from '../../sim/currentWork';
import { hasActiveRun } from '../projects/runState';

/** Mission control (docs/09 §2.1). */
export function Overview({ projectId, tabId }: { projectId: string; tabId: string }) {
  const project = useProject(projectId);
  const metrics = useProjectMetrics(projectId);
  const tasks = useTasks(projectId);
  const org = useOrg(projectId);
  const approvals = useApprovals(projectId, 'pending');
  const log = useEventLog(selectEventLog(projectId));
  const openDrawer = useUi((s) => s.openDrawer);
  // The feed is pushed, not polled: the age label needs its own ticking clock.
  const now = useNow();

  const units = useMemo(() => flattenOrg(org.data?.root), [org.data]);
  const counts = useMemo(() => orgCounts(units), [units]);

  const runs = useRuns(projectId);
  const gate = runs.data?.find((run) =>
    run.status === 'pending_confirmation' || run.status === 'pending_clarification');
  const taskItems = latestRunTasks(tasks.data?.items ?? [], project.data);
  const done = taskItems.filter((t) => t.state === 'completed').length;
  const total = taskItems.length;
  const pending = (approvals.data?.items.length ?? project.data?.pending_approvals ?? 0) + (gate ? 1 : 0);

  // Never a fabricated 0%: with no finished task history the rate is unknown, not zero
  // (review 2026-10-14, the API reports 0.0 for an empty denominator).
  const hasTaskHistory = (metrics.data?.tasks_total ?? total) > 0;
  const successRate = hasTaskHistory
    ? metrics.data?.task_success_rate ?? metrics.data?.success_rate ?? project.data?.success_rate
    : undefined;
  const spend = project.data?.spend_micros ?? metrics.data?.cost_micros ?? 0;
  const cap = project.data?.budget_cap_micros ?? 0;

  const recent = log.items.slice(-50).reverse();

  // Cumulative burn by event, real data, straight off the firehose.
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
          label="Latest run tasks"
          value={`${done}/${total || 'n/a'}`}
          hint={total ? formatPercent(total ? done / total : 0) + ' complete' : 'no plan yet'}
          tone={total > 0 && done === total ? 'success' : 'neutral'}
        />
        <StatCard
          label="Org size"
          value={counts.agent || 'n/a'}
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
          value={successRate !== undefined ? formatPercent(successRate) : 'n/a'}
          tone={successRate !== undefined && successRate >= 0.8 ? 'success' : 'neutral'}
        />
        <StatCard
          label="Waiting on you"
          value={pending}
          tone={pending > 0 ? 'warning' : 'neutral'}
          hint={pending > 0 ? 'approvals or confirmations' : 'nothing waiting'}
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
            <p className="py-6 text-center text-xs text-slate-400">
              No spend events yet, the chart fills as the org works.
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
                    formatter={(v: TooltipValueType | undefined) => {
                      // Recharts 3 widens a tooltip value to ValueType | undefined;
                      // format only real numbers and never print a fake "$NaN".
                      const usd = typeof v === 'number' && Number.isFinite(v) ? v : null;
                      return [usd === null ? 'n/a' : `$${usd.toFixed(4)}`, 'cumulative'];
                    }}
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
        subtitle={`${recent.length} recent events, click a row to jump to its unit`}
        actions={
          <span className="text-[11px] text-slate-400">
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
                  {/* The record is UTC. The clock is printed in UTC with its label
                      on every row, and the age beside it stays this machine's
                      "how long ago". */}
                  <span
                    className="shrink-0 whitespace-nowrap font-mono text-[10px] tabular-nums text-slate-400"
                    title={`${e.ts} recorded in UTC`}
                  >
                    {formatClockUtc(e.ts)}
                    <span className="ml-0.5 text-[9px] uppercase tracking-wide text-slate-400">UTC</span>
                  </span>
                  <Badge tone={severityTone(e.severity)}>{e.type}</Badge>
                  <span className="min-w-0 flex-1 truncate text-slate-300">{e.title}</span>
                  {e.actor && <span className="shrink-0 text-[10px] text-slate-400">{e.actor}</span>}
                  {typeof e.cost_micros === 'number' && e.cost_micros > 0 && (
                    <span className="shrink-0 tabular-nums text-[10px] text-slate-400">
                      {formatMicros(e.cost_micros)}
                    </span>
                  )}
                  <span className="shrink-0 text-[10px] text-slate-400">{formatRelativeTime(e.ts, now)}</span>
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
  const editedGoal = useRef(false);
  useEffect(() => { if (!editedGoal.current) setGoal(defaultGoal); }, [defaultGoal]);
  const runs = useRuns(projectId);
  // The form opens on the project's ACTUAL last-run mode: the select is not a second
  // source of truth for how the org runs (it used to reset to Guided on every mount,
  // which read as if the chosen Autonomous mode had flipped back).
  const lastMode = runs.data?.[0]?.mode;
  const [mode, setMode] = useState<'interactive' | 'autonomous'>('interactive');
  const modeTouched = useRef(false);
  useEffect(() => {
    if (!modeTouched.current && (lastMode === 'interactive' || lastMode === 'autonomous')) {
      setMode(lastMode);
    }
  }, [lastMode]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [skipAsk, setSkipAsk] = useState(false);
  const qc = useQueryClient();
  const setToast = useUi((s) => s.setToast);
  const project = useProject(projectId);
  const onboarding = useOnboardingState();
  const tasks = useTasks(projectId);
  const items = latestRunTasks(tasks.data?.items ?? [], project.data);
  const done = items.filter((t) => t.state === 'completed').length;
  const total = items.length;
  const stage = project.data?.stage ?? 'IDLE';
  const runActive = project.data ? hasActiveRun(project.data) : false;
  const needsConfirm = !skipAsk && (runActive || done > 0);

  const start = useMutation({
    mutationFn: () => api.startRun(projectId, { goal: goal.trim() || defaultGoal, mode }),
    onSuccess: () => {
      setToast({ kind: 'success', message: 'Run accepted, watching the event stream.' });
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
          if (runActive) return;
          if (needsConfirm) {
            setConfirmOpen(true);   // a fresh run re-plans from scratch, say so first
            return;
          }
          start.mutate();
        }}
      >
        <Field label="Goal">
          <Textarea value={goal} onChange={(e) => { editedGoal.current = true; setGoal(e.target.value); }} placeholder="What should the org achieve?" />
        </Field>
        <Field
          label="Mode"
          hint={
            mode === 'autonomous'
              ? 'Plans and schedules work automatically. Tool approvals and spending caps still apply.'
              : 'Keeps you involved at run checkpoints. Tool approvals and spending caps still apply.'
          }
        >
          <Select value={mode} onChange={(e) => { modeTouched.current = true; setMode(e.target.value as 'interactive' | 'autonomous'); }}>
            <option value="interactive">Guided</option>
            <option value="autonomous">Autonomous</option>
          </Select>
        </Field>
        {runActive && <p className="text-xs text-amber-200" role="status">A run is already in progress. Review or resume it before starting another.</p>}
        {onboarding.data?.offline_llm && (
          <p className="text-[11px] text-slate-400">
            Demo runs use a fixed simulated plan: the goal is recorded, but it does not change the plan.
          </p>
        )}
        <Button type="submit" variant="primary" loading={start.isPending} disabled={runActive || !(goal.trim() || defaultGoal)}>
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
              Start new run
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
          A new run <span className="text-slate-100">re-plans the goal from scratch</span>, it does not
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
  // Both numbers from ONE source: the latest run's tasks. The page envelope's `total`
  // covers the whole project, which made "previous run: 80/430" un-reachable and false
  // (review 2026-10-14).
  const items = latestRunTasks(tasks.data?.items ?? [], project.data);
  const total = items.length;
  if (total === 0) return null;
  const done = items.filter((t) => t.state === 'completed').length;
  return (
    <div className="pt-1">
      <div className="mb-1 text-[11px] text-slate-400">
        previous run: {done}/{total} tasks · stage {project.data?.stage ?? 'n/a'}
      </div>
    </div>
  );
}
