/**
 * Floor plan (pure).
 *
 * The floor is a real 3D plane: departments are rooms, agents get desks, and a
 * corridor network (a vertical spine plus one corridor per shelf row) connects
 * every room — so characters walk *between* departments instead of teleporting.
 *
 * Deterministic: the same org tree always produces the same floor.
 */
import type { OrgNode } from '../api/types';
import type { Point } from './geometry';

export const DESK_W = 104;
export const DESK_H = 92;

/**
 * The desk itself — the top, not the bay it sits in — in metres.
 *
 * The bay is 1.45 m wide by definition (`DESK_W` below), and the desk that stands in
 * it is 1.4 × 0.7: a desk, with the rest of the bay left as legroom and chair space.
 * These are the numbers the atlas art has to match, and `sprites.test.ts` checks
 * that it does — the art is the one thing here that can silently disagree.
 */
export const DESK_TOP_W_M = 1.4;
export const DESK_TOP_D_M = 0.7;
/** This world's metre, as the plan counts it. */
const M_UNIT = DESK_W / 1.45;
export const DESK_TOP_W = DESK_TOP_W_M * M_UNIT;
export const DESK_TOP_D = DESK_TOP_D_M * M_UNIT;
/** Six centimetres of clearance so a sitter's legs are under the desk, not against it. */
export const DESK_LEGROOM = 0.06 * M_UNIT;

/**
 * The whole plan is generated from these numbers.
 *
 * They are the difference between a floor that reads as an office and one that
 * reads as a storage rack, and they were tight: a desk three metres from a door
 * still felt crowded, because the rooms are only just bigger than their contents.
 * Widened once, together, so the ratio between desks and floor changed rather than
 * one gap growing.
 */
export const DESK_GAP_X = 30;
export const DESK_GAP_Y = 26;
export const ROOM_PAD = 28;
export const ROOM_HEADER = 30;
/** Wall gap between neighbouring rooms on the same shelf row. */
export const ROOM_COL_GAP = 60;
/** Corridor band between two shelf rows. */
export const ROW_GAP = 152;
/** Vertical corridor running down the left-hand side of the floor. */
export const SPINE_W = 96;
export const MAX_ROW_WIDTH = 720;
export const ENTRANCE_MARGIN = 44;

/** A room's place on the floor. Allocated once, and then never moved. */
export interface RoomSlot {
  row: number;
  x: number;
  y: number;
  /** The width and height the slot was allocated for, so growth can be detected. */
  w: number;
  h: number;
  /**
   * The slot's BAY: what it was given, with one desk of slack in each direction. The
   * drawn room may grow inside its bay without the shelf — or anything below it —
   * moving. This is the field that makes "a hire is a local event" true rather than
   * hopeful, and it is why bays have to be carried between builds.
   */
  bayW: number;
  bayH: number;
  /** The pitch the block was laid out with, so a rebuild can tell it has changed. */
  pitchW: number;
  pitchH: number;
  /** Which cell of the block the room sits in. Position is a pure function of this. */
  col: number;
}

/**
 * The block's pitch: how far apart two cells are.
 *
 * It is the smallest it can be for the rooms that exist — a two-desk department plus its
 * bay — and it GROWS when a department's roster outgrows that, so a room is always as
 * big as the people in it and the block stays tight instead of being a grid of empty
 * bays. Every slot carries the pitch it was laid out with, so the number survives
 * between builds; only when it has to grow does the block re-lay itself, which is a
 * visible, honest event ("more agents, bigger building") rather than every hire sliding
 * something.
 */
const MIN_PITCH_HOLDER = null;

/**
 * The slack a fresh bay gets: one more desk, each way.
 *
 * A bay that fits its first roster exactly is the bug this whole placement exists to
 * fix. The first hire into a department then grows that room past its allocation, the
 * shelf gets taller, and every shelf below slides down — one new agent in one
 * department, and a different department on the far side of the floor moves.
 */
const BAY_SLACK = { w: DESK_W + DESK_GAP_X, h: DESK_H + DESK_GAP_Y };

