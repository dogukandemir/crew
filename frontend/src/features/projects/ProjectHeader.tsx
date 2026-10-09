import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { Project, Stage } from '../../api/types';
import { STAGES } from '../../api/types';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { Input } from '../../components/ui/Field';
import { ProgressBar } from '../../components/ui/Card';
import { Skeleton } from '../../components/ui/EmptyState';
import { cn } from '../../lib/cn';
import { budgetFraction, formatMicros, formatPercent } from '../../lib/format';
import { useCompanies, useProject, useProjects } from '../../app/hooks';
import { useTabs } from '../../stores/tabs';
import { useUi } from '../../stores/ui';
import { Menu } from '../../components/ui/Menu';
import { switchTargets } from './projectSwitch';

function StageStepper({ stage }: { stage: Stage }) {
  const current = STAGES.indexOf(stage);
  return (
    <ol className="flex flex-wrap items-center gap-1" aria-label="Run stage">
      {STAGES.map((s, i) => {
        const done = current >= 0 && i < current;
        const active = i === current;
        return (
          <li key={s} className="flex items-center gap-1">
            <span
              className={cn(
                'rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
                active
                  ? 'border-emerald-400/70 bg-emerald-950/60 text-emerald-300'
                  : done
                    ? 'border-slate-600/60 bg-slate-800/60 text-slate-300'
                    : 'border-slate-700/50 text-slate-500',
              )}
              aria-current={active ? 'step' : undefined}
            >
              {s}
            </span>
            {i < STAGES.length - 1 && <span className="text-slate-700">›</span>}
          </li>
        );
      })}
    </ol>
  );
}

