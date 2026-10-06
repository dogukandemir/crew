/**
 * SVG character metrics (pure).
 *
 * The 2D office draws *chibi* people: big head, short stubby limbs, small
 * variation between individuals. Cuteness is not an accident here, it is a
 * constraint — the head is a fixed fraction of the body, limbs are short, and
 * everything is rounded — so the figure stays readable and likeable when it is
 * 40 pixels tall on the floor.
 *
 * Identity comes from the shared `look` (the same person the 3D office draws);
 * this module only decides *how that person is proportioned* in 2D.
 */
import type { CharacterLook, HairStyle, TopKind } from './look';
import type { Pose } from './poses';

export const VIEW = { w: 64, h: 100 } as const;

/** The skeleton, in viewBox units. Feet sit on `footY`. */
export const CHIBI = {
  headR: 15.5,
  headCy: 26,
  neckTop: 41,
  shoulderY: 50,
  torsoTop: 45,
  torsoBottom: 69,
  hipY: 67,
  footY: 92,
  /** Half-distance between the legs. */
  hipSep: 6,
  /** Horizontal offset of a shoulder from the centre line. */
  armX: 11,
  armUpper: 9.5,
  armFore: 8.5,
  handR: 3.4,
  thigh: 11,
  shin: 12,
  shoeW: 9,
  /** Shoe height, used to land the sole on the floor line. */
  shoeH: 3.4,
  /** How far the hips drop when sitting on a chair. */
  seatDrop: 21,
  /** Torso half-width, before girth. */
  torsoHalfW: 12,
} as const;

/** An invariant worth protecting: the head dominates a cute figure. */
export const HEAD_FRACTION_FLOOR = 0.3;