/** The block's pitch: how far apart two cells are. Declared after the slack it uses. */
const MIN_PITCH = {
  w: ROOM_PAD * 2 + 2 * DESK_W + DESK_GAP_X + BAY_SLACK.w,
  h: ROOM_PAD * 2 + ROOM_HEADER + 2 * DESK_H + DESK_GAP_Y + BAY_SLACK.h,
};

export interface Placement {
  slots: Record<string, RoomSlot>;
  rows: number;
  width: number;
  height: number;
  /** y of each shelf, and the height of the tallest room on it — its corridor follows. */
  rowTops: number[];
  rowHeights: number[];
}

/**
 * Where every room sits — and, the part that matters, that it stays there.
 *
 * The floor is a SQUARE BLOCK of cells. Rooms fill it in reading order, and a hire that
 * opens a department takes the next free cell, so the new office completes the square
 * rather than being tacked onto the end of a corridor. When the square is full the next
 * ring begins — three-by-three becomes four-by-four — and nothing already standing
 * moves, because a room's position is its cell times the same two constants.
 *
 * A room is placed ONCE. A hire re-grids the desks inside a department's slot; it does
 * not move the slot. What this replaced packed every room from scratch on every update,
 * so one new agent widened a department and slid every room after it along the shelf,
 * and the building read as a corridor with rooms hung off it rather than a floor.
 *
 * `prev` is the placement from the last update. A room that already has a slot keeps it
 * verbatim, including its x and y. Only rooms without one are allocated.
 */
export function placeRooms(sizes: { id: string; w: number; h: number }[], prev: Placement['slots'] = {}): Placement {
  const slots: Record<string, RoomSlot> = {};
  const taken = new Set<string>();
  let maxCol = -1;
  let maxRow = -1;

  // 0. The bays FIRST, then the pitch that has to hold them — in that order, because the
  // pitch must be sized by what a room is RESERVED, not by what it happens to hold. The
  // bay is sticky: a hire eats into it, and only outgrowing it grows the pitch. Sizing
  // the pitch off the current width instead made every hire re-lay the whole block,
  // which is the sliding building this placement exists to stop.
  const bayOf: Record<string, { w: number; h: number }> = {};
  let pitchW = MIN_PITCH.w;
  let pitchH = MIN_PITCH.h;
  let wasPitchW = 0;
  let wasPitchH = 0;
  for (const room of sizes) {
    const was = prev[room.id];
    const bay = {
      w: Math.max(was?.bayW ?? room.w + BAY_SLACK.w, room.w),
      h: Math.max(was?.bayH ?? room.h + BAY_SLACK.h, room.h),
    };
    bayOf[room.id] = bay;
    pitchW = Math.max(pitchW, bay.w);
    pitchH = Math.max(pitchH, bay.h);
    if (was) {
      wasPitchW = Math.max(wasPitchW, was.pitchW ?? 0);
      wasPitchH = Math.max(wasPitchH, was.pitchH ?? 0);
    }
  }
  pitchW = Math.max(pitchW, wasPitchW);
  pitchH = Math.max(pitchH, wasPitchH);
  // A pitch that grew means the grid itself changed: the whole block re-lays from its
  // cells, deliberately and at once, rather than leaving new rooms on a grid the old
  // ones are not on.
  const repitch = wasPitchW > 0 && (wasPitchW !== pitchW || wasPitchH !== pitchH);

  // 1. Rooms that already exist keep the cell they were given, and — unless the pitch
  // itself changed — their exact x and y. A carried position is a promise; a recomputed
  // one is arithmetic that can drift.
  for (const room of sizes) {
    const was = prev[room.id];
    if (!was) continue;
    const col = was.col ?? Math.max(0, Math.round((was.x - SPINE_W) / (pitchW + ROOM_COL_GAP)));
    const { w: bayW, h: bayH } = bayOf[room.id];
    slots[room.id] = {
      ...was,
      col,
      x: repitch ? SPINE_W + col * (pitchW + ROOM_COL_GAP) : was.x,
      y: repitch ? was.row * (pitchH + ROW_GAP) : was.y,
      w: room.w,
      h: room.h,
      bayW,
      bayH,
      pitchW,
      pitchH,
    };
    taken.add(`${col},${was.row}`);
    maxCol = Math.max(maxCol, col);
    maxRow = Math.max(maxRow, was.row);
  }

  // 2. The block is a SQUARE: the smallest one that holds everything, and never smaller
  // than what is already standing — a department emptying must not fold the building in.
  const side = Math.max(Math.ceil(Math.sqrt(sizes.length)), maxCol + 1, maxRow + 1);

  // 3. New rooms take the first free cell, in reading order: the new office completes
  // the square instead of being tacked onto the end of a corridor.
  let scan = 0;
  for (const room of sizes) {
    if (slots[room.id]) continue;
    let col = -1;
    let row = -1;
    while (scan < side * side) {
      const c = scan % side;
      const r = Math.floor(scan / side);
      scan += 1;
      if (!taken.has(`${c},${r}`)) {
        col = c;
        row = r;
        break;
      }
    }
    if (col === -1) {
      // The square is full and they are still hiring: a new ring.
      col = scan % side;
      row = Math.floor(scan / side);
      scan += 1;
    }
    taken.add(`${col},${row}`);
    const { w: bayW, h: bayH } = bayOf[room.id];
    slots[room.id] = {
      row,
      col,
      x: SPINE_W + col * (pitchW + ROOM_COL_GAP),
      y: row * (pitchH + ROW_GAP),
      w: room.w,
      h: room.h,
      bayW,
      bayH,
      pitchW,
      pitchH,
    };
  }

  // 4. Shelves for the corridors: a ring's y is its row times the same two numbers, so
  // a room's corridor spur follows it for free.
  const rowTops: number[] = [];
  const rowHeights: number[] = [];
  for (let r = 0; r < side; r += 1) {
    rowTops[r] = r * (pitchH + ROW_GAP);
    rowHeights[r] = pitchH;
  }

  const gapsW = Math.max(0, side - 1) * ROOM_COL_GAP;
  const gapsH = Math.max(0, side - 1) * ROW_GAP;
  const contentWidth = side * pitchW + gapsW;
  const contentHeight = side * pitchH + gapsH;
  return {
    slots,
    rows: side,
    width: SPINE_W + contentWidth + 40,
    height: contentHeight + ROW_GAP * 0.55,
    rowTops,
    rowHeights,
  };
}

