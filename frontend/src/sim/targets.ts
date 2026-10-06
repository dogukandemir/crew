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
import type { Task } from '../api/types';
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
      out[agentId] = { agentId, roomId: home, point: desk, reason: act.note };
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

    out[agentId] = { agentId, roomId: home, point: desk, reason: act?.note ?? 'at their desk' };
  }

  // Spread agents that share a spot onto a ring around it.
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
