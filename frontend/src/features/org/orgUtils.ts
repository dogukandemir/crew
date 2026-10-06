import type { Edge, Node } from '@xyflow/react';
import type { OrgNode } from '../../api/types';

export interface UnitNodeData extends Record<string, unknown> {
  unit: OrgNode;
  /** "Hear the org": this unit emitted an event in the last 30 s. */
  pulse?: boolean;
}

export type UnitFlowNode = Node<UnitNodeData, 'unit'>;

export const X_GAP = 210;
export const Y_GAP = 132;

export function flattenOrg(node: OrgNode | null | undefined): OrgNode[] {
  if (!node) return [];
  const out: OrgNode[] = [];
  const walk = (n: OrgNode) => {
    out.push(n);
    for (const child of n.children ?? []) walk(child);
  };
  walk(node);
  return out;
}

export interface OrgCounts {
  project: number;
  department: number;
  squad: number;
  agent: number;
}

export function orgCounts(nodes: OrgNode[]): OrgCounts {
  const counts: OrgCounts = { project: 0, department: 0, squad: 0, agent: 0 };
  for (const n of nodes) {
    if (n.kind in counts) counts[n.kind as keyof OrgCounts] += 1;
  }
  return counts;
}

export function orgSpendMicros(nodes: OrgNode[]): number {
  return nodes
    .filter((n) => n.kind === 'department' || n.kind === 'project')
    .reduce((sum, n) => sum + (n.spend_micros ?? n.cost_micros ?? 0), 0);
}

export interface LayoutOptions {
  /** Hide archived units unless explicitly shown (docs/09 §2.2). */
  hideArchived?: boolean;
  /** Node size by spend ("show cost" overlay). */
  showCost?: boolean;
}

/**
 * A tidy layered layout: leaves are packed left-to-right, parents are centred
 * over their children. Deterministic, so the chart does not jump on re-render.
 */
export function layoutOrg(
  root: OrgNode | null | undefined,
  opts: LayoutOptions = {},
): { nodes: UnitFlowNode[]; edges: Edge[] } {
  if (!root) return { nodes: [], edges: [] };

  const hideArchived = opts.hideArchived ?? true;

  const childrenOf = (n: OrgNode): OrgNode[] =>
    (n.children ?? []).filter((c) => !(hideArchived && c.state === 'archived'));

  const positions = new Map<string, { x: number; y: number }>();
  let cursor = 0;

  const walk = (node: OrgNode, depth: number): void => {
    const kids = childrenOf(node);
    if (kids.length === 0) {
      positions.set(node.id, { x: cursor * X_GAP, y: depth * Y_GAP });
      cursor += 1;
      return;
    }
    const xs: number[] = [];
    for (const kid of kids) {
      walk(kid, depth + 1);
      const p = positions.get(kid.id);
      if (p) xs.push(p.x);
    }
    const x = xs.length ? (Math.min(...xs) + Math.max(...xs)) / 2 : cursor++ * X_GAP;
    positions.set(node.id, { x, y: depth * Y_GAP });
  };

  walk(root, 0);

  const all = flattenOrg(root);
  const maxSpend = Math.max(
    1,
    ...all.map((n) => n.spend_micros ?? n.cost_micros ?? 0),
  );

  const nodes: UnitFlowNode[] = all
    .filter((n) => positions.has(n.id))
    .map((n) => ({
      id: n.id,
      type: 'unit',
      position: positions.get(n.id) ?? { x: 0, y: 0 },
      data: { unit: n },
      style: opts.showCost
        ? {
            // Cost overlay: size encodes spend (docs/09 §2.2).
            width: `${150 + Math.round(((n.spend_micros ?? n.cost_micros ?? 0) / maxSpend) * 90)}px`,
          }
        : undefined,
    }));

  const edges: Edge[] = [];
  const walkEdges = (node: OrgNode) => {
    for (const kid of childrenOf(node)) {
      if (!positions.has(kid.id)) continue;
      edges.push({
        id: `${node.id}->${kid.id}`,
        source: node.id,
        target: kid.id,
        type: 'smoothstep',
        animated: kid.kind === 'agent' && (kid.open_tasks ?? 0) > 0,
        style: { stroke: '#475569', strokeWidth: 1.25 },
      });
      walkEdges(kid);
    }
  };
  walkEdges(root);

  return { nodes, edges };
}

export function gradeLabel(grade: number | undefined): string {
  switch (grade) {
    case 5:
      return 'Principal';
    case 4:
      return 'Staff';
    case 3:
      return 'Senior';
    case 2:
      return 'Mid';
    case 1:
      return 'Junior';
    case 0:
      return 'Trainee';
    default:
      return '—';
  }
}