/**
 * The placement a built office came out with, to hand back as `prev` next time.
 *
 * Read out of the office rather than kept beside it, so the two cannot drift: if the
 * office says a room is at (x, y), that is the slot the next build will restore.
 */
export function placementOf(office: Office): Placement['slots'] {
  return office.placement;
}

/** Department accents: muted, distinguishable on a dark floor, no neon. */
export const ROOM_ACCENTS = [
  '#5b8def',
  '#e0a458',
  '#5fbf8f',
  '#c97bb6',
  '#6fc3d0',
  '#d97a6c',
] as const;

/* ── The break corner's round tables ──────────────────────────────────────────
   Shared by the simulation (which seats people) and the renderer (which draws a
   chair under each of them), so the two can never disagree about where a chair
   is. */

export const BREAK_TABLE_R = 34;
export const BREAK_TABLE_SEATS = 3;
/** How far a chair sits from its table's centre. */
export const BREAK_SEAT_R = 50;

export interface BreakTable {
  x: number;
  y: number;
}

export interface BreakSeat {
  table: number;
  index: number;
  point: Point;
  /** The table's centre, so two people at one table look at each other. */
  faceTowards: Point;
}

/** Every chair in the break corner, table by table. */
export function breakSeats(tables: BreakTable[]): BreakSeat[] {
  const out: BreakSeat[] = [];
  tables.forEach((table, t) => {
    for (let i = 0; i < BREAK_TABLE_SEATS; i += 1) {
      const angle = (i / BREAK_TABLE_SEATS) * Math.PI * 2 - Math.PI / 2;
      out.push({
        table: t,
        index: i,
        point: {
          x: table.x + Math.cos(angle) * BREAK_SEAT_R,
          y: table.y + Math.sin(angle) * BREAK_SEAT_R * 0.62,
        },
        faceTowards: { x: table.x, y: table.y },
      });
    }
  });
  return out;
}

