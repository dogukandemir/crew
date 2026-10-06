import { useMemo, useState } from 'react';
import type { Task } from '../../api/types';
import { useAgent, useAgentRewards, useTaskArtifacts, useTasks } from '../../app/hooks';
import { selectEventLog, useEventLog } from '../../stores/eventLog';
import { Badge, severityTone } from '../../components/ui/Badge';
import { StatusDot, dotForState } from '../../components/ui/StatusDot';
import { JsonView } from '../../components/ui/JsonView';
import { EmptyState, SkeletonRows } from '../../components/ui/EmptyState';
import { PanelError } from '../../components/PanelError';
import { cn } from '../../lib/cn';
import {
  formatClock,
  formatMicros,
  formatPercent,
  formatRelativeTime,
  formatTokens,
} from '../../lib/format';
import { avatarFor } from './avatars';
import { currentTaskFor, type Activity } from './activity';

type StationTab = 'thinking' | 'output' | 'stats';

/**
 * The workstation panel: what the character you clicked is *thinking* and what
 * they have *produced*. Thinking is the live event stream scoped to one agent —
 * the same events driving the animation, so the panel and the sprite can never
 * disagree.
 */
export function AgentWorkstation({
  agentId,
  projectId,
  activity,
  onClose,
}: {
  agentId: string;
  projectId: string;
  activity?: Activity;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<StationTab>('thinking');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const agent = useAgent(agentId);
  const tasks = useTasks(projectId);
  const log = useEventLog(selectEventLog(projectId));

  const task: Task | undefined = useMemo(
    () => currentTaskFor(agentId, tasks.data?.items ?? []),
    [agentId, tasks.data],
  );
  const artifacts = useTaskArtifacts(task?.id);
  const rewards = useAgentRewards(agentId);

  const stream = useMemo(
    () => log.items.filter((e) => e.agent_id === agentId).slice(-150).reverse(),
    [log.items, agentId],
  );

  const a = agent.data;
  const avatar = avatarFor(a?.role, agentId);

  return (
    <aside className="station" aria-label={`Workstation: ${a?.name ?? agentId}`}>
      <header className="station-head">
        <span className="station-avatar" aria-hidden>
          {avatar}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="station-title truncate">{a?.name ?? 'Agent'}</span>
            {a && <StatusDot state={dotForState(a.state)} pulse={activity?.kind === 'typing'} />}
            {a?.grade !== undefined && <Badge tone="accent">G{a.grade}</Badge>}
          </div>
          <div className="station-sub truncate">
            {a?.role ?? '—'}
            {a?.model_tier ? ` · ${a.model_tier}` : ''}
          </div>
          {activity && (
            <div className="station-now">
              {activity.bubble && <span aria-hidden>{activity.bubble}</span>}
              <span className="truncate">{activity.note}</span>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close workstation"
          className="rounded p-1 text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-100"
        >
          ✕
        </button>
      </header>

      <div className="station-tabs" role="tablist">
        {(
          [
            ['thinking', `Thinking ${stream.length ? `(${stream.length})` : ''}`],
            ['output', 'Output'],
            ['stats', 'Scorecard'],
          ] as Array<[StationTab, string]>
        ).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            type="button"
            aria-selected={tab === id}
            className="station-tab"
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="station-body">
        {agent.isLoading && <SkeletonRows rows={5} />}
        {agent.isError && <PanelError error={agent.error} label="Agent" />}

        {tab === 'thinking' && (
          <>
            {stream.length === 0 ? (
              <EmptyState
                title="Nothing on the wire yet"
                description="Thoughts, tool calls and messages appear here the moment the agent emits them. Nothing is polled — this is the same event stream the office is animating from."
              />
            ) : (
              <div className="station-stream">
                {stream.map((e) => (
                  <div key={e.id}>
                    <button
                      type="button"
                      className="station-row w-full text-left"
                      onClick={() => setExpandedId(expandedId === e.id ? null : e.id)}
                      aria-expanded={expandedId === e.id}
                    >
                      <span className="station-time">{formatClock(e.ts)}</span>
                      <span className="min-w-0">
                        <span className="station-type">{e.type}</span>
                        <span className="station-text block truncate" title={e.title}>
                          {e.title}
                        </span>
                      </span>
                      <span className="station-cost">
                        {typeof e.cost_micros === 'number' && e.cost_micros > 0
                          ? formatMicros(e.cost_micros)
                          : e.duration_ms !== undefined
                            ? `${e.duration_ms}ms`
                            : ''}
                      </span>
                    </button>
                    {expandedId === e.id && (
                      <div className="px-2 pb-2">
                        <div className="mb-1 flex items-center gap-2 text-[10px] text-slate-500">
                          <Badge tone={severityTone(e.severity)}>{e.severity}</Badge>
                          <span>seq {e.seq}</span>
                          <span>{formatRelativeTime(e.ts)}</span>
                          {e.trace_id && <span className="font-mono">trace {e.trace_id.slice(0, 12)}</span>}
                          {e.tokens_in !== undefined && (
                            <span>
                              {formatTokens(e.tokens_in)} in / {formatTokens(e.tokens_out)} out
                            </span>
                          )}
                        </div>
                        <JsonView value={e.payload} maxHeight="16rem" />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {tab === 'output' && (
          <>
            <div className="station-section">
              <h4>Current task</h4>
              {!task ? (
                <div className="station-card text-[11px] text-slate-400">
                  No task assigned right now.
                </div>
              ) : (
                <div className="station-card">
                  <div className="flex items-center gap-2">
                    <Badge tone="neutral">{task.state}</Badge>
                    {task.effort && <Badge tone="muted">{task.effort}</Badge>}
                    <span className="ml-auto text-[10px] tabular-nums text-slate-500">
                      {formatMicros(task.cost_micros)}
                    </span>
                  </div>
                  <div className="mt-1 text-[12px] font-medium text-slate-200">{task.title}</div>
                  {task.description && (
                    <p className="mt-1 text-[11px] text-slate-400">{task.description}</p>
                  )}
                  {(task.acceptance_criteria ?? []).length > 0 && (
                    <ul className="mt-1.5 list-inside list-disc space-y-0.5 text-[11px] text-slate-300">
                      {task.acceptance_criteria!.map((c, i) => (
                        <li key={i}>{c}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>

            <div className="station-section">
              <h4>Artifacts</h4>
              {artifacts.isLoading && <SkeletonRows rows={2} />}
              {artifacts.isError && <PanelError error={artifacts.error} label="Artifacts" />}
              {artifacts.isSuccess && artifacts.data.items.length === 0 && (
                <div className="station-card text-[11px] text-slate-400">
                  No artifacts produced yet.
                </div>
              )}
              {artifacts.isSuccess && artifacts.data.items.length > 0 && (
                <ul className="space-y-1">
                  {artifacts.data.items.map((art) => (
                    <li
                      key={art.id}
                      className="station-card flex items-center gap-2 text-[11px]"
                    >
                      <Badge tone="muted">{art.kind}</Badge>
                      <span className="min-w-0 flex-1 truncate text-slate-200" title={art.path}>
                        {art.path ?? art.id}
                      </span>
                      {art.bytes !== undefined && (
                        <span className="text-slate-500">{art.bytes}B</span>
                      )}
                      {art.trust && <Badge tone="neutral">{art.trust}</Badge>}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="station-section">
              <h4>Rewards earned</h4>
              {rewards.isLoading && <SkeletonRows rows={2} />}
              {rewards.isSuccess && rewards.data.items.length === 0 && (
                <div className="station-card text-[11px] text-slate-400">
                  Nothing settled yet — rewards follow verification.
                </div>
              )}
              {rewards.isSuccess && rewards.data.items.length > 0 && (
                <ul className="space-y-1">
                  {rewards.data.items.slice(0, 12).map((r) => (
                    <li key={r.id} className="station-card text-[11px]">
                      <div className="flex items-center gap-2">
                        <Badge tone={(r.reward ?? 0) >= 0 ? 'success' : 'danger'}>
                          {(r.reward ?? 0).toFixed(3)}
                        </Badge>
                        <span className="text-slate-400">{r.role_in_task ?? 'producer'}</span>
                        {r.verdict && <Badge tone="neutral">{r.verdict}</Badge>}
                        <span className="ml-auto text-slate-500">
                          {formatRelativeTime(r.created_at)}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}

        {tab === 'stats' && a && (
          <>
            <div className="station-section">
              <h4>Reputation</h4>
              <div className="station-card flex items-center gap-3">
                <span className="text-2xl font-semibold tabular-nums text-slate-100">
                  {a.score.toFixed(3)}
                </span>
                <span className="text-[11px] text-slate-400">
                  confidence{' '}
                  {a.score_confidence !== undefined ? formatPercent(a.score_confidence) : '—'}
                </span>
                <span className="ml-auto text-[11px] text-slate-400">
                  grade {a.grade}
                </span>
              </div>
            </div>
            <div className="station-section">
              <h4>Output</h4>
              <dl className="station-card grid grid-cols-[7rem_1fr] gap-x-2 gap-y-1 text-[11px]">
                <dt className="text-slate-500">success rate</dt>
                <dd className="tabular-nums text-slate-200">
                  {a.success_rate !== undefined ? formatPercent(a.success_rate) : '—'}
                </dd>
                <dt className="text-slate-500">tasks</dt>
                <dd className="tabular-nums text-slate-200">
                  {a.tasks_done ?? 0} done / {a.tasks_failed ?? 0} failed
                </dd>
                <dt className="text-slate-500">evidence</dt>
                <dd className="tabular-nums text-slate-200">{a.evidence_count ?? 0}</dd>
                <dt className="text-slate-500">penalties</dt>
                <dd className="tabular-nums text-slate-200">{a.penalty_count ?? 0}</dd>
                <dt className="text-slate-500">spend today</dt>
                <dd className="tabular-nums text-slate-200">
                  {formatMicros(a.spend_today_micros)}
                </dd>
                <dt className="text-slate-500">token cap/step</dt>
                <dd className="tabular-nums text-slate-200">
                  {formatTokens(a.token_cap_per_step)}
                </dd>
                <dt className="text-slate-500">autonomy</dt>
                <dd className="text-slate-200">{a.autonomy ?? '—'}</dd>
                <dt className="text-slate-500">model</dt>
                <dd className="truncate text-slate-200">{a.model_id ?? '—'}</dd>
                <dt className="text-slate-500">last active</dt>
                <dd className="text-slate-200">{formatRelativeTime(a.last_active_at)}</dd>
              </dl>
            </div>
            {(a.skills ?? []).length > 0 && (
              <div className="station-section">
                <h4>Skills</h4>
                <div className="station-card space-y-1.5">
                  {(a.skills ?? []).map((s) => (
                    <div key={s.skill_id}>
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="text-slate-300">{s.label ?? s.skill_id}</span>
                        <span className="tabular-nums text-slate-500">
                          {formatPercent(s.proficiency)}
                        </span>
                      </div>
                      <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-slate-700/70">
                        <div
                          className={cn('h-full rounded-full bg-emerald-400')}
                          style={{ width: `${Math.max(0, Math.min(1, s.proficiency)) * 100}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
