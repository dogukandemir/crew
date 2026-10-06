/**
 * Where each character should be standing (pure).
 *
 * This is the rule set that turns domain state into *movement*: escalation sends
 * you to the orchestrator's office, verification sends you to the review table, a
 * task owned by another department sends you across the floor to it, and a long
 * idle spell sends you to the coffee corner. Everything else is your own desk.
 *
 * Agents sharing a destination are spread onto a small ring so they stand around
 * the table rather than inside each other.
 */
import type { Task, TaskState } from '../api/types';
import type { Point } from './geometry';
import { DESK_W, type Office } from './floorplan';
import { anchorOf } from './paths';
import { currentTaskFor, type Activity } from './activity';

export interface Target {
  agentId: string;
  roomId: string;
  point: Point;
  /** Human sentence for the tooltip. */
  reason: string;
  /**
   * Who the character should be looking at while standing here. Two people in
   * conversation have to face each other, or it reads as two strangers.
   */
  faceTowards?: Point;
}

export interface TargetInput {
  office: Office;
  activities: Record<string, Activity>;
  tasks: Task[];
  now: number;
  /** agentId → when it last became idle. */
  idleSince: Map<string, number>;
  /** Agents that have just been hired and should walk in from the door. */
  arriving: Set<string>;
  /** ms of idling before someone wanders off for coffee. */
  breakAfterMs?: number;
}

const RING_RADIUS = 52;

/** Task states where two people on one task should visibly work together. */
const PAIRABLE: TaskState[] = ['assigned', 'running', 'ready', 'verifying'];

/**
 * Stand beside someone rather than on top of them — and on the side you are
 * arriving from, so walking over ends in a natural position.
 */
function beside(anchor: Point, from: Point): Point {
  const side = from.x >= anchor.x ? 1 : -1;
  return { x: anchor.x + side * DESK_W * 0.62, y: anchor.y + 6 };
}

/**
 * Turn the name a message was addressed to into an agent, or nothing.
 *
 * Names come from the model, so they are matched loosely (first name or full
 * name, case-insensitive) and a role word means the orchestrator. An unknown
 * name resolves to nothing and the character stays put: inventing a recipient
 * would put a person on the floor who was never spoken to.
 */
export function resolvePeer(office: Office, selfId: string, name: string): string | undefined {
  const wanted = name.toLowerCase().trim();
  if (!wanted) return undefined;

  const orchestrator = Object.keys(office.agentOf).find((id) =>
    /orchestrator/i.test(office.agentOf[id].role ?? ''),
  );

  // A report goes to the reporter's own manager — the org tree's `manager_id` —
  // and only falls back to whoever runs the floor. So "reports to my manager"
  // walks to a real desk, and a manager's own report walks up from there.
  if (/^(manager|lead|head|boss|supervisor)$/.test(wanted)) {
    const manager = office.managerOf[selfId];
    return manager && manager !== selfId ? manager : orchestrator;
  }
  if (/^(orchestrator|owner|board)$/.test(wanted)) return orchestrator;

  const names = Object.keys(office.agentOf);
  for (const id of names) {
    if (id === selfId) continue;
    const full = (office.agentOf[id].name ?? '').toLowerCase().trim();
    if (full === wanted || full.split(/\s+/)[0] === wanted) return id;
  }
  return undefined;
}

/**
 * agentId → the colleague to work beside. Only the junior of a pair moves.
 *
 * Grounded in squads, because a task has a single `assignee_agent_id`: the way
 * several people genuinely share one job in this model is a task assigned to a
 * *squad*, with agents belonging to it. Nothing gathers unless such a task is
 * live, so this cannot invent collaboration that is not happening.
 */