/**
 * The break corner, laid out in one place.
 *
 * The simulation seats people on these spots and the renderer draws the props
 * that own them, so the vending machine somebody is standing at is always the
 * vending machine that is actually drawn there.
 */
export interface BreakLayout {
  /** Round tables, in a line. */
  tables: BreakTable[];
  vending: { x: number; y: number; w: number; d: number };
  /** Where you stand to buy something: two can queue. */
  vendingQueue: Point[];
  foosball: { x: number; y: number; w: number; d: number };
  /** One stand at each end of the table, facing across it. */
  foosballEnds: Point[];
}

export const EMPTY_BREAK_LAYOUT: BreakLayout = {
  tables: [],
  vending: { x: 0, y: 0, w: 0, d: 0 },
  vendingQueue: [],
  foosball: { x: 0, y: 0, w: 0, d: 0 },
  foosballEnds: [],
};

export function breakLayout(room: { x: number; y: number; w: number; h: number }): BreakLayout {
  const vending = { x: room.x + 14, y: room.y + 22, w: 56, d: 34 };
  const foosball = { x: room.x + room.w - 106, y: room.y + 88, w: 100, d: 60 };
  const midY = foosball.y + foosball.d / 2;
  // Two round tables, clear of the vending machine and clear of the foosball.
  const gap = BREAK_TABLE_R * 2 + 52;
  const cx = room.x + 74;
  return {
    tables: [
      { x: cx, y: room.y + room.h * 0.66 },
      { x: cx + gap, y: room.y + room.h * 0.66 },
    ],
    vending,
    vendingQueue: [
      { x: vending.x + vending.w / 2, y: vending.y + vending.d + 24 },
      { x: vending.x + vending.w / 2 + 36, y: vending.y + vending.d + 26 },
    ],
    foosball,
    foosballEnds: [
      { x: foosball.x - 24, y: midY },
      { x: foosball.x + foosball.w + 24, y: midY },
    ],
  };
}

export type RoomKind = 'commons' | 'orchestrator' | 'department' | 'bench' | 'break' | 'lab';

/**
 * Work that belongs at a lab bench rather than at a desk.
 *
 * Read off the org's own words — a department's name and mission, an agent's
 * role, a task's title — so the lab is used because the organization is doing
 * research, not because a timer said so.
 */
const RE_RND = /research|r&d|lab\b|laborator|science|scientist|innovat|experiment|discover|analysis|analyst/i;
const RE_RND_TASK = /research|experiment|study|analys|benchmark|prototype|evaluat|survey|measur/i;

export function isResearchWork(...texts: (string | undefined)[]): boolean {
  return texts.some((t) => !!t && RE_RND.test(t));
}

export function isResearchTask(title: string | undefined): boolean {
  return !!title && RE_RND_TASK.test(title);
}

export interface Desk {
  agentId: string;
  agent: OrgNode;
  /** Top-left, relative to the room's content origin. */
  x: number;
  y: number;
}

export interface Room {
  id: string;
  kind: RoomKind;
  name: string;
  subtitle?: string;
  accent: string;
  x: number;
  y: number;
  w: number;
  h: number;
  desks: Desk[];
  dept?: OrgNode;
  seats: number;
  rows: number;
  cols: number;
  /** Shelf row this room was packed into — decides which corridor serves it. */
  row: number;
  /** Waypoint just outside the room's bottom edge, where its corridor spur starts. */
  door: Point;
}

