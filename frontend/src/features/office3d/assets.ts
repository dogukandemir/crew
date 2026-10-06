/**
 * Shared geometry and materials for the 3D office.
 *
 * Two rules keep this cheap enough to put twenty-odd animated characters on
 * screen: every character reuses the *same* geometry objects, and materials are
 * cached by colour so a hundred garments collapse into a couple of dozen
 * materials. Without either, each character would allocate its own GPU buffers
 * and the floor would stutter.
 *
 * All sizes are in metres, modelled on a real body (~1.7 m) standing next to a
 * real desk (1.45 m × 0.74 m), so proportions read true at a glance.
 */
import * as THREE from 'three';

// ── Body ────────────────────────────────────────────────────────────────────
export const BODY = {
  headR: 0.115,
  neckH: 0.08,
  torsoR: 0.145,
  torsoL: 0.28,
  pelvisW: 0.30,
  pelvisH: 0.20,
  pelvisD: 0.19,
  upperArmR: 0.048,
  upperArmL: 0.21,
  forearmR: 0.042,
  forearmL: 0.18,
  handR: 0.052,
  thighR: 0.075,
  thighL: 0.29,
  shinR: 0.058,
  shinL: 0.32,
  footW: 0.095,
  footH: 0.055,
  footL: 0.21,
  shoulderSep: 0.175,
  hipSep: 0.085,
  /**
   * Height of the pelvis centre, which is also the hip joint the legs rotate
   * about. Chosen so the sole lands on the floor in both poses: thigh + shin is
   * 0.876 m, so standing at 0.94 leaves the ankle 0.064 up and the sole on the
   * ground, and seated at 0.50 does the same with the shin hanging down.
   */
  hipStanding: 0.94,
  hipSeated: 0.5,
  /** Top of the chair seat, just under a seated pelvis. */
  seatHeight: 0.47,
} as const;

/** Derived joint offsets so the rig and the pose table agree. */
export const JOINT = {
  shoulderY: 0.44, // from the hip pivot up to the shoulder
  headY: 0.52, // from the hip pivot up to the base of the neck
  legLen: BODY.thighL + BODY.thighR * 2 + BODY.shinL + BODY.shinR * 2,
} as const;

function geo<T extends THREE.BufferGeometry>(g: T): T {
  return g;
}

