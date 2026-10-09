import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { ProjectSettings } from '../../api/types';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Field, Input, Textarea, Toggle } from '../../components/ui/Field';
import { Section } from '../../components/ui/Tabs';
import { Modal } from '../../components/ui/Drawer';
import { SkeletonRows } from '../../components/ui/EmptyState';
import { PanelError } from '../../components/PanelError';
import { usdToMicros, microsToUsd } from '../../lib/format';
import { useProject } from '../../app/hooks';
import { useUi } from '../../stores/ui';

const DEFAULT_SETTINGS: ProjectSettings = {
  autonomous_intake: false,
  require_goal_confirmation: true,
  require_human_verification: false,
  max_agents: 24,
  max_departments: 6,
  max_senior_ratio: 0.5,
  auto_hire: true,
  layoff_idle_days: 14,
  budget_warning_pct: 0.8,
  egress_allow: [],
  model_tiers: {},
};

const TIERS = ['reasoning', 'standard', 'fast', 'embed'];

/** Settings (docs/09 §2.9, MVP = budget + limits + autonomy + egress + tiers + danger zone). */
export function SettingsPanel({ projectId }: { projectId: string }) {
  const project = useProject(projectId);
  const qc = useQueryClient();
  const setToast = useUi((s) => s.setToast);

  const [settings, setSettings] = useState<ProjectSettings>(DEFAULT_SETTINGS);
  const [budgetUsd, setBudgetUsd] = useState('10');
  const [egressText, setEgressText] = useState('');
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveWord, setArchiveWord] = useState('');

  useEffect(() => {
    if (!project.data) return;
    setBudgetUsd(String(microsToUsd(project.data.budget_cap_micros)));
    const s = { ...DEFAULT_SETTINGS, ...(project.data.settings ?? {}) };
    setSettings(s);
    setEgressText((s.egress_allow ?? []).join('\n'));
  }, [project.data]);

  const tiers = useMemo(() => settings.model_tiers ?? {}, [settings.model_tiers]);

  const save = useMutation({
    mutationFn: () =>
      api.patchProject(projectId, {
        budget_cap_micros: usdToMicros(Number.parseFloat(budgetUsd) || 0),
        settings: {
          ...settings,
          egress_allow: egressText
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean),
        },
      }),
    onSuccess: () => {
      setToast({ kind: 'success', message: 'Settings saved.' });
      void qc.invalidateQueries({ queryKey: ['project', projectId] });
      void qc.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (err) => setToast({ kind: 'error', message: String(err) }),
  });

  const lifecycle = useMutation({
    mutationFn: (action: 'pause' | 'resume' | 'archive') => {
      if (action === 'pause') return api.pauseProject(projectId);
      if (action === 'resume') return api.resumeProject(projectId);
      return api.archiveProject(projectId);
    },
    onSuccess: (_r, action) => {
      setToast({ kind: 'success', message: `Project ${action} accepted.` });
      setArchiveOpen(false);
      setArchiveWord('');
      void qc.invalidateQueries({ queryKey: ['project', projectId] });
      void qc.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (err) => setToast({ kind: 'error', message: String(err) }),
  });

  const verifyAudit = useMutation({
    mutationFn: api.verifyAudit,
    onSuccess: (r) =>
      setToast({
        kind: r.ok ? 'success' : 'error',
        message: r.ok ? 'Audit hash chain verified.' : `Audit chain broken at seq ${r.broken_at}`,
      }),
    onError: (err) => setToast({ kind: 'error', message: String(err) }),
  });

  if (project.isLoading) return <SkeletonRows rows={8} />;
  if (project.isError) return <PanelError error={project.error} onRetry={() => void project.refetch()} label="Settings" />;
  if (!project.data) return null;

  const paused = project.data.status === 'paused';

  return (
    <div className="max-w-3xl">
      <Card
        title="Budget"
        subtitle="Hard-enforced server-side: a run physically cannot exceed the cap."
        actions={
          <Button variant="primary" size="sm" loading={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        }
      >
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="Project budget cap (USD)">
            <Input type="number" min="0" step="0.5" value={budgetUsd} onChange={(e) => setBudgetUsd(e.target.value)} />
          </Field>
          <Field label="Warning threshold (fraction of cap)" hint="Raises a budget.warning event above this level.">
            <Input
              type="number"
              min="0"
              max="1"
              step="0.05"
              value={String(settings.budget_warning_pct ?? 0.8)}
              onChange={(e) =>
                setSettings((s) => ({ ...s, budget_warning_pct: Number.parseFloat(e.target.value) || 0 }))
              }
            />
          </Field>
        </div>

        <Section title="Autonomy" description="What the org may do without asking you.">
          <Toggle
            label="Autonomous intake"
            hint="agent picks up new work without a confirmation gate"
            checked={settings.autonomous_intake}
            onChange={(v) => setSettings((s) => ({ ...s, autonomous_intake: v }))}
          />
          <Toggle
            label="Require goal confirmation"
            hint="the orchestrator's interpretation is shown for your approval before planning"
            checked={settings.require_goal_confirmation}
            onChange={(v) => setSettings((s) => ({ ...s, require_goal_confirmation: v }))}
          />
          <Toggle
            label="Require human verification"
            hint="a verdict of pass is not enough — a human must sign off"
            checked={settings.require_human_verification}
            onChange={(v) => setSettings((s) => ({ ...s, require_human_verification: v }))}
          />
        </Section>

        <Section title="Org limits" description="Bounds on the shape of the organization.">
          <div className="grid gap-2 sm:grid-cols-3">
            <Field label="Max agents">
              <Input
                type="number"
                min="1"
                value={settings.max_agents}
                onChange={(e) => setSettings((s) => ({ ...s, max_agents: Number.parseInt(e.target.value, 10) || 0 }))}
              />
            </Field>
            <Field label="Max departments">
              <Input
                type="number"
                min="1"
                value={settings.max_departments}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, max_departments: Number.parseInt(e.target.value, 10) || 0 }))
                }
              />
            </Field>
            <Field label="Max senior ratio (0–1)">
              <Input
                type="number"
                min="0"
                max="1"
                step="0.05"
                value={settings.max_senior_ratio}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, max_senior_ratio: Number.parseFloat(e.target.value) || 0 }))
                }
              />
            </Field>
          </div>
          <Toggle
            label="Auto-hire"
            hint="let the orchestrator hire when a capability gap blocks work"
            checked={settings.auto_hire}
            onChange={(v) => setSettings((s) => ({ ...s, auto_hire: v }))}
          />
          <div className="mt-1 max-w-xs">
            <Field label="Layoff after idle days">
              <Input
                type="number"
                min="0"
                value={settings.layoff_idle_days}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, layoff_idle_days: Number.parseInt(e.target.value, 10) || 0 }))
                }
              />
            </Field>
          </div>
        </Section>

        <Section
          title="Egress allowlist"
          description="Default-deny. One host per line. Blocked attempts are logged as security.egress.blocked."
        >
          <Textarea
            value={egressText}
            onChange={(e) => setEgressText(e.target.value)}
            placeholder={'api.example.com\nfiles.pythonhosted.org'}
            className="font-mono text-xs"
            rows={5}
          />
        </Section>

        <Section
          title="Command allowlist"
          description="Standing approvals (ADR 0017): risky commands you chose to “Always allow” run without asking. Revoking closes the door again — every change is audited."
        >
          <CommandAllowlist projectId={projectId} />
        </Section>

        <Section title="Model tier mapping" description="Which provider and model each capability tier resolves to — providers are connected at onboarding.">
          <div className="grid gap-2 sm:grid-cols-2">
            {TIERS.map((tier) => (
              <Field key={tier} label={tier}>
                <Input
                  value={tiers[tier] ?? ''}
                  placeholder="deepseek/deepseek-flash"
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      model_tiers: { ...(s.model_tiers ?? {}), [tier]: e.target.value },
                    }))
                  }
                />
              </Field>
            ))}
          </div>
        </Section>
      </Card>

      <Card title="Danger zone" subtitle="These act on the project immediately." className="mt-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            loading={lifecycle.isPending}
            onClick={() => lifecycle.mutate(paused ? 'resume' : 'pause')}
          >
            {paused ? '▶ Resume project' : '⏸ Pause project'}
          </Button>
          <Button size="sm" variant="danger" onClick={() => setArchiveOpen(true)}>
            Archive project
          </Button>
          <Button size="sm" variant="ghost" loading={verifyAudit.isPending} onClick={() => verifyAudit.mutate()}>
            Verify audit chain
          </Button>
        </div>
        <p className="mt-2 text-[11px] text-slate-500">
          Deleting a project is a soft archive server-side: runs stop, nothing is destroyed.
        </p>
      </Card>

      <Modal
        open={archiveOpen}
        title="Archive project"
        onClose={() => {
          setArchiveOpen(false);
          setArchiveWord('');
        }}
        footer={
          <>
            <Button variant="ghost" onClick={() => setArchiveOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="dangerSolid"
              disabled={archiveWord !== project.data.name}
              loading={lifecycle.isPending}
              onClick={() => lifecycle.mutate('archive')}
            >
              Archive
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-300">
          Archiving stops all runs and hides the project from the active list. Type the project name to confirm.
        </p>
        <label className="mt-3 block">
          <span className="mb-1 block text-xs text-slate-400">
            Type <code className="font-mono text-amber-300">{project.data.name}</code>
          </span>
          <Input value={archiveWord} onChange={(e) => setArchiveWord(e.target.value)} autoFocus />
        </label>
      </Modal>
    </div>
  );
}

