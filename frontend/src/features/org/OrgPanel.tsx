import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type NodeMouseHandler,
} from '@xyflow/react';
import { api } from '../../api/client';
import type { OrgNode } from '../../api/types';
import { Button } from '../../components/ui/Button';
import { EmptyState, SkeletonRows } from '../../components/ui/EmptyState';
import { PanelError } from '../../components/PanelError';
import { Field, Input, Select, Textarea } from '../../components/ui/Field';
import { Modal } from '../../components/ui/Drawer';
import { formatMicros } from '../../lib/format';
import { useOrg } from '../../app/hooks';
import { selectEventLog, useEventLog } from '../../stores/eventLog';
import { useUi } from '../../stores/ui';
import { flattenOrg, layoutOrg, orgCounts, type UnitFlowNode } from './orgUtils';
import { UnitNode } from './UnitNode';
import { UnitDrawer } from './UnitDrawer';

const nodeTypes = { unit: UnitNode };

export function OrgPanel({ projectId, tabId }: { projectId: string; tabId: string }) {
  const org = useOrg(projectId);
  const log = useEventLog(selectEventLog(projectId));
  const drawer = useUi((s) => s.drawers[tabId]);
  const openDrawer = useUi((s) => s.openDrawer);
  const closeDrawer = useUi((s) => s.closeDrawer);

  const [hideArchived, setHideArchived] = useState(true);
  const [showCost, setShowCost] = useState(false);
  const [hearOrg, setHearOrg] = useState(false);
  const [hireOpen, setHireOpen] = useState(false);

  // "Hear the org": units that emitted an event in the last 30s pulse.
  const activeAgents = useMemo(() => {
    if (!hearOrg) return new Set<string>();
    const now = Date.now();
    const set = new Set<string>();
    for (const e of log.items.slice(-300)) {
      if (e.agent_id && now - Date.parse(e.ts) < 30_000) set.add(e.agent_id);
    }
    return set;
  }, [hearOrg, log.items]);

  const graph = useMemo(() => {
    const root = org.data?.root;
    const { nodes, edges } = layoutOrg(root, { hideArchived, showCost });
    const withPulse: UnitFlowNode[] = nodes.map((n) => ({
      ...n,
      data: { ...n.data, pulse: activeAgents.has(n.id) },
    }));
    return { nodes: withPulse, edges };
  }, [org.data, hideArchived, showCost, activeAgents]);

  const counts = useMemo(() => orgCounts(flattenOrg(org.data?.root)), [org.data]);

  const onNodeClick: NodeMouseHandler<UnitFlowNode> = (_event, node) => {
    openDrawer(tabId, { kind: 'unit', id: node.id, name: node.data.unit.name });
  };

  const selected: OrgNode | null =
    drawer?.kind === 'unit' ? findUnit(org.data?.root, drawer.id) : null;

  if (org.isLoading) return <SkeletonRows rows={6} />;
  if (org.isError) return <PanelError error={org.error} onRetry={() => void org.refetch()} label="Org chart" />;
  if (!org.data?.root || counts.agent === 0) {
    return (
      <EmptyState
        icon="◫"
        title="No org yet"
        description="Nothing has been staffed. Start a run on Overview — the orchestrator analyses the goal, works out the capabilities it needs and hires the agents to provide them."
        action={
          <Button variant="primary" size="sm" onClick={() => setHireOpen(true)}>
            Hire an agent manually
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
        <span className="tabular-nums">
          {counts.department} depts · {counts.squad} squads · {counts.agent} agents
        </span>
        <span className="ml-auto flex items-center gap-1">
          <Button size="xs" variant={hideArchived ? 'secondary' : 'ghost'} onClick={() => setHideArchived((v) => !v)}>
            hide archived
          </Button>
          <Button size="xs" variant={showCost ? 'secondary' : 'ghost'} onClick={() => setShowCost((v) => !v)}>
            show cost
          </Button>
          <Button size="xs" variant={hearOrg ? 'secondary' : 'ghost'} onClick={() => setHearOrg((v) => !v)}>
            live pulse
          </Button>
          <Button size="xs" variant="primary" onClick={() => setHireOpen(true)}>
            ＋ Hire
          </Button>
        </span>
      </div>

      <div className="h-[62vh] overflow-hidden rounded-lg border border-slate-700/60 bg-slate-950/60">
        <ReactFlow
          nodes={graph.nodes}
          edges={graph.edges}
          nodeTypes={nodeTypes}
          onNodeClick={onNodeClick}
          fitView
          minZoom={0.15}
          proOptions={{ hideAttribution: true }}
          nodesDraggable={false}
          nodesConnectable={false}
        >
          <Background color="#1e293b" gap={22} />
          <MiniMap pannable zoomable className="!bg-slate-900" maskColor="rgba(2,6,23,0.7)" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>

      <UnitDrawer
        unit={selected}
        projectId={projectId}
        onClose={() => closeDrawer(tabId)}
        onOpenAgent={(agentId) => openDrawer(tabId, { kind: 'agent', id: agentId })}
      />

      <HireDialog
        open={hireOpen}
        onClose={() => setHireOpen(false)}
        projectId={projectId}
        departments={flattenOrg(org.data.root).filter((n) => n.kind === 'department')}
      />

      <p className="text-[11px] text-slate-500">
        Node cost is the unit's own committed spend; the project total below is the authoritative rollup
        (summing every node would double-count). Project spend:{' '}
        {formatMicros(org.data.root.spend_micros ?? org.data.root.cost_micros)} across {counts.department}{' '}
        departments, {counts.squad} squads and {counts.agent} agents.
      </p>
    </div>
  );
}

function findUnit(root: OrgNode | undefined, id: string): OrgNode | null {
  if (!root) return null;
  if (root.id === id) return root;
  for (const child of root.children ?? []) {
    const hit = findUnit(child, id);
    if (hit) return hit;
  }
  return null;
}

function HireDialog({
  open,
  onClose,
  projectId,
  departments,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  departments: OrgNode[];
}) {
  const [role, setRole] = useState('');
  const [grade, setGrade] = useState('2');
  const [departmentId, setDepartmentId] = useState('');
  const [mission, setMission] = useState('');
  const qc = useQueryClient();
  const setToast = useUi((s) => s.setToast);

  const hire = useMutation({
    mutationFn: () =>
      api.hireAgent(projectId, {
        role: role.trim(),
        grade: Number.parseInt(grade, 10),
        department_id: departmentId || undefined,
        mission: mission.trim() || undefined,
      }),
    onSuccess: () => {
      setToast({ kind: 'success', message: 'Hire accepted.' });
      onClose();
      setRole('');
      setMission('');
      void qc.invalidateQueries({ queryKey: ['project', projectId, 'org'] });
    },
    onError: (err) => setToast({ kind: 'error', message: String(err) }),
  });

  return (
    <Modal
      open={open}
      title="Hire an agent"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!role.trim()} loading={hire.isPending} onClick={() => hire.mutate()}>
            Hire
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Role (required)" hint="e.g. Market Researcher, Backend Engineer, QA Verifier">
          <Input value={role} onChange={(e) => setRole(e.target.value)} autoFocus />
        </Field>
        <Field label="Grade" hint="0 trainee … 5 principal — a higher grade unlocks better models and bigger spend limits.">
          <Select value={grade} onChange={(e) => setGrade(e.target.value)}>
            {[0, 1, 2, 3, 4, 5].map((g) => (
              <option key={g} value={g}>
                G{g}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Department" hint="Leave empty and the orchestrator places it.">
          <Select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
            <option value="">— auto —</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Mission">
          <Textarea value={mission} onChange={(e) => setMission(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
