/**
 * The HQ scene model (ADR 0011): the whole company on one floor, as data.
 *
 * Pure — no React, no DOM — so the layout the renderer draws and the routes the
 * walkers take are the same numbers a test can hold still. The floor is a fixed
 * plan because a headquarters is fixed: the board room up top, the C-suite row,
 * and one pod per member project. The people are the record's people — the
 * executives the company hired, the board it seated, one lead per project — and
 * every note they carry is a line the record already wrote.
 */
import { UNITS_PER_METRE } from '../office/iso';
import { DESK_W } from '../../sim/floorplan';
import { scaleForWidth, spriteCentreOffset, spriteFootprint } from '../sprites/sprites';
import type { Hq, HqActivity } from '../../api/types';

export const M = UNITS_PER_METRE;

export interface HqPoint {
  x: number;
  y: number;
}

export type HqRoomKind = 'board' | 'exec' | 'pod';

export interface HqRoom {
  id: string;
  kind: HqRoomKind;
  x: number;
  y: number;
  w: number;
  d: number;
  label: string;
  sub: string;
  accent: string;
}

export interface HqPerson {
  id: string;
  name: string;
  role: string;
  title: string;
  kind: 'exec' | 'board' | 'lead';
  room: string;
  home: HqPoint;
  /** Seated at an owned desk when undisturbed (execs and pod leads). */
  anchors: boolean;
  note: string;
  project_id?: string;
}

export interface HqStage {
  personId: string;
  path: HqPoint[];
  note: string;
  at: HqPoint;
}

export interface HqWorld {
  w: number;
  h: number;
  rooms: HqRoom[];
  people: HqPerson[];
  /** Where the animator should walk people, and what it should let them say. */
  stages: HqStage[];
  banner: string | null;
  inSession: boolean;
}

export const VERDICT_COLOR: Record<string, string> = {
  on_track: '#3fb388',
  at_risk: '#d9a441',
  no_activity: '#6b7a90',
  stop: '#d05a5a',
};

const EXEC_ORDER = ['ceo', 'cto', 'cmo', 'cpo', 'coo', 'cfo'];

// ── the fixed plan, in floor units ───────────────────────────────────────────
export const BOARD_ROOM = { x: 8.6 * M, y: 0.5 * M, w: 9 * M, d: 5.6 * M };
export const EXEC_ROW = { y: 7.1 * M, w: 3.9 * M, d: 3.6 * M, gap: 0.16 * M, x0: 1.2 * M };
export const POD_ROW = { y: 12.6 * M, w: 8 * M, d: 6.4 * M, gap: 0.4 * M, x0: 1.2 * M };

export const BOARD_TABLE = (() => {
  const w = 3.4 * M;
  const s = scaleForWidth('prop.table.3', w);
  const depth = (spriteFootprint('prop.table.3')?.b ?? 100) * s;
  const clear = spriteCentreOffset('prop.chair.turned').y * 1.2;
  const x = BOARD_ROOM.x + (BOARD_ROOM.w - w) / 2;
  const y = BOARD_ROOM.y + 2.1 * M;
  const step = w / 5;
  return {
    x,
    y,
    w,
    depth,
    seats: [
      { x: x + step, y: y + depth + clear },
      { x: x + step * 2, y: y + depth + clear },
      { x: x + step * 3, y: y + depth + clear },
      { x: x + step * 4, y: y + depth + clear },
      { x: x + step, y: y - clear },
      { x: x + w - step, y: y - clear },
    ] as HqPoint[],
  };
})();

/** The corridor band walkers use between wings. */
const CORRIDOR_Y = 6.2 * M;

function doorIn(room: { x: number; y: number; w: number; d: number }): HqPoint {
  return { x: room.x + room.w / 2, y: room.y + room.d + 14 };
}

function route(from: HqPoint, homeDoor: HqPoint, to: HqPoint, toDoor: HqPoint): HqPoint[] {
  return [homeDoor, { x: homeDoor.x, y: CORRIDOR_Y }, { x: toDoor.x, y: CORRIDOR_Y }, toDoor, to];
}

