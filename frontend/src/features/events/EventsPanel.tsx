import { useMemo, useState } from 'react';
import type { EventQuery, EventRow, Severity } from '../../api/types';
import { SEVERITIES } from '../../api/types';
import { Badge, severityTone } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Field, Input, Select } from '../../components/ui/Field';
import { JsonView } from '../../components/ui/JsonView';
import { StatusDot } from '../../components/ui/StatusDot';
import { VirtualList } from '../../components/ui/VirtualList';
import { EmptyState } from '../../components/ui/EmptyState';
import {
  filterEventRows,
  namespaceOf,
  SEVERITY_RANK,
} from '../../lib/events';
import { formatClockUtc, formatMicros, formatRelativeTime } from '../../lib/format';
import { clearSinceSeq, type ConnectionState } from '../../lib/socket';
import { selectEventLog, useEventLog } from '../../stores/eventLog';
import { selectConnection, useConnection } from '../../stores/connection';
import { useProjectSocket } from '../../app/useProjectSocket';
import { useOrg, useTasks } from '../../app/hooks';
import { flattenOrg } from '../org/orgUtils';
import { cn } from '../../lib/cn';

const ROW_HEIGHT = 26;

/** Events firehose (docs/09 §2.8). */
export function EventsPanel({ projectId }: { projectId: string; tabId: string }) {
  const log = useEventLog(selectEventLog(projectId));
  const conn = useConnection(selectConnection(projectId));
  const socket = useProjectSocket(projectId);
  const org = useOrg(projectId);
  const tasks = useTasks(projectId);

  const [query, setQuery] = useState<EventQuery>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // History is backfilled once per project by the socket provider.

  const agents = useMemo(
    () => flattenOrg(org.data?.root).filter((u) => u.kind === 'agent'),
    [org.data],
  );

  const namespaces = useMemo(() => {
    const set = new Set<string>();
    for (const e of log.items) set.add(namespaceOf(e.type));
    return Array.from(set).sort();
  }, [log.items]);

  const filtered = useMemo(() => filterEventRows(log.items, query), [log.items, query]);
  // Newest first in the UI; the store keeps seq-ascending order.
  const rows = useMemo(() => [...filtered].reverse(), [filtered]);
  const selected: EventRow | undefined = useMemo(
    () => log.items.find((e) => e.id === selectedId),
    [log.items, selectedId],
  );

  const errored = log.items.filter((e) => SEVERITY_RANK[e.severity] >= SEVERITY_RANK.error).length;
  const lastGap = log.gaps[log.gaps.length - 1];

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      {/* Filter bar */}
      <div className="flex flex-wrap items-end gap-2">
        <Field label="search" className="w-48">
          <Input
            value={query.q ?? ''}
            onChange={(e) => setQuery((q) => ({ ...q, q: e.target.value }))}
            placeholder="type, title, actor…"
            className="h-7 text-xs"
          />
        </Field>
        <Field label="namespace" className="w-40">
          <Select
            value={query.namespace ?? ''}
            onChange={(e) => setQuery((q) => ({ ...q, namespace: e.target.value || undefined }))}
            className="h-7 text-xs"
          >
            <option value="">all</option>
            {namespaces.map((ns) => (
              <option key={ns} value={ns}>
                {ns}.*
              </option>
            ))}
          </Select>
        </Field>
        <Field label="severity ≥" className="w-32">
          <Select
            value={query.severity ?? ''}
            onChange={(e) =>
              setQuery((q) => ({ ...q, severity: (e.target.value || undefined) as Severity | undefined }))
            }
            className="h-7 text-xs"
          >
            <option value="">all</option>
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="agent" className="w-40">
          <Select
            value={query.agent_id ?? ''}
            onChange={(e) => setQuery((q) => ({ ...q, agent_id: e.target.value || undefined }))}
            className="h-7 text-xs"
          >
            <option value="">all</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="task" className="w-40">
          <Select
            value={query.task_id ?? ''}
            onChange={(e) => setQuery((q) => ({ ...q, task_id: e.target.value || undefined }))}
            className="h-7 text-xs"
          >
            <option value="">all</option>
            {(tasks.data?.items ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </Select>
        </Field>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => setQuery({})}
          disabled={Object.values(query).every((v) => !v)}
        >
          clear
        </Button>
        <div className="ml-auto flex items-center gap-2 text-[11px] text-slate-500">
          <StateChip state={conn.state} />
          <span className="tabular-nums">{filtered.length}/{log.items.length} rows</span>
          {errored > 0 && <Badge tone="danger">{errored} errors</Badge>}
          {log.dropped > 0 && <Badge tone="muted">{log.dropped} evicted</Badge>}
          {log.truncated && <Badge tone="warning">payloads truncated</Badge>}
        </div>
      </div>

      {/* Reconnect / gap notices */}
      <div className="flex flex-wrap items-center gap-2">
        {(conn.state === 'disconnected' || conn.state === 'reconnecting') && (
          <div className="flex flex-1 items-center gap-2 rounded-md border border-amber-700/60 bg-amber-950/40 px-2 py-1 text-[11px] text-amber-200">
            <StatusDot state="warning" />
            <span className="min-w-0 flex-1 truncate">
              Disconnected{conn.detail ? ` (${conn.detail})` : ''}, resuming from seq {log.maxSeq}.
            </span>
            <Button size="xs" variant="secondary" onClick={() => socket?.resume()}>
              Resume
            </Button>
          </div>
        )}
        {lastGap && (
          <div className="flex flex-1 items-center gap-2 rounded-md border border-rose-800/60 bg-rose-950/40 px-2 py-1 text-[11px] text-rose-200">
            <span className="min-w-0 flex-1 truncate">
              Gap: {lastGap.from}–{lastGap.to} skipped ({lastGap.reason}),{' '}
              {lastGap.to - lastGap.from + 1} events not shown.
            </span>
            <Button size="xs" variant="secondary" onClick={() => useEventLog.getState().dismissGaps(projectId)}>
              Dismiss
            </Button>
          </div>
        )}
        <div className="flex items-center gap-2 text-[11px] text-slate-500">
          <span title="the resume cursor is remembered on this device">
            since_seq {log.maxSeq}
          </span>
          <Button
            size="xs"
            variant="ghost"
            title="Forget the saved cursor and reconnect from the live head"
            onClick={() => {
              clearSinceSeq(projectId);
              useEventLog.getState().reset(projectId);
              socket?.resume();
            }}
          >
            reset cursor
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => downloadJson(rows, `${projectId.slice(0, 8)}-events.json`)}
            disabled={rows.length === 0}
          >
            export {rows.length}
          </Button>
        </div>
      </div>

      {/* List + payload viewer */}
      <div className="grid min-h-0 flex-1 gap-2 lg:grid-cols-[1fr_22rem]">
        <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-slate-700/60">
          {/* The record is written in UTC: label the clock so a reader never
              mistakes it for their own wall clock. The age beside it is the
              reader-facing "how long ago". */}
          <div className="flex shrink-0 items-center gap-2 border-b border-slate-800/70 bg-slate-900/40 px-2 py-1 text-[10px] uppercase tracking-wide text-slate-500">
            <span className="w-16 shrink-0" title="Recorded in UTC, not the host clock">time UTC</span>
            <span className="w-14 shrink-0 text-right">seq</span>
            <span className="w-16 shrink-0">level</span>
            <span className="w-40 shrink-0">type</span>
            <span className="min-w-0 flex-1">event</span>
          </div>
          <VirtualList
            items={rows}
            rowHeight={ROW_HEIGHT}
            height={520}
            keyOf={(e) => e.id}
            empty={
              <EmptyState
                title="No events match"
                description="The firehose is fed by the WebSocket. Start a run, or widen the filters, events arrive here the moment they happen."
              />
            }
            render={(e) => (
              <button
                type="button"
                onClick={() => setSelectedId(e.id)}
                className={cn(
                  'flex w-full items-center gap-2 px-2 text-left text-[11px] leading-[26px] hover:bg-slate-800/50',
                  selectedId === e.id && 'bg-slate-800/70',
                )}
              >
                <span className="w-16 shrink-0 font-mono tabular-nums text-slate-500" title={`${e.ts} recorded in UTC`}>
                  {formatClockUtc(e.ts)}
                </span>
                <span className="w-14 shrink-0 text-right font-mono tabular-nums text-slate-600">{e.seq}</span>
                <span className="w-16 shrink-0">
                  <Badge tone={severityTone(e.severity)}>{e.severity}</Badge>
                </span>
                <span className="w-40 shrink-0 truncate font-mono text-slate-400" title={e.type}>
                  {e.type}
                </span>
                <span className="min-w-0 flex-1 truncate text-slate-200" title={e.title}>
                  {e.title}
                </span>
                {e.cost_micros !== undefined && e.cost_micros > 0 && (
                  <span className="shrink-0 tabular-nums text-slate-500">{formatMicros(e.cost_micros)}</span>
                )}
                {(e.tokens_in || e.tokens_out) ? (
                  <span className="shrink-0 tabular-nums text-slate-600" title="tokens in / out">
                    {e.tokens_in ?? 0}/{e.tokens_out ?? 0}
                  </span>
                ) : null}
              </button>
            )}
          />
        </div>

        <div className="min-h-0 overflow-y-auto rounded-lg border border-slate-700/60 bg-slate-900/40 p-2">
          {!selected ? (
            <p className="mt-6 text-center text-xs text-slate-500">
              Select an event to inspect its JSON payload.
            </p>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-[11px]">
                <span className="font-mono tabular-nums text-slate-500">seq {selected.seq}</span>
                <Badge tone={severityTone(selected.severity)}>{selected.severity}</Badge>
                <span className="ml-auto text-slate-500">{formatRelativeTime(selected.ts)}</span>
              </div>
              <div className="text-xs text-slate-200">{selected.title}</div>
              {selected.summary && <p className="text-[11px] text-slate-400">{selected.summary}</p>}
              <dl className="grid grid-cols-[5.5rem_1fr] gap-x-2 gap-y-0.5 text-[11px]">
                {(
                  [
                    ['type', selected.type],
                    ['actor', selected.actor],
                    ['agent', selected.agent_id],
                    ['task', selected.task_id],
                    ['run', selected.run_id],
                    ['department', selected.department_id],
                    ['trace', selected.trace_id],
                    ['span', selected.span_id],
                    ['duration', selected.duration_ms !== undefined ? `${selected.duration_ms}ms` : undefined],
                  ] as Array<[string, string | null | undefined]>
                )
                  .filter(([, v]) => v)
                  .map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt className="text-slate-500">{k}</dt>
                      <dd className="truncate font-mono text-slate-300" title={String(v)}>
                        {v}
                      </dd>
                    </div>
                  ))}
              </dl>
              <JsonView value={selected.payload} maxHeight="18rem" />
              {selected.trace_id && (
                <p className="text-[11px] text-slate-500">
                  trace{' '}
                  <code className="font-mono" title="correlation id for this event">
                    {selected.trace_id}
                  </code>
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StateChip({ state }: { state: ConnectionState }) {
  const tone = state === 'connected' ? 'text-emerald-300' : state === 'idle' ? 'text-slate-500' : 'text-amber-300';
  return (
    <span className={cn('flex items-center gap-1.5', tone)}>
      <StatusDot state={state === 'connected' ? 'ok' : state === 'idle' ? 'idle' : 'warning'} pulse={state === 'connected'} />
      {state}
    </span>
  );
}

function downloadJson(value: unknown, filename: string): void {
  try {
    const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  } catch {
    /* private mode / no DOM, the export is a convenience, not a guarantee */
  }
}
