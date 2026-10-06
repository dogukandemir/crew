import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { Button } from '../../components/ui/Button';
import { Input, Field, Textarea } from '../../components/ui/Field';
import { Modal } from '../../components/ui/Drawer';
import { useUi } from '../../stores/ui';
import { useTabs } from '../../stores/tabs';
import { PanelError } from '../../components/PanelError';

export function NewProjectDialog() {
  const open = useUi((s) => s.newProjectOpen);
  const setOpen = useUi((s) => s.setNewProjectOpen);
  const setToast = useUi((s) => s.setToast);
  const openTab = useTabs((s) => s.openTab);
  const setName = useTabs((s) => s.setName);
  const qc = useQueryClient();

  const [name, setLocalName] = useState('');
  const [goal, setGoal] = useState('');
  const [budget, setBudget] = useState('10');

  const create = useMutation({
    mutationFn: () =>
      api.createProject({
        name: name.trim(),
        goal: goal.trim(),
        budget_cap_usd: Number.parseFloat(budget) || undefined,
      }),
    onSuccess: (project) => {
      setName(project.id, project.name);
      openTab(project.id, 'main', 'office');
      setOpen(false);
      setLocalName('');
      setGoal('');
      setToast({ kind: 'success', message: `Project “${project.name}” created.` });
      void qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });

  const valid = name.trim().length > 0 && goal.trim().length > 0;

  return (
    <Modal
      open={open}
      title="New project"
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
        <Field label="Name">
          <Input value={name} onChange={(e) => setLocalName(e.target.value)} placeholder="ChannelFactory-marketing" autoFocus />
        </Field>
        <Field label="Goal" hint="What should the org achieve? The Orchestrator interprets this and forms the org.">
          <Textarea value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Build a launch plan for the Q3 campaign." />
        </Field>
        <Field label="Budget cap (USD)" hint="Hard-enforced server-side (docs/11 §4 budget_exceeded).">
          <Input type="number" min="0" step="0.5" value={budget} onChange={(e) => setBudget(e.target.value)} />
        </Field>
        {create.isError && <PanelError error={create.error} label="Create project" />}
      </div>
    </Modal>
  );
}
