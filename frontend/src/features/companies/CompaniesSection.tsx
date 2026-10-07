import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useCompanies, useProjects } from '../../app/hooks';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import type { CompanyVerdictName } from '../../api/types';

const VERDICT_TONE: Record<CompanyVerdictName, 'success' | 'warning' | 'muted' | 'danger'> = {
  on_track: 'success',
  at_risk: 'warning',
  no_activity: 'muted',
  stop: 'danger',
};

/**
 * The company strip (ADR 0009): headquarters above the projects. Optional by design —
 * a backend without the company layer fails this query and the section disappears
 * rather than breaking Home.
 */
export function CompaniesSection() {
  const companies = useCompanies();
  const projects = useProjects();
  const qc = useQueryClient();
  const [name, setName] = useState('');

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['companies'] });
  const create = useMutation({
    mutationFn: () => api.createCompany({ name: name.trim() }),
    onSuccess: () => {
      setName('');
      invalidate();
    },
  });
  const attach = useMutation({
    mutationFn: (p: { companyId: string; projectId: string }) =>
      api.attachProjectToCompany(p.companyId, p.projectId),
    onSuccess: () => {
      invalidate();
      void qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });
  const review = useMutation({
    mutationFn: (companyId: string) => api.reviewCompany(companyId),
    onSuccess: invalidate,
  });

  if (companies.isError) return null;

  const items = companies.data?.items ?? [];
  const attachable = (projects.data?.items ?? []).filter((p) => !p.company_id);
  const error = create.error ?? attach.error ?? review.error;

  return (
    <section className="mt-8">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-slate-300">Companies</h2>
        <div className="flex items-center gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="New company name"
            className="rounded-md border border-slate-700/60 bg-slate-900/60 px-2 py-1 text-xs text-slate-200 placeholder:text-slate-600"
          />
          <Button
            variant="primary"
            size="sm"
            disabled={!name.trim() || create.isPending}
            onClick={() => create.mutate()}
          >
            ＋ New company
          </Button>
        </div>
      </div>

      {error && <p className="mt-2 text-xs text-rose-400">{error.message}</p>}

      {items.length === 0 ? (
        <p className="mt-2 text-xs text-slate-500">
          None yet. A company is a headquarters that holds the portfolio: it hires a CEO, projects attach
          to it, and a review writes one binding directive — grounded in each project&apos;s own numbers —
          into every member&apos;s stream.
        </p>
      ) : (
        <ul className="mt-3 space-y-3">
          {items.map((c) => (
            <li key={c.id} className="rounded-lg border border-slate-700/60 px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-slate-100">{c.name}</span>
                {c.ceo && <Badge tone="info">CEO · {c.ceo.name}</Badge>}
                <Badge tone="neutral">
                  {c.projects.length} project{c.projects.length === 1 ? '' : 's'}
                </Badge>
                <span className="ml-auto text-[11px] tabular-nums text-slate-400">
                  {Math.round(c.spend_ratio * 100)}% of budget used
                </span>
              </div>

              {c.last_review && c.last_review.verdicts.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {c.last_review.verdicts.map((v) => (
                    <li key={v.project_id} className="flex items-start gap-2 text-xs">
                      <Badge tone={VERDICT_TONE[v.verdict] ?? 'neutral'}>
                        {v.verdict.replace('_', ' ')}
                      </Badge>
                      <span className="text-slate-400">
                        <span className="text-slate-300">{v.name}</span> — {v.directive}
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              <div className="mt-2 flex items-center gap-2">
                <Button size="xs" disabled={review.isPending} onClick={() => review.mutate(c.id)}>
                  Review now
                </Button>
                <select
                  aria-label={`Attach a project to ${c.name}`}
                  className="rounded-md border border-slate-700/60 bg-slate-900/60 px-2 py-1 text-xs text-slate-300"
                  defaultValue=""
                  onChange={(e) => {
                    if (e.target.value) attach.mutate({ companyId: c.id, projectId: e.target.value });
                  }}
                >
                  <option value="" disabled>
                    {attachable.length ? 'Attach a project…' : 'No unattached projects'}
                  </option>
                  {attachable.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
