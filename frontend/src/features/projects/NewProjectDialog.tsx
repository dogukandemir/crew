import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { Button } from '../../components/ui/Button';
import { Input, Field, Textarea } from '../../components/ui/Field';
import { Modal } from '../../components/ui/Drawer';
import { useUi } from '../../stores/ui';
import { useTabs } from '../../stores/tabs';
import { useCompanies } from '../../app/hooks';
import { PanelError } from '../../components/PanelError';

const STANDALONE = '__standalone__';

/**
 * New project (ADR 0015, company-first): when opened from a company's portfolio the
 * project is born UNDER that company (fixed, no selector); opened freely it defaults
 * to the first company and still offers "standalone", the model keeps that freedom,
 * the flow just stops hiding it.
 */
export function NewProjectDialog() {
  const open = useUi((s) => s.newProjectOpen);
  const companyContext = useUi((s) => s.newProjectCompanyId);
  const setOpen = useUi((s) => s.setNewProjectOpen);
  const setToast = useUi((s) => s.setToast);
  const openTab = useTabs((s) => s.openTab);
  const rename = useTabs((s) => s.rename);
  const qc = useQueryClient();
  const companies = useCompanies();

  const [name, setLocalName] = useState('');
  const [goal, setGoal] = useState('');
  const [budget, setBudget] = useState('10');
  const [companyId, setCompanyId] = useState<string>(STANDALONE);

  // Re-arm each time the dialog opens: a company-born dialog is pinned to its
  // company; a free one preselects the first company when any exists.
  useEffect(() => {
    if (!open) return;
    setCompanyId(
      companyContext ?? (companies.data?.items?.length ? companies.data.items[0].id : STANDALONE),
    );
  }, [open, companyContext, companies.data]);

  const effective = companyContext ?? companyId;
  const contextName = companyContext
    ? companies.data?.items.find((c) => c.id === companyContext)?.name
    : undefined;

  const create = useMutation({
    mutationFn: () =>
      api.createProject({
        name: name.trim(),
        goal: goal.trim(),
        budget_usd: Number.parseFloat(budget) || undefined,
        company_id: effective === STANDALONE ? null : effective,
      }),
    onSuccess: (project) => {
      rename(project.id, project.name);
      openTab(project.id, 'main', 'office');
      setOpen(false);
      setLocalName('');
      setGoal('');
      const co = companies.data?.items.find((c) => c.id === project.company_id);
      setToast({
        kind: 'success',
        message: co
          ? `Project “${project.name}” born under ${co.name}.`
          : `Project “${project.name}” created.`,
      });
      void qc.invalidateQueries({ queryKey: ['projects'] });
      void qc.invalidateQueries({ queryKey: ['companies'] });
    },
  });

  const valid = name.trim().length > 0 && goal.trim().length > 0;

  return (
    <Modal
      open={open}
      title={contextName ? `New project in ${contextName}` : 'New project'}
      onClose={() => setOpen(false)}
      footer={
        <>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!valid}
            loading={create.isPending}
            onClick={() => create.mutate()}
          >
            Create project
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {companyContext ? (
          <Field label="Company">
            <p className="text-xs text-slate-300">
              ⌂ {contextName ?? 'This company'}, the project reports up to its CEO from birth.
            </p>
          </Field>
        ) : (
          <Field
            label="Company"
            hint="A company's projects report up to its CEO; a standalone project answers to its own Orchestrator."
          >
            <select
              value={companyId}
              onChange={(e) => setCompanyId(e.target.value)}
              className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100 focus:border-emerald-500/60 focus:outline-none"
            >
              <option value={STANDALONE}>standalone (no company)</option>
              {(companies.data?.items ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  ⌂ {c.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Name">
          <Input value={name} onChange={(e) => setLocalName(e.target.value)} placeholder="q3-launch" autoFocus />
        </Field>
        <Field label="Goal" hint="What should the org achieve? The Orchestrator interprets this and forms the org.">
          <Textarea value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Build a launch plan for the Q3 campaign." />
        </Field>
        <Field label="Budget cap (USD)" hint="Hard-enforced server-side, a run cannot exceed the cap.">
          <Input type="number" min="1" max="100000" step="0.5" value={budget} onChange={(e) => setBudget(e.target.value)} />
        </Field>
        {create.isError && <PanelError error={create.error} label="Create project" />}
      </div>
    </Modal>
  );
}