function ageSeconds(at: string, now: number): number {
  const t = Date.parse(at);
  return Number.isFinite(t) ? (now - t) / 1000 : Number.POSITIVE_INFINITY;
}

function youngest(activity: HqActivity[], type: string): HqActivity | null {
  let best: HqActivity | null = null;
  let bestAge = Number.POSITIVE_INFINITY;
  for (const a of activity) {
    if (a.type !== type) continue;
    const age = Date.parse(a.at);
    if (Number.isFinite(age) && age < bestAge) {
      bestAge = age;
      best = a;
    }
  }
  return best;
}

/** Which windows make the floor move. Seconds; the record is polled every 10 s. */
export const WINDOWS = { session: 300, allocation: 300, visit: 240 };

export function execSeat(room: { x: number; y: number; w: number }): HqPoint {
  return { x: room.x + room.w / 2, y: room.y + 1.1 * M + 74 };
}

export function buildHqWorld(hq: Hq, now = Date.now()): HqWorld {
  const rooms: HqRoom[] = [];
  const people: HqPerson[] = [];

  // the board room
  rooms.push({ id: 'board', kind: 'board', ...BOARD_ROOM, label: 'Board room',
               sub: `${hq.board.length} director${hq.board.length === 1 ? '' : 's'} seated`,
               accent: '#8d7bd4' });

  // the C-suite row: one office per executive, in role order
  const execs = [...hq.executives].sort(
    (a, b) => EXEC_ORDER.indexOf(a.role) - EXEC_ORDER.indexOf(b.role),
  );
  execs.forEach((e, i) => {
    const x = EXEC_ROW.x0 + i * (EXEC_ROW.w + EXEC_ROW.gap);
    const room = { id: `exec-${e.role}`, x, y: EXEC_ROW.y, w: EXEC_ROW.w, d: EXEC_ROW.d };
    rooms.push({ ...room, kind: 'exec', label: e.name,
                 sub: e.role === 'ceo' ? 'CEO' : e.role.toUpperCase(),
                 accent: e.role === 'ceo' ? '#d9a441' : '#5e8bd6' });
    people.push({
      id: e.id, name: e.name, role: e.role, title: e.title, kind: 'exec', room: room.id,
      home: execSeat(room), anchors: true,
      note: `${e.title} — in their office`,
    });
  });

  // the board: at their lounge strip normally; around the table in session
  hq.board.forEach((b, i) => {
    people.push({
      id: b.id, name: b.name, role: b.role,
      title: b.role === 'chair' ? 'Chair of the Board' : 'Board Member',
      kind: 'board', room: 'board',
      home: { x: BOARD_ROOM.x + 0.7 * M, y: BOARD_ROOM.y + 3.4 * M + i * 40 },
      anchors: false,
      note: b.role === 'chair' ? 'Chair of the board — in the board room' : 'Off the floor until sessions',
    });
  });

  // one pod per member project, one lead per pod (the first team's head)
  hq.projects.forEach((p, i) => {
    const x = POD_ROW.x0 + i * (POD_ROW.w + POD_ROW.gap);
    const room = { id: `pod-${p.id}`, x, y: POD_ROW.y, w: POD_ROW.w, d: POD_ROW.d };
    const accent = VERDICT_COLOR[p.verdict] ?? VERDICT_COLOR.no_activity;
    const teams = p.teams.map((t) => t.name).join(' · ') || 'no teams yet';
    rooms.push({ ...room, kind: 'pod', label: p.name,
                 sub: `${p.verdict.replace('_', ' ')} · ${teams}`, accent });
    people.push({
      id: `lead-${p.id}`, name: p.teams[0]?.head_name ?? `${p.name} lead`,
      role: 'lead', title: `${p.name} — project lead`, kind: 'lead', room: room.id,
      home: { x: room.x + 1.1 * M, y: room.y + 1.25 * M + 74 },
      anchors: true,
      note: p.directive || `${p.completed} completed · ${p.failed} failed`,
      project_id: p.id,
    });
  });

  // ── who moves, and why (windows over the record) ────────────────────────────
  const stages: HqStage[] = [];
  let banner: string | null = null;

  const convened = youngest(hq.activity, 'board.convened');
  const decided = youngest(hq.activity, 'decision.recorded');
  const inSession =
    convened !== null &&
    ageSeconds(convened.at, now) < WINDOWS.session &&
    (decided === null || Date.parse(decided.at) < Date.parse(convened.at));

  const allocation = youngest(hq.activity, 'company.allocation.decided');
  const inAllocation = allocation !== null && ageSeconds(allocation.at, now) < WINDOWS.allocation;

  if (inSession) {
    const topic = String((convened?.payload?.topic as string) ?? 'board session');
    banner = `Board in session — ${topic}`;
    const directors = people.filter((p) => p.kind === 'board');
    directors.forEach((b, i) => {
      const seat = BOARD_TABLE.seats[Math.min(i, BOARD_TABLE.seats.length - 1)];
      // the directors are already in the room — they take their chairs, no corridor detour
      stages.push({ personId: b.id, at: seat, note: `${topic}`, path: [seat] });
    });
    const ceo = people.find((p) => p.role === 'ceo');
    if (ceo) {
      const seat = BOARD_TABLE.seats[BOARD_TABLE.seats.length - 1];
      const homeRoom = rooms.find((r) => r.id === ceo.room);
      stages.push({
        personId: ceo.id, at: seat, note: `reporting to the board — ${topic}`,
        path: route(ceo.home, homeRoom ? doorIn(homeRoom) : ceo.home, seat, seat),
      });
    }
  } else if (inAllocation) {
    banner = 'The portfolio is allocated — the C-suite is in the board room';
    for (const p of people.filter((x) => x.kind === 'exec' && x.role !== 'ceo')) {
      const homeRoom = rooms.find((r) => r.id === p.room);
      const corner = { x: BOARD_ROOM.x + 1.1 * M, y: BOARD_ROOM.y + 0.9 * M + 44 * Number(p.id.length % 3) };
      stages.push({ personId: p.id, at: corner, note: 'allocation decided — standing with the numbers',
                    path: route(p.home, homeRoom ? doorIn(homeRoom) : p.home, corner, corner) });
    }
  }

  // a fresh directive: the project's lead is with the CEO. Reporting up, visible.
  const ceoRoom = rooms.find((r) => r.kind === 'exec' && r.id === 'exec-ceo');
  for (const p of hq.projects) {
    const dir = hq.activity.find((a) => a.type === 'company.directive' && a.project_id === p.id);
    if (!dir || ageSeconds(dir.at, now) >= WINDOWS.visit) continue;
    if (inSession) continue; // the board is sitting; no side meetings
    const lead = people.find((x) => x.id === `lead-${p.id}`);
    const homeRoom = rooms.find((r) => r.id === lead?.room);
    if (!lead || !homeRoom || !ceoRoom) continue;
    const door = doorIn(ceoRoom);
    const spot = { x: door.x, y: door.y + 26 };
    banner = banner ?? `${p.name} is ${p.verdict.replace('_', ' ')} — its lead is with the CEO`;
    stages.push({
      personId: lead.id, at: spot,
      note: String((dir.payload?.directive as string) ?? p.directive ?? 'called up'),
      path: route(lead.home, doorIn(homeRoom), spot, door),
    });
  }

  return {
    w: 26.2 * M,
    h: 20.5 * M,
    rooms,
    people,
    stages,
    banner,
    inSession,
  };
}

/** Desk bay for an exec office (desk art width DESK_W, seat 74 units south). */
export function deskBay(room: { x: number; w: number }): { x: number; seatX: number } {
  return { x: room.x + (room.w - DESK_W) / 2, seatX: room.x + room.w / 2 };
}
