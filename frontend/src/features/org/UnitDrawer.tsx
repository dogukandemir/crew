import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { OrgNode } from '../../api/types';
import { Drawer } from '../../components/ui/Drawer';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Input, Field, Textarea } from '../../components/ui/Field';
import { KeyValue } from '../../components/ui/Tabs';
import { PanelError } from '../../components/PanelError';
import { SkeletonRows } from '../../components/ui/EmptyState';
import { formatMicros, formatPercent } from '../../lib/format';
import { useAgent, useDepartment } from '../../app/hooks';
import { useUi } from '../../stores/ui';
import { gradeLabel } from './orgUtils';

/**
 * Side drawer for any org unit (docs/09 §2.2). Agent/dept detail is fetched
 * from the detail endpoints; project/squad nodes show what the tree carries.
 */
export function UnitDrawer({
  unit,
  projectId,
  onClose,
  onOpenAgent,
}: {
  unit: OrgNode | null;
  projectId: string;
  onClose: () => void;
  onOpenAgent?: (agentId: string) => void;
}) {
  const isAgent = unit?.kind === 'agent';
  const isDept = unit?.kind === 'department';
  const agent = useAgent(isAgent ? unit?.id : undefined);
  const dept = useDepartment(isDept ? unit?.id : undefined);
  const qc = useQueryClient();
  const setToast = useUi((s) => s.setToast);
  const [reason, setReason] = useState('');

  const transition = useMutation({
    mutationFn: async (kind: 'promote' | 'demote' | 'fire') => {
      if (!unit) throw new Error('no unit');
      const r = reason.trim() || 'manual action from the org chart';
      if (kind === 'promote') return api.promoteAgent(unit.id, r);
      if (kind === 'demote') return api.demoteAgent(unit.id, r);
      return api.fireAgent(unit.id, r);
    },
    onSuccess: (_res, kind) => {
      setToast({ kind: 'success', message: `Agent ${kind} accepted (audited).` });
      setReason('');
      void qc.invalidateQueries({ queryKey: ['project', projectId, 'org'] });
      void qc.invalidateQueries({ queryKey: ['project', projectId, 'leaderboard'] });
    },
    onError: (err) =>
      setToast({ kind: 'error', message: `${err instanceof Error ? err.message : String(err)}` }),
  });

  if (!unit) return null;

  const detail = isAgent ? agent.data : isDept ? dept.data : undefined;
  const loading = (isAgent && agent.isLoading) || (isDept && dept.isLoading);
  const error = isAgent ? agent.error : isDept ? dept.error : null;

  return (
    <Drawer
      open={!!unit}
      onClose={onClose}
      title={unit.name}
      subtitle={
        <span className="flex flex-wrap items-center gap-1">
          <Badge tone="muted">{unit.kind}</Badge>
          {unit.role && <Badge tone="info">{unit.role}</Badge>}
          {unit.grade !== undefined && <Badge tone="accent">G{unit.grade}</Badge>}
          {unit.state && <Badge tone="neutral">{unit.state}</Badge>}
        </span>
      }
      footer={
        isAgent ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="xs" variant="primary" onClick={() => transition.mutate('promote')} disabled={!reason.trim()}>
              ▲ Promote
            </Button>
            <Button size="xs" variant="secondary" onClick={() => transition.mutate('demote')} disabled={!reason.trim()}>
              ▼ Demote
            </Button>
            <Button size="xs" variant="danger" onClick={() => transition.mutate('fire')} disabled={!reason.trim()}>
              Fire (archive)
            </Button>
          </div>
        ) : undefined
      }
    >
      <div className="space-y-3">
        {loading && <SkeletonRows rows={4} />}
        {error && <PanelError error={error} label="Unit detail" />}

        <KeyValue
          pairs={[
            ['id', <code className="font-mono text-[11px]">{unit.id}</code>],
            ['kind', unit.kind],
            ['state', unit.state ?? '—'],
            ['score', typeof unit.score === 'number' ? unit.score.toFixed(3) : '—'],
            ['grade', unit.grade !== undefined ? `${unit.grade} · ${gradeLabel(unit.grade)}` : '—'],
            ['spend', unit.spend_micros !== undefined ? formatMicros(unit.spend_micros) : '—'],
            [
              'budget envelope',
              unit.budget_envelope_micros !== undefined ? formatMicros(unit.budget_envelope_micros) : '—',
            ],
            [
              'success rate',
              (unit.tasks_done ?? 0) > 0 && unit.success_rate !== undefined
                ? formatPercent(unit.success_rate)
                : '—',
            ],
            [
              'tasks',
              unit.tasks_total !== undefined
                ? `${unit.tasks_done ?? 0} / ${unit.tasks_total}`
                : unit.tasks_done !== undefined
                  ? `${unit.tasks_done} done / ${unit.tasks_failed ?? 0} failed`
                  : '—',
            ],
            ['open tasks', unit.open_tasks ?? 0],
            ['mission', unit.mission ?? '—'],
          ]}
        />

        {isAgent && agent.data && (
          <div className="rounded-md border border-slate-700/60 bg-slate-900/50 p-2 text-xs">
            <div className="mb-1 font-medium text-slate-300">Agent</div>
            <KeyValue
              pairs={[
                ['autonomy', agent.data.autonomy ?? '—'],
                ['model tier', agent.data.model_tier ?? '—'],
                ['model', agent.data.model_id ?? '—'],
                ['spend today', formatMicros(agent.data.spend_today_micros)],
                ['evidence', agent.data.evidence_count ?? 0],
                ['penalties', agent.data.penalty_count ?? 0],
                ['skills', (agent.data.skills ?? []).map((s) => s.label ?? s.skill_id).join(', ') || '—'],
              ]}
            />
            {onOpenAgent && (
              <Button
                size="xs"
                variant="secondary"
                className="mt-2"
                onClick={() => {
                  onOpenAgent(unit.id);
                  onClose();
                }}
              >
                Open agent timeline →
              </Button>
            )}
          </div>
        )}

        {isDept && dept.data && (
          <div className="rounded-md border border-slate-700/60 bg-slate-900/50 p-2 text-xs">
            <div className="mb-1 font-medium text-slate-300">Department</div>
            <KeyValue
              pairs={[
                ['status', dept.data.status],
                ['capabilities', (dept.data.capabilities ?? []).join(', ') || '—'],
                ['roster', (dept.data.roster ?? []).length || '—'],
                ['brain', dept.data.brain_id ?? '—'],
              ]}
            />
          </div>
        )}

        {isAgent && (
          <div className="rounded-md border border-slate-700/60 bg-slate-900/50 p-2">
            <Field
              label="Reason (required for promote / demote / fire)"
              hint="Manual transitions are audited server-side."
            >
              <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="why?" />
            </Field>
            <Field label="Steer this agent" hint="Delivered at its next step." className="mt-2">
              <SteerBox agentId={unit.id} />
            </Field>
          </div>
        )}

      </div>
    </Drawer>
  );
}

function SteerBox({ agentId }: { agentId: string }) {
  const [text, setText] = useState('');
  const setToast = useUi((s) => s.setToast);
  const send = useMutation({
    mutationFn: () => api.messageAgent(agentId, text.trim()),
    onSuccess: () => {
      setText('');
      setToast({ kind: 'success', message: 'Message queued for delivery.' });
    },
    onError: (err) => setToast({ kind: 'error', message: String(err) }),
  });
  return (
    <div className="flex gap-2">
      <Textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. prefer deterministic checks over evaluator" />
      <Button size="sm" variant="primary" loading={send.isPending} disabled={!text.trim()} onClick={() => send.mutate()}>
        Send
      </Button>
    </div>
  );
}