export interface Figure {
  /** Uniform scale about the feet. */
  stature: number;
  /** Limb and torso thickness multiplier. */
  girth: number;
  headR: number;
  headCy: number;
  neckTop: number;
  shoulderY: number;
  torsoTop: number;
  torsoBottom: number;
  hipY: number;
  footY: number;
  hipSep: number;
  armX: number;
  armUpper: number;
  armFore: number;
  handR: number;
  thigh: number;
  shin: number;
  shoeW: number;
  shoeH: number;
  seatDrop: number;
  torsoHalfW: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Map a shared `look` onto chibi proportions. Variation is deliberately damped:
 * a floor of cute characters should read as one cast, not a height chart, so a
 * tall agent is a little taller and a broad one a little wider, and no more.
 */
export function figureFor(look: CharacterLook): Figure {
  const stature = clamp(0.94 + (look.height - 1) * 0.5, 0.93, 1.06);
  const girth = clamp(
    look.frame === 'slim' ? 0.92 : look.frame === 'broad' ? 1.12 : 1,
    0.9,
    1.15,
  );

  return {
    stature,
    girth,
    headR: CHIBI.headR,
    headCy: CHIBI.headCy,
    neckTop: CHIBI.neckTop,
    shoulderY: CHIBI.shoulderY,
    torsoTop: CHIBI.torsoTop,
    torsoBottom: CHIBI.torsoBottom,
    hipY: CHIBI.hipY,
    footY: CHIBI.footY,
    hipSep: CHIBI.hipSep * girth,
    armX: CHIBI.armX * girth,
    armUpper: CHIBI.armUpper,
    armFore: CHIBI.armFore,
    handR: CHIBI.handR,
    thigh: CHIBI.thigh,
    shin: CHIBI.shin,
    shoeW: CHIBI.shoeW,
    shoeH: CHIBI.shoeH,
    seatDrop: CHIBI.seatDrop,
    torsoHalfW: CHIBI.torsoHalfW * girth,
  };
}

/** Height of the drawn figure in viewBox units, including the scale. */
export function figureHeight(fig: Figure): number {
  return fig.footY * fig.stature;
}

/** Head diameter as a fraction of the drawn height — the cuteness check. */
export function headFraction(fig: Figure): number {
  return (fig.headR * 2 * fig.stature) / figureHeight(fig);
}

// ── Colour ──────────────────────────────────────────────────────────────────

function parse(hex: string): [number, number, number] {
  const v = hex.replace('#', '');
  const full = v.length === 3 ? v.split('').map((c) => c + c).join('') : v;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

function toHex(rgb: [number, number, number]): string {
  return `#${rgb
    .map((c) => clamp(Math.round(c), 0, 255).toString(16).padStart(2, '0'))
    .join('')}`;
}

/**
 * Lift a colour toward white. The 2D floor is a lighter surface than the dark
 * 3D office, so identity colours get a small lift to stay legible — the person
 * is still the same colour, just read at a smaller size.
 */
export function lift(hex: string, amount = 0.12): string {
  const [r, g, b] = parse(hex);
  return toHex([r + (255 - r) * amount, g + (255 - g) * amount, b + (255 - b) * amount]);
}

/** Darken, for outlines and shoes — never pure black, which reads as a hole. */
export function shade(hex: string, amount = 0.55): string {
  const [r, g, b] = parse(hex);
  return toHex([r * (1 - amount), g * (1 - amount), b * (1 - amount)]);
}

/** The soft outline colour every shape shares, so the cast looks like one set. */
export const INK = '#20242e';

/** Blush, and the eye colours. */
export const FACE = {
  eyeWhite: '#ffffff',
  pupil: '#2a2f3a',
  blush: '#e88a8a',
  mouth: '#7a4b45',
} as const;

// ── Style keys the renderer switches on ─────────────────────────────────────

export type HairKind = 'none' | 'cap' | 'capFringe' | 'sideSweep' | 'curly' | 'bun' | 'ponytail' | 'long';

export function hairKind(style: HairStyle): HairKind {
  switch (style) {
    case 'bald':
      return 'none';
    case 'buzz':
      return 'cap';
    case 'short':
      return 'capFringe';
    case 'wave':
      return 'sideSweep';
    case 'curly':
      return 'curly';
    case 'bun':
      return 'bun';
    case 'ponytail':
      return 'ponytail';
    case 'braid':
      // A plait hangs like a ponytail, which is the nearest shape the rig has.
      return 'ponytail';
    case 'long':
      return 'long';
    default:
      return 'capFringe';
  }
}

/** Issued clothing is a fixed colour; personal clothing keeps its own. */
export function uniformColour(kind: TopKind): string | null {
  if (kind === 'hivis') return '#e8a33d';
  if (kind === 'labcoat') return '#eef1f5';
  return null;
}

/** A short label for the collar style, so the renderer can pick a shape. */
export function collarKind(kind: TopKind): 'plain' | 'collar' | 'hood' | 'coat' | 'vest' {
  switch (kind) {
    case 'blazer':
      return 'collar';
    case 'hoodie':
      return 'hood';
    case 'labcoat':
      return 'coat';
    case 'hivis':
      return 'vest';
    default:
      return 'plain';
  }
}

// ── 2D projection of the shared pose table ──────────────────────────────────

/**
 * A pose in flat 2D, in degrees, plus how far the hips drop.
 *
 * The 3D rig and this 2D rig share one pose table (`sim`-adjacent `poses.ts`),
 * so a character stands, sits and walks the same way in both views. Only the
 * *fold* is re-mapped: a 3D seated thigh is horizontal, which in a flat billboard
 * would stick straight out sideways, so it is folded to an angle that reads as
 * sitting from the front.
 */
export interface Pose2d {
  /** Downward move of the whole body, in viewBox units. */
  drop: number;
  lean: number;
  headPitch: number;
  armL: number;
  armR: number;
  elbowL: number;
  elbowR: number;
  thighL: number;
  thighR: number;
  kneeL: number;
  kneeR: number;
  seated: boolean;
}

const DEG = 180 / Math.PI;
/** Seated fold for a flat figure: knees out, shins tucked back under. */
const SIT_THIGH = -65;
const SIT_KNEE = 100;

/** Where the ankle ends up, given the fold — used to keep feet on the floor. */
export function ankleY(fig: Figure, thighDeg: number, kneeDeg: number): number {
  const t = (thighDeg * Math.PI) / 180;
  const k = (kneeDeg * Math.PI) / 180;
  return fig.hipY + fig.thigh * Math.cos(t) + fig.shin * Math.cos(t - k);
}

/**
 * How far the hips must drop for a given fold, so the ankle stays exactly on
 * the floor line. Sitting must not make anyone float or sink — this is the
 * arithmetic that guarantees it, and it is tested.
 */
export function dropFor(fig: Figure, thighDeg: number, kneeDeg: number): number {
  return fig.footY - (ankleY(fig, thighDeg, kneeDeg) + fig.shoeH);
}

export function to2d(pose: Pose, fig: Figure): Pose2d {
  if (pose.seated) {
    return {
      drop: dropFor(fig, SIT_THIGH, SIT_KNEE),
      lean: pose.hipPitch * DEG,
      headPitch: pose.headPitch * DEG,
      armL: pose.armL[0] * DEG,
      armR: pose.armR[0] * DEG,
      elbowL: -pose.elbowL * DEG,
      elbowR: -pose.elbowR * DEG,
      thighL: SIT_THIGH,
      thighR: SIT_THIGH,
      kneeL: SIT_KNEE,
      kneeR: SIT_KNEE,
      seated: true,
    };
  }

  return {
    drop: 0,
    lean: pose.hipPitch * DEG,
    headPitch: pose.headPitch * DEG,
    armL: pose.armL[0] * DEG,
    armR: pose.armR[0] * DEG,
    elbowL: -pose.elbowL * DEG,
    elbowR: -pose.elbowR * DEG,
    thighL: pose.hipL * DEG,
    thighR: pose.hipR * DEG,
    kneeL: pose.kneeL * DEG,
    kneeR: pose.kneeR * DEG,
    seated: false,
  };
}
