/**
 * Scene projection (pure), the seam between the domain and any renderer.
 *
 * `Office` is the *static* floor (rooms, desks, doors, corridors) and only
 * changes when the organization changes. `SceneState` is the *dynamic* frame
 * (who is where, doing what) and is rebuilt every tick. Two payloads, two
 * cadences.
 *
 * Nothing here imports React or three.js, on purpose: the same projector is
 * meant to run in a cloud scene worker and stream `SceneState` to clients, while
 * the renderer stays a dumb consumer. See docs/13.
 */
import type { Task } from '../api/types';
import type { Activity, ActivityKind } from './activity';
import { currentTaskFor } from './activity';
import type { Office } from './floorplan';
import type { Point } from './geometry';
import type { Target } from './targets';

/** Bump when the shape below changes in a way a client must know about. */
export const SCENE_CONTRACT = 1;

export interface SceneAgent {
  id: string;
  name: string;
  role: string;
  grade?: number;
  state?: string;
  /** Pose + bubble the character shows. */
  activity: ActivityKind;
  bubble?: string;
  /** Sentence for tooltips and the workstation header. */
  note: string;
  /** Where they are heading, and what that room is called. */
  intent: { roomId: string; roomName: string; point: Point };
  /** The room they are coming from, for route building. */
  fromRoomId: string;
  /** Their own desk, so a renderer can show a reserved seat. */
  desk: Point;
  homeRoomId: string;
  /** The task they currently hold, if any. */
  taskTitle?: string;
  taskId?: string;
}

export interface SceneStats {
  seats: number;
  working: number;
  thinking: number;
  attention: number;
  walking: number;
}

export interface SceneState {
  version: number;
  projectId: string;
  builtAt: number;
  agents: SceneAgent[];
  stats: SceneStats;
}

export interface ProjectSceneInput {
  projectId: string;
  office: Office;
  activities: Record<string, Activity>;
  targets: Record<string, Target>;
  tasks: Task[];
  now: number;
}

/** Map a room id to its display name without leaking the whole room object. */
function roomName(office: Office, roomId: string | undefined): string {
  if (!roomId) return 'unknown';
  return office.rooms.find((r) => r.id === roomId)?.name ?? roomId;
}

const ACTIVE: ActivityKind[] = ['typing', 'tool', 'talking', 'walking'];

export function emptyScene(projectId: string, now: number): SceneState {
  return {
    version: SCENE_CONTRACT,
    projectId,
    builtAt: now,
    agents: [],
    stats: { seats: 0, working: 0, thinking: 0, attention: 0, walking: 0 },
  };
}

/**
 * Build the dynamic frame. Deterministic for a given input, so a replay of the
 * same events produces byte-identical scenes (docs/07 §5).
 */
export function projectScene(input: ProjectSceneInput): SceneState {
  const { projectId, office, activities, targets, tasks, now } = input;
  const agents: SceneAgent[] = [];

  const stats: SceneStats = { seats: 0, working: 0, thinking: 0, attention: 0, walking: 0 };

  for (const agentId of Object.keys(office.deskOf).sort()) {
    const agent = office.agentOf[agentId];
    const activity = activities[agentId];
    if (!agent || !activity) continue;

    const target = targets[agentId];
    const homeRoomId = office.roomOf[agentId] ?? '';
    const task = currentTaskFor(agentId, tasks);

    const intent = {
      roomId: target?.roomId ?? homeRoomId,
      roomName: roomName(office, target?.roomId ?? homeRoomId),
      point: target?.point ?? office.deskOf[agentId],
    };

    agents.push({
      id: agentId,
      name: agent.name,
      role: agent.role ?? 'agent',
      grade: agent.grade,
      state: agent.state,
      activity: activity.kind,
      bubble: activity.bubble,
      note: target?.reason ?? activity.note,
      intent,
      fromRoomId: homeRoomId,
      desk: office.deskOf[agentId],
      homeRoomId,
      taskTitle: task?.title,
      taskId: task?.id,
    });

    stats.seats += 1;
    if (ACTIVE.includes(activity.kind)) stats.working += 1;
    if (activity.kind === 'thinking') stats.thinking += 1;
    if (activity.kind === 'blocked' || activity.kind === 'waiting') stats.attention += 1;
    if (activity.kind === 'walking') stats.walking += 1;
  }

  return { version: SCENE_CONTRACT, projectId, builtAt: now, agents, stats };
}
