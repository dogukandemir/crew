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
export const DESK_GAP_X = 16;
export const DESK_GAP_Y = 14;
export const ROOM_PAD = 14;
export const ROOM_HEADER = 30;
/** Wall gap between neighbouring rooms on the same shelf row. */
export const ROOM_COL_GAP = 34;
/** Corridor band between two shelf rows. */
export const ROW_GAP = 108;
/** Vertical corridor running down the left-hand side of the floor. */
export const SPINE_W = 96;
export const MAX_ROW_WIDTH = 720;
export const ENTRANCE_MARGIN = 44;
/** Visual height of walls / desks in the 3D scene, in px. */
export const WALL_H = 30;
export const DESK_TOP_Z = 17;

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
}

export interface BuildOptions {
  showArchived?: boolean;
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

  // ── Shelf packing, leaving a corridor band between rows ────────────────────
  const rowCorridors: number[] = [];
  let row = 0;
  let cursorX = 0;
  let rowY = 0;
  let rowH = 0;

  for (const room of rooms) {
    if (cursorX > 0 && cursorX + room.w > MAX_ROW_WIDTH) {
      rowCorridors[row] = rowY + rowH + ROW_GAP / 2;
      row += 1;
      rowY += rowH + ROW_GAP;
      cursorX = 0;
      rowH = 0;
    }
    room.row = row;
    room.x = cursorX;
    room.y = rowY;
    cursorX += room.w + ROOM_COL_GAP;
    rowH = Math.max(rowH, room.h);
  }
  rowCorridors[row] = rowY + rowH + ROW_GAP / 2;

  const contentWidth = Math.max(...rooms.map((r) => r.x + r.w));
  const contentHeight = rowY + rowH;

  // Shift everything right to clear the vertical spine.
  for (const room of rooms) room.x += SPINE_W;

  const width = SPINE_W + contentWidth + 40;
  const height = contentHeight + ROW_GAP * 0.55;

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
      deskOf[desk.agentId] = {
        x: room.x + desk.x + DESK_W / 2,
        y: room.y + desk.y + DESK_H - 30,
      };
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
    corridorY,
    spineX: SPINE_W / 2,
  };
}

/** World position of the orchestrator's desk, if there is an orchestrator. */
export function orchestratorSeat(office: Office): Point | null {
  const room = office.rooms.find((r) => r.kind === 'orchestrator');
  const desk = room?.desks[0];
  if (!room || !desk) return null;
  return { x: room.x + desk.x + DESK_W / 2, y: room.y + desk.y + DESK_H - 30 };
}
