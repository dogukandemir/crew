/**
 * Poses (pure) — what a body does for each activity.
 *
 * Kept free of three.js so the interesting part is unit-testable: that every
 * activity has a pose, that desk work is seated, that walking is upright, and
 * that blending between poses is safe. The rig just applies these numbers.
 *
 * Angles are radians. Sign conventions, from the rig's point of view:
 *   hipPitch    > 0  leans the torso forward
 *   shoulder.x  < 0  swings the arm forward   (0 = hanging at the side)
 *   shoulder.z  > 0  lifts the arm away from the body (left) / towards (right)
 *   hip         < 0  swings the thigh forward
 *   knee        > 0  bends the knee
 */
import type { ActivityKind } from '../../sim/activity';

export interface Pose {
  /** Hip height in metres — drops when seated. */
  hipY: number;
  hipPitch: number;
  headPitch: number;
  headYaw: number;
  armL: readonly [number, number, number];
  elbowL: number;
  armR: readonly [number, number, number];
  elbowR: number;
  hipL: number;
  kneeL: number;
  hipR: number;
  kneeR: number;
  /** 0..1 hand oscillation, for typing. */
  typing: number;
  /** 0..1 arm gesture, for talking. */
  gesture: number;
  /** 0..1 walk cycle. */
  walk: number;
  /** Extra vertical bob in metres. */
  bob: number;
  /** True when the body is seated, so the chair can be placed under it. */
  seated: boolean;
}

const HIP_STAND = 0.94;
const HIP_SIT = 0.5;
const THIGH_FWD = -Math.PI / 2; // thigh horizontal, pointing forward
const KNEE_BENT = Math.PI / 2; // shin vertical again, foot on the floor

/** Seated at a desk, knees under the table. */
function seated(over: Partial<Pose> = {}): Pose {
  return {
    hipY: HIP_SIT,
    hipPitch: 0.1,
    headPitch: 0.18,
    headYaw: 0,
    armL: [-0.95, 0.18, 0],
    elbowL: 0.85,
    armR: [-0.95, -0.18, 0],
    elbowR: 0.85,
    hipL: THIGH_FWD,
    kneeL: KNEE_BENT,
    hipR: THIGH_FWD,
    kneeR: KNEE_BENT,
    typing: 0,
    gesture: 0,
    walk: 0,
    bob: 0,
    seated: true,
    ...over,
  };
}

/** Upright on both feet. */
function standing(over: Partial<Pose> = {}): Pose {
  return {
    hipY: HIP_STAND,
    hipPitch: 0,
    headPitch: 0,
    headYaw: 0,
    armL: [0, 0.06, 0],
    elbowL: 0.12,
    armR: [0, -0.06, 0],
    elbowR: 0.12,
    hipL: 0,
    kneeL: 0,
    hipR: 0,
    kneeR: 0,
    typing: 0,
    gesture: 0,
    walk: 0,
    bob: 0,
    seated: false,
    ...over,
  };
}

export const POSES: Record<ActivityKind, Pose> = {
  // Working at the machine.
  typing: seated({ typing: 1, headPitch: 0.16 }),
  // Reaching for something — a build, a device, a file.
  tool: seated({
    typing: 0.35,
    hipPitch: 0.15,
    armR: [-1.35, -0.14, 0],
    elbowR: 0.55,
    headPitch: 0.22,
  }),
  // Hand to the chin, leaning back a little.
  thinking: seated({
    hipPitch: -0.06,
    headPitch: 0.06,
    armR: [-1.55, -0.22, 0],
    elbowR: 1.75,
    armL: [-0.55, 0.2, 0],
    elbowL: 0.9,
  }),
  // Talking to someone.
  talking: standing({
    gesture: 1,
    armL: [-0.75, 0.3, 0],
    elbowL: 1.1,
    armR: [-0.7, -0.3, 0],
    elbowR: 1.0,
  }),
  // On the move.
  walking: standing({ walk: 1 }),
  // Blocked on someone else — hands off the desk, waiting.
  waiting: seated({ armL: [-0.7, 0.24, 0], elbowL: 0.7, armR: [-0.7, -0.24, 0], elbowR: 0.7, headPitch: 0.1 }),
  // Something is wrong: leaning back off the desk, palms up.
  blocked: seated({
    hipPitch: -0.14,
    headPitch: -0.06,
    armL: [-0.5, 0.42, 0],
    elbowL: 1.25,
    armR: [-0.5, -0.42, 0],
    elbowR: 1.25,
    typing: 0,
  }),
  // Arms up.
  celebrating: standing({
    armL: [-2.5, 0.35, 0],
    elbowL: 0.35,
    armR: [-2.5, -0.35, 0],
    elbowR: 0.35,
    headPitch: -0.2,
    bob: 0.02,
  }),
  // At rest, breathing.
  idle: seated({ armL: [-0.62, 0.2, 0], elbowL: 0.75, armR: [-0.62, -0.2, 0], elbowR: 0.75, headPitch: 0.05 }),
  // Away from the desk: still in the room, but not working.
  offline: seated({
    hipPitch: -0.1,
    headPitch: 0.3,
    armL: [0.12, 0.12, 0],
    elbowL: 0.5,
    armR: [0.12, -0.12, 0],
    elbowR: 0.5,
  }),
};

export function poseFor(activity: ActivityKind): Pose {
  return POSES[activity] ?? POSES.idle;
}

