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
import { DESK_W, breakSeats, isResearchTask, meetingLayout, type Office } from './floorplan';
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
  /**
   * True when the character is sitting, at their own desk, or on a chair in the
   * break corner. The renderer only ever seats people at their own workstation:
   * visiting somebody does not mean taking their chair.
   */
  seated?: boolean;
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
  /**
   * The council in session, if any. Its panel is IN A MEETING, and that outranks
   * everything else a member might be doing, it is what is actually happening to
   * them (docs/02 §4).
   */
  meeting?: { id: string; question: string; members: readonly string[] } | null;
}

const RING_RADIUS = 52;

/** Task states where two people on one task should visibly work together. */
const PAIRABLE: TaskState[] = ['assigned', 'running', 'ready', 'verifying'];

/**
 * Stand beside someone rather than on top of them, and on the side you are
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

  // A report goes to the reporter's own manager, the org tree's `manager_id`,
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
  const { office, activities, tasks, now, idleSince, arriving, meeting } = input;
  const breakAfter = input.breakAfterMs ?? 16_000;
  const meetingRoom = office.rooms.find((r) => r.kind === 'meeting');

  const out: Record<string, Target> = {};
  const shared: Record<string, string[]> = {};
  const pairWith = pairAnchor(office, tasks);

  for (const agentId of Object.keys(office.deskOf)) {
    const home = office.roomOf[agentId];
    const desk = office.deskOf[agentId];
    const act: Activity | undefined = activities[agentId];

    // A council outranks everything else a member might be doing: they are in a
    // meeting, and showing that is the floor's whole job for them right now.
    if (meeting && meetingRoom && meeting.members.includes(agentId)) {
      const seats = meetingLayout(meetingRoom).seats;
      const seat = seats[meeting.members.indexOf(agentId) % seats.length];
      out[agentId] = {
        agentId,
        roomId: meetingRoom.id,
        point: { x: seat.x, y: seat.y },
        reason: `in council: ${meeting.question}`,
        faceTowards: seat.face,
        seated: true,
      };
      continue;
    }

    if (arriving.has(agentId)) {
      out[agentId] = { agentId, roomId: home, point: desk, reason: 'just hired, walking to their desk' };
      continue;
    }

    if (act?.where === 'orchestrator') {
      const seat = office.rooms.find((r) => r.kind === 'orchestrator')?.id;
      const seatPoint = seat ? anchorOf(office, seat) : desk;
      out[agentId] = {
        agentId,
        roomId: seat ?? home,
        // Stand beside the boss and face them, never on top of them.
        point: seat ? beside(seatPoint, desk) : desk,
        reason: act.note,
        faceTowards: seatPoint,
      };
      // Several people can be waiting on the boss at once. Put them through the
      // same ring the shared destinations use, or they stand inside each other.
      if (seat) shared[seat] = [...(shared[seat] ?? []), agentId];
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
          reason: 'idle, at the break corner',
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
        seated: true,
      };
      continue;
    }

    // R&D work is done at the lab bench, not at a desk. Grounded in the task's
    // own title, which is a word the organization actually used.
    if (office.labRoomId) {
      const research = currentTaskFor(agentId, tasks);
      if (research && isResearchTask(research.title) && research.state !== 'completed') {
        out[agentId] = {
          agentId,
          roomId: office.labRoomId,
          point: office.labBench,
          reason: `in the lab: ${research.title}`,
          faceTowards: { x: office.labBench.x, y: office.labBench.y - 26 },
        };
        shared[office.labRoomId] = [...(shared[office.labRoomId] ?? []), agentId];
        continue;
      }
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
      seated: true,
    };
  }

  // The break corner: seat them at the round tables, round-robin over the chairs
  // in sorted order. Deterministic, collision-free, and two people who land at
  // one table end up facing each other across it.
  const breakers = shared.__break;
  if (breakers && breakers.length > 0) {
    const seats = breakSeats(office.breakTables);
    if (seats.length > 0) {
      const sorted = [...breakers].sort();
      const byTable: Record<number, string[]> = {};
      const standing: string[] = [];
      sorted.forEach((id, i) => {
        // More people than chairs: the extras stay on their feet, and the
        // foosball table and the vending machine take them.
        const seat = seats[i];
        if (!seat) {
          standing.push(id);
          return;
        }
        byTable[seat.table] = [...(byTable[seat.table] ?? []), id];
        out[id] = {
          ...out[id],
          roomId: '__break',
          point: seat.point,
          faceTowards: seat.faceTowards,
          seated: true,
        };
      });
      // Sharing a table is a fact the floor can state: say who is sitting
      // together, and never invent what they said.
      for (const ids of Object.values(byTable)) {
        if (ids.length < 2) continue;
        for (const id of ids) {
          const others = ids
            .filter((other) => other !== id)
            .map((other) => office.agentOf[other]?.name ?? 'someone');
          out[id].reason = `on a break with ${others.join(' & ')}`;
        }
      }
      const layout = office.breakLayout;
      const rest = [...standing];
      const nameOf = (id: string) => office.agentOf[id]?.name ?? 'someone';

      // Two can take the foosball table, one at each end, facing across it.
      const players = rest.splice(0, layout.foosballEnds.length);
      players.forEach((id, i) => {
        out[id] = {
          ...out[id],
          roomId: '__break',
          point: layout.foosballEnds[i],
          faceTowards: {
            x: (layout.foosballEnds[0].x + layout.foosballEnds[1].x) / 2,
            y: (layout.foosballEnds[0].y + layout.foosballEnds[1].y) / 2,
          },
          reason: 'at the foosball table',
        };
      });
      if (players.length === 2) {
        out[players[0]].reason = `playing foosball with ${nameOf(players[1])}`;
        out[players[1]].reason = `playing foosball with ${nameOf(players[0])}`;
      }

      // Then a short queue at the vending machine, because it is free.
      const queue = rest.splice(0, layout.vendingQueue.length);
      queue.forEach((id, i) => {
        out[id] = {
          ...out[id],
          roomId: '__break',
          point: layout.vendingQueue[i],
          faceTowards: { x: layout.vending.x + layout.vending.w / 2, y: layout.vending.y + layout.vending.d },
          reason: i === 0 ? 'at the vending machine' : 'queuing for the vending machine',
        };
      });

      // Anybody left over stands by the counter: let the shared-spot ring spread
      // them out instead of piling them on one point.
      if (rest.length > 0) shared.__break = rest;
      else delete shared.__break;
    } else {
      delete shared.__break;
    }
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

/**
 * Is the machine at a desk being worked at, right now?
 *
 * This used to be asked of `activity` alone, `typing` or `tool`, which is the
 * wrong question: activity says what somebody is doing, never where they are. A
 * researcher with a live task works at the lab bench; the junior of a squad pair
 * works at the senior's desk; somebody on another department's task stands in
 * that department. In each case the desk at home lit up with an empty chair,
 * which reads as a machine running by itself, and where the person actually was
 * had no screen at all. Tying the screen to sitting at its own desk makes the
 * screen and the body the same fact, so they cannot disagree.
 */
export function deskInUse(
  target: Target | undefined,
  act: Activity | undefined,
  homeRoomId: string | undefined,
  moving = false,
): boolean {
  if (moving) return false;
  if (!target?.seated || !act || !homeRoomId) return false;
  if (target.roomId !== homeRoomId) return false;
  return act.kind === 'typing' || act.kind === 'tool';
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
