import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TILT_X,
  DEFAULT_TILT_Z,
  cameraLabel,
  fitTilted,
  focusTilted,
  projectPoint,
  projectedBounds,
  toScreen,
} from './camera';

describe('camera projection', () => {
  it('is the identity when the floor is not tilted', () => {
    const p = projectPoint(120, 80, 1, 0, 0);
    expect(p.x).toBeCloseTo(120, 6);
    expect(p.y).toBeCloseTo(80, 6);
  });

  it('scales without rotating', () => {
    const p = projectPoint(10, 20, 2, 0, 0);
    expect(p).toEqual({ x: 20, y: 40 });
  });

  it('turns the floor about z', () => {
    const p = projectPoint(0, 100, 1, 0, -90);
    // rotateZ(-90): (0,100) → (100, 0)
    expect(p.x).toBeCloseTo(100, 6);
    expect(p.y).toBeCloseTo(0, 6);
  });

  it('compresses depth about x — that is the aerial angle', () => {
    const p = projectPoint(0, 100, 1, 60, 0);
    expect(p.x).toBeCloseTo(0, 6);
    expect(p.y).toBeCloseTo(100 * Math.cos((60 * Math.PI) / 180), 6);
    expect(p.y).toBeLessThan(100);
  });

  it('keeps a horizontal span horizontal under the default tilt', () => {
    const a = projectPoint(0, 0, 1, DEFAULT_TILT_X, 0);
    const b = projectPoint(100, 0, 1, DEFAULT_TILT_X, 0);
    expect(a.y).toBeCloseTo(b.y, 6);
  });

  it('centres the projected bounding box on the viewport', () => {
    const view = { w: 1200, h: 700 };
    const camera = fitTilted(900, 500, view.w, view.h, DEFAULT_TILT_X, DEFAULT_TILT_Z);
    const screen = toScreen(450, 250, camera, DEFAULT_TILT_X, DEFAULT_TILT_Z);
    expect(screen.x).toBeCloseTo(view.w / 2, 4);
    expect(screen.y).toBeCloseTo(view.h / 2, 4);
  });

  it('fits the tilted floor inside the viewport', () => {
    const view = { w: 1200, h: 700 };
    const camera = fitTilted(900, 500, view.w, view.h, DEFAULT_TILT_X, DEFAULT_TILT_Z, 40);
    const b = projectedBounds(900, 500, DEFAULT_TILT_X, DEFAULT_TILT_Z);
    expect(b.width * camera.scale).toBeLessThanOrEqual(view.w - 40);
    expect(b.height * camera.scale).toBeLessThanOrEqual(view.h - 40);
  });

  it('never zooms past its ceiling, however small the floor', () => {
    const camera = fitTilted(20, 20, 1200, 700, DEFAULT_TILT_X, DEFAULT_TILT_Z, 40, 1.35);
    expect(camera.scale).toBeLessThanOrEqual(1.35);
  });

  it('returns a sane camera for degenerate inputs', () => {
    expect(fitTilted(0, 0, 0, 0, 0, 0)).toEqual({ x: 0, y: 0, scale: 1 });
    expect(focusTilted({ x: 0, y: 0, w: 0, h: 0 }, 0, 0, 0, 0)).toEqual({ x: 0, y: 0, scale: 1 });
  });

  it('focuses a room in the middle of the viewport', () => {
    const rect = { x: 400, y: 200, w: 300, h: 200 };
    const camera = focusTilted(rect, 1000, 700, DEFAULT_TILT_X, DEFAULT_TILT_Z, 1.2);
    const centre = toScreen(rect.x + rect.w / 2, rect.y + rect.h / 2, camera, DEFAULT_TILT_X, DEFAULT_TILT_Z);
    expect(centre.x).toBeCloseTo(500, 4);
    expect(centre.y).toBeCloseTo(350, 4);
    expect(camera.scale).toBeLessThanOrEqual(1.2);
  });

  it('projects a rotated square into a bigger bounding box', () => {
    const flat = projectedBounds(100, 100, 0, 0);
    expect(flat.width).toBeCloseTo(100, 6);
    const turned = projectedBounds(100, 100, 0, -45);
    expect(turned.width).toBeGreaterThan(100);
  });

  it('exposes the tilt presets it ships with', () => {
    for (const preset of ['iso', 'steep', 'top'] as const) {
      expect(cameraLabel(preset).length).toBeGreaterThan(0);
    }
  });
});
