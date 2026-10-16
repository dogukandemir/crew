import { describe, expect, it } from 'vitest';
import type { OrgNode } from '../api/types';
import { BREAK_TABLE_R, breakSeats, buildOffice } from './floorplan';
import { computeTargets } from './targets';
import type { Activity } from './activity';

const NOW = Date.parse('2026-03-01T12:00:00.000Z');

const agentNode = (id: string, name: string): OrgNode => ({
  id,
  kind: 'agent',
  name,
  role: 'Builder',
  grade: 2,
  state: 'idle',
  department_id: 'd1',
});

const org = (count: number): OrgNode => ({
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
      children: Array.from({ length: count }, (_, i) => agentNode(`a${i}`, `Agent ${i}`)),
    },
  ],
});

const idle = (): Activity => ({ kind: 'idle', note: 'idle, no work assigned', where: 'desk' });
const typing = (): Activity => ({ kind: 'typing', note: 'working', where: 'desk' });

function setUp(count: number, idleIds: string[], idleForMs = 120_000) {
  const office = buildOffice(org(count));
  const activities: Record<string, Activity> = {};
  const idleSince = new Map<string, number>();
  for (const id of Object.keys(office.deskOf)) {
    const isIdle = idleIds.includes(id);
    activities[id] = isIdle ? idle() : typing();
    if (isIdle) idleSince.set(id, NOW - idleForMs);
  }
  const targets = computeTargets({ office, activities, tasks: [], now: NOW, idleSince, arriving: new Set() });
  return { office, targets };
}

describe('the break corner', () => {
  it('has round tables with chairs, and they are all distinct', () => {
    const office = buildOffice(org(2));
    expect(office.breakTables.length).toBeGreaterThan(1);
    const seats = breakSeats(office.breakTables);
    expect(seats.length).toBe(office.breakTables.length * 3);
    const unique = new Set(seats.map((s) => `${Math.round(s.point.x)},${Math.round(s.point.y)}`));
    expect(unique.size).toBe(seats.length);
  });

  it('sits idle people on chairs, facing their own table', () => {
    const { office, targets } = setUp(3, ['a0', 'a1', 'a2']);
    const seats = breakSeats(office.breakTables);
    for (const id of ['a0', 'a1', 'a2']) {
      expect(targets[id].roomId).toBe('__break');
      expect(targets[id].seated, `${id} should be sitting`).toBe(true);
      const seat = seats.find(
        (s) => Math.abs(s.point.x - targets[id].point.x) < 0.01 && Math.abs(s.point.y - targets[id].point.y) < 0.01,
      );
      expect(seat, `${id} is on a real chair`).toBeTruthy();
      expect(targets[id].faceTowards).toEqual(seat?.faceTowards);
    }
  });

  it('tells you who somebody is sitting with, and only when it is true', () => {
    const { targets } = setUp(3, ['a0', 'a1', 'a2']);
    // Three people fill one table, so everybody there names the other two.
    for (const id of ['a0', 'a1', 'a2']) {
      expect(targets[id].reason).toContain('on a break with');
    }
    expect(targets.a0.reason).toContain('Agent 1');
    expect(targets.a0.reason).toContain('Agent 2');
    expect(targets.a0.reason).not.toContain('Agent 0');
  });

  it('leaves somebody sitting alone without a made-up conversation', () => {
    const { targets } = setUp(2, ['a0']);
    expect(targets.a0.seated).toBe(true);
    expect(targets.a0.reason).toBe('idle, at the break corner');
  });

  it('keeps people at their desks while they are still working', () => {
    const { office, targets } = setUp(3, ['a0']);
    for (const id of ['a1', 'a2']) {
      expect(targets[id].point).toEqual(office.deskOf[id]);
      expect(targets[id].seated).toBe(true);
      expect(targets[id].roomId).not.toBe('__break');
    }
  });

  it('does not send anyone to the break corner before they have waited', () => {
    const { office, targets } = setUp(2, ['a0', 'a1'], 1_000);
    for (const id of ['a0', 'a1']) {
      expect(targets[id].point).toEqual(office.deskOf[id]);
    }
  });

  it('does not stack people when there are more of them than chairs', () => {
    const { targets } = setUp(12, ['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'a10', 'a11']);
    const seats = breakSeats(buildOffice(org(12)).breakTables);
    expect(seats.length).toBe(6);
    const taken = seats.filter((seat) =>
      Object.values(targets).some(
        (t) => Math.abs(t.point.x - seat.point.x) < 0.01 && Math.abs(t.point.y - seat.point.y) < 0.01,
      ),
    );
    // Every chair is used, at most once, and the extras are left standing.
    expect(taken.length).toBe(seats.length);
    const positions = Object.values(targets).map((t) => `${Math.round(t.point.x)},${Math.round(t.point.y)}`);
    expect(new Set(positions).size).toBe(positions.length);
  });

  it('puts the chairs outside the tables, not on top of them', () => {
    const seats = breakSeats([{ x: 0, y: 0 }]);
    for (const seat of seats) {
      // The vertical squash means the ellipse test is a scale, not a circle.
      const dx = seat.point.x;
      const dy = seat.point.y / 0.62;
      expect(Math.hypot(dx, dy)).toBeGreaterThan(BREAK_TABLE_R + 8);
    }
  });
});