export const GEOM = {
  /** A one-metre cube, scaled per use — walls, slabs, rims. */
  unit: geo(new THREE.BoxGeometry(1, 1, 1)),
  head: geo(new THREE.SphereGeometry(BODY.headR, 20, 16)),
  neck: geo(new THREE.CylinderGeometry(0.048, 0.052, BODY.neckH, 12)),
  torso: geo(new THREE.CapsuleGeometry(BODY.torsoR, BODY.torsoL, 6, 14)),
  pelvis: geo(new THREE.BoxGeometry(BODY.pelvisW, BODY.pelvisH, BODY.pelvisD)),
  upperArm: geo(new THREE.CapsuleGeometry(BODY.upperArmR, BODY.upperArmL, 4, 10)),
  forearm: geo(new THREE.CapsuleGeometry(BODY.forearmR, BODY.forearmL, 4, 10)),
  hand: geo(new THREE.SphereGeometry(BODY.handR, 10, 8)),
  thigh: geo(new THREE.CapsuleGeometry(BODY.thighR, BODY.thighL, 4, 10)),
  shin: geo(new THREE.CapsuleGeometry(BODY.shinR, BODY.shinL, 4, 10)),
  foot: geo(new THREE.BoxGeometry(BODY.footW, BODY.footH, BODY.footL)),
  skirt: geo(new THREE.CylinderGeometry(0.20, 0.28, 0.32, 16, 1, true)),

  // Face
  eye: geo(new THREE.SphereGeometry(0.017, 8, 6)),
  brow: geo(new THREE.BoxGeometry(0.038, 0.008, 0.006)),

  // Hair pieces
  hairCap: geo(new THREE.SphereGeometry(BODY.headR * 1.06, 18, 12)),
  bun: geo(new THREE.SphereGeometry(0.05, 10, 8)),
  ponytail: geo(new THREE.CapsuleGeometry(0.034, 0.16, 4, 8)),
  longHair: geo(new THREE.CapsuleGeometry(0.075, 0.16, 4, 12)),

  // Accessories
  glassesFrame: geo(new THREE.BoxGeometry(0.20, 0.011, 0.01)),
  lens: geo(new THREE.BoxGeometry(0.052, 0.042, 0.006)),
  capTop: geo(new THREE.SphereGeometry(BODY.headR * 1.08, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2)),
  capBrim: geo(new THREE.BoxGeometry(0.19, 0.012, 0.10)),
  headsetBand: geo(new THREE.TorusGeometry(BODY.headR * 1.1, 0.008, 6, 16, Math.PI)),
  headsetCup: geo(new THREE.BoxGeometry(0.03, 0.045, 0.03)),
  badge: geo(new THREE.BoxGeometry(0.05, 0.07, 0.006)),
  lanyard: geo(new THREE.CylinderGeometry(0.004, 0.004, 0.2, 5)),

  // Furniture / props
  deskTop: geo(new THREE.BoxGeometry(1.45, 0.045, 1.05)),
  deskLeg: geo(new THREE.BoxGeometry(0.05, 0.72, 0.05)),
  chairSeat: geo(new THREE.BoxGeometry(0.46, 0.06, 0.44)),
  chairBack: geo(new THREE.BoxGeometry(0.42, 0.44, 0.06)),
  chairPost: geo(new THREE.CylinderGeometry(0.028, 0.028, 0.34, 8)),
  chairBase: geo(new THREE.CylinderGeometry(0.27, 0.30, 0.05, 12)),
  monitor: geo(new THREE.BoxGeometry(0.52, 0.31, 0.03)),
  monitorFoot: geo(new THREE.CylinderGeometry(0.08, 0.10, 0.02, 10)),
  monitorArm: geo(new THREE.BoxGeometry(0.04, 0.20, 0.04)),
  keyboard: geo(new THREE.BoxGeometry(0.36, 0.015, 0.13)),
  mug: geo(new THREE.CylinderGeometry(0.038, 0.032, 0.09, 10)),
  papers: geo(new THREE.BoxGeometry(0.21, 0.008, 0.29)),
  laptop: geo(new THREE.BoxGeometry(0.32, 0.02, 0.22)),
  laptopLid: geo(new THREE.BoxGeometry(0.32, 0.22, 0.015)),
  whiteboard: geo(new THREE.BoxGeometry(2.2, 1.2, 0.05)),
  tableTop: geo(new THREE.BoxGeometry(2.6, 0.06, 1.2)),
  plantPot: geo(new THREE.CylinderGeometry(0.16, 0.12, 0.26, 10)),
  plantLeaf: geo(new THREE.SphereGeometry(0.26, 10, 8)),
  counter: geo(new THREE.BoxGeometry(2.4, 0.06, 0.6)),
  coffeeMachine: geo(new THREE.BoxGeometry(0.34, 0.42, 0.3)),
  fridge: geo(new THREE.BoxGeometry(0.6, 1.7, 0.6)),
} as const;

// ── Materials ───────────────────────────────────────────────────────────────

export interface MatOptions {
  roughness?: number;
  metalness?: number;
  opacity?: number;
  emissive?: string;
  emissiveIntensity?: number;
  side?: THREE.Side;
}

const cache = new Map<string, THREE.MeshStandardMaterial>();

export function matte(color: string, options: MatOptions = {}): THREE.MeshStandardMaterial {
  const {
    roughness = 0.82,
    metalness = 0,
    opacity = 1,
    emissive,
    emissiveIntensity = 1,
    side = THREE.FrontSide,
  } = options;
  const key = `${color}|${roughness}|${metalness}|${opacity}|${emissive ?? '-'}|${emissiveIntensity}|${side}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(color),
    roughness,
    metalness,
    transparent: opacity < 1,
    opacity,
    side,
    emissive: emissive ? new THREE.Color(emissive) : new THREE.Color('#000000'),
    emissiveIntensity: emissive ? emissiveIntensity : 0,
  });
  cache.set(key, material);
  return material;
}

// ── Office palette (matches the 2D floor and the rest of the UI) ────────────

export const OFFICE = {
  carpet: '#1b1e27',
  corridor: '#242833',
  wall: '#2c313d',
  wallTrim: '#3a4150',
  deskTop: '#4a3a2c',
  deskLegDark: '#1e2129',
  chair: '#22262f',
  monitorBezel: '#14171d',
  screen: '#2b4c6f',
  screenGlow: '#5b8def',
  plant: '#3f5e42',
  pot: '#2a2f38',
  whiteboard: '#c9ced8',
  metal: '#5a6070',
  kitchen: '#333a46',
  lampGlow: '#ffd9a0',
} as const;

/** Muted accents per department, same set the 2D floor uses. */
export const ACCENTS = ['#5b8def', '#e0a458', '#5fbf8f', '#c97bb6', '#6fc3d0', '#d97a6c'] as const;

export function accentFor(index: number): string {
  return ACCENTS[((index % ACCENTS.length) + ACCENTS.length) % ACCENTS.length];
}

/** How many metres one simulation unit is. Desks are ~104 units ≈ 1.45 m. */
export const UNIT = 0.014;
