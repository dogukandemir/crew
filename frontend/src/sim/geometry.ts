/**
 * Floor geometry primitives.
 *
 * The simulation works in a flat world plane (x → right, y → "south"); every
 * renderer projects from here. Keeping this dependency-free is what lets the
 * same simulation run in the browser today and in a cloud scene worker later.
 */

export interface Point {
  x: number;
  y: number;
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Frames in between, for renderers that smooth movement. */
export function lerpPoint(a: Point, b: Point, t: number): Point {
  const k = Math.max(0, Math.min(1, t));
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
}

/** Angle of travel in radians, where 0 points along +x. */
export function heading(a: Point, b: Point): number {
  return Math.atan2(b.y - a.y, b.x - a.x);
}
