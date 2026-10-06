/**
 * Isometric projection (pure).
 *
 * The floor used to be a CSS 3D plane that was rotated and tilted, with the
 * characters counter-rotated to stand up in it. It looked wrong: a tilted plane
 * forecloses the vertical axis, so people read as lying down on the floor.
 *
 * This is the fix, and it is how 2D games have always done it. A dimetric
 * projection with a 2:1 axis ratio keeps **verticals vertical on screen** — a
 * standing character is drawn straight up, and every prop is drawn as a real
 * volume with a lit top face and two shaded side faces. Nothing is rotated in
 * 3D; the whole scene is flat SVG that merely *looks* three-dimensional.
 *
 *   screen.x = (worldX - worldY) * KX
 *   screen.y = (worldX + worldY) * KY - height * KZ
 *
 * Note that `screen.y` grows with `worldX + worldY`: the near corner of anything
 * is the one with the largest sum, and that is where the viewer is looking from.
 */
import { DESK_W } from '../../sim/floorplan';

export interface Screen {
  x: number;
  y: number;
}

export interface WorldPoint {
  x: number;
  y: number;
}

export const ISO = {
  /** Horizontal spread per world unit. */
  kx: 1,
  /** Vertical spread per world unit — half of kx gives the classic 2:1 diamond. */
  ky: 0.5,
  /** Screen pixels per world unit of height (verticals are not foreshortened). */
  kz: 1,
} as const;

/**
 * World units per metre. Derived from the floor plan rather than invented: a desk
 * is `DESK_W` units wide and desks are 1.45 m across, so a 1.7 m person is 122
 * units tall and stands correctly against the furniture.
 */
export const UNITS_PER_METRE = DESK_W / 1.45;

/** Metres → world units, for turning real sizes into scene heights. */
export function mh(metres: number): number {
  return metres * UNITS_PER_METRE;
}

export function project(wx: number, wy: number, wz = 0): Screen {
  return {
    x: (wx - wy) * ISO.kx,
    y: (wx + wy) * ISO.ky - wz * ISO.kz,
  };
}

const r = (n: number): string => (Math.round(n * 100) / 100).toString();

/** An SVG `points` attribute from projected corners. */
export function polyPoints(ps: Screen[]): string {
  return ps.map((p) => `${r(p.x)},${r(p.y)}`).join(' ');
}

/** A rectangle lying flat on the floor, as a diamond on screen. */
export function floorRect(x: number, y: number, w: number, d: number, z = 0): string {
  return polyPoints([
    project(x, y, z),
    project(x + w, y, z),
    project(x + w, y + d, z),
    project(x, y + d, z),
  ]);
}

export interface BoxFaces {
  /** Top face, lit. */
  top: string;
  /** The +x side, in shadow. */
  right: string;
  /** The +y side, deepest shadow (it faces away from the light). */
  front: string;
}

/**
 * The three visible faces of a box standing on the floor.
 *
 * Light comes from the upper left, so the top face keeps its colour and the two
 * visible sides are darkened by `FACE_SHADE` — that contrast is what makes a flat
 * rectangle read as a solid object.
 */
export function boxFaces(x: number, y: number, w: number, d: number, h: number): BoxFaces {
  const top = floorRect(x, y, w, d, h);
  const right = polyPoints([
    project(x + w, y, h),
    project(x + w, y + d, h),
    project(x + w, y + d, 0),
    project(x + w, y, 0),
  ]);
  const front = polyPoints([
    project(x, y + d, h),
    project(x + w, y + d, h),
    project(x + w, y + d, 0),
    project(x, y + d, 0),
  ]);
  return { top, right, front };
}

/** How much to darken each face. Top faces are the reference. */
export const FACE_SHADE = {
  top: 1,
  right: 0.72,
  front: 0.55,
} as const;

/** Centre of a box on screen, for placing labels and badges above it. */
export function boxCentre(x: number, y: number, w: number, d: number, h = 0): Screen {
  return project(x + w / 2, y + d / 2, h);
}

/** A soft contact shadow on the floor under something. */
export function shadowEllipse(cx: number, cy: number, rx: number, ry = rx * 0.6): Screen & { rx: number; ry: number } {
  return { ...project(cx, cy), rx, ry };
}

/** Distance between two world points, in units. */
export function worldDistance(a: WorldPoint, b: WorldPoint): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/* ── Camera ───────────────────────────────────────────────────────────────── */

export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Camera {
  x: number;
  y: number;
  scale: number;
}

/**
 * The screen box a world rectangle occupies.
 *
 * `headroom` lifts the top of the box, because signage and speech bubbles live
 * above the floor and would otherwise be cropped by a fit that only knew about
 * the ground.
 */
export function isoBounds(worldW: number, worldH: number, headroom = 0, margin = 0): Bounds {
  const corners = [
    project(-margin, -margin, 0),
    project(worldW + margin, -margin, 0),
    project(worldW + margin, worldH + margin, 0),
    project(-margin, worldH + margin, 0),
  ];
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys) - headroom;
  return {
    x,
    y,
    w: Math.max(...xs) - x,
    h: Math.max(...ys) - y,
  };
}

/** A transform that puts `bounds` in the middle of the viewport. */
export function fitCamera(
  bounds: Bounds,
  viewport: { w: number; h: number },
  { padding = 18, zoom = 1 }: { padding?: number; zoom?: number } = {},
): Camera {
  if (bounds.w <= 0 || bounds.h <= 0 || viewport.w <= 0 || viewport.h <= 0) {
    return { x: 0, y: 0, scale: 1 };
  }
  const scale =
    Math.min((viewport.w - padding * 2) / bounds.w, (viewport.h - padding * 2) / bounds.h) * zoom;
  return {
    scale,
    x: viewport.w / 2 - (bounds.x + bounds.w / 2) * scale,
    y: viewport.h / 2 - (bounds.y + bounds.h / 2) * scale,
  };
}

/** Where a world point lands on screen, through the camera. */
export function screenOf(x: number, y: number, camera: Camera, z = 0): Screen {
  const p = project(x, y, z);
  return { x: p.x * camera.scale + camera.x, y: p.y * camera.scale + camera.y };
}
