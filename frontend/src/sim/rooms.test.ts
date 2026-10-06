import { describe, expect, it } from 'vitest';
import type { EventRow, OrgNode } from '../api/types';
import type { Activity } from './activity';
import { buildOffice } from './floorplan';
import { CV_WINDOW_MS, NEW_DEPT_WINDOW_MS, OUTPUT_WINDOW_MS, floorPulse } from './rooms';

const NOW = Date.parse('2026-03-01T12:00:00.000Z');

const agentNode = (id: string, name: string, dept: string): OrgNode => ({
  id,
  kind: 'agent',
  name,
  role: 'Builder',
  grade: 2,
  state: 'idle',
  department_id: dept,
});

const ORG: OrgNode = {
  id: 'p',
  kind: 'project',
  name: 'Test',
  state: 'active',
  children: [
    {
      id: 'd1',
      kind: 'department',
      name: 'Research',
      state: 'active',
      children: [agentNode('a1', 'Ada', 'd1'), agentNode('a2', 'Bo', 'd1')],
    },
    {
      id: 'd2',
      kind: 'department',
      name: 'Engineering',
      state: 'active',
      children: [agentNode('a3', 'Cleo', 'd2')],
    },
  ],
};

const office = buildOffice(ORG);

const activity = (kind: Activity['kind'], note = ''): Activity => ({ kind, note, where: 'desk' });

const event = (agentId: string, type: string, secondsAgo: number, payload?: unknown): EventRow =>
  ({
    id: `${agentId}-${type}-${secondsAgo}`,
    project_id: 'p',
    seq: 1,
    ts: new Date(NOW - secondsAgo * 1000).toISOString(),
    type,
    severity: 'info',
    title: `${type} by ${agentId}`,
    payload: payload ?? null,
    agent_id: agentId,
  }) as unknown as EventRow;

describe('floor pulse', () => {
  it('seats every room, including the ones with nobody in them', () => {
    const pulse = floorPulse({
      office,
      activities: { a1: activity('typing') },
      events: [],
      now: NOW,
    });
    expect(pulse.rooms.d1.seats).toBe(2);
    expect(pulse.rooms.d2.seats).toBe(1);
    expect(pulse.rooms.__commons.seats).toBe(0);
  });

  it('counts producing separately from just being busy', () => {
    const pulse = floorPulse({
      office,
      activities: {
        a1: activity('typing'),
        a2: activity('talking'),
        a3: activity('tool'),
      },
      events: [],
      now: NOW,
    });
    // Typing and tool calls are production; talking is work but not output.
    expect(pulse.rooms.d1.producing).toBe(1);
    expect(pulse.rooms.d1.working).toBe(2);
    expect(pulse.rooms.d2.producing).toBe(1);
  });

  it('separates people who need help from people who are fine', () => {
    const pulse = floorPulse({
      office,
      activities: {
        a1: activity('blocked'),
        a2: activity('waiting'),
        a3: activity('idle'),
      },
      events: [],
      now: NOW,
    });
    expect(pulse.rooms.d1.blocked).toBe(2);
    expect(pulse.rooms.d1.idle).toBe(0);
    expect(pulse.rooms.d2.idle).toBe(1);
  });

  it('counts deliverables a room actually shipped', () => {
    const pulse = floorPulse({
      office,
      activities: {},
      events: [event('a1', 'task.completed', 60), event('a1', 'task.completed', 120), event('a3', 'task.completed', 30)],
      now: NOW,
    });
    expect(pulse.rooms.d1.shipped).toBe(2);
    expect(pulse.rooms.d2.shipped).toBe(1);
  });

  it('reports the newest deliverable, not just any of them', () => {
    const pulse = floorPulse({
      office,
      activities: {},
      events: [event('a1', 'task.completed', 900), event('a1', 'task.completed', 300)],
      now: NOW,
    });
    expect(pulse.rooms.d1.lastOutput?.title).toContain('task.completed by a1');
    expect(pulse.rooms.d1.lastOutput?.at).toBe(NOW - 300_000);
  });

  it('stops counting a delivery as shipped once the window has passed', () => {
    const pulse = floorPulse({
      office,
      activities: {},
      events: [event('a1', 'task.completed', OUTPUT_WINDOW_MS / 1000 + 60)],
      now: NOW,
    });
    expect(pulse.rooms.d1.shipped).toBe(0);
    // It is still that agent's latest deliverable for a lot longer.
    expect(pulse.outputs.a1?.title).toBeTruthy();
  });

  it('forgets a deliverable entirely after the CV window', () => {
    const pulse = floorPulse({
      office,
      activities: {},
      events: [event('a1', 'task.completed', CV_WINDOW_MS / 1000 + 60)],
      now: NOW,
    });
    expect(pulse.outputs.a1).toBeUndefined();
  });

  it('ignores events stamped in the future rather than trusting them', () => {
    const pulse = floorPulse({
      office,
      activities: {},
      events: [event('a1', 'task.completed', -600)],
      now: NOW,
    });
    expect(pulse.outputs.a1).toBeUndefined();
  });

  it('flags a department the log says was just opened', () => {
    const pulse = floorPulse({
      office,
      activities: {},
      events: [event('a0', 'org.department.created', 30, { department_id: 'd2', name: 'Engineering' })],
      now: NOW,
    });
    expect(pulse.rooms.d2.brandNew).toBe(true);
    expect(pulse.rooms.d1.brandNew).toBe(false);
  });

  it('stops calling it new once the window passes', () => {
    const pulse = floorPulse({
      office,
      activities: {},
      events: [
        event('a0', 'org.department.created', NEW_DEPT_WINDOW_MS / 1000 + 30, {
          department_id: 'd2',
          name: 'Engineering',
        }),
      ],
      now: NOW,
    });
    expect(pulse.rooms.d2.brandNew).toBe(false);
  });

  it('falls back to the department name when the payload has no id', () => {
    const pulse = floorPulse({
      office,
      activities: {},
      events: [event('a0', 'org.department.created', 10, { name: 'Research' })],
      now: NOW,
    });
    expect(pulse.rooms.d1.brandNew).toBe(true);
    expect(pulse.rooms.d2.brandNew).toBe(false);
  });

  it('can ignore archived people, and count them when asked', () => {
    // The office has to seat them for the question to mean anything.
    const seated = buildOffice(
      {
        ...ORG,
        children: [
          {
            id: 'd1',
            kind: 'department',
            name: 'Research',
            state: 'active',
            children: [{ ...agentNode('a1', 'Ada', 'd1'), state: 'archived' } as OrgNode],
          },
        ],
      },
      { showArchived: true },
    );
    const hidden = floorPulse({ office: seated, activities: { a1: activity('typing') }, events: [], now: NOW });
    expect(hidden.rooms.d1.producing).toBe(0);
    const shown = floorPulse({
      office: seated,
      activities: { a1: activity('typing') },
      events: [],
      now: NOW,
      showArchived: true,
    });
    expect(shown.rooms.d1.producing).toBe(1);
  });
});
