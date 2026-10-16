import type { OrgNode } from '../api/types';

/**
 * The office as a schedule, not a photograph.
 *
 * A fixture that is a still life can only ever prove that a floor plan draws. What the
 * office actually does is grow: agents are hired while the tab is open, a hire into an
 * existing department adds a desk to that department's room, and a hire into nothing
 * opens a whole new room on the canvas. All three are transitions, and transitions are
 * what this file exists to make testable, `orgAt(seconds)` is the org as it stood
 * `seconds` after the project opened.
 *
 * The mock backend stages the same SHAPE of growth, a hire into an existing room, a
 * hire that opens a new one, on its own accelerated beats (`BEAT` in `dev/mock`), so
 * the tests and the demo describe the same transitions, not the same clock.
 */

/** Seconds after the project opened, and who arrives. */
export interface Hire {
  at: number;
  /** The department the hire joins. An id that has no department yet OPENS one. */
  dept: string;
  /** The squad they join, when they join one that already exists. */
  squad?: string;
  node: OrgNode;
}

export interface Department {
  id: string;
  name: string;
}

export const DEPARTMENTS: Department[] = [
  { id: 'd1', name: 'Research' },
  { id: 'd2', name: 'Engineering' },
  { id: 'd3', name: 'Support' },
  { id: 'd4', name: 'Growth' },
];

function agent(
  id: string,
  name: string,
  role: string,
  dept: string | null,
  over: Partial<OrgNode> = {},
): OrgNode {
  return {
    id,
    kind: 'agent',
    name,
    role,
    department_id: dept,
    state: 'idle',
    children: [],
    ...over,
  };
}

export const ORCHESTRATOR: OrgNode = agent('a0', 'Alex', 'Orchestrator', null, { score: 0.9 });

export const HIRES: Hire[] = [
  // The office the project opens with: three departments, one squad.
  { at: 0, dept: 'd1', squad: 's1', node: agent('a1', 'Ada', 'Market Researcher', 'd1', { squad_id: 's1', state: 'busy' }) },
  { at: 0, dept: 'd1', squad: 's1', node: agent('a2', 'Bo', 'Data Analyst', 'd1', { squad_id: 's1' }) },
  { at: 0, dept: 'd2', node: agent('a3', 'Cleo', 'Backend Engineer', 'd2', { state: 'busy' }) },
  { at: 0, dept: 'd2', node: agent('a4', 'Dev', 'QA Verifier', 'd2', { state: 'probation' }) },
  { at: 0, dept: 'd3', node: agent('a5', 'Iris', 'Support Agent', 'd3') },

  // t+14 · a second engineer joins an EXISTING department. Engineering's room gets
  // wider or taller; every other room on the floor stays exactly where it was.
  { at: 14, dept: 'd2', node: agent('a6', 'Max', 'Backend Engineer', 'd2') },

  // t+28 · a hire into nothing: a new department, with a room of its own, allocated
  // beside the existing ones rather than re-packing the building.
  { at: 28, dept: 'd4', node: agent('a7', 'Zoe', 'Growth Lead', 'd4') },
  { at: 34, dept: 'd4', node: agent('a8', 'Nils', 'Content Strategist', 'd4') },
  { at: 40, dept: 'd4', node: agent('a9', 'Rae', 'SEO Analyst', 'd4') },
];

/** The org as it stood `seconds` after the project opened. */
export function orgAt(seconds: number): OrgNode {
  const here = HIRES.filter((h) => h.at <= seconds);
  const children: OrgNode[] = [ORCHESTRATOR];
  for (const dept of DEPARTMENTS) {
    const mine = here.filter((h) => h.dept === dept.id);
    if (mine.length === 0) continue;
    const inSquad = mine.filter((h) => h.squad);
    const direct = mine.filter((h) => !h.squad);
    const kids: OrgNode[] = [];
    if (inSquad.length > 0) {
      kids.push({
        id: inSquad[0].squad!,
        kind: 'squad',
        name: 'Market-scan',
        state: 'active',
        department_id: dept.id,
        children: inSquad.map((h) => h.node),
      });
    }
    kids.push(...direct.map((h) => h.node));
    children.push({
      id: dept.id,
      kind: 'department',
      name: dept.name,
      state: 'active',
      budget_envelope_micros: 4_000_000,
      children: kids,
    });
  }
  return {
    id: 'p1',
    kind: 'project',
    name: 'Market Brief',
    state: 'active',
    children,
  };
}

/** Everyone working `seconds` in, which is what the roster counters want. */
export function headcountAt(seconds: number): number {
  return HIRES.filter((h) => h.at <= seconds).length + 1;
}
