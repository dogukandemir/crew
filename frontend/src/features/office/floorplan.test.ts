import { describe, expect, it } from 'vitest';
import type { OrgNode } from '../../api/types';
import {
  DESK_H,
  DESK_W,
  ROOM_HEADER,
  ROOM_PAD,
  SPINE_W,
  buildOffice,
  orchestratorSeat,
} from './floorplan';

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

function project(children: OrgNode[]): OrgNode {
  return { id: 'p1', kind: 'project', name: 'Launch', state: 'active', children };
}

function dept(id: string, name: string, children: OrgNode[]): OrgNode {
  return { id, kind: 'department', name, state: 'active', children };
}

const TREE = project([
  agent('a0', 'Alex', 'Orchestrator', 'd1'),
  dept('d1', 'Research', [
    agent('a1', 'Ada', 'Market Researcher', 'd1', { squad_id: 's1' }),
    agent('a2', 'Bo', 'Data Analyst', 'd1', { squad_id: 's1' }),
  ]),
  dept('d2', 'Engineering', [
    agent('a3', 'Cleo', 'Backend Engineer', 'd2'),
    agent('a4', 'Dev', 'QA Verifier', 'd2'),
    agent('a5', 'Eve', 'Frontend Engineer', 'd2'),
  ]),
  dept('d3', 'Growth', [
    agent('a6', 'Fay', 'Growth Lead', 'd3'),
    agent('a7', 'Gil', 'SEO Specialist', 'd3'),
  ]),
]);

