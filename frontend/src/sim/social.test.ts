import { describe, expect, it } from 'vitest';
import type { OrgNode, Task } from '../api/types';
import { buildOffice, type Office } from './floorplan';
import { computeTargets, resolvePeer, type TargetInput } from './targets';
import { distance } from './geometry';
import type { Activity } from './activity';

const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);

function agent(over: Partial<OrgNode> & { id: string; name: string }): OrgNode {
  return { kind: 'agent', state: 'busy', grade: 2, role: 'Analyst', children: [], ...over };
}

const ORG: OrgNode = {
  id: 'p1',
  kind: 'project',
  name: 'Launch',
  state: 'active',
  children: [
    agent({ id: 'orch', name: 'Alex', role: 'Orchestrator', grade: 5 }),
    {
      id: 'd1',
      kind: 'department',
      name: 'Research',
      state: 'active',
      children: [agent({ id: 'bo', name: 'Bo Chen', role: 'Market Researcher', grade: 3, department_id: 'd1' })],
    },
    {
      id: 'd2',
      kind: 'department',
      name: 'Engineering',
      state: 'active',
      children: [
        agent({ id: 'cleo', name: 'Cleo', role: 'Backend Engineer', grade: 3, squad_id: 'sq1', department_id: 'd2' }),
        agent({ id: 'dev', name: 'Dev' , role: 'Engineer', grade: 1, squad_id: 'sq1', department_id: 'd2' }),
      ],
    },
  ],
};

const OFFICE: Office = buildOffice(ORG);

function act(over: Partial<Activity> & { kind: Activity['kind'] }): Activity {
  return { note: 'note', where: 'desk', ...over };
}

function targets(activities: Record<string, Activity>, tasks: Task[] = []) {
  return computeTargets({
    office: OFFICE,
    activities,
    tasks,
    now: NOW,
    idleSince: new Map(),
    arriving: new Set(),
  } satisfies TargetInput);
}

const squadTask = (state: Task['state']): Task => ({
  id: 't1',
  project_id: 'p1',
  title: 'Ship the schema',
  state,
  department_id: 'd2',
  assignee_squad_id: 'sq1',
});

describe('resolving who a message was meant for', () => {
  it('matches a first name, a full name and a case', () => {
    expect(resolvePeer(OFFICE, 'bo', 'Cleo')).toBe('cleo');
    expect(resolvePeer(OFFICE, 'bo', 'cleo')).toBe('cleo');
    expect(resolvePeer(OFFICE, 'bo', 'Bo Chen')).toBe(undefined); // never yourself
    expect(resolvePeer(OFFICE, 'cleo', 'Bo Chen')).toBe('bo');
    expect(resolvePeer(OFFICE, 'cleo', 'Bo')).toBe('bo');
  });

  it('reads a role word as whoever runs the floor', () => {
    for (const word of ['manager', 'Manager', 'lead', 'orchestrator']) {
      expect(resolvePeer(OFFICE, 'bo', word)).toBe('orch');
    }
  });

  it('returns nothing rather than guessing', () => {
    expect(resolvePeer(OFFICE, 'bo', 'Nobody At All')).toBeUndefined();
    expect(resolvePeer(OFFICE, 'bo', '')).toBeUndefined();
    expect(resolvePeer(OFFICE, 'bo', '   ')).toBeUndefined();
  });
});

