import { describe, expect, it } from 'vitest';
import { MAX_ROW_WIDTH, ROOM_COL_GAP, SPINE_W, placeRooms } from './floorplan';

/**
 * The placement's one promise: a room that exists does not move.
 *
 * This is not tidiness. `buildOffice` runs again on every office update, and the
 * version this replaced packed the shelves from scratch each time, so hiring one
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
    // Either beside `a` on the same shelf, clear of `a`'s whole bay, or on a shelf of
    // its own below. A bay is a desk wider than the room it holds, so two rooms that
    // look like they fit can genuinely not, which is the placement working.
    if (b.row === a.row) {
      expect(b.x).toBeGreaterThanOrEqual(a.x + a.bayW);
      expect(b.y).toBe(a.y);
    } else {
      expect(b.row).toBeGreaterThan(a.row);
      expect(b.y).toBeGreaterThan(a.y);
    }
  });

  it('fills the block in reading order, and grows the SQUARE when it is full', () => {
    // Nine rooms make a three-by-three. The ninth completes it; the tenth starts a
    // four-by-four, and the nine that were already there do not move, which is what
    // "the new office completes the square" means as arithmetic.
    const nine = Array.from({ length: 9 }, (_, i) => sized(`r${i}`, 300, 200));
    const full = placeRooms(nine);
    expect(full.rows).toBe(3);
    const at = (i: number) => ({ col: i % 3, row: Math.floor(i / 3) });
    nine.forEach((room, i) => {
      expect({ col: full.slots[room.id].col, row: full.slots[room.id].row }).toEqual(at(i));
    });

    const ten = [...nine, sized('r9', 300, 200)];
    const bigger = placeRooms(ten, full.slots);
    expect(bigger.rows).toBe(4);
    for (const room of nine) {
      expect(bigger.slots[room.id], room.id).toEqual(full.slots[room.id]);
    }
    expect(bigger.slots.r9.row).toBe(0);
    expect(bigger.slots.r9.col).toBe(3);
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
