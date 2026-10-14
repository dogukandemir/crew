import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { Drawer } from '../../components/ui/Drawer';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Input, Field } from '../../components/ui/Field';
import { KeyValue } from '../../components/ui/Tabs';
import { JsonView } from '../../components/ui/JsonView';
import { SkeletonRows } from '../../components/ui/EmptyState';
import { PanelError } from '../../components/PanelError';
import { formatDuration, formatMicros, formatPercent, formatTokens, skillLabel } from '../../lib/format';
import { useOrg, useTask, useTaskArtifacts, useTasks } from '../../app/hooks';
import { flattenOrg } from '../org/orgUtils';
import { useUi } from '../../stores/ui';

const VERDICT_TONE = {
  pass: 'success',
  pass_with_notes: 'info',
  fail: 'danger',
  inconclusive: 'warning',
} as const;

/** Task detail drawer (docs/09 §2.3). */
export function TaskDrawer({
  taskId,
  projectId,
  onClose,
}: {
  taskId: string;
  projectId: string;
  onClose: () => void;
}) {
  const task = useTask(taskId);
  const artifacts = useTaskArtifacts(taskId);
  const org = useOrg(projectId);
  const tasks = useTasks(projectId);
  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const u of flattenOrg(org.data?.root)) m.set(u.id, u.name);
    return m;
  }, [org.data]);
  const agents = useMemo(
    () => flattenOrg(org.data?.root).filter((u) => u.kind === 'agent'),
    [org.data],
  );
  const titleById = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of tasks.data?.items ?? []) m.set(t.id, t.title);
    return m;
  }, [tasks.data]);
  const qc = useQueryClient();
  const setToast = useUi((s) => s.setToast);
  const [reassignTo, setReassignTo] = useState('');
  const [reason, setReason] = useState('');

  const act = useMutation({
    mutationFn: async (kind: 'retry' | 'cancel' | 'reassign' | 'escalate') => {
      if (kind === 'retry') return api.retryTask(taskId, reason || undefined);
      if (kind === 'cancel') return api.cancelTask(taskId, reason || undefined);
      if (kind === 'reassign') return api.reassignTask(taskId, reassignTo.trim(), reason || undefined);
      return api.escalateTask(taskId, reason.trim());
    },
    onSuccess: (_r, kind) => {
      setToast({ kind: 'success', message: `Task ${kind} accepted.` });
      void qc.invalidateQueries({ queryKey: ['task', taskId] });
      void qc.invalidateQueries({ queryKey: ['project', projectId, 'tasks'] });
    },
    onError: (err) => setToast({ kind: 'error', message: String(err) }),
  });

  const t = task.data;

  return (
    <Drawer
      open
      onClose={onClose}
      width="34rem"
      title={t?.title ?? 'Task'}
      subtitle={
        t && (
          <span className="flex flex-wrap items-center gap-1">
            <Badge tone="neutral">{t.state}</Badge>
            {t.effort && <Badge tone="muted">effort {t.effort}</Badge>}
            {t.attempts !== undefined && <Badge tone="muted">attempts {t.attempts}</Badge>}
            {t.verification && (
              <Badge tone={VERDICT_TONE[t.verification.verdict] ?? 'neutral'}>
                verify: {t.verification.verdict}
              </Badge>
            )}
          </span>
        )
      }
      footer={
        t ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="xs" variant="secondary" disabled={!reason.trim()} onClick={() => act.mutate('retry')}>
              ↻ Retry
            </Button>
            <Button size="xs" variant="danger" disabled={!reason.trim()} onClick={() => act.mutate('cancel')}>
              Cancel
            </Button>
            <Button
              size="xs"
              variant="secondary"
              disabled={!reason.trim()}
              onClick={() => act.mutate('escalate')}
            >
              ▲ Escalate
            </Button>
            <select
              value={reassignTo}
              onChange={(e) => setReassignTo(e.target.value)}
              aria-label="Reassign to agent"
              className="h-6 w-40 rounded border border-slate-700 bg-slate-900 px-1.5 text-[11px] text-slate-300"
            >
              <option value="">agent…</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <Button
              size="xs"
              variant="secondary"
              disabled={!reassignTo.trim()}
              onClick={() => act.mutate('reassign')}
            >
              Reassign
            </Button>
          </div>
        ) : undefined
      }
    >
      {task.isLoading && <SkeletonRows rows={6} />}
      {task.isError && <PanelError error={task.error} onRetry={() => void task.refetch()} label="Task detail" />}

      {t && (
        <div className="space-y-4">
          <KeyValue
            pairs={[
              ['id', <code className="font-mono text-[11px]">{t.id}</code>],
              ['state', t.state],
              ['assignee', t.assignee_agent_id
                ? (nameById.get(t.assignee_agent_id) ?? t.assignee_agent_id) : '—'],
              ['department', t.department_id
                ? (nameById.get(t.department_id) ?? t.department_id) : '—'],
              ['squad', t.assignee_squad_id
                ? (nameById.get(t.assignee_squad_id) ?? t.assignee_squad_id) : '—'],
              ['cost', formatMicros(t.cost_micros)],
              ['tokens', `${formatTokens(t.tokens_in)} in / ${formatTokens(t.tokens_out)} out`],
              ['deliverable', t.deliverable ?? '—'],
              ['escalated to', t.escalated_to ?? '—'],
              ['escalation reason', t.escalation_reason ?? '—'],
            ]}
          />

          {t.description && (
            <section>
              <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Description</h4>
              <p className="whitespace-pre-wrap text-xs text-slate-300">{t.description}</p>
            </section>
          )}

          <section>
            <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
              Acceptance criteria
            </h4>
            {(t.acceptance_criteria ?? []).length === 0 ? (
              <p className="text-xs text-slate-500">No acceptance criteria recorded.</p>
            ) : (
              <ul className="list-inside list-disc space-y-0.5 text-xs text-slate-300">
                {t.acceptance_criteria!.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Required skills</h4>
            <div className="flex flex-wrap gap-1">
              {(t.required_skills ?? []).length === 0 ? (
                <span className="text-xs text-slate-500">none</span>
              ) : (
                t.required_skills!.map((s, i) => (
                  <Badge key={i} tone="info" title={typeof s === 'string' ? s : `weight ${s.weight ?? '—'}`}>
                    {skillLabel(s)}
                  </Badge>
                ))
              )}
            </div>
            {(t.depends_on ?? []).length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                <span className="text-[11px] text-slate-500">depends on:</span>
                {t.depends_on!.map((d) => (
                  <Badge key={d} tone="muted" title={d}>
                    {titleById.get(d) ?? d.slice(0, 8)}
                  </Badge>
                ))}
              </div>
            )}
          </section>

          <section>
            <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Verification</h4>
            {!t.verification ? (
              <p className="text-xs text-slate-500">Not verified yet.</p>
            ) : (
              <div className="rounded-md border border-slate-700/60 bg-slate-900/50 p-2 text-xs">
                <div className="flex items-center gap-2">
                  <Badge tone={VERDICT_TONE[t.verification.verdict] ?? 'neutral'}>
                    {t.verification.verdict}
                  </Badge>
                  <Badge tone="muted">{t.verification.method}</Badge>
                  {t.verification.confidence !== undefined && (
                    <span className="text-slate-400">
                      confidence {formatPercent(t.verification.confidence)}
                    </span>
                  )}
                </div>
                {(t.verification.checks ?? []).length > 0 && (
                  <ul className="mt-1.5 space-y-0.5">
                    {t.verification.checks!.map((c, i) => (
                      <li key={i} className="flex items-center gap-1.5">
                        <span className={c.ok ? 'text-emerald-400' : 'text-rose-400'}>{c.ok ? '✓' : '✗'}</span>
                        <span className="text-slate-300">{c.name}</span>
                        {c.detail && <span className="text-slate-500">{c.detail}</span>}
                      </li>
                    ))}
                  </ul>
                )}
                {t.verification.evidence !== undefined && (
                  <div className="mt-1.5">
                    <JsonView value={t.verification.evidence} defaultOpen={false} maxHeight="12rem" />
                  </div>
                )}
              </div>
            )}
          </section>

          <section>
            <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
              Artifacts {artifacts.data ? `(${artifacts.data.items.length})` : ''}
            </h4>
            {artifacts.isLoading && <SkeletonRows rows={2} />}
            {artifacts.isError && <PanelError error={artifacts.error} label="Artifacts" />}
            {artifacts.isSuccess && artifacts.data.items.length === 0 && (
              <p className="text-xs text-slate-500">No artifacts yet.</p>
            )}
            {artifacts.isSuccess && artifacts.data.items.length > 0 && (
              <ul className="space-y-1 text-xs">
                {artifacts.data.items.map((a) => (
                  <li key={a.id} className="flex items-center gap-2 rounded border border-slate-700/50 px-2 py-1">
                    <Badge tone="muted">{a.kind}</Badge>
                    <span className="min-w-0 flex-1 truncate text-slate-300" title={a.path}>
                      {a.path ?? a.id}
                    </span>
                    {a.bytes !== undefined && <span className="text-slate-500">{a.bytes}B</span>}
                    {a.trust && <Badge tone="neutral">{a.trust}</Badge>}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
              Reward breakdown
            </h4>
            {(t.rewards ?? []).length === 0 ? (
              <p className="text-xs text-slate-500">No reward events for this task yet.</p>
            ) : (
              <ul className="space-y-1 text-xs">
                {t.rewards!.map((r) => (
                  <li key={r.id} className="rounded border border-slate-700/50 px-2 py-1">
                    <div className="flex items-center gap-2">
                      <Badge tone={(r.reward ?? 0) >= 0 ? 'success' : 'danger'}>
                        {(r.reward ?? 0).toFixed(3)}
                      </Badge>
                      <span className="text-slate-400">{r.role_in_task ?? 'producer'}</span>
                      <span className="text-slate-500">{nameById.get(r.agent_id) ?? r.agent_id.slice(0, 8)}</span>
                    </div>
                    {r.components && (
                      <div className="mt-0.5 font-mono text-[10px] text-slate-500">
                        {Object.entries(r.components)
                          .map(([k, v]) => `${k}=${Number(v).toFixed(2)}`)
                          .join('  ')}
                      </div>
                    )}
                    {r.penalties && Object.keys(r.penalties).length > 0 && (
                      <div className="font-mono text-[10px] text-rose-400/80">
                        penalties: {Object.entries(r.penalties).map(([k, v]) => `${k}=${Number(v).toFixed(2)}`).join('  ')}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Output contract</h4>
            <JsonView value={t.output_contract} defaultOpen={false} maxHeight="10rem" />
          </section>

          <div className="rounded-md border border-slate-700/60 bg-slate-900/50 p-2">
            <Field label="Reason (required for retry / cancel / escalate)">
              <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="why?" />
            </Field>
            {t.started_at && t.ended_at && (
              <p className="mt-1 text-[11px] text-slate-500">
                ran for {formatDuration(Date.parse(t.ended_at) - Date.parse(t.started_at))}
              </p>
            )}
          </div>
        </div>
      )}
    </Drawer>
  );
}