function GoalEditor({ project }: { project: Project }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(project.goal);
  const qc = useQueryClient();
  const setToast = useUi((s) => s.setToast);

  useEffect(() => setDraft(project.goal), [project.goal]);

  const save = useMutation({
    mutationFn: () => api.patchProject(project.id, { goal: draft.trim() }),
    onSuccess: () => {
      setEditing(false);
      setToast({ kind: 'success', message: 'Goal updated.' });
      void qc.invalidateQueries({ queryKey: ['project', project.id] });
    },
    onError: (err) =>
      setToast({ kind: 'error', message: `Goal update failed: ${err instanceof Error ? err.message : err}` }),
  });

  if (!editing) {
    return (
      <p className="flex min-w-0 items-start gap-2 text-xs text-slate-300">
        <span className="min-w-0 truncate" title={project.goal}>
          {project.goal || '— no goal set —'}
        </span>
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="shrink-0 text-[10px] text-slate-500 underline decoration-dotted hover:text-emerald-300"
        >
          edit
        </button>
      </p>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Input value={draft} onChange={(e) => setDraft(e.target.value)} className="h-7 text-xs" autoFocus />
      <Button size="xs" variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
        Save
      </Button>
      <Button size="xs" variant="ghost" onClick={() => setEditing(false)}>
        Cancel
      </Button>
    </div>
  );
}

function LifecycleControls({ project }: { project: Project }) {
  const qc = useQueryClient();
  const setToast = useUi((s) => s.setToast);
  const paused = project.status === 'paused';

  const mutate = useMutation({
    mutationFn: () => (paused ? api.resumeProject(project.id) : api.pauseProject(project.id)),
    onSuccess: () => {
      setToast({ kind: 'success', message: paused ? 'Project resumed.' : 'Project paused.' });
      void qc.invalidateQueries({ queryKey: ['project', project.id] });
      void qc.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (err) =>
      setToast({ kind: 'error', message: `Lifecycle command failed: ${err instanceof Error ? err.message : err}` }),
  });

  return (
    <Button size="xs" variant="secondary" loading={mutate.isPending} onClick={() => mutate.mutate()}>
      {paused ? '▶ Resume' : '⏸ Pause'}
    </Button>
  );
}

export function ProjectHeader({ projectId }: { projectId: string }) {
  const project = useProject(projectId);
  const companies = useCompanies();
  const allProjects = useProjects();
  const openTab = useTabs((s) => s.openTab);
  const rename = useTabs((s) => s.rename);
  const activeTabId = useTabs((s) => s.activeTabId);
  const openDrawer = useUi((s) => s.openDrawer);

  useEffect(() => {
    if (project.data) rename(projectId, project.data.name);
  }, [project.data, projectId, rename]);

  const fraction = useMemo(
    () => budgetFraction(project.data?.spend_micros, project.data?.budget_cap_micros),
    [project.data],
  );

  if (project.isLoading) {
    return (
      <div className="space-y-2 border-b border-slate-800/70 px-3 py-2">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-3 w-72" />
      </div>
    );
  }

  if (project.isError || !project.data) {
    return (
      <div className="border-b border-slate-800/70 px-3 py-2 text-xs text-slate-400">
        Project {projectId.slice(0, 8)} — detail unavailable.
      </div>
    );
  }

  const p = project.data;
  const isCompany = p.kind === 'company';
  const targets = switchTargets(p, companies.data?.items, allProjects.data?.items);

  return (
    <div className="border-b border-slate-800/70 px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {p.company_id && (
          <>
            {/* Up one level (ADR 0015): the company the project reports to. */}
            <button
              type="button"
              onClick={() => openTab(p.company_id as string, 'main', 'hq')}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-slate-400 hover:bg-slate-800/70 hover:text-emerald-300"
              title="Up one level — open the company floor"
            >
              ⌂ {p.company_name ?? 'Company'}
            </button>
            <span className="text-slate-600">›</span>
          </>
        )}
        <h1 className="text-sm font-semibold text-slate-100">{p.name}</h1>
        <Badge tone={p.status === 'active' ? 'success' : p.status === 'paused' ? 'warning' : 'muted'}>
          {p.status}
        </Badge>
        {isCompany && <Badge tone="info">company</Badge>}
        {!isCompany && <StageStepper stage={p.stage} />}
        <div className="ml-auto flex items-center gap-2">
          <div className="w-28" title={`${formatMicros(p.spend_micros)} of ${formatMicros(p.budget_cap_micros)}`}>
            <ProgressBar
              value={fraction}
              tone={fraction > 0.9 ? 'danger' : fraction > 0.7 ? 'warning' : 'accent'}
              label="budget"
            />
          </div>
          <span className="text-[11px] tabular-nums text-slate-400">
            {formatMicros(p.spend_micros)}
            <span className="text-slate-600"> / {formatMicros(p.budget_cap_micros)}</span> ·{' '}
            {formatPercent(fraction)}
          </span>
          {targets.length > 0 && (
            <Menu
              label="⇄ switch"
              title="Switch between this company's projects"
              items={[
                ...targets.map((t) => ({
                  key: t.id,
                  current: t.current,
                  label: (
                    <>
                      <span className="min-w-0 flex-1 truncate">{t.name}</span>
                      {t.status && <span className="text-[10px] text-slate-500">{t.status}</span>}
                      {t.current && <span className="text-[10px] text-emerald-400">current</span>}
                    </>
                  ),
                  onSelect: () => openTab(t.id, 'main', 'office'),
                })),
                ...(p.company_id
                  ? [
                      {
                        key: '__hq',
                        label: <span className="text-slate-300">🏢 Open HQ floor</span>,
                        onSelect: () => openTab(p.company_id as string, 'main', 'hq'),
                      },
                    ]
                  : []),
              ]}
            />
          )}
          {!isCompany && <LifecycleControls project={p} />}
          {!isCompany && (
            <Button
              size="xs"
              variant="secondary"
              title="The Captain's desk — give orders, float ideas, ask questions"
              onClick={() => {
                if (activeTabId) openDrawer(activeTabId, { kind: 'command', id: 'command' });
              }}
            >
              ❯ Command
            </Button>
          )}
          <Button
            size="xs"
            variant="ghost"
            title="Open a second view of this project side by side"
            onClick={() => openTab(projectId, `alt-${Date.now().toString(36)}`, 'org')}
          >
            ⧉ split
          </Button>
        </div>
      </div>
      <div className="mt-1 flex items-center gap-2">
        <Badge tone="muted">{isCompany ? 'mission' : 'goal'}</Badge>
        <GoalEditor project={p} />
      </div>
    </div>
  );
}