type NumericPoseKey =
  | 'hipY'
  | 'hipPitch'
  | 'headPitch'
  | 'headYaw'
  | 'elbowL'
  | 'elbowR'
  | 'hipL'
  | 'kneeL'
  | 'hipR'
  | 'kneeR'
  | 'typing'
  | 'gesture'
  | 'walk'
  | 'bob';

const FIELDS: NumericPoseKey[] = [
  'hipY',
  'hipPitch',
  'headPitch',
  'headYaw',
  'elbowL',
  'elbowR',
  'hipL',
  'kneeL',
  'hipR',
  'kneeR',
  'typing',
  'gesture',
  'walk',
  'bob',
];

const clamp01 = (t: number) => Math.max(0, Math.min(1, t));

/** Smoothstep so posture changes ease instead of snapping. */
export function ease(t: number): number {
  const k = clamp01(t);
  return k * k * (3 - 2 * k);
}

/**
 * Blend two poses. All numeric fields interpolate; `seated` flips at the
 * halfway point so the rig never sits *and* stands at the same time.
 */
export function blendPose(from: Pose, to: Pose, t: number): Pose {
  const k = ease(t);
  const out: Pose = { ...to };
  for (const f of FIELDS) {
    out[f] = from[f] + (to[f] - from[f]) * k;
  }
  const armL: [number, number, number] = [0, 0, 0];
  const armR: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; i += 1) {
    armL[i] = from.armL[i] + (to.armL[i] - from.armL[i]) * k;
    armR[i] = from.armR[i] + (to.armR[i] - from.armR[i]) * k;
  }
  out.armL = armL;
  out.armR = armR;
  out.seated = k >= 0.5 ? to.seated : from.seated;
  return out;
}

/**
 * Somewhere to stand that is not the desk — used when the simulation says an
 * agent is not at their own seat, so the rig stands instead of sitting in
 * mid-air on the corridor carpet.
 */
export function poseForContext(activity: ActivityKind, atDesk: boolean): Pose {
  if (atDesk) return poseFor(activity);
  switch (activity) {
    case 'walking':
      return poseFor('walking');
    case 'typing':
    case 'tool':
      // Working somewhere else: a laptop on the shared table, standing.
      return standing({ hipPitch: 0.12, armL: [-1.15, 0.2, 0], elbowL: 0.9, armR: [-1.15, -0.2, 0], elbowR: 0.9, typing: 1 });
    case 'blocked':
      return standing({ armL: [-0.5, 0.4, 0], elbowL: 1.2, armR: [-0.5, -0.4, 0], elbowR: 1.2, hipPitch: -0.08 });
    case 'waiting':
      return standing({ armL: [-0.1, 0.16, 0], elbowL: 0.25, armR: [-0.1, -0.16, 0], elbowR: 0.25 });
    case 'offline':
      return standing({ hipPitch: -0.08, headPitch: 0.24 });
    default:
      return poseFor(activity);
  }
}

// ── Per-frame animation offsets ─────────────────────────────────────────────

export interface MotionOffset {
  hipY: number;
  hipPitch: number;
  armL: readonly [number, number, number];
  armR: readonly [number, number, number];
  elbowL: number;
  elbowR: number;
  hipL: number;
  hipR: number;
  kneeL: number;
  kneeR: number;
  yaw: number;
}

/**
 * The animation layer on top of a pose: a walk cycle, typing hands, talking
 * gestures, breathing. Pure maths — `phase` is time in seconds.
 */
export function motionOffset(pose: Pose, phase: number): MotionOffset {
  const walk = pose.walk;
  const gesture = pose.gesture;
  const typing = pose.typing;

  // Walk cycle: legs in antiphase, arms counter-swinging, a slight bob.
  const swing = Math.sin(phase);
  const swingOpp = Math.sin(phase + Math.PI);
  const legSwing = swing * 0.5;

  // Typing: small, fast, and out of phase between the hands.
  const typePhase = phase * 9;
  const typeL = Math.sin(typePhase) * 0.09 * typing;
  const typeR = Math.sin(typePhase + 1.7) * 0.09 * typing;

  // Talking: slow gestures, with the shoulders joining in a little.
  const talk = Math.sin(phase * 2.1) * gesture;
  const talkL = Math.sin(phase * 2.1 + 0.6) * gesture;

  const breathe = Math.sin(phase * 1.4) * 0.012 * (1 - walk);

  // Each arm swings opposite the leg on the same side.
  const ARM_SWING = 0.38;

  return {
    hipY: Math.abs(Math.sin(phase * 2)) * 0.022 * walk + breathe,
    hipPitch: walk * 0.06 - breathe * 0.5,
    armL: [swingOpp * ARM_SWING * walk + talkL * 0.25 + typeL * 0.6, talkL * 0.22, 0],
    armR: [swing * ARM_SWING * walk + talk * 0.25 + typeR * 0.6, -talk * 0.22, 0],
    elbowL: typeL * 0.5 + talkL * 0.18,
    elbowR: typeR * 0.5 + talk * 0.18,
    hipL: legSwing * walk,
    hipR: swingOpp * 0.5 * walk,
    // Knees only bend on the back-swing, which is what stops the legs looking
    // like scissors.
    kneeL: Math.max(0, swingOpp) * 0.75 * walk,
    kneeR: Math.max(0, swing) * 0.75 * walk,
    yaw: Math.sin(phase) * 0.05 * walk,
  };
}
