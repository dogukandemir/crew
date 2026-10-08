/**
 * The HQ tab (ADR 0011): the whole company on one screen — executive suites, the
 * board room and one pod per project — with the three governance actions that make
 * the floor move: review the books, allocate the portfolio, convene the board.
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useCompanyHq } from '../../app/hooks';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { SkeletonRows } from '../../components/ui/EmptyState';
import { PanelError } from '../../components/PanelError';
import { HqFloor } from './HqFloor';
import type { CompanyVerdictName } from '../../api/types';

const VERDICT_TONE: Record<CompanyVerdictName, 'success' | 'warning' | 'muted' | 'danger'> = {
  on_track: 'success',
  at_risk: 'warning',
  no_activity: 'muted',
  stop: 'danger',
};

export function HqTab({ companyId }: { companyId: string }) {
  const hq = useCompanyHq(companyId);
  const qc = useQueryClient();
  const [topic, setTopic] = useState('Winter slate review');

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['company-hq', companyId] });
  const review = useMutation({ mutationFn: () => api.reviewCompany(companyId), onSuccess: invalidate });
  const allocate = useMutation({ mutationFn: () => api.allocateCompany(companyId), onSuccess: invalidate });
  const session = useMutation({
    mutationFn: () => api.conveneBoard(companyId, { topic: topic.trim() }),
    onSuccess: invalidate,
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
            <Badge key={p.id} tone={VERDICT_TONE[p.verdict]}>
              {p.name.split('—')[0].trim()} · {p.verdict.replace('_', ' ')}
            </Badge>
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
          <Button size="xs" disabled={!topic.trim() || session.isPending} onClick={() => session.mutate()}>
            Convene board
          </Button>
          <Button size="xs" disabled={allocate.isPending} onClick={() => allocate.mutate()}>
            Allocate
          </Button>
          <Button size="xs" disabled={review.isPending} onClick={() => review.mutate()}>
            Review
          </Button>
        </div>
      </div>
      {error && <p className="px-3 pb-1 text-xs text-rose-400">{error.message}</p>}

      <div className="min-h-0 flex-1 border-t border-slate-800/70">
        <HqFloor hq={d} />
      </div>
    </div>
  );
}
