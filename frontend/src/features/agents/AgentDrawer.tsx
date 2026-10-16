import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { DeliverableRow, RewardEvent } from '../../api/types';
import { DownloadButton } from '../../components/ui/DownloadButton';
import { Drawer } from '../../components/ui/Drawer';
import { Badge, severityTone } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Textarea } from '../../components/ui/Field';
import { KeyValue } from '../../components/ui/Tabs';
import { Sparkline } from '../../components/ui/Sparkline';
import { EmptyState, SkeletonRows } from '../../components/ui/EmptyState';
import { PanelError } from '../../components/PanelError';
import { formatClock, formatDateTime, formatMicros, formatPercent, formatRelativeTime, formatTokens } from '../../lib/format';
import { useAgent, useAgentContext, useAgentRewards, useProjectArtifacts } from '../../app/hooks';
import { selectEventLog, useEventLog } from '../../stores/eventLog';
import { useUi } from '../../stores/ui';
import { gradeLabel } from '../org/orgUtils';
import {
  DeliverablePreviewModal,
  formatDeliverableSize,
} from '../deliverables/DeliverablesPanel';

/** Agent detail drawer (docs/09 §2.4 + docs/07 §3.3). */
export function AgentDrawer({
  agentId,
  projectId,
  onClose,
}: {
  agentId: string;
  projectId: string;
  onClose: () => void;
}) {
  const agent = useAgent(agentId);
  const rewards = useAgentRewards(agentId);
  const log = useEventLog(selectEventLog(projectId));
  const [timelineFilter, setTimelineFilter] = useState<'all' | 'tools'>('all');
  const context = useAgentContext(projectId, agentId);

  const timeline = useMemo(() => {
    const rows = log.items.filter((e) => e.agent_id === agentId);
    const filtered = timelineFilter === 'tools' ? rows.filter((e) => e.type.startsWith('agent.tool')) : rows;
    return filtered.slice(-200).reverse();
  }, [log.items, agentId, timelineFilter]);

  const trend = useMemo(
    () => (rewards.data?.items ?? []).slice(-30).map((r: RewardEvent) => r.score_after ?? null),
    [rewards.data],
  );

  return (
    <Drawer
      open
      onClose={onClose}
      width="34rem"
      title={agent.data?.name ?? 'Agent'}
      subtitle={
        agent.data && (
          <span className="flex flex-wrap items-center gap-1">
            <Badge tone="info">{agent.data.role}</Badge>
            <Badge tone="accent">G{agent.data.grade}</Badge>
            <Badge tone="neutral">{agent.data.state}</Badge>
            <Badge tone="muted">{agent.data.autonomy ?? 'autonomy,'}</Badge>
          </span>
        )
      }
      footer={<SteerBox agentId={agentId} />}
    >
      <div className="space-y-4">
        {agent.isLoading && <SkeletonRows rows={5} />}
        {agent.isError && <PanelError error={agent.error} onRetry={() => void agent.refetch()} label="Agent detail" />}

        {agent.data && (
          <>
            <section className="rounded-md border border-slate-700/60 bg-slate-900/50 p-2">
              <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Scorecard</h4>
              <div className="flex items-center gap-3">
                <span className="text-2xl font-semibold tabular-nums text-slate-100">
                  {agent.data.score.toFixed(3)}
                </span>
                <Sparkline values={trend} width={120} height={28} />
                <span className="text-[11px] text-slate-500">
                  confidence {agent.data.score_confidence !== undefined ? formatPercent(agent.data.score_confidence) : 'n/a'}
                </span>
              </div>
              <KeyValue
                className="mt-2"
                pairs={[
                  ['grade', `${agent.data.grade} · ${gradeLabel(agent.data.grade)}`],
                  [
                    'knowledge',
                    agent.data.company_knowledge !== undefined
                      ? `${formatPercent(agent.data.company_knowledge)} · ${agent.data.tenure_days ?? 0}d tenure`
                      : 'n/a',
                  ],
                  [
                    'success rate',
                    (agent.data.tasks_done ?? 0) > 0 && agent.data.success_rate !== undefined
                      ? formatPercent(agent.data.success_rate)
                      : 'n/a',
                  ],
                  ['tasks', `${agent.data.tasks_done ?? 0} done / ${agent.data.tasks_failed ?? 0} failed`],
                  ['evidence', agent.data.evidence_count ?? 0],
                  ['penalties', agent.data.penalty_count ?? 0],
                  ['model', `${agent.data.model_tier ?? 'n/a'} · ${agent.data.model_id ?? 'n/a'}`],
                  ['spend today', formatMicros(agent.data.spend_today_micros)],
                  ['token cap / step', formatTokens(agent.data.token_cap_per_step)],
                  ['last active', formatRelativeTime(agent.data.last_active_at)],
                ]}
              />
              {(agent.data.skills ?? []).length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {(agent.data.skills ?? []).map((s) => (
                    <Badge key={s.skill_id} tone="neutral" title={`proficiency ${s.proficiency}`}>
                      {s.label ?? s.skill_id} {formatPercent(s.proficiency)}
                    </Badge>
                  ))}
                </div>
              )}
            </section>

            {agent.data.soul && Object.keys(agent.data.soul).length > 0 && (
              <section className="rounded-md border border-slate-700/60 bg-slate-900/50 p-3">
                <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Soul
                </h4>
                {agent.data.soul.vision && (
                  <p className="text-xs italic text-slate-300">“{agent.data.soul.vision}”</p>
                )}
                {(agent.data.soul.traits ?? []).length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {(agent.data.soul.traits ?? []).map((t) => (
                      <Badge key={t} tone="neutral">
                        {t}
                      </Badge>
                    ))}
                  </div>
                )}
                <KeyValue
                  className="mt-2"
                  pairs={[
                    ['values', (agent.data.soul.values ?? []).join(' · ') || 'n/a'],
                    ['voice', agent.data.soul.voice ?? 'n/a'],
                    ['background', agent.data.soul.background ?? 'n/a'],
                  ]}
                />
                <p className="mt-1 text-[10px] text-slate-500">
                  soul {agent.data.soul.source ?? 'deterministic'}
                </p>
                {agent.data.soul_md && (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-[11px] text-slate-500">soul.md</summary>
                    <pre className="mt-1 whitespace-pre-wrap font-sans text-[11px] leading-relaxed text-slate-400">
                      {agent.data.soul_md}
                    </pre>
                  </details>
                )}
              </section>
            )}

            <section>
              <DeliverablesSection projectId={projectId} agentId={agentId} />
            </section>

            <section>
              <div className="mb-1 flex items-center justify-between">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Live timeline ({timeline.length})
                </h4>
                <div className="flex gap-1">
                  <Button
                    size="xs"
                    variant={timelineFilter === 'all' ? 'secondary' : 'ghost'}
                    onClick={() => setTimelineFilter('all')}
                  >
                    all
                  </Button>
                  <Button
                    size="xs"
                    variant={timelineFilter === 'tools' ? 'secondary' : 'ghost'}
                    onClick={() => setTimelineFilter('tools')}
                  >
                    tools
                  </Button>
                </div>
              </div>
              {timeline.length === 0 ? (
                <EmptyState
                  title="No activity yet"
                  description="Thoughts, tool calls and messages appear here as the agent works. Nothing is polled, if it isn't an event, it didn't happen."
                />
              ) : (
                <ul className="max-h-64 space-y-0.5 overflow-y-auto rounded-md border border-slate-700/60">
                  {timeline.map((e) => (
                    <li
                      key={e.id}
                      className="flex items-start gap-2 border-b border-slate-800/60 px-2 py-1 text-[11px] last:border-0"
                    >
                      <span className="shrink-0 font-mono text-slate-500">{formatClock(e.ts)}</span>
                      <Badge tone={severityTone(e.severity)}>{e.type}</Badge>
                      <span className="min-w-0 flex-1 truncate text-slate-300" title={e.title}>
                        {e.title}
                      </span>
                      {typeof e.duration_ms === 'number' && (
                        <span className="shrink-0 tabular-nums text-slate-500">{e.duration_ms}ms</span>
                      )}
                      {typeof e.cost_micros === 'number' && e.cost_micros > 0 && (
                        <span className="shrink-0 tabular-nums text-slate-500">{formatMicros(e.cost_micros)}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section>
              <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Reward ledger</h4>
              {rewards.isLoading && <SkeletonRows rows={3} />}
              {rewards.isError && <PanelError error={rewards.error} label="Reward ledger" />}
              {rewards.isSuccess && rewards.data.items.length === 0 && (
                <EmptyState title="No rewards settled" description="Rewards appear after a task is verified." />
              )}
              {rewards.isSuccess && rewards.data.items.length > 0 && (
                <ul className="max-h-48 space-y-1 overflow-y-auto text-[11px]">
                  {rewards.data.items.slice(0, 40).map((r) => (
                    <li key={r.id} className="rounded border border-slate-700/50 bg-slate-900/40 px-2 py-1">
                      <div className="flex items-center gap-2">
                        <Badge tone={(r.reward ?? 0) >= 0 ? 'success' : 'danger'}>
                          {(r.reward ?? 0) >= 0 ? '+' : ''}
                          {(r.reward ?? 0).toFixed(3)}
                        </Badge>
                        <span className="text-slate-400">{r.role_in_task ?? 'producer'}</span>
                        {r.verdict && <Badge tone="neutral">{r.verdict}</Badge>}
                        <span className="ml-auto text-slate-500">{formatRelativeTime(r.created_at)}</span>
                      </div>
                      {r.components && (
                        <div className="mt-0.5 font-mono text-[10px] text-slate-500">
                          {Object.entries(r.components)
                            .filter(
                              (entry): entry is [string, number] =>
                                typeof entry[1] === 'number' && Number.isFinite(entry[1]),
                            )
                            .map(([k, v]) => `${k}=${v.toFixed(2)}`)
                            .join('  ')}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section>
              <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
                Context inspector (last step)
              </h4>
              {context.isLoading && <SkeletonRows rows={2} />}
              {context.isError && (
                <p className="text-[11px] text-slate-500">
                  No context pack published for this agent yet.
                </p>
              )}
              {context.isSuccess && (
                <pre className="max-h-40 overflow-auto rounded-md border border-slate-700/60 bg-slate-950/70 p-2 font-mono text-[10px] text-slate-300">
                  {JSON.stringify(context.data, null, 2)}
                </pre>
              )}
            </section>
          </>
        )}
      </div>
    </Drawer>
  );
}

function SteerBox({ agentId }: { agentId: string }) {
  const [text, setText] = useState('');
  const setToast = useUi((s) => s.setToast);
  const send = useMutation({
    mutationFn: () => api.messageAgent(agentId, text.trim()),
    onSuccess: () => {
      setText('');
      setToast({ kind: 'success', message: 'Steering message queued, they read it at their next step.' });
    },
    onError: (err) => setToast({ kind: 'error', message: String(err) }),
  });

  return (
    <form
      className="flex items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) send.mutate();
      }}
    >
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Steer this agent, delivered at its next step"
        className="min-h-[38px] flex-1 text-xs"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim()) send.mutate();
        }}
      />
      <Button type="submit" size="sm" variant="primary" loading={send.isPending} disabled={!text.trim()}>
        Send
      </Button>
    </form>
  );
}

/** This agent's published deliverables, the individual-level read of the same
 * records the project and company surfaces list. */
function DeliverablesSection({ projectId, agentId }: { projectId: string; agentId: string }) {
  const q = useProjectArtifacts(projectId, { agent_id: agentId });
  const [preview, setPreview] = useState<DeliverableRow | null>(null);
  const items = q.data?.items ?? [];
  return (
    <>
      <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
        Deliverables ({items.length})
      </h4>
      {q.isLoading ? (
        <SkeletonRows rows={3} />
      ) : items.length === 0 ? (
        <p className="text-[11px] text-slate-500">
          Nothing published yet, the outputs this agent produces land here as files.
        </p>
      ) : (
        <ul className="max-h-40 overflow-y-auto rounded-md border border-slate-700/60">
          {items.map((r) => (
            <li key={r.id}>
              <div
                className="flex w-full items-center gap-2 border-b border-slate-800/60 px-2 py-1 text-[11px] last:border-0 hover:bg-slate-900/60"
                title={r.task_title ? `From the task: ${r.task_title}` : r.path}
              >
                {/* One interactive element per row: the open button. Nested buttons inside
                    a role=button row break screen readers (review 2026-10-14). */}
                <button
                  type="button"
                  onClick={() => setPreview(r)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                >
                  <span className="min-w-0 flex-1 truncate text-slate-300">{r.name}</span>
                  <span className="shrink-0 tabular-nums text-slate-500">
                    {formatDeliverableSize(r.bytes)}
                  </span>
                </button>
                <span
                  className="shrink-0 text-slate-500"
                  title={formatDateTime(r.created_at)}
                >
                  {formatRelativeTime(r.created_at)}
                </span>
                <DownloadButton
                  path={`/api/artifacts/${r.id}/download`}
                  filename={r.name}
                  className="shrink-0 rounded px-1 text-slate-500 hover:bg-slate-800/70 hover:text-slate-200"
                  title="Download this file"
                >
                  ↓
                </DownloadButton>
              </div>
            </li>
          ))}
        </ul>
      )}
      <DeliverablePreviewModal row={preview} onClose={() => setPreview(null)} />
    </>
  );
}
