import { describe, expect, it } from 'vitest';
import type { OrgNode, Task } from '../../api/types';
import { buildOffice } from './floorplan';
import { computeTargets, targetIsInsideRoom } from './targets';
import type { Activity } from './activity';

function agent(id: string, dept: string, role = 'Engineer'): OrgNode {
  return { id, kind: 'agent', name: id, role, department_id: dept, state: 'busy', children: [] };
}

function dept(id: string, name: string, children: OrgNode[]): OrgNode {
  return { id, kind: 'department', name, state: 'active', children };
}

const OFFICE = buildOffice({
  id: 'p1',
  kind: 'project',
  name: 'Launch',
  state: 'active',
  children: [
    agent('orchestrator', 'd1', 'Orchestrator'),
    dept('d1', 'Research', [agent('a1', 'd1'), agent('a2', 'd1')]),
    dept('d2', 'Engineering', [agent('a3', 'd2'), agent('a4', 'd2')]),
  ],
});

function act(kind: Activity['kind'], over: Partial<Activity> = {}): Activity {
  return { kind, note: `${kind} note`, where: 'desk', ...over };
}

const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);

function run(
  activities: Record<string, Activity>,
  over: Partial<Parameters<typeof computeTargets>[0]> = {},
) {
  return computeTargets({
    office: OFFICE,
    activities,
    tasks: [],
    now: NOW,
    idleSince: new Map(),
    arriving: new Set(),
    ...over,
  });
}

describe('movement rules', () => {
  it('leaves everyone at their own desk by default', () => {
    const t = run({ a1: act('typing'), a3: act('typing') });
    expect(t.a1.roomId).toBe('d1');
    expect(t.a1.point).toEqual(OFFICE.deskOf.a1);
    expect(t.a3.roomId).toBe('d2');
  });

  it('sends an escalating agent to the orchestrator office', () => {
    const t = run({ a3: act('blocked', { where: 'orchestrator', note: 'escalated: budget' }) });
    expect(t.a3.roomId).toBe('__orchestrator');
    expect(t.a3.reason).toContain('budget');
  });

  it('sends a verifying agent to the shared review table', () => {
    const t = run({ a2: act('walking', { where: 'commons' }) });
    expect(t.a2.roomId).toBe('__commons');
    expect(t.a2.point).toEqual(OFFICE.reviewTable);
  });

  it('spreads a crowd around the review table instead of stacking them', () => {
    const t = run({
      a1: act('walking', { where: 'commons' }),
      a2: act('walking', { where: 'commons' }),
      a3: act('walking', { where: 'commons' }),
    });
    const points = [t.a1.point, t.a2.point, t.a3.point];
    const unique = new Set(points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`));
    expect(unique.size).toBe(3);
    for (const p of points) {
      expect(Math.hypot(p.x - OFFICE.reviewTable.x, p.y - OFFICE.reviewTable.y)).toBeLessThan(60);
    }
  });

  it('walks an agent to another department for a cross-department task', () => {
    const tasks: Task[] = [
      {
        id: 't1',
        project_id: 'p1',
        title: 'Ship the schema',
        state: 'running',
        assignee_agent_id: 'a1',
        department_id: 'd2',
      },
    ];
    const t = run({ a1: act('typing') }, { tasks });
    expect(t.a1.roomId).toBe('d2');
    expect(t.a1.reason).toContain('visiting Engineering');
  });

  it('keeps an agent home when the task belongs to their own department', () => {
    const tasks: Task[] = [
      {
        id: 't1',
        project_id: 'p1',
        title: 'Research',
        state: 'running',
        assignee_agent_id: 'a1',
        department_id: 'd1',
      },
    ];
    const t = run({ a1: act('typing') }, { tasks });
    expect(t.a1.roomId).toBe('d1');
    expect(t.a1.point).toEqual(OFFICE.deskOf.a1);
  });

  it('sends a long-idle agent to the break corner', () => {
    const idleSince = new Map([['a1', NOW - 120_000]]);
    const t = run({ a1: act('idle') }, { idleSince });
    expect(t.a1.roomId).toBe('__break');
    expect(t.a1.reason).toContain('break');
  });

  it('leaves a freshly idle agent at their desk', () => {
    const idleSince = new Map([['a1', NOW - 1_000]]);
    const t = run({ a1: act('idle') }, { idleSince });
    expect(t.a1.roomId).toBe('d1');
  });

  it('never lets an idle agent with no recorded timer wander off', () => {
    const t = run({ a1: act('idle') });
    expect(t.a1.roomId).toBe('d1');
  });

  it('starts a new hire at their desk room, marked as walking in', () => {
    const t = run({ a1: act('walking') }, { arriving: new Set(['a1']) });
    expect(t.a1.roomId).toBe('d1');
    expect(t.a1.reason).toContain('just hired');
  });

  it('keeps every destination inside its room', () => {
    for (const t of Object.values(run({ a1: act('walking', { where: 'commons' }), a2: act('idle') }))) {
      expect(targetIsInsideRoom(OFFICE, t), `${t.agentId} @ ${t.roomId}`).toBe(true);
    }
  });

  it('produces a destination for every seated agent', () => {
    const t = run({});
    expect(Object.keys(t).sort()).toEqual(Object.keys(OFFICE.deskOf).sort());
  });
});