function pairAnchor(office: Office, tasks: Task[]): Record<string, string> {
  const liveSquads = new Set(
    tasks
      .filter((t) => t.assignee_squad_id && PAIRABLE.includes(t.state))
      .map((t) => t.assignee_squad_id as string),
  );
  if (liveSquads.size === 0) return {};

  const bySquad: Record<string, string[]> = {};
  for (const id of Object.keys(office.deskOf)) {
    const squad = office.agentOf[id]?.squad_id;
    if (!squad || !liveSquads.has(squad)) continue;
    bySquad[squad] = [...(bySquad[squad] ?? []), id];
  }

  const anchors: Record<string, string> = {};
  for (const ids of Object.values(bySquad)) {
    if (ids.length < 2) continue;
    const senior = [...ids].sort(
      (a, b) => (office.agentOf[b].grade ?? 0) - (office.agentOf[a].grade ?? 0) || a.localeCompare(b),
    )[0];
    for (const id of ids) {
      if (id !== senior) anchors[id] = senior;
    }
  }
  return anchors;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

export function computeTargets(input: TargetInput): Record<string, Target> {
  const { office, activities, tasks, now, idleSince, arriving } = input;
  const breakAfter = input.breakAfterMs ?? 16_000;

  const out: Record<string, Target> = {};
  const shared: Record<string, string[]> = {};
  const pairWith = pairAnchor(office, tasks);

  for (const agentId of Object.keys(office.deskOf)) {
    const home = office.roomOf[agentId];
    const desk = office.deskOf[agentId];
    const act: Activity | undefined = activities[agentId];

    if (arriving.has(agentId)) {
      out[agentId] = { agentId, roomId: home, point: desk, reason: 'just hired — walking to their desk' };
      continue;
    }

    if (act?.where === 'orchestrator') {
      const seat = office.rooms.find((r) => r.kind === 'orchestrator')?.id;
      out[agentId] = {
        agentId,
        roomId: seat ?? home,
        point: seat ? anchorOf(office, seat) : desk,
        reason: act.note,
      };
      continue;
    }

    if (act?.where === 'commons') {
      out[agentId] = { agentId, roomId: '__commons', point: office.reviewTable, reason: act.note };
      shared.__commons = [...(shared.__commons ?? []), agentId];
      continue;
    }

    // Someone was asked a question: walk over and ask it in person. Grounded in
    // the harness's own `ask_colleague` call, which names its recipient.
    if (act?.where === 'peer' && act.peerName) {
      const peerId = resolvePeer(office, agentId, act.peerName);
      const peerPoint = peerId ? office.deskOf[peerId] : undefined;
      if (peerId && peerPoint) {
        out[agentId] = {
          agentId,
          roomId: office.roomOf[peerId] ?? home,
          point: beside(peerPoint, desk),
          reason: act.note,
          faceTowards: peerPoint,
        };
        continue;
      }
      // An unrecognised name must not invent a colleague to visit.
    }

    // Two people on one task work side by side: the junior joins the senior.
    const anchor = pairWith[agentId];
    if (anchor && (act?.kind === 'typing' || act?.kind === 'tool')) {
      const anchorDesk = office.deskOf[anchor];
      if (anchorDesk) {
        const squad = office.agentOf[anchor]?.squad_id;
        const squadTask = tasks.find(
          (t) => t.assignee_squad_id === squad && PAIRABLE.includes(t.state),
        );
        out[agentId] = {
          agentId,
          roomId: office.roomOf[anchor] ?? home,
          point: beside(anchorDesk, desk),
          reason: `pairing with ${office.agentOf[anchor]?.name ?? 'a colleague'} on: ${
            squadTask?.title ?? 'shared squad work'
          }`,
          faceTowards: anchorDesk,
        };
        continue;
      }
    }

    if (act?.kind === 'idle') {
      const since = idleSince.get(agentId);
      const waited = since === undefined ? 0 : now - since;
      // Stagger the coffee run so the floor does not move as one.
      const threshold = breakAfter + (hash(agentId) % 20_000);
      if (since !== undefined && waited > threshold) {
        out[agentId] = {
          agentId,
          roomId: '__break',
          point: office.breakSpot,
          reason: 'idle — at the break corner',
        };
        shared.__break = [...(shared.__break ?? []), agentId];
        continue;
      }
      out[agentId] = {
        agentId,
        roomId: home,
        point: desk,
        reason: act.note,
        faceTowards: { x: desk.x, y: desk.y - 30 },
      };
      continue;
    }

    // Working on someone else's task: go and stand in that department.
    const task = currentTaskFor(agentId, tasks);
    const visit = task?.department_id;
    if (visit && visit !== home && office.rooms.some((r) => r.id === visit)) {
      const room = office.rooms.find((r) => r.id === visit)!;
      out[agentId] = {
        agentId,
        roomId: visit,
        point: { x: room.x + room.w / 2, y: room.y + room.h - 30 },
        reason: `visiting ${room.name}: ${task?.title ?? 'cross-department task'}`,
      };
      shared[visit] = [...(shared[visit] ?? []), agentId];
      continue;
    }

    out[agentId] = {
      agentId,
      roomId: home,
      point: desk,
      reason: act?.note ?? 'at their desk',
      // Sitting at your desk means looking at it. Without this the character
      // keeps whatever way they were last walking and stares at the wall.
      faceTowards: { x: desk.x, y: desk.y - 30 },
    };
  }

  // Spread agents that share a spot onto a ring around it, turned inward so a
  // group reads as people talking rather than as strangers queuing.
  for (const [roomId, ids] of Object.entries(shared)) {
    if (ids.length < 2) continue;
    const sorted = [...ids].sort();
    const centre = out[sorted[0]].point;
    sorted.forEach((id, i) => {
      const angle = (i / sorted.length) * Math.PI * 2;
      out[id] = {
        ...out[id],
        roomId,
        point: {
          x: centre.x + Math.cos(angle) * RING_RADIUS,
          y: centre.y + Math.sin(angle) * RING_RADIUS * 0.62,
        },
        faceTowards: centre,
      };
    });
  }

  return out;
}

/** Desks are wide; keep the ring from pushing anyone into a wall. */
export function targetIsInsideRoom(office: Office, t: Target): boolean {
  const room = office.rooms.find((r) => r.id === t.roomId);
  if (!room) return false;
  const slack = DESK_W / 3;
  return (
    t.point.x >= room.x - slack &&
    t.point.x <= room.x + room.w + slack &&
    t.point.y >= room.y - slack &&
    t.point.y <= room.y + room.h + slack
  );
}
