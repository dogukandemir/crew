/**
 * What each department is doing right now (pure).
 *
 * A room is not just a box on the floor: it produces things, it can be blocked,
 * and it can be brand new. Everything here is counted from the agents the org
 * actually seated in that room and from the event log — so a sign that says a
 * department is producing is reporting a fact, and a sign that says it shipped
 * three things is counting three real `task.completed` events.
 */
import type { EventRow } from '../api/types';
import type { Activity } from './activity';
import type { Office } from './floorplan';

/** How long a finished task still counts as "just shipped". */
export const OUTPUT_WINDOW_MS = 20 * 60_000;
/** How long an agent's latest deliverable stays pinned above their desk. */
export const CV_WINDOW_MS = 6 * 60 * 60_000;
/** How long a newly opened department is flagged as new. */
export const NEW_DEPT_WINDOW_MS = 4 * 60_000;

export interface RoomPulse {
  seats: number;
  working: number;
  blocked: number;
  idle: number;
  /** Producing output this second: typing or running a tool. */
  producing: number;
  /** Deliverables completed inside the output window. */
  shipped: number;
  /** The newest deliverable in this room, with when it landed. */
  lastOutput?: { title: string; at: number };
  /** The log says this department was opened recently. */
  brandNew: boolean;
}

export interface Output {
  title: string;
  at: number;
}

export interface FloorPulse {
  rooms: Record<string, RoomPulse>;
  /** Agent id → their latest deliverable. */
  outputs: Record<string, Output>;
}

const ACTIVE: Activity['kind'][] = ['typing', 'tool', 'talking', 'walking'];

function tsOf(event: EventRow): number {
  const ts = Date.parse(event.ts);
  return Number.isNaN(ts) ? -Infinity : ts;
}

export function floorPulse({
  office,
  activities,
  events,
  now,
  showArchived = false,
}: {
  office: Office;
  activities: Record<string, Activity>;
  events: EventRow[];
  now: number;
  showArchived?: boolean;
}): FloorPulse {
  const rooms: Record<string, RoomPulse> = {};
  for (const room of office.rooms) {
    rooms[room.id] = {
      seats: room.desks.length,
      working: 0,
      blocked: 0,
      idle: 0,
      producing: 0,
      shipped: 0,
      brandNew: false,
    };
  }

  // Latest deliverable per agent, from real completions.
  const outputs: Record<string, Output> = {};
  const shippedByRoom: Record<string, Output[]> = {};
  for (const event of events) {
    if (event.type !== 'task.completed') continue;
    const agentId = event.agent_id;
    if (!agentId) continue;
    const at = tsOf(event);
    if (at < 0 || now - at > CV_WINDOW_MS || at > now) continue;
    const title = event.title || 'a task';
    if (!outputs[agentId] || outputs[agentId].at < at) outputs[agentId] = { title, at };

    const roomId = office.roomOf[agentId];
    if (!roomId || !rooms[roomId]) continue;
    if (now - at > OUTPUT_WINDOW_MS) continue;
    shippedByRoom[roomId] = [...(shippedByRoom[roomId] ?? []), { title, at }];
  }

  for (const [roomId, list] of Object.entries(shippedByRoom)) {
    const newest = list.reduce((a, b) => (b.at > a.at ? b : a));
    rooms[roomId].shipped = list.length;
    rooms[roomId].lastOutput = newest;
  }

  // Who is where, and what are they doing.
  for (const [agentId, activity] of Object.entries(activities)) {
    const roomId = office.roomOf[agentId];
    const pulse = roomId ? rooms[roomId] : undefined;
    if (!pulse) continue;
    const state = office.agentOf[agentId]?.state;
    if (!showArchived && (state === 'archived' || state === 'suspended')) continue;
    if (activity.kind === 'blocked' || activity.kind === 'waiting') pulse.blocked += 1;
    else if (ACTIVE.includes(activity.kind)) pulse.working += 1;
    else pulse.idle += 1;
    if (activity.kind === 'typing' || activity.kind === 'tool') pulse.producing += 1;
  }

  // A department the log says was opened just now.
  for (const event of events) {
    if (event.type !== 'org.department.created') continue;
    const at = tsOf(event);
    if (at < 0 || now - at > NEW_DEPT_WINDOW_MS || at > now) continue;
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const id =
      (typeof payload.department_id === 'string' && payload.department_id) ||
      (typeof payload.id === 'string' && payload.id) ||
      undefined;
    const name = typeof payload.name === 'string' ? payload.name : event.title;
    for (const room of office.rooms) {
      const matches = id ? room.id === id : !!name && room.name === name;
      if (matches) rooms[room.id].brandNew = true;
    }
  }

  return { rooms, outputs };
}