/** The owner's standing permissions (ADR 0017): every entry here was approved by a
 * human with "Always allow"; revoking closes the gate again immediately. */
function CommandAllowlist({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const setToast = useUi((s) => s.setToast);
  const allows = useQuery({
    queryKey: ['project', projectId, 'command-allows'],
    queryFn: () => api.listCommandAllows(projectId),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeCommandAllow(id, 'revoked from settings'),
    onSuccess: () => {
      setToast({ kind: 'success', message: 'Allow entry revoked — the command will ask again.' });
      void qc.invalidateQueries({ queryKey: ['project', projectId, 'command-allows'] });
    },
    onError: (err) => setToast({ kind: 'error', message: String(err) }),
  });

  if (allows.isLoading) return <p className="text-xs text-slate-500">Loading…</p>;
  if (allows.isError) return <PanelError error={allows.error} label="Command allowlist" />;
  const items = allows.data?.items ?? [];
  if (items.length === 0) {
    return (
      <p className="text-xs text-slate-500">
        Nothing on the list. When a risky command is approved with “Always allow”, it lands here —
        audited and revocable.
      </p>
    );
  }
  return (
    <ul className="space-y-1.5">
      {items.map((a) => (
        <li
          key={a.id}
          className="flex items-center gap-2 rounded border border-slate-700/60 bg-slate-900/50 px-2 py-1.5"
        >
          <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-300" title={a.command}>
            {a.command}
          </code>
          <span className="shrink-0 text-[10px] text-slate-500">{a.created_by ?? '—'}</span>
          <Button size="xs" variant="danger" loading={revoke.isPending} onClick={() => revoke.mutate(a.id)}>
            Revoke
          </Button>
        </li>
      ))}
    </ul>
  );
}
