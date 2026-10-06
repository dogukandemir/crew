import { useMemo, useState } from 'react';
import type { BrainEntry } from '../../api/types';
import { api } from '../../api/client';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Chip } from '../../components/ui/Chip';
import { Input, Field } from '../../components/ui/Field';
import { JsonView } from '../../components/ui/JsonView';
import { EmptyState, SkeletonRows } from '../../components/ui/EmptyState';
import { PanelError } from '../../components/PanelError';
import { formatPercent, formatRelativeTime } from '../../lib/format';
import { useBrainEntries, useBrains } from '../../app/hooks';
import { cn } from '../../lib/cn';

const KIND_TONE = {
  fact: 'info',
  procedure: 'accent',
  decision: 'success',
  artifact_ref: 'muted',
  lesson: 'warning',
  glossary: 'neutral',
} as const;

/**
 * Brains (docs/09 §2.6, MVP = list). Scope tree on the left, entries on the
 * right with provenance and trust; the retrieval debug search shows the same
 * scored hits the agents get.
 */
export function BrainsPanel({ projectId }: { projectId: string }) {
  const brains = useBrains(projectId);
  const [selectedBrain, setSelectedBrain] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [entryId, setEntryId] = useState<string | null>(null);

  const flatBrains = useMemo(() => {
    const out: Array<{ id: string; name: string; scope: string; count?: number }> = [];
    const walk = (list: typeof brains.data | undefined) => {
      for (const b of list ?? []) {
        out.push({
          id: b.id,
          name: `${b.scope}${b.owner_id ? ` · ${b.owner_id.slice(0, 6)}` : ''}`,
          scope: b.scope,
          count: b.entry_count,
        });
        if (b.children) walk(b.children);
      }
    };
    walk(brains.data);
    return out;
  }, [brains.data]);

  const activeBrainId = selectedBrain ?? flatBrains[0]?.id ?? null;
  const entries = useBrainEntries(activeBrainId, query.trim() ? { q: query.trim() } : undefined);

  const selected: BrainEntry | undefined = useMemo(
    () => entries.data?.items.find((e) => e.id === entryId),
    [entries.data, entryId],
  );

  return (
    <div className="grid gap-3 lg:grid-cols-[14rem_1fr]">
      <div className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Scope tree</h3>
        {brains.isLoading && <SkeletonRows rows={4} />}
        {brains.isError && <PanelError error={brains.error} onRetry={() => void brains.refetch()} label="Brains" />}
        {brains.isSuccess && flatBrains.length === 0 && (
          <EmptyState
            title="No brains yet"
            description="Three scopes exist per project: project, department and agent. Entries appear as the org learns."
          />
        )}
        <ul className="space-y-1">
          {flatBrains.map((b) => (
            <li key={b.id}>
              <button
                type="button"
                onClick={() => {
                  setSelectedBrain(b.id);
                  setEntryId(null);
                }}
                className={cn(
                  'flex w-full items-center justify-between gap-2 rounded border px-2 py-1 text-left text-xs',
                  b.id === activeBrainId
                    ? 'border-emerald-500/50 bg-slate-800/60 text-slate-100'
                    : 'border-slate-700/50 text-slate-400 hover:bg-slate-800/40',
                )}
              >
                <span className="truncate">{b.name}</span>
                {b.count !== undefined && <span className="tabular-nums text-slate-500">{b.count}</span>}
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="space-y-2">
        <div className="flex items-end gap-2">
          <Field label="search entries" className="w-56" hint="POST /brains/search returns scored hits — this filters the list">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="rate-limit playbook"
              className="h-7 text-xs"
            />
          </Field>
          {activeBrainId && <RetrievalDebug projectId={projectId} query={query} />}
        </div>

        {!activeBrainId && <EmptyState title="Pick a brain" description="Select a scope on the left." />}
        {activeBrainId && entries.isLoading && <SkeletonRows rows={6} />}
        {activeBrainId && entries.isError && (
          <PanelError error={entries.error} onRetry={() => void entries.refetch()} label="Brain entries" />
        )}
        {activeBrainId && entries.isSuccess && entries.data.items.length === 0 && (
          <EmptyState
            title="No entries"
            description="Nothing has been written to this scope yet, or the filter excludes everything."
          />
        )}

        {entries.isSuccess && entries.data.items.length > 0 && (
          <div className="grid gap-2 lg:grid-cols-2">
            <ul className="divide-y divide-slate-800/70 overflow-hidden rounded-lg border border-slate-700/60">
              {entries.data.items.map((e) => (
                <li key={e.id}>
                  <button
                    type="button"
                    onClick={() => setEntryId(e.id)}
                    className={cn(
                      'flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-slate-800/40',
                      entryId === e.id && 'bg-slate-800/60',
                    )}
                  >
                    <Badge tone={KIND_TONE[e.kind] ?? 'neutral'}>{e.kind}</Badge>
                    <span className="min-w-0 flex-1 truncate text-slate-200">{e.title}</span>
                    {e.human_edited && <Badge tone="accent">edited</Badge>}
                    {e.superseded_by && <Badge tone="muted">superseded</Badge>}
                    <span className="shrink-0 text-slate-500">{formatRelativeTime(e.created_at)}</span>
                  </button>
                </li>
              ))}
            </ul>

            <div className="rounded-lg border border-slate-700/60 bg-slate-900/40 p-2">
              {!selected ? (
                <p className="mt-6 text-center text-xs text-slate-500">Select an entry for provenance and history.</p>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Badge tone={KIND_TONE[selected.kind] ?? 'neutral'}>{selected.kind}</Badge>
                    <span className="text-xs font-medium text-slate-100">{selected.title}</span>
                  </div>
                  {selected.body && (
                    <p className="max-h-40 overflow-y-auto whitespace-pre-wrap text-[11px] text-slate-300">
                      {selected.body}
                    </p>
                  )}
                  <dl className="grid grid-cols-[6rem_1fr] gap-x-2 gap-y-0.5 text-[11px]">
                    <dt className="text-slate-500">trust</dt>
                    <dd className="tabular-nums text-slate-300">
                      {selected.trust !== undefined ? formatPercent(selected.trust) : '—'}
                    </dd>
                    <dt className="text-slate-500">importance</dt>
                    <dd className="tabular-nums text-slate-300">{selected.importance ?? '—'}</dd>
                    <dt className="text-slate-500">uses</dt>
                    <dd className="tabular-nums text-slate-300">{selected.use_count ?? 0}</dd>
                    <dt className="text-slate-500">decay</dt>
                    <dd className="tabular-nums text-slate-300">{selected.decay_score ?? '—'}</dd>
                    <dt className="text-slate-500">source</dt>
                    <dd className="truncate font-mono text-slate-300" title={JSON.stringify(selected.source)}>
                      {selected.source ? JSON.stringify(selected.source) : '—'}
                    </dd>
                  </dl>
                  {(selected.tags ?? []).length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {(selected.tags ?? []).map((t) => (
                        <Chip key={t}>{t}</Chip>
                      ))}
                    </div>
                  )}
                  <JsonView value={selected.payload} defaultOpen={false} maxHeight="12rem" />
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function RetrievalDebug({ projectId, query }: { projectId: string; query: string }) {
  const [result, setResult] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex items-center gap-2 pb-0.5">
      <Button
        size="xs"
        variant="secondary"
        disabled={!query.trim() || busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            setResult(await api.searchBrains(projectId, query.trim()));
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'scoring…' : 'score retrieval'}
      </Button>
      {error && <span className="text-[11px] text-rose-300">{error}</span>}
      {result !== null && (
        <div className="absolute z-20 mt-2 w-[28rem] translate-y-6 rounded-md border border-slate-600/70 bg-slate-950 p-2 shadow-xl">
          <JsonView value={result} maxHeight="14rem" />
        </div>
      )}
    </div>
  );
}
