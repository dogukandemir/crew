/**
 * Viewport maths for the office canvas (pure).
 *
 * A single `translate(x, y) scale(s)` applied with `transform-origin: 0 0`.
 * Keeping the maths out of the component makes zoom-around-the-cursor testable:
 * the world point under the pointer must not move when the wheel turns.
 */

export interface Transform {
  x: number;
  y: number;
  scale: number;
}

export const MIN_SCALE = 0.05;
export const MAX_SCALE = 2.2;

export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

export function panBy(t: Transform, dx: number, dy: number): Transform {
  return { ...t, x: t.x + dx, y: t.y + dy };
}

/** Zoom by `factor` keeping the world point under (px, py) pinned. */
export function zoomAt(t: Transform, factor: number, px: number, py: number): Transform {
  const requested = t.scale * factor;
  // Fitting an exceptionally large floor may go below the manual zoom minimum.
  // An outward gesture must never turn into an inward zoom.
  const scale = requested < t.scale ? Math.max(Math.min(MIN_SCALE, t.scale), requested) : clampScale(requested);
  if (scale === t.scale) return t;
  // world = (screen - t) / scale  → keep world fixed for the new scale
  const k = scale / t.scale;
  return {
    scale,
    x: px - (px - t.x) * k,
    y: py - (py - t.y) * k,
  };
}
