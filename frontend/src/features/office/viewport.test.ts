import { describe, expect, it } from 'vitest';
import { MAX_SCALE, MIN_SCALE, clampScale, panBy, zoomAt, type Transform } from './viewport';

/** Inverse of the camera transform, kept local so the maths stays verifiable. */
const toWorld = (t: Transform, px: number, py: number) => ({
  x: (px - t.x) / t.scale,
  y: (py - t.y) / t.scale,
});

describe('viewport maths', () => {
  it('zooming out never zooms into a floor fitted below the old minimum', () => {
    const fitted = { x: 60, y: 40, scale: 0.21 };
    expect(zoomAt(fitted, 0.8, 300, 200).scale).toBeLessThan(fitted.scale);
    const enormous = { ...fitted, scale: 0.02 };
    expect(zoomAt(enormous, 0.8, 300, 200).scale).toBeLessThanOrEqual(enormous.scale);
  });
  it('clamps the zoom range', () => {
    expect(clampScale(0.01)).toBe(MIN_SCALE);
    expect(clampScale(99)).toBe(MAX_SCALE);
    expect(clampScale(1.5)).toBe(1.5);
    expect(clampScale(Number.NaN)).toBe(1);
  });

  it('pans without touching the scale', () => {
    const t = { x: 10, y: 20, scale: 1.5 };
    expect(panBy(t, -5, 7)).toEqual({ x: 5, y: 27, scale: 1.5 });
  });

  it('keeps the point under the cursor pinned while zooming', () => {
    const t: Transform = { x: 40, y: 25, scale: 1 };
    const before = toWorld(t, 300, 200);
    const zoomed = zoomAt(t, 1.6, 300, 200);
    const after = toWorld(zoomed, 300, 200);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    expect(zoomed.scale).toBeCloseTo(1.6, 6);
  });

  it('stays pinned across several zoom steps', () => {
    let t: Transform = { x: 0, y: 0, scale: 1 };
    const anchor = { x: 512, y: 288 };
    const before = toWorld(t, anchor.x, anchor.y);
    for (let i = 0; i < 8; i += 1) t = zoomAt(t, 1.1, anchor.x, anchor.y);
    const after = toWorld(t, anchor.x, anchor.y);
    expect(after.x).toBeCloseTo(before.x, 4);
    expect(after.y).toBeCloseTo(before.y, 4);
  });

  it('does not drift when the zoom is already clamped', () => {
    const t: Transform = { x: 12, y: -8, scale: MAX_SCALE };
    expect(zoomAt(t, 2, 100, 100)).toBe(t);
  });
});
