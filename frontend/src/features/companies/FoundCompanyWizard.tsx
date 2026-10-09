import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { Button } from '../../components/ui/Button';
import { Input, Field, Textarea } from '../../components/ui/Field';
import { Modal } from '../../components/ui/Drawer';
import { PanelError } from '../../components/PanelError';
import { cn } from '../../lib/cn';
import { useTabs } from '../../stores/tabs';
import { useUi } from '../../stores/ui';
import { FOUND_TEMPLATES, templateById } from './foundTemplates';

/**
 * Found your company (ADR 0015): company first, its first project born under it, and
 * the first run — one call (`POST /api/found`), one landing on the company floor.
 *
 * Quick setup: pick a template, name the company, done. Detailed setup opens the
 * same form with every field visible (mission, project, goals, budgets, run mode);
 * both paths create exactly the same thing — the preview line says so.
 */
export function FoundCompanyWizard({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [mode, setMode] = useState<'quick' | 'detailed'>('quick');
  const [templateId, setTemplateId] = useState(FOUND_TEMPLATES[0].id);
  const [name, setName] = useState('');
  const [mission, setMission] = useState('');
  const [projectName, setProjectName] = useState('');
  const [goal, setGoal] = useState('');
  const [companyBudget, setCompanyBudget] = useState('');
  const [projectBudget, setProjectBudget] = useState('');
  const [workspacePath, setWorkspacePath] = useState('');
  const [runMode, setRunMode] = useState<'autonomous' | 'interactive'>('autonomous');

  const openTab = useTabs((s) => s.openTab);
  const setToast = useUi((s) => s.setToast);
  const qc = useQueryClient();

  const applyTemplate = (id: string) => {
    const t = templateById(id);
    setTemplateId(t.id);
    setName(t.companyName);
    setMission(t.mission);
    setProjectName(t.projectName);
    setGoal(t.goal);
    setCompanyBudget(String(t.companyBudgetUsd));
    setProjectBudget(String(t.projectBudgetUsd));
  };

  // Re-arm on open: the first template's defaults are the shortest path to a working
  // company; everything stays editable.
  useEffect(() => {
    if (open) {
      setMode('quick');
      setRunMode('autonomous');
      setWorkspacePath('');
      applyTemplate(FOUND_TEMPLATES[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const found = useMutation({
    mutationFn: () =>
      api.foundCompany({
        name: name.trim(),
        mission: mission.trim(),
        budget_usd: Number.parseFloat(companyBudget) || undefined,
        project_name: projectName.trim(),
        project_goal: goal.trim(),
        project_budget_usd: Number.parseFloat(projectBudget) || undefined,
        workspace_path: workspacePath.trim() || undefined,
        mode: runMode,
        start_run: true,
      }),
    onSuccess: ({ company, project }) => {
      openTab(company.id, 'main', 'hq');
      setToast({
        kind: 'success',
        message: `“${company.name}” founded — ${project.name} is planning its first run.`,
      });
      void qc.invalidateQueries({ queryKey: ['projects'] });
      void qc.invalidateQueries({ queryKey: ['companies'] });
      onClose();
    },
  });

  const valid =
    name.trim().length > 0 && projectName.trim().length > 0 && goal.trim().length >= 3;

  return (
    <Modal
      open={open}
      title="Found your company"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!valid}
            loading={found.isPending}
            onClick={() => found.mutate()}
          >
            ⌂ Found the company
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex items-center gap-1 rounded-lg border border-slate-800 bg-slate-950/60 p-0.5 text-xs">
          {(['quick', 'detailed'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={cn(
                'flex-1 rounded-md px-2 py-1 capitalize transition-colors',
                mode === m ? 'bg-slate-800 text-slate-100' : 'text-slate-500 hover:text-slate-300',
              )}
            >
              {m} setup
            </button>
          ))}
        </div>

        <div className="grid grid-cols-3 gap-2">
          {FOUND_TEMPLATES.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => applyTemplate(t.id)}
              aria-pressed={t.id === templateId}
              className={cn(
                'rounded-lg border p-2.5 text-left transition-colors',
                t.id === templateId
                  ? 'border-emerald-400/70 bg-emerald-950/30'
                  : 'border-slate-700/60 bg-slate-900/40 hover:border-slate-500/70',
              )}
            >
              <div className="text-base text-emerald-300">{t.icon}</div>
              <div className="mt-1 text-xs font-medium text-slate-100">{t.title}</div>
              <div className="mt-0.5 text-[11px] leading-snug text-slate-500">{t.blurb}</div>
            </button>
          ))}
        </div>

        <Field label="Company name">
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>

        {mode === 'detailed' && (
          <>
            <Field label="Mission" hint="The company brain's first entry — every member agent retrieves it.">
              <Textarea value={mission} onChange={(e) => setMission(e.target.value)} rows={2} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="First project">
                <Input value={projectName} onChange={(e) => setProjectName(e.target.value)} />
              </Field>
              <Field label="Company budget (USD)">
                <Input
                  type="number"
                  min="0"
                  step="1"
                  value={companyBudget}
                  onChange={(e) => setCompanyBudget(e.target.value)}
                />
              </Field>
            </div>
            <Field label="First project budget (USD)">
              <Input
                type="number"
                min="0"
                step="0.5"
                value={projectBudget}
                onChange={(e) => setProjectBudget(e.target.value)}
              />
            </Field>
            <Field
              label="Workspace root"
              hint="Where this company's project folders live. Agents are jailed to (and sandboxed inside) this tree — they can never touch anything outside it. Empty → ~/crew/workspace/{company}/{project}."
            >
              <Input
                value={workspacePath}
                onChange={(e) => setWorkspacePath(e.target.value)}
                placeholder="Absolute path, e.g. D:\\crew-work or /srv/crew"
                className="font-mono text-xs"
              />
            </Field>
          </>
        )}

        <Field label="First goal" hint="The Orchestrator interprets this and forms the org.">
          <Textarea value={goal} onChange={(e) => setGoal(e.target.value)} rows={2} />
        </Field>

        {mode === 'detailed' && (
          <Field label="First run mode">
            <div className="flex items-center gap-3 text-xs text-slate-300">
              {(['autonomous', 'interactive'] as const).map((m) => (
                <label key={m} className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    name="found-run-mode"
                    checked={runMode === m}
                    onChange={() => setRunMode(m)}
                    className="accent-emerald-500"
                  />
                  {m}
                </label>
              ))}
            </div>
          </Field>
        )}

        <p className="rounded border border-slate-800 bg-slate-950/60 px-3 py-2 text-[11px] leading-relaxed text-slate-500">
          Will create: <span className="text-slate-300">{name.trim() || '—'}</span> (company, CEO +
          board), <span className="text-slate-300">{projectName.trim() || '—'}</span> under it, and
          start its first run{runMode === 'autonomous' ? '' : ' (interactive)'}. Agents work inside{' '}
          <span className="font-mono text-slate-400">
            {workspacePath.trim() || '~/crew/workspace/… (default tree)'}
          </span>{' '}
          — never outside it.
        </p>

        {found.isError && <PanelError error={found.error} label="Found the company" />}
      </div>
    </Modal>
  );
}