export interface Office {
  rooms: Room[];
  width: number;
  height: number;
  /** Where new hires walk in from (bottom of the spine). */
  entrance: Point;
  /** The shared review table agents walk to while verifying. */
  reviewTable: Point;
  /** Coffee corner idle agents wander to. */
  breakSpot: Point;
  /** The break corner's round tables, and the chairs around them. */
  breakTables: BreakTable[];
  /** The break corner's full layout: tables, vending machine, foosball. */
  breakLayout: BreakLayout;
  /** The lab, when the organization does any research at all. */
  labRoomId: string | null;
  /** The bench in the lab where research work is done. */
  labBench: Point;
  /** Agent id → where their body belongs, in world coordinates. */
  deskOf: Record<string, Point>;
  /** Agent id → the room their desk sits in. */
  roomOf: Record<string, string>;
  /** Agent id → the agent they report to, from the org's own `manager_id`. */
  managerOf: Record<string, string>;
  agentOf: Record<string, OrgNode>;
  /** Room id → y of the corridor serving its shelf row. */
  corridorY: Record<string, number>;
  /** x of the vertical spine. */
  spineX: number;
  /**
   * Every room's slot, bays included. Hand this back as `BuildOptions.prev` and the
   * floor is extended instead of re-packed — which is the only way a room keeps its
   * place while the organization changes around it.
   */
  placement: Placement['slots'];
}

export interface BuildOptions {
  showArchived?: boolean;
  /**
   * The previous placement, so a room that already exists keeps the slot it was given
   * instead of being packed again. Omitting it is a fresh floor — correct for the first
   * build, and for a test that wants the packing itself.
   */
  prev?: Placement['slots'];
}

function isArchived(a: OrgNode): boolean {
  return a.state === 'archived';
}

/** Every unit under `node`, depth-first. */
export function flattenOrg(node: OrgNode | null | undefined): OrgNode[] {
  if (!node) return [];
  const out: OrgNode[] = [];
  const walk = (n: OrgNode) => {
    out.push(n);
    for (const c of n.children ?? []) walk(c);
  };
  walk(node);
  return out;
}

function gridFor(n: number): { cols: number; rows: number } {
  const cols = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(n))));
  const rows = Math.max(1, Math.ceil(n / cols));
  return { cols, rows };
}

function roomSize(cols: number, rows: number): { w: number; h: number } {
  return {
    w: ROOM_PAD * 2 + cols * DESK_W + (cols - 1) * DESK_GAP_X,
    h: ROOM_PAD * 2 + ROOM_HEADER + rows * DESK_H + (rows - 1) * DESK_GAP_Y,
  };
}

function accentFor(index: number): string {
  return ROOM_ACCENTS[index % ROOM_ACCENTS.length];
}

function makeDesks(roster: OrgNode[], cols: number): Desk[] {
  return roster.map((a, idx) => ({
    agentId: a.id,
    agent: a,
    x: ROOM_PAD + (idx % cols) * (DESK_W + DESK_GAP_X),
    y: ROOM_PAD + ROOM_HEADER + Math.floor(idx / cols) * (DESK_H + DESK_GAP_Y),
  }));
}

type RoomInit = Pick<Room, 'id' | 'kind' | 'name' | 'accent' | 'w' | 'h' | 'cols' | 'rows'> &
  Partial<Room>;

function shell(init: RoomInit): Room {
  return {
    subtitle: undefined,
    x: 0,
    y: 0,
    desks: [],
    seats: 0,
    row: 0,
    door: { x: 0, y: 0 },
    ...init,
  };
}

/**
 * Build the floor plan.
 *
 * Rooms are packed shelf-style (left to right, wrapping at MAX_ROW_WIDTH). Rows
 * are separated by a corridor band, and the whole floor is shifted right to
 * leave room for the vertical spine — that pair of corridors is what makes
 * cross-row (cross-department) walking possible.
 */
