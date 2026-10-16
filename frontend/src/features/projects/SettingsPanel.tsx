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
import { flattenOrg } from '../org/orgUtils';
import { usdToMicros, microsToUsd } from '../../lib/format';
import { useOrg, useProject } from '../../app/hooks';
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
  cadence_enabled: false,
  cadence_max_runs: 3,
};

const TIERS = ['reasoning', 'standard', 'fast', 'embed'];

/** Bounded numeric settings (docs/10): out-of-range typed values are rejected
 * before the request instead of surfacing as a server error toast. */
function validateSettings(s: ProjectSettings): string | null {
  if (!(s.max_agents >= 1 && s.max_agents <= 24)) return 'Max agents must be between 1 and 24.';
  if (!(s.max_departments >= 1 && s.max_departments <= 6)) return 'Max departments must be between 1 and 6.';
  if (!(s.layoff_idle_days >= 1 && s.layoff_idle_days <= 3650)) {
    return 'Layoff after idle days must be between 1 and 3650.';
  }
  const cadence = s.cadence_max_runs ?? 3;
  if (!(cadence >= 1 && cadence <= 10)) return 'Max consecutive follow-on passes must be between 1 and 10.';
  const warning = s.budget_warning_pct ?? 0.8;
  if (!(warning >= 0 && warning <= 1)) return 'Warning threshold must be between 0 and 1.';
  if (!(s.max_senior_ratio >= 0 && s.max_senior_ratio <= 1)) return 'Max senior ratio must be between 0 and 1.';
  return null;
}

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
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!project.data) return;
    setBudgetUsd(String(microsToUsd(project.data.budget_cap_micros)));
    // API responses also contain server-owned workspace and lifecycle fields.
    // Only copy the controls this form edits into its mutation payload.
    const stored: Partial<ProjectSettings> = project.data.settings ?? {};
    const editable = Object.fromEntries(Object.keys(DEFAULT_SETTINGS)
      .filter(key => stored[key as keyof ProjectSettings] !== undefined)
      .map(key => [key, stored[key as keyof ProjectSettings]]));
    const s = { ...DEFAULT_SETTINGS, ...editable };
    setSettings(s);
    setEgressText((s.egress_allow ?? []).join('\n'));
  }, [project.data]);

  const tiers = useMemo(() => settings.model_tiers ?? {}, [settings.model_tiers]);

  const save = useMutation({
    mutationFn: () => {
      const amount = Number(budgetUsd);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error('Enter a positive budget amount.');
      return api.patchProject(projectId, {
        budget_cap_micros: usdToMicros(amount),
        settings: {
          ...settings,
          egress_allow: egressText
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean),
        },
      });
    },
    onSuccess: () => {
      setFormError(null);
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
          subtitle="New requests reserve estimated usage against this cap. Also set billing limits with your provider."
        actions={
          <>
            {formError && <span className="text-xs text-rose-400">{formError}</span>}
            <Button
              variant="primary"
              size="sm"
              loading={save.isPending}
              onClick={() => {
                const invalid = validateSettings(settings);
                setFormError(invalid);
                if (!invalid) save.mutate();
              }}
            >
              Save
            </Button>
          </>
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
            label="Full autonomy (YOLO)"
            hint="skip every human approval: tools run as requested, and each auto-granted call is audited"
            checked={settings.yolo ?? false}
            onChange={(v) => setSettings((s) => ({ ...s, yolo: v }))}
          />
          <Toggle
            label="Require goal confirmation"
            hint="the orchestrator's interpretation is shown for your approval before planning"
            checked={settings.require_goal_confirmation}
            onChange={(v) => setSettings((s) => ({ ...s, require_goal_confirmation: v }))}
          />
          <Toggle
            label="Require human verification"
            hint="a verdict of pass is not enough, a human must sign off"
            checked={settings.require_human_verification}
            onChange={(v) => setSettings((s) => ({ ...s, require_human_verification: v }))}
          />
        </Section>

        <Section
          title="Operating cadence"
          description="Let the company keep working after a run finishes, the answer to a floor that goes idle."
        >
          <Toggle
            label="Continue automatically"
            hint="when a run completes, start the next pass without waiting for you"
            checked={!!settings.cadence_enabled}
            onChange={(v) => setSettings((s) => ({ ...s, cadence_enabled: v }))}
          />
          <div className="mt-1 max-w-xs">
            <Field
              label="Max consecutive follow-on passes"
              hint="A run you start by hand resets the streak; failures and pauses never continue."
            >
              <Input
                type="number"
                min="1"
                max="10"
                value={settings.cadence_max_runs ?? 3}
                onChange={(e) =>
                  setSettings((s) => ({
                    ...s,
                    cadence_max_runs: Math.max(1, Math.min(10, Number.parseInt(e.target.value, 10) || 1)),
                  }))
                }
              />
            </Field>
          </div>
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
            aria-label="Egress allowlist hosts"
            className="font-mono text-xs"
            rows={5}
          />
        </Section>

        <Section
          title="Command allowlist"
          description="Standing approvals: risky commands you chose to “Always allow” run without asking. Revoking closes the door again, every change is audited."
        >
          <CommandAllowlist projectId={projectId} />
        </Section>

        <Section
          title="Tool allowlist"
          description="Standing tool approvals: when a gated tool (for example the sandboxed Python) is approved with “Always allow”, calls of that capability by that agent stop asking. Revoking closes the gate again immediately."
        >
          <CapabilityAllowlist projectId={projectId} />
        </Section>

        <Section title="Model tier mapping" description="Which provider and model each capability tier resolves to, providers are connected at onboarding.">
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

/** Standing TOOL approvals ("Always allow" on a tool gate): capability + agent,
 * revocable, audited. Hard gates (delete/push/post) never appear here. */
function CapabilityAllowlist({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const setToast = useUi((s) => s.setToast);
  const org = useOrg(projectId);
  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const u of flattenOrg(org.data?.root)) m.set(u.id, u.name);
    return m;
  }, [org.data]);
  const allows = useQuery({
    queryKey: ['project', projectId, 'capability-allows'],
    queryFn: () => api.listCapabilityAllows(projectId),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeCapabilityAllow(id, 'revoked from settings'),
    onSuccess: () => {
      setToast({ kind: 'success', message: 'Standing tool approval revoked, it will ask again.' });
      void qc.invalidateQueries({ queryKey: ['project', projectId, 'capability-allows'] });
    },
    onError: (err) => setToast({ kind: 'error', message: String(err) }),
  });

  if (allows.isLoading) return <p className="text-xs text-slate-500">Loading…</p>;
  if (allows.isError) return <PanelError error={allows.error} label="Tool allowlist" />;
  const items = allows.data?.items ?? [];
  if (items.length === 0) {
    return (
      <p className="text-xs text-slate-500">
        Nothing on the list. When a gated tool is approved with “Always allow”, the capability
        lands here, audited and revocable.
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
          <code className="shrink-0 font-mono text-[11px] text-slate-300">{a.capability}</code>
          <span className="min-w-0 flex-1 truncate text-[11px] text-slate-400">
            {a.agent_id ? (nameById.get(a.agent_id) ?? a.agent_id) : 'any agent'}
          </span>
          <span className="shrink-0 text-[10px] text-slate-500">{a.created_by ?? 'n/a'}</span>
          <Button size="xs" variant="danger" loading={revoke.isPending} onClick={() => revoke.mutate(a.id)}>
            Revoke
          </Button>
        </li>
      ))}
    </ul>
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
      setToast({ kind: 'success', message: 'Allow entry revoked, the command will ask again.' });
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
        Nothing on the list. When a risky command is approved with “Always allow”, it lands here,
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
          <span className="shrink-0 text-[10px] text-slate-500">{a.created_by ?? 'n/a'}</span>
          <Button size="xs" variant="danger" loading={revoke.isPending} onClick={() => revoke.mutate(a.id)}>
            Revoke
          </Button>
        </li>
      ))}
    </ul>
  );
}
