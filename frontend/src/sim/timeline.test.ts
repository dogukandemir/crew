import { describe, expect, it } from 'vitest';
import { buildOffice, placementOf, type Placement } from './floorplan';
import { DEPARTMENTS, HIRES, headcountAt, orgAt } from './timeline';

/**
 * The office has to GROW, and growing has to be a local event.
 *
 * Everything here is a transition rather than a still life: the org at t+45 compared
 * with the org at t+10, with the first build's placement handed into the second one,
 * exactly as the app does it. That is the only way to catch the failure that matters,
 * a floor that re-packs itself, so that hiring one agent slides every room after it and
 * "engineering is bottom left" stops being true.
 */
const officeAt = (seconds: number, prev?: Placement['slots']) =>
  buildOffice(orgAt(seconds), prev ? { prev } : {});

describe('the office grows', () => {
  it('is the schedule it claims to be', () => {
    // Guards the fixture itself: these tests mean nothing if the later hires never
    // arrive or arrive in the wrong order.
    expect(HIRES.filter((h) => h.at === 0)).toHaveLength(5);
    expect(orgAt(0).children).toHaveLength(4); // orchestrator + three departments
    expect(orgAt(20).children).toHaveLength(4); // still three: the hire joined one
    expect(orgAt(45).children).toHaveLength(5); // four: Growth opened
    expect(headcountAt(0)).toBe(6);
    expect(headcountAt(45)).toBe(10);
  });

  it('seats a new hire at a desk in the department they joined', () => {
    const before = officeAt(10);
    expect(before.roomOf.a6).toBeUndefined();
    const after = officeAt(20);
    expect(after.roomOf.a6).toBe('d2');
    expect(after.deskOf.a6).toBeDefined();
    // A desk is a seat, not a suggestion: nobody else's seat may be a6's.
    const seats = Object.entries(after.deskOf).filter(([id]) => id !== 'a6');
    for (const [, point] of seats) {
      expect(Math.hypot(point.x - after.deskOf.a6.x, point.y - after.deskOf.a6.y)).toBeGreaterThan(20);
    }
  });

  it('opens a new room when a hire arrives into nothing, and seats its people there', () => {
    const before = officeAt(20);
    expect(before.rooms.some((r) => r.id === 'd4')).toBe(false);

    const after = officeAt(45, placementOf(before));
    const growth = after.rooms.find((r) => r.id === 'd4');
    expect(growth).toBeDefined();
    for (const id of ['a7', 'a8', 'a9']) {
      expect(after.roomOf[id]).toBe('d4');
      expect(after.deskOf[id]).toBeDefined();
    }
    // The new room is inside the canvas the camera will be asked to frame.
    expect(growth!.x + growth!.w).toBeLessThanOrEqual(after.width);
    expect(growth!.y + growth!.h).toBeLessThanOrEqual(after.height);
  });

  it('does not move a room that did not itself change', () => {
    const first = officeAt(10);
    const last = officeAt(45, placementOf(first));
    const was = new Map(first.rooms.map((r) => [r.id, r]));
    // Carried rooms keep their cell, so the square can grow a ring without disturbing
    // anything standing in it.
    const moved: string[] = [];
    for (const room of last.rooms) {
      const before = was.get(room.id);
      if (!before) continue;
      if (before.x !== room.x || before.y !== room.y) moved.push(`${room.id} ${before.x},${before.y} -> ${room.x},${room.y}`);
    }
    expect(moved).toEqual([]);
  });

  it('keeps every room clear of the spine and of each other, however far it grows', () => {
    let prev = undefined as Placement['slots'] | undefined;
    for (const t of [0, 10, 16, 20, 30, 36, 45, 90]) {
      const office = officeAt(t, prev);
      prev = placementOf(office);
      for (const room of office.rooms) {
        expect(room.x, `${room.id} @${t}`).toBeGreaterThanOrEqual(0);
        expect(room.x + room.w, `${room.id} @${t}`).toBeLessThanOrEqual(office.width);
        expect(room.y + room.h, `${room.id} @${t}`).toBeLessThanOrEqual(office.height);
      }
      for (let i = 0; i < office.rooms.length; i += 1) {
        for (let j = i + 1; j < office.rooms.length; j += 1) {
          const a = office.rooms[i];
          const b = office.rooms[j];
          const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
          expect(overlap, `${a.id} over ${b.id} @${t}`).toBe(false);
        }
      }
    }
  });

  it('takes an archived roster off the floor without taking the building with it', () => {
    // The agents go to the bench: an archived agent is not seated at a desk.
    const before = officeAt(45);
    const shrinking = orgAt(45);
    const kids = shrinking.children ?? [];
    const d3 = kids.find((c) => c.id === 'd3');
    if (d3 && d3.children) for (const a of d3.children) a.state = 'archived';
    const after = buildOffice(shrinking, { prev: placementOf(before) });
    expect(after.roomOf.a5).toBeUndefined();
    expect(after.deskOf.a5).toBeUndefined();
    // Everything else is where it was: one department emptying does not move another.
    expect(after.rooms.some((r) => r.id === 'd4')).toBe(true);
    const was = new Map(before.rooms.map((r) => [r.id, r]));
    for (const room of after.rooms) {
      const prev = was.get(room.id);
      if (!prev || room.id === 'd3') continue;
      if (prev.w === room.w && prev.h === room.h) {
        expect({ x: room.x, y: room.y }, room.id).toEqual({ x: prev.x, y: prev.y });
      }
    }
  });
});