export function buildOffice(root: OrgNode | null | undefined, opts: BuildOptions = {}): Office {
  const showArchived = opts.showArchived ?? false;

  const all = flattenOrg(root);
  const agents = all.filter((n) => n.kind === 'agent' && (showArchived || !isArchived(n)));
  const departments = all.filter(
    (n) => n.kind === 'department' && (showArchived || !isArchived(n)),
  );

  const agentOf: Record<string, OrgNode> = {};
  for (const a of agents) agentOf[a.id] = a;

  // The command chain, straight from the org tree's own manager_id — this is what
  // lets a report walk to the reporter's actual manager, and onward to whoever
  // runs the floor.
  const managerOf: Record<string, string> = {};
  for (const a of agents) {
    const manager = a.manager_id;
    if (manager && manager !== a.id) managerOf[a.id] = manager;
  }
  const top = agents.find((a) => /orchestrator/i.test(a.role ?? ''));
  if (top) {
    for (const a of agents) {
      if (!managerOf[a.id] && a.id !== top.id) managerOf[a.id] = top.id;
    }
  }

  // The orchestrator runs the floor from its own office; it is the escalation target.
  const orchestrator = agents.find((a) => /orchestrator/i.test(a.role ?? ''));
  const others = agents.filter((a) => a.id !== orchestrator?.id);

  const rooms: Room[] = [];

  // 1. Break corner — where genuinely idle characters wander, with room for
  // round tables and the chairs around them rather than a single coffee point.
  const breakSize = roomSize(3, 1);
  rooms.push(
    shell({
      id: '__break',
      kind: 'break',
      name: 'Break corner',
      subtitle: 'coffee & talk',
      accent: '#9a8f72',
      w: breakSize.w,
      h: breakSize.h,
      cols: 3,
      rows: 1,
    }),
  );

  // 2. Commons — the shared review table (walk target while verifying).
  const commonsSize = roomSize(2, 1);
  rooms.push(
    shell({
      id: '__commons',
      kind: 'commons',
      name: 'Review table',
      subtitle: 'stand-up & review',
      accent: '#8b93a7',
      w: commonsSize.w,
      h: commonsSize.h,
      cols: 2,
      rows: 1,
    }),
  );

  // 3. Orchestrator office.
  if (orchestrator) {
    const size = roomSize(1, 1);
    rooms.push(
      shell({
        id: '__orchestrator',
        kind: 'orchestrator',
        name: orchestrator.name,
        subtitle: 'Orchestrator',
        accent: '#e0a458',
        w: size.w,
        h: size.h,
        cols: 1,
        rows: 1,
        seats: 1,
        desks: makeDesks([orchestrator], 1),
      }),
    );
  }

  // 3.5 The lab — where research and R&D work is actually done. It exists only
  // when the organization has a department whose own words say it does research.
  const wantsLab = isResearchWork(...departments.flatMap((d) => [d.name, d.mission]));
  if (wantsLab) {
    const size = roomSize(2, 1);
    rooms.push(
      shell({
        id: '__lab',
        kind: 'lab',
        name: 'Lab',
        subtitle: 'R&D bench',
        accent: '#6fc3d0',
        w: size.w,
        h: size.h,
        cols: 2,
        rows: 1,
      }),
    );
  }

  // 4. One room per department.
  departments.forEach((dept, i) => {
    const roster = others
      .filter((a) => a.department_id === dept.id)
      .sort(
        (a, b) =>
          (a.squad_id ?? '').localeCompare(b.squad_id ?? '') || a.name.localeCompare(b.name),
      );
    const { cols, rows } = gridFor(Math.max(roster.length, 1));
    const size = roomSize(cols, rows);
    rooms.push(
      shell({
        id: dept.id,
        kind: 'department',
        name: dept.name,
        subtitle: dept.mission,
        accent: accentFor(i),
        w: size.w,
        h: size.h,
        cols,
        rows,
        dept,
        seats: roster.length,
        desks: makeDesks(roster, cols),
      }),
    );
  });

  // 5. Anyone the org has not seated yet (hire in flight, or no department).
  const seated = new Set(rooms.flatMap((r) => r.desks.map((d) => d.agentId)));
  const bench = others.filter((a) => !seated.has(a.id));
  if (bench.length > 0) {
    const { cols, rows } = gridFor(bench.length);
    const size = roomSize(cols, rows);
    rooms.push(
      shell({
        id: '__bench',
        kind: 'bench',
        name: 'Bench',
        subtitle: 'not yet assigned',
        accent: '#6b7280',
        w: size.w,
        h: size.h,
        cols,
        rows,
        seats: bench.length,
        desks: makeDesks(bench, cols),
      }),
    );
  }

  // ── Shelf packing: once per room, and then never again ─────────────────────
  // `placeRooms` and not a fresh pack on every update. A room that already exists keeps
  // the slot it was given, so hiring into engineering re-grids engineering's own desks
  // and moves nobody else — and a room stays where the reader last saw it.
  const placement = placeRooms(rooms, opts.prev ?? {});
  for (const room of rooms) {
    const slot = placement.slots[room.id];
    room.row = slot.row;
    room.x = slot.x;
    room.y = slot.y;
  }

  // The corridor band for a shelf, from that shelf's own tallest room.
  const rowCorridors: number[] = placement.rowTops.map(
    (top, r) => top + (placement.rowHeights[r] ?? 0) + ROW_GAP / 2,
  );
  const { width, height } = placement;
  const contentWidth = width - SPINE_W - 40;
  const contentHeight = height - ROW_GAP * 0.55;

  // ── Doors and corridors ───────────────────────────────────────────────────
  const corridorY: Record<string, number> = {};
  for (const room of rooms) {
    room.door = { x: room.x + room.w / 2, y: room.y + room.h + 16 };
    corridorY[room.id] = rowCorridors[room.row] ?? room.y + room.h + ROW_GAP / 2;
  }

  const deskOf: Record<string, Point> = {};
  const roomOf: Record<string, string> = {};
  for (const room of rooms) {
    for (const desk of room.desks) {
      deskOf[desk.agentId] = deskSeat(room, desk);
      roomOf[desk.agentId] = room.id;
    }
  }

  const find = (k: RoomKind) => rooms.find((r) => r.kind === k);
  const commons = find('commons');
  const breakRoom = find('break');
  const labRoom = find('lab');

  return {
    rooms,
    width,
    height,
    entrance: { x: SPINE_W / 2, y: height + ENTRANCE_MARGIN },
    reviewTable: commons
      ? { x: commons.x + commons.w / 2, y: commons.y + commons.h - 20 }
      : { x: SPINE_W / 2, y: height / 2 },
    breakSpot: breakRoom
      ? { x: breakRoom.x + breakRoom.w / 2, y: breakRoom.y + breakRoom.h - 24 }
      : { x: SPINE_W / 2, y: height - 20 },
    breakTables: breakRoom ? breakLayout(breakRoom).tables : [],
    breakLayout: breakRoom ? breakLayout(breakRoom) : EMPTY_BREAK_LAYOUT,
    labRoomId: labRoom?.id ?? null,
    labBench: labRoom
      ? { x: labRoom.x + labRoom.w * 0.34, y: labRoom.y + labRoom.h * 0.5 }
      : { x: 0, y: 0 },
    deskOf,
    roomOf,
    managerOf,
    agentOf,
    placement: placement.slots,
    corridorY,
    spineX: SPINE_W / 2,
  };
}

/**
 * Where the person at a desk sits.
 *
 * ONE function, because two things need it: the simulation walks a body to this
 * point, and the renderer draws the chair under it. They used to be two formulas —
 * `DESK_H - 30` in the plan and a constant assembled from a slab depth that existed
 * nowhere else — which agreed to within three units purely by luck, and would have
 * drifted apart on the next edit to either. The seat is the desk's own near edge
 * plus the legroom, and both callers ask this.
 */
export function deskSeat(room: { x: number; y: number }, desk: { x: number; y: number }): Point {
  return {
    x: room.x + desk.x + DESK_W / 2,
    y: room.y + desk.y + DESK_TOP_D + DESK_LEGROOM,
  };
}

/** World position of the orchestrator's desk, if there is an orchestrator. */
export function orchestratorSeat(office: Office): Point | null {
  const room = office.rooms.find((r) => r.kind === 'orchestrator');
  const desk = room?.desks[0];
  if (!room || !desk) return null;
  return deskSeat(room, desk);
}