describe('floor plan', () => {
  it('lays out a break corner, a review table and an orchestrator office', () => {
    const office = buildOffice(TREE);
    expect(office.rooms.map((r) => r.kind)).toEqual(
      expect.arrayContaining(['break', 'commons', 'orchestrator']),
    );
    expect(orchestratorSeat(office)).toEqual(expect.objectContaining({ x: expect.any(Number) }));
  });

  it('seats every visible agent and records which room they are in', () => {
    const office = buildOffice(TREE);
    for (const id of ['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7']) {
      expect(office.deskOf[id], id).toBeDefined();
      expect(office.roomOf[id], id).toBeDefined();
    }
    expect(Object.keys(office.deskOf)).toHaveLength(8);
  });

  it('routes each agent to their own department room', () => {
    const office = buildOffice(TREE);
    expect(office.roomOf.a1).toBe('d1');
    expect(office.roomOf.a3).toBe('d2');
    expect(office.roomOf.a6).toBe('d3');
    expect(office.roomOf.a0).toBe('__orchestrator');
  });

  it('hides archived agents by default and seats them on request', () => {
    const withArchived = project([
      dept('d1', 'Research', [agent('a1', 'Ada', 'Researcher', 'd1', { state: 'archived' })]),
    ]);
    expect(buildOffice(withArchived).deskOf.a1).toBeUndefined();
    expect(buildOffice(withArchived, { showArchived: true }).deskOf.a1).toBeDefined();
  });

  it('puts agents with no department on the bench', () => {
    const office = buildOffice(project([agent('a9', 'Zed', 'Generalist', null)]));
    expect(office.roomOf.a9).toBe('__bench');
  });

  it('never overlaps two rooms', () => {
    const office = buildOffice(TREE);
    for (let i = 0; i < office.rooms.length; i += 1) {
      for (let j = i + 1; j < office.rooms.length; j += 1) {
        const a = office.rooms[i];
        const b = office.rooms[j];
        const overlap = a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
        expect(overlap, `${a.id} overlaps ${b.id}`).toBe(false);
      }
    }
  });

  it('keeps every desk inside its room content box', () => {
    const office = buildOffice(TREE);
    for (const room of office.rooms) {
      for (const desk of room.desks) {
        expect(desk.x).toBeGreaterThanOrEqual(ROOM_PAD);
        expect(desk.y).toBeGreaterThanOrEqual(ROOM_PAD + ROOM_HEADER);
        expect(desk.x + DESK_W).toBeLessThanOrEqual(room.w - ROOM_PAD + 1);
        expect(desk.y + DESK_H).toBeLessThanOrEqual(room.h - ROOM_PAD + 1);
      }
    }
  });

  it('keeps every desk anchor inside its own room', () => {
    const office = buildOffice(TREE);
    for (const room of office.rooms) {
      for (const desk of room.desks) {
        const p = office.deskOf[desk.agentId];
        expect(p.x).toBeGreaterThanOrEqual(room.x);
        expect(p.x).toBeLessThanOrEqual(room.x + room.w);
        expect(p.y).toBeGreaterThanOrEqual(room.y);
        expect(p.y).toBeLessThanOrEqual(room.y + room.h);
      }
    }
  });

  it('gives every room a door and a corridor to walk in', () => {
    const office = buildOffice(TREE);
    for (const room of office.rooms) {
      expect(room.door.y).toBeGreaterThan(room.y + room.h);
      expect(Number.isFinite(office.corridorY[room.id])).toBe(true);
      expect(office.corridorY[room.id]).toBeGreaterThan(room.y + room.h);
    }
  });

  it('reserves the spine to the left of every room so cross-row walking has a lane', () => {
    const office = buildOffice(TREE);
    for (const room of office.rooms) {
      expect(room.x).toBeGreaterThanOrEqual(SPINE_W);
    }
    expect(office.spineX).toBeLessThan(SPINE_W);
    expect(office.entrance.x).toBeLessThan(SPINE_W);
    expect(office.entrance.y).toBeGreaterThan(office.height);
  });

  it('separates shelf rows by at least one corridor band', () => {
    const office = buildOffice(TREE);
    const rows = new Map<number, { top: number; bottom: number }>();
    for (const room of office.rooms) {
      const current = rows.get(room.row);
      rows.set(room.row, {
        top: Math.min(current?.top ?? Infinity, room.y),
        bottom: Math.max(current?.bottom ?? 0, room.y + room.h),
      });
    }
    const sorted = Array.from(rows.entries()).sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < sorted.length; i += 1) {
      const gapBetween = sorted[i][1].top - sorted[i - 1][1].bottom;
      expect(gapBetween).toBeGreaterThan(60);
    }
  });

  it('sizes the world to contain every room', () => {
    const office = buildOffice(TREE);
    for (const room of office.rooms) {
      expect(room.x + room.w).toBeLessThanOrEqual(office.width + 1);
      expect(room.y + room.h).toBeLessThanOrEqual(office.height + 1);
    }
  });

  it('is deterministic for the same tree', () => {
    expect(buildOffice(TREE)).toEqual(buildOffice(TREE));
  });

  it('survives an empty project and a missing tree', () => {
    for (const office of [buildOffice(project([])), buildOffice(undefined)]) {
      expect(office.rooms.length).toBeGreaterThanOrEqual(2); // break + review table
      expect(Object.keys(office.deskOf)).toHaveLength(0);
      expect(office.width).toBeGreaterThan(0);
      expect(office.height).toBeGreaterThan(0);
      expect(Number.isFinite(office.reviewTable.x)).toBe(true);
      expect(Number.isFinite(office.breakSpot.y)).toBe(true);
    }
  });

  it('wraps a wide floor onto more than one shelf row', () => {
    const many = Array.from({ length: 6 }, (_, i) =>
      dept(`d${i}`, `Dept ${i}`, [
        agent(`a${i}a`, `A${i}`, 'Engineer', `d${i}`),
        agent(`a${i}b`, `B${i}`, 'Engineer', `d${i}`),
        agent(`a${i}c`, `C${i}`, 'Engineer', `d${i}`),
      ]),
    );
    const office = buildOffice(project(many));
    const rows = new Set(office.rooms.map((r) => r.row));
    expect(rows.size).toBeGreaterThan(1);
    expect(office.rooms.filter((r) => r.kind === 'department')).toHaveLength(6);
  });
});