describe('asking a colleague in person', () => {
  it('walks the asker to that colleague and turns them to face each other', () => {
    const out = targets({
      bo: act({ kind: 'talking', where: 'peer', peerName: 'Cleo', note: '→ Cleo: what is the schema?' }),
    });
    const bo = out.bo;
    expect(bo.roomId).toBe(OFFICE.roomOf.cleo);
    expect(bo.faceTowards).toEqual(OFFICE.deskOf.cleo);
    // Standing beside the desk, not on top of it.
    const gap = distance(bo.point, OFFICE.deskOf.cleo);
    expect(gap).toBeGreaterThan(10);
    expect(gap).toBeLessThan(80);
  });

  it('keeps the asker at their desk when the name matches nobody', () => {
    const out = targets({
      bo: act({ kind: 'talking', where: 'peer', peerName: 'Ghost Colleague' }),
    });
    expect(out.bo.point).toEqual(OFFICE.deskOf.bo);
    expect(out.bo.roomId).toBe('d1');
    // Stays put and looks at their own desk — an unresolved name must not put
    // anyone else on the floor as a recipient.
    expect(out.bo.faceTowards?.x).toBe(OFFICE.deskOf.bo.x);
    expect(out.bo.faceTowards?.y).toBeLessThan(OFFICE.deskOf.bo.y);
  });

  it('sends an upward report to the orchestrator', () => {
    const out = targets({ bo: act({ kind: 'talking', where: 'peer', peerName: 'manager' }) });
    expect(out.bo.roomId).toBe(OFFICE.roomOf.orch);
  });
});

describe('working together', () => {
  it('gathers a squad around its most senior member', () => {
    const out = targets(
      { cleo: act({ kind: 'typing' }), dev: act({ kind: 'typing' }) },
      [squadTask('running')],
    );

    // The senior keeps their desk; the junior comes over.
    expect(out.cleo.point).toEqual(OFFICE.deskOf.cleo);
    expect(out.cleo.roomId).toBe('d2');

    expect(out.dev.roomId).toBe('d2');
    expect(out.dev.faceTowards).toEqual(OFFICE.deskOf.cleo);
    expect(distance(out.dev.point, OFFICE.deskOf.cleo)).toBeLessThan(90);
    expect(out.dev.reason).toContain('pairing with Cleo');
    expect(out.dev.reason).toContain('Ship the schema');
  });

  it('does not gather anyone on a task that is over', () => {
    for (const state of ['completed', 'failed', 'aborted'] as Task['state'][]) {
      const out = targets(
        { cleo: act({ kind: 'typing' }), dev: act({ kind: 'typing' }) },
        [squadTask(state)],
      );
      expect(out.dev.point, `moved on a ${state} task`).toEqual(OFFICE.deskOf.dev);
      // Back at their own desk, they look at their own desk — never at Cleo.
      expect(out.dev.faceTowards).not.toEqual(OFFICE.deskOf.cleo);
      expect(out.dev.faceTowards?.x).toBe(OFFICE.deskOf.dev.x);
    }
  });

  it('does not gather when nobody has a squad', () => {
    const out = targets({ cleo: act({ kind: 'typing' }), dev: act({ kind: 'typing' }) }, []);
    expect(out.dev.point).toEqual(OFFICE.deskOf.dev);
  });

  it('leaves an idle squad member alone even while a squad task is live', () => {
    const out = targets(
      { cleo: act({ kind: 'typing' }), dev: act({ kind: 'idle' }) },
      [squadTask('running')],
    );
    // Idle stays idle; nobody is dragged to a desk to watch.
    expect(out.dev.point).toEqual(OFFICE.deskOf.dev);
  });
});

describe('gatherings', () => {
  it('turns a group at the review table inward, so they read as talking', () => {
    const out = targets({
      bo: act({ kind: 'walking', where: 'commons', note: 'verifying' }),
      cleo: act({ kind: 'walking', where: 'commons', note: 'verifying' }),
    });
    expect(out.bo.faceTowards).toEqual(OFFICE.reviewTable);
    expect(out.cleo.faceTowards).toEqual(OFFICE.reviewTable);
    // Spread out rather than stacked.
    expect(distance(out.bo.point, out.cleo.point)).toBeGreaterThan(40);
  });

  it('leaves a lone visitor facing nothing in particular', () => {
    const out = targets({ bo: act({ kind: 'walking', where: 'commons', note: 'verifying' }) });
    expect(out.bo.faceTowards).toBeUndefined();
    expect(out.bo.point).toEqual(OFFICE.reviewTable);
  });
});
