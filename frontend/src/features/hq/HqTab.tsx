/**
 * The HQ tab (ADR 0011): the whole company on one screen — executive suites, the
 * board room and one pod per project — with the three governance actions that make
 * the floor move: review the books, allocate the portfolio, convene the board.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useCompanyHq } from '../../app/hooks';
import { useTabs } from '../../stores/tabs';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { SkeletonRows } from '../../components/ui/EmptyState';
import { PanelError } from '../../components/PanelError';
import { HqFloor } from './HqFloor';
import { VERDICT_TONE } from './verdict';

export function HqTab({ companyId }: { companyId: string }) {
  const hq = useCompanyHq(companyId);
  const qc = useQueryClient();
  const [topic, setTopic] = useState('Launch readiness review');

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['company-hq', companyId] });
  const review = useMutation({ mutationFn: () => api.reviewCompany(companyId), onSuccess: invalidate });
  const allocate = useMutation({ mutationFn: () => api.allocateCompany(companyId), onSuccess: invalidate });
  const decisions = useQuery({
    queryKey: ['decisions', companyId],
    queryFn: () => api.listDecisions(companyId),
    refetchInterval: 20_000,
  });
  const openTab = useTabs((s) => s.openTab);
  const session = useMutation({
    mutationFn: () => api.conveneBoard(companyId, { topic: topic.trim() }),
    onSuccess: () => {
      invalidate();
      void qc.invalidateQueries({ queryKey: ['decisions', companyId] });
    },
  });

  if (hq.isPending) return <SkeletonRows rows={6} />;
  if (hq.isError) {
    return (
      <PanelError
        error={hq.error}
        onRetry={() => void hq.refetch()}
      />
    );
  }
  const d = hq.data;
  const error = review.error ?? allocate.error ?? session.error;

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <span className="text-sm font-medium text-slate-100">{d.company.name}</span>
        <span className="hidden text-[11px] text-slate-500 sm:inline">{d.company.mission}</span>
        <span className="text-[11px] tabular-nums text-slate-400">
          ${d.company.spend_usd.toFixed(2)} / ${d.company.budget_usd.toFixed(2)}
        </span>
        <div className="flex flex-wrap items-center gap-1">
          {d.projects.map((p) => (
            <button
              key={p.id}
              type="button"
              title={`Open ${p.name}`}
              onClick={() => openTab(p.id, 'main', 'office')}
            >
              <Badge tone={VERDICT_TONE[p.verdict]}>
                {p.name.split('—')[0].trim()} · {p.verdict.replace('_', ' ')}
              </Badge>
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <input
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            aria-label="Board session topic"
            className="w-44 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200 placeholder:text-slate-600"
            placeholder="Board session topic"
          />
          <Button
            size="xs"
            disabled={!topic.trim() || session.isPending}
            onClick={() => session.mutate()}
            title="Seat the board and debate this topic; the outcome is recorded as a binding decision."
          >
            Convene board
          </Button>
          <Button
            size="xs"
            disabled={allocate.isPending}
            onClick={() => allocate.mutate()}
            title="Re-rank the portfolio and hand each project its budget cap from its verdict."
          >
            Allocate
          </Button>
          <Button
            size="xs"
            disabled={review.isPending}
            onClick={() => review.mutate()}
            title="Read every project's books and write one grounded directive into each one."
          >
            Review
          </Button>
        </div>
      </div>
      {error && <p className="px-3 pb-1 text-xs text-rose-400">{error.message}</p>}

      {decisions.data && decisions.data.items.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-t border-slate-800/70 px-3 py-1.5 text-[11px] text-slate-500">
          <span className="uppercase tracking-wide">Board decisions</span>
          {decisions.data.items.slice(0, 4).map((d) => (
            <span
              key={d.id}
              className="max-w-72 truncate rounded border border-slate-800/70 bg-slate-900/50 px-2 py-0.5"
              title={`${d.question}\n\n${d.rationale ?? ''}`}
            >
              <span className="text-slate-200">{d.chosen_option}</span>
              <span className="text-slate-500"> · {d.question}</span>
            </span>
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1 border-t border-slate-800/70">
        <HqFloor hq={d} />
      </div>
    </div>
  );
}
