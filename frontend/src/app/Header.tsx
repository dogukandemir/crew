import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { Button } from '../components/ui/Button';
import { Modal } from '../components/ui/Drawer';
import { Input } from '../components/ui/Field';
import { ProgressBar } from '../components/ui/Card';
import { StatusDot } from '../components/ui/StatusDot';
import { Badge } from '../components/ui/Badge';
import { useHealth, useProjects } from './hooks';
import { useTabs } from '../stores/tabs';
import { useConnection } from '../stores/connection';
import { useUi } from '../stores/ui';
import { budgetFraction, formatMicros, formatPercent } from '../lib/format';
import { CONTRACT_VERSION } from '../api/types';

function ConnectionIndicator() {
  const { data, isError, isLoading } = useHealth();
  const tabs = useTabs((s) => s.tabs);
  const byProject = useConnection((s) => s.byProject);

  const openSockets = tabs.map((t) => byProject[t.projectId]).filter(Boolean);
  const live = openSockets.filter((c) => c.state === 'connected').length;
  const total = tabs.length;

  if (isError) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-rose-300">
        <StatusDot state="offline" />
        offline
      </span>
    );
  }
  if (isLoading || !data) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-slate-400">
        <StatusDot state="idle" pulse />
        connecting…
      </span>
    );
  }
  const mismatch = data.contract !== CONTRACT_VERSION;
  return (
    <span
      className="flex items-center gap-1.5 text-xs text-slate-300"
      title={`backend ${data.version} · contract ${data.contract} · live event streams: ${live} of ${total} open tabs`}
    >
      <StatusDot state={total === 0 || live > 0 ? 'ok' : 'warning'} pulse />
      connected
      {total > 0 && (
        <span className="text-slate-500" title="open project tabs with a live stream">
          {live}/{total}
        </span>
      )}
      {mismatch && <Badge tone="warning">contract {data.contract}≠{CONTRACT_VERSION}</Badge>}
    </span>
  );
}

function GlobalBudgetMeter() {
  const { data } = useProjects();
  const projects = data?.items ?? [];
  const spend = projects.reduce((sum, p) => sum + (p.spend_micros ?? 0), 0);
  const cap = projects.reduce((sum, p) => sum + (p.budget_cap_micros ?? 0), 0);
  if (projects.length === 0) return null;
  const fraction = budgetFraction(spend, cap);
  return (
    <div
      className="hidden min-w-[10rem] items-center gap-2 md:flex"
      title={`all projects — ${formatMicros(spend)} of ${formatMicros(cap)}`}
    >
      <div className="w-24">
        <ProgressBar
          value={fraction}
          tone={fraction > 0.9 ? 'danger' : fraction > 0.7 ? 'warning' : 'accent'}
          label="all-projects budget"
        />
      </div>
      <span className="text-[11px] tabular-nums text-slate-400">
        <span className="text-slate-600">all projects · </span>
        {formatMicros(spend)} <span className="text-slate-600">/ {formatMicros(cap)}</span> · {formatPercent(fraction)}
      </span>
    </div>
  );
}

function KillSwitch() {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const qc = useQueryClient();
  const { data } = useProjects();
  const setToast = useUi((s) => s.setToast);
  // no runs in flight → keep the emergency stop available but quiet (it was the
  // loudest thing on an empty control room)
  const active = (data?.items ?? []).some(
    (p) => !!p.stage && !['IDLE', 'DONE', 'FAILED', ''].includes(p.stage),
  );

  const kill = useMutation({
    mutationFn: () => api.killAll(true),
    onSuccess: () => {
      setOpen(false);
      setTyped('');
      setToast({ kind: 'success', message: 'Kill signal accepted for all runs.' });
      void qc.invalidateQueries();
    },
    onError: (err) => {
      setToast({ kind: 'error', message: `Kill failed: ${err instanceof Error ? err.message : String(err)}` });
    },
  });

  const confirmWord = 'KILL';

  return (
    <>
      <Button
        variant={active ? 'dangerSolid' : 'ghost'}
        size="sm"
        onClick={() => setOpen(true)}
        title={active
          ? 'Stop every run in every project'
          : 'Emergency stop — nothing is running right now, but this always stops everything'}
      >
        ⏹ Kill all
      </Button>
      <Modal
        open={open}
        title="Kill all runs?"
        onClose={() => {
          setOpen(false);
          setTyped('');
        }}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setOpen(false);
                setTyped('');
              }}
            >
              Cancel
            </Button>
            <Button
              variant="dangerSolid"
              disabled={typed !== confirmWord}
              loading={kill.isPending}
              onClick={() => kill.mutate()}
            >
              Kill everything
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-300">
          This stops <strong>every run in every project</strong>. Agents in flight are aborted; queued
          jobs are cancelled. Work already completed is preserved.
        </p>
        <label className="mt-3 block">
          <span className="mb-1 block text-xs text-slate-400">
            Type <code className="font-mono text-amber-300">{confirmWord}</code> to confirm
          </span>
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={confirmWord} autoFocus />
        </label>
      </Modal>
    </>
  );
}

export function Header() {
  const newProjectOpen = useUi((s) => s.newProjectOpen);
  const setNewProjectOpen = useUi((s) => s.setNewProjectOpen);

  return (
    <header className="flex items-center justify-between gap-3 border-b border-slate-700/60 bg-slate-950/80 px-3 py-1.5">
      <div className="flex items-center gap-3">
        <span className="text-sm font-semibold tracking-tight text-slate-100">
          <span className="mr-1 text-emerald-400">◈</span>Crew
        </span>
        <Button variant="secondary" size="xs" onClick={() => setNewProjectOpen(!newProjectOpen)}>
          ＋ New project
        </Button>
      </div>
      <div className="flex items-center gap-4">
        <GlobalBudgetMeter />
        <ConnectionIndicator />
        <KillSwitch />
      </div>
    </header>
  );
}
