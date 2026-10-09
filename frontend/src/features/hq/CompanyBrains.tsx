import { useState } from 'react';
import { Badge } from '../../components/ui/Badge';
import { SkeletonRows } from '../../components/ui/EmptyState';
import { PanelError } from '../../components/PanelError';
import { formatRelativeTime } from '../../lib/format';
import { useBrainEntries, useCompanyBrains } from '../../app/hooks';
import { useTabs } from '../../stores/tabs';
import { cn } from '../../lib/cn';

const KIND_TONE = {
  fact: 'info',
  procedure: 'accent',
  decision: 'success',
  artifact_ref: 'muted',
  lesson: 'warning',
  glossary: 'neutral',
} as const;

const SCOPE_LABEL: Record<string, string> = {
  company: '⌂ company',
  project: '◆ project',
  department: '▦ dept',
  agent: '● person',
};

/**
 * The company's memory page (ADR 0015): the umbrella brain — mission, review lessons,
 * allocation decisions — and the members' index, so you can see WHERE the portfolio's
 * knowledge lives without opening every project. Reading here is reading what the
 * agents retrieve; nothing is simulated.
 */
export function CompanyBrains({ companyId }: { companyId: string }) {
  const page = useCompanyBrains(companyId);
  const openTab = useTabs((s) => s.openTab);
  const brainId = page.data?.company_brain?.id ?? null;
  const entries = useBrainEntries(brainId);
  const [entryId, setEntryId] = useState<string | null>(null);

  if (page.isLoading) return <SkeletonRows rows={4} />;
  if (page.isError) return <PanelError error={page.error} onRetry={() => void page.refetch()} />;
  const d = page.data;
  if (!d) return <SkeletonRows rows={4} />;

  const selected = entries.data?.items.find((e) => e.id === entryId);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-medium text-slate-100">Company memory</h2>
        <span className="text-[11px] tabular-nums text-slate-500">
          {d.company_brain ? `${d.company_brain.entries} entries` : 'no company brain yet'}
        </span>
        <span className="text-[11px] text-slate-500">· retrieved by every member&apos;s agents</span>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <div className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">The umbrella brain</h3>
          {entries.isLoading && <SkeletonRows rows={4} />}
          {entries.isError && (
            <PanelError error={entries.error} onRetry={() => void entries.refetch()} label="Company brain entries" />
          )}
          {entries.isSuccess && entries.data.items.length === 0 && (
            <p className="rounded border border-dashed border-slate-700/70 p-4 text-center text-[11px] text-slate-500">
              Nothing written yet — the mission seeds it at founding; reviews and allocations add decisions.
            </p>
          )}
          {entries.isSuccess && entries.data.items.length > 0 && (
            <>
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
                      <span className="shrink-0 text-slate-500">{formatRelativeTime(e.created_at)}</span>
                    </button>
                  </li>
                ))}
              </ul>
              {selected && (
                <div className="rounded-lg border border-slate-700/60 bg-slate-900/40 p-2">
                  <div className="flex items-center gap-2">
                    <Badge tone={KIND_TONE[selected.kind] ?? 'neutral'}>{selected.kind}</Badge>
                    <span className="text-xs font-medium text-slate-100">{selected.title}</span>
                  </div>
                  {selected.body && (
                    <p className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap text-[11px] text-slate-300">
                      {selected.body}
                    </p>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        <div className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Where the portfolio&apos;s memory lives
          </h3>
          {d.members.length === 0 && (
            <p className="rounded border border-dashed border-slate-700/70 p-4 text-center text-[11px] text-slate-500">
              No member projects yet.
            </p>
          )}
          {d.members.map((m) => (
            <div key={m.project_id} className="rounded-lg border border-slate-800 bg-slate-900/50 p-2.5">
              <button
                type="button"
                onClick={() => openTab(m.project_id, 'main', 'brains')}
                className="text-xs font-medium text-slate-200 hover:text-emerald-300"
                title="Open this project's brains"
              >
                {m.name} →
              </button>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {m.brains.map((b) => (
                  <span
                    key={b.id}
                    className="rounded border border-slate-700/60 px-1.5 py-0.5 text-[10px] text-slate-400"
                  >
                    {SCOPE_LABEL[b.scope] ?? b.scope}
                    {(b.owner_name || b.label) ? ` · ${b.owner_name || b.label}` : ''} · {b.entries}
                  </span>
                ))}
                {m.brains.length === 0 && (
                  <span className="text-[10px] text-slate-600">no brains yet</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
