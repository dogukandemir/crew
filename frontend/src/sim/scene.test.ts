import { describe, expect, it } from 'vitest';
import type { OrgNode, Task } from '../api/types';
import { buildOffice, type Office } from './floorplan';
import { computeTargets } from './targets';
import { projectScene, SCENE_CONTRACT, emptyScene } from './scene';
import type { Activity } from './activity';

function agent(id: string, name: string, role: string, dept: string): OrgNode {
  return { id, kind: 'agent', name, role, department_id: dept, state: 'busy', grade: 3, children: [] };
}
function dept(id: string, name: string, kids: OrgNode[]): OrgNode {
  return { id, kind: 'department', name, state: 'active', children: kids };
}

const OFFICE: Office = buildOffice({
  id: 'p1',
  kind: 'project',
  name: 'Launch',
  state: 'active',
  children: [
    agent('orch', 'Alex', 'Orchestrator', 'd1'),
    dept('d1', 'Research', [agent('a1', 'Ada', 'Market Researcher', 'd1'), agent('a2', 'Bo', 'Analyst', 'd1')]),
    dept('d2', 'Engineering', [agent('a3', 'Cleo', 'Backend Engineer', 'd2')]),
  ],
});

const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);

function act(kind: Activity['kind'], over: Partial<Activity> = {}): Activity {
  return { kind, note: `${kind} note`, where: 'desk', ...over };
}

function project(activities: Record<string, Activity>, tasks: Task[] = []) {
  const targets = computeTargets({
    office: OFFICE,
    activities,
    tasks,
    now: NOW,
    idleSince: new Map(),
    arriving: new Set(),
  });
  return projectScene({ projectId: 'p1', office: OFFICE, activities, targets, tasks, now: NOW });
}

describe('scene projection', () => {
  it('describes an empty project', () => {
    const scene = emptyScene('p1', NOW);
    expect(scene.version).toBe(SCENE_CONTRACT);
    expect(scene.agents).toEqual([]);
    expect(scene.stats.seats).toBe(0);
  });

  it('emits one entry per seat', () => {
    const scene = project({ a1: act('typing'), a2: act('typing'), a3: act('typing'), orch: act('idle') });
    expect(scene.agents.map((a) => a.id)).toEqual(['a1', 'a2', 'a3', 'orch']);
    expect(scene.stats.seats).toBe(4);
  });

  it('carries the pose, the bubble and the human sentence', () => {
    const scene = project({ a1: act('blocked', { where: 'orchestrator', bubble: '❗', note: 'escalated: budget' }) });
    const a1 = scene.agents.find((a) => a.id === 'a1')!;
    expect(a1.activity).toBe('blocked');
    expect(a1.bubble).toBe('❗');
    expect(a1.note).toContain('budget');
  });

  it('resolves the intent to a named room', () => {
    const scene = project({ a3: act('walking', { where: 'commons' }) });
    const a3 = scene.agents.find((a) => a.id === 'a3')!;
    expect(a3.intent.roomId).toBe('__commons');
    expect(a3.intent.roomName).toBe('Review table');
    expect(a3.intent.point).toEqual(OFFICE.reviewTable);
  });

  it('defaults the intent to the agent own desk', () => {
    const scene = project({ a1: act('typing') });
    const a1 = scene.agents.find((a) => a.id === 'a1')!;
    expect(a1.intent.roomId).toBe('d1');
    expect(a1.intent.point).toEqual(OFFICE.deskOf.a1);
    expect(a1.desk).toEqual(OFFICE.deskOf.a1);
    expect(a1.homeRoomId).toBe('d1');
  });

  it('carries the task the agent holds', () => {
    const tasks: Task[] = [
      { id: 't1', project_id: 'p1', title: 'Ship the schema', state: 'running', assignee_agent_id: 'a1', department_id: 'd1' },
    ];
    const scene = project({ a1: act('typing') }, tasks);
    const a1 = scene.agents.find((a) => a.id === 'a1')!;
    expect(a1.taskTitle).toBe('Ship the schema');
    expect(a1.taskId).toBe('t1');
  });

  it('counts what the toolbar shows', () => {
    const scene = project({
      a1: act('typing'),
      a2: act('thinking'),
      a3: act('blocked'),
      orch: act('walking', { where: 'commons' }),
    });
    expect(scene.stats).toEqual({ seats: 4, working: 2, thinking: 1, attention: 1, walking: 1 });
  });

  it('is deterministic for the same input', () => {
    const a = project({ a1: act('typing') });
    const b = project({ a1: act('typing') });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('survives a JSON round trip, it is meant to cross the wire', () => {
    const scene = project({ a1: act('typing'), a3: act('blocked') });
    expect(JSON.parse(JSON.stringify(scene))).toEqual(scene);
  });

  it('skips seats with no activity yet rather than inventing one', () => {
    const scene = project({ a1: act('typing') });
    expect(scene.agents.map((a) => a.id)).toEqual(['a1']);
    expect(scene.stats.seats).toBe(1);
  });
});
