import { describe, expect, it } from 'vitest';
import type { OrgNode } from '../api/types';
import { buildOffice, type Office } from './floorplan';
import { anchorOf, roomById, routeBetween } from './paths';

function agent(id: string, name: string, dept: string): OrgNode {
  return { id, kind: 'agent', name, role: 'Engineer', department_id: dept, state: 'idle', children: [] };
}

function dept(id: string, name: string, n: number): OrgNode {
  return {
    id,
    kind: 'department',
    name,
    state: 'active',
    children: Array.from({ length: n }, (_, i) => agent(`${id}-a${i}`, `${name} ${i}`, id)),
  };
}

/** Enough departments to force at least two shelf rows. */
const OFFICE: Office = buildOffice({
  id: 'p1',
  kind: 'project',
  name: 'Launch',
  state: 'active',
  children: [dept('d1', 'Research', 3), dept('d2', 'Engineering', 3), dept('d3', 'Growth', 3), dept('d4', 'Ops', 3)],
});

function axisAligned(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  return Math.abs(a.x - b.x) < 0.5 || Math.abs(a.y - b.y) < 0.5;
}

describe('corridor routing', () => {
  it('walks a straight line when the destination is in the same room', () => {
    const p = routeBetween(OFFICE, 'd1', 'd1', { x: 10, y: 10 }, { x: 90, y: 40 });
    expect(p).toHaveLength(2);
    expect(p[0]).toEqual({ x: 10, y: 10 });
    expect(p[1]).toEqual({ x: 90, y: 40 });
  });

  it('starts at the origin and ends at the destination anchor', () => {
    const from = OFFICE.deskOf['d1-a0'];
    const to = anchorOf(OFFICE, 'd2');
    const p = routeBetween(OFFICE, 'd1', 'd2', from, to);
    expect(p[0]).toEqual(from);
    expect(p[p.length - 1]).toEqual(to);
  });

  it('leaves through the door and follows the corridor', () => {
    const room = roomById(OFFICE, 'd1');
    const corridor = OFFICE.corridorY.d1;
    const p = routeBetween(OFFICE, 'd1', 'd2', OFFICE.deskOf['d1-a0'], anchorOf(OFFICE, 'd2'));
    expect(p).toContainEqual(room?.door);
    expect(p.some((pt) => Math.abs(pt.y - corridor) < 0.5)).toBe(true);
  });

  it('is axis-aligned once out of the room, so people walk the halls', () => {
    const p = routeBetween(OFFICE, 'd1', 'd2', OFFICE.deskOf['d1-a0'], anchorOf(OFFICE, 'd2'));
    for (let i = 1; i < p.length - 2; i += 1) {
      expect(axisAligned(p[i], p[i + 1]), `segment ${i} is diagonal`).toBe(true);
    }
  });

  it('detours through the vertical spine to reach another shelf row', () => {
    const d1 = roomById(OFFICE, 'd1')!;
    const other = OFFICE.rooms.find((r) => r.kind === 'department' && r.row !== d1.row);
    expect(other, 'test floor should have two rows').toBeDefined();
    const p = routeBetween(OFFICE, 'd1', other!.id, OFFICE.deskOf['d1-a0'], anchorOf(OFFICE, other!.id));
    expect(p.some((pt) => Math.abs(pt.x - OFFICE.spineX) < 0.5)).toBe(true);
  });

  it('routes to the review table and the break corner', () => {
    const desk = OFFICE.deskOf['d1-a0'];
    const toTable = routeBetween(OFFICE, 'd1', '__commons', desk, anchorOf(OFFICE, '__commons'));
    expect(toTable[toTable.length - 1]).toEqual(OFFICE.reviewTable);

    const toBreak = routeBetween(OFFICE, 'd1', '__break', desk, anchorOf(OFFICE, '__break'));
    expect(toBreak[toBreak.length - 1]).toEqual(OFFICE.breakSpot);
  });

  it('walks in from the entrance to a desk', () => {
    const target = OFFICE.deskOf['d1-a0'];
    const room = roomById(OFFICE, 'd1')!;
    const p = routeBetween(OFFICE, '__spine', 'd1', OFFICE.entrance, target);
    expect(p[0]).toEqual(OFFICE.entrance);
    expect(p[p.length - 1]).toEqual(target);
    // unknown origin room: falls back to a direct line rather than throwing
    expect(p.every((pt) => Number.isFinite(pt.x) && Number.isFinite(pt.y))).toBe(true);
    expect(room).toBeDefined();
  });

  it('never emits duplicate consecutive points', () => {
    const p = routeBetween(OFFICE, 'd1', 'd3', OFFICE.deskOf['d1-a0'], anchorOf(OFFICE, 'd3'));
    for (let i = 1; i < p.length; i += 1) {
      const same = Math.abs(p[i].x - p[i - 1].x) < 0.5 && Math.abs(p[i].y - p[i - 1].y) < 0.5;
      expect(same, `duplicate at ${i}`).toBe(false);
    }
  });

  it('has an anchor inside every room', () => {
    for (const room of OFFICE.rooms) {
      const a = anchorOf(OFFICE, room.id);
      expect(a.x).toBeGreaterThanOrEqual(room.x);
      expect(a.x).toBeLessThanOrEqual(room.x + room.w);
      expect(a.y).toBeGreaterThanOrEqual(room.y);
      expect(a.y).toBeLessThanOrEqual(room.y + room.h);
    }
  });
});
