import { describe, expect, it } from 'vitest';
import { MAX_ROW_WIDTH, ROOM_COL_GAP, SPINE_W, placeRooms } from './floorplan';

/**
 * The placement's one promise: a room that exists does not move.
 *
 * This is not tidiness. `buildOffice` runs again on every office update, and the
 * version this replaced packed the shelves from scratch each time — so hiring one
 * agent widened its department, slid every room after it along the shelf and could
 * push an entire shelf onto the next one. On screen the whole building jumped, and a
 * room could not be pointed at across two updates, which is what a floor plan is for.
 */
describe('placeRooms', () => {
  const sized = (id: string, w: number, h = 200) => ({ id, w, h });

  it('never moves a room that already has a slot', () => {
    const first = placeRooms([sized('eng', 300), sized('res', 300), sized('ops', 300)]);
    // Engineering doubles, and a whole new department arrives.
    const next = placeRooms(
      [sized('eng', 380), sized('res', 300), sized('ops', 300), sized('lab', 280)],
      first.slots,
    );
    expect(next.slots.eng.x).toBe(first.slots.eng.x);
    expect(next.slots.eng.y).toBe(first.slots.eng.y);
    // Untouched rooms come back byte for byte, not merely close enough.
    expect(next.slots.res).toEqual(first.slots.res);
    expect(next.slots.ops).toEqual(first.slots.ops);
  });

  it('seats a new room without overlapping anything already placed', () => {
    const first = placeRooms([sized('a', 300)]);
    const next = placeRooms([sized('a', 300), sized('b', 260, 180)], first.slots);
    const a = next.slots.a;
    const b = next.slots.b;
    const overlaps = b.x < a.x + a.w && a.x < b.x + b.w && b.y < a.y + a.h && a.y < b.y + b.h;
    expect(overlaps).toBe(false);
    // Placed to the right of what is already there, at the shelf's own y.
    expect(b.x).toBeGreaterThanOrEqual(a.x + a.w);
    expect(b.y).toBe(a.y);
  });

  it('opens a shelf instead of sliding the last room along', () => {
    const wide = (id: string) => sized(id, MAX_ROW_WIDTH - 20);
    const first = placeRooms([wide('a'), wide('b')]);
    expect(first.slots.a.row).toBe(0);
    // 700 units + the column gap no longer fits in a 720-unit shelf.
    expect(first.slots.b.row).toBe(1);
    expect(first.slots.b.y).toBeGreaterThan(first.slots.a.y);

    const next = placeRooms([wide('a'), wide('b'), wide('c')], first.slots);
    expect(next.slots.a).toEqual(first.slots.a);
    expect(next.slots.b).toEqual(first.slots.b);
    expect(next.slots.c.row).toBe(2);
  });

  it('keeps everything clear of the vertical spine and inside the canvas', () => {
    const rooms = [sized('a', 300), sized('b', 300), sized('c', 300), sized('d', 300)];
    const { slots, width, height } = placeRooms(rooms);
    for (const room of rooms) {
      const s = slots[room.id];
      expect(s.x).toBeGreaterThanOrEqual(SPINE_W);
      expect(s.x + room.w).toBeLessThanOrEqual(width);
      expect(s.y + room.h).toBeLessThanOrEqual(height);
    }
    // Rooms on one shelf are separated by the column gap, not merely adjacent.
    const row0 = rooms.map((r) => slots[r.id]).filter((s) => s.row === 0).sort((l, r) => l.x - r.x);
    for (let i = 1; i < row0.length; i += 1) {
      expect(row0[i].x).toBeGreaterThanOrEqual(row0[i - 1].x + row0[i - 1].w + ROOM_COL_GAP);
    }
  });

  it('copes with an empty org, which is a real state on first load', () => {
    const { slots, rows, width, height } = placeRooms([]);
    expect(slots).toEqual({});
    expect(rows).toBe(0);
    // A canvas that is a spine and a margin, not NaN.
    expect(width).toBe(SPINE_W + 40);
    expect(Number.isFinite(height)).toBe(true);
  });
});
