import { describe, expect, it } from 'vitest';
import type { OrgNode } from '../api/types';
import {
  MEETING_TABLE_D,
  MEETING_TABLE_W,
  buildOffice,
  meetingLayout,
  placementOf,
} from './floorplan';
import { computeTargets } from './targets';

const agent = (id: string, dept: string, name = id): OrgNode =>
  ({ id, kind: 'agent', name, role: 'Engineer', department_id: dept, manager_id: 'a0', state: 'idle', grade: 2 }) as OrgNode;

const org = (): OrgNode =>
  ({
    id: 'p1',
    kind: 'project',
    name: 'P',
    children: [
      { id: 'a0', kind: 'agent', name: 'Alex', role: 'Orchestrator', state: 'idle' } as OrgNode,
      {
        id: 'd1',
        kind: 'department',
        name: 'Ops',
        state: 'active',
        children: [agent('a1', 'd1', 'Ada'), agent('a2', 'd1', 'Bo')],
      } as OrgNode,
    ],
  }) as OrgNode;

describe('meetingLayout — the table and its eight chairs', () => {
  const M = 104 / 1.45;
  const room = {
    x: 100,
    y: 200,
    w: 2 * 28 + MEETING_TABLE_W + 2 * (0.42 * M + 0.3 * M),
    h: 2 * 28 + 30 + MEETING_TABLE_D + 2 * (0.42 * M + 0.3 * M),
  };

  it('centres the table in the room at the art’s own size', () => {
    const l = meetingLayout(room);
    expect(l.table.w).toBeCloseTo(MEETING_TABLE_W, 5);
    expect(l.table.d).toBeCloseTo(MEETING_TABLE_D, 5);
    expect(l.table.x).toBeCloseTo(room.x + (room.w - MEETING_TABLE_W) / 2, 5);
    expect(l.table.y).toBeCloseTo(room.y + (room.h - MEETING_TABLE_D) / 2, 5);
  });

  it('puts eight distinct seats, none of them on the table', () => {
    const l = meetingLayout(room);
    expect(l.seats).toHaveLength(8);
    expect(new Set(l.seats.map((s) => `${Math.round(s.x)}:${Math.round(s.y)}`)).size).toBe(8);
    for (const s of l.seats) {
      const onTop =
        s.x > l.table.x && s.x < l.table.x + l.table.w && s.y > l.table.y && s.y < l.table.y + l.table.d;
      expect(onTop).toBe(false);
    }
  });

  it('alternates across the table, so two people face each other', () => {
    const l = meetingLayout(room);
    const [a, b] = l.seats;
    expect(a.y).toBeGreaterThan(b.y); // south side first, then the north side
    expect(a.face).toEqual(b.face); // both look at the middle of the table
  });
});

describe('buildOffice — a room that exists only while it is needed', () => {
  it('has no meeting room until a council needs one', () => {
    expect(buildOffice(org(), {}).rooms.some((r) => r.kind === 'meeting')).toBe(false);
  });

  it('creates it on demand and keeps its slot while the sitting lasts', () => {
    const first = buildOffice(org(), { meeting: { question: 'ship or fold?' } });
    const room = first.rooms.find((r) => r.kind === 'meeting');
    expect(room).toBeDefined();
    expect(room!.subtitle).toBe('ship or fold?');

    const again = buildOffice(org(), { meeting: { question: 'ship or fold?' }, prev: placementOf(first) });
    const same = again.rooms.find((r) => r.kind === 'meeting')!;
    expect([same.x, same.y]).toEqual([room!.x, room!.y]);
  });

  it('stays once built, and the sitting after it lands in the same room', () => {
    const first = buildOffice(org(), { meeting: { question: 'one' } });
    const room = first.rooms.find((r) => r.kind === 'meeting')!;
    // The council closes: the room stays where it is — its slot is in the placement
    // from then on — with the nameplate saying so.
    const closed = buildOffice(org(), { prev: placementOf(first) });
    const kept = closed.rooms.find((r) => r.kind === 'meeting');
    expect(kept).toBeDefined();
    expect([kept!.x, kept!.y]).toEqual([room.x, room.y]);
    expect(kept!.subtitle).toBe('between sessions');
    // The next sitting lands in the SAME room, not somewhere new.
    const reopened = buildOffice(org(), { meeting: { question: 'two' }, prev: placementOf(closed) });
    const back = reopened.rooms.find((r) => r.kind === 'meeting')!;
    expect([back.x, back.y]).toEqual([room.x, room.y]);
    expect(back.subtitle).toBe('two');
  });
});

describe('computeTargets — the panel meets at the table', () => {
  const office = buildOffice(org(), { meeting: { question: 'ship or fold?' } });
  const meeting = { id: 'c1', question: 'ship or fold?', members: ['a1', 'a2'] };
  const targets = computeTargets({
    office,
    activities: {},
    tasks: [],
    now: 0,
    idleSince: new Map(),
    arriving: new Set(),
    meeting,
  });

  it('seats each member at their own seat, facing the table', () => {
    const t1 = targets.a1;
    const t2 = targets.a2;
    expect(t1.roomId).toBe('__meeting');
    expect(t1.seated).toBe(true);
    expect(t2.roomId).toBe('__meeting');
    expect(`${t1.point.x}:${t1.point.y}`).not.toBe(`${t2.point.x}:${t2.point.y}`);
    const layout = meetingLayout(office.rooms.find((r) => r.kind === 'meeting')!);
    expect(t1.faceTowards).toEqual(layout.seats[0].face);
    expect(t1.reason).toContain('ship or fold?');
  });

  it('leaves people who are not on the panel alone', () => {
    expect(targets.a0.roomId).not.toBe('__meeting');
  });
});
