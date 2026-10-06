/**
 * Camera projection (pure).
 *
 * The floor is a real 3D plane: `translate(tx, ty) scale(s) rotateX(theta) rotateZ(phi)`.
 * That gives the angled aerial view; characters are billboarded back to face the
 * camera so they stand upright on the tilted floor.
 *
 * Everything here works in "screen" pixels relative to the canvas origin, so the
 * pan/zoom maths in viewport.ts keeps working unchanged.
 */

import type { Point } from '../../sim/geometry';

/** Re-exported so the 2D renderer and its tests keep a single Point type. */
export type { Point };

export const DEFAULT_TILT_X = 54;
export const DEFAULT_TILT_Z = -26;

export type CameraPreset = 'iso' | 'steep' | 'top';

export interface CameraPresetInfo {
  rotX: number;
  rotZ: number;
  label: string;
}

export const CAMERA_PRESETS: Record<CameraPreset, CameraPresetInfo> = {
  iso: { rotX: DEFAULT_TILT_X, rotZ: DEFAULT_TILT_Z, label: 'Isometric' },
  steep: { rotX: 72, rotZ: -14, label: 'Steep' },
  top: { rotX: 0, rotZ: 0, label: 'Plan' },
};

export function cameraLabel(preset: CameraPreset): string {
  return CAMERA_PRESETS[preset].label;
}

export function deg2rad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/**
 * World point → screen offset (before the camera translate/scale), for a floor
 * rotated by `rotX` about X and `rotZ` about Z. Origin is the world's (0,0).
 */
export function projectPoint(
  x: number,
  y: number,
  scale: number,
  rotX: number,
  rotZ: number,
): Point {
  const rz = deg2rad(rotZ);
  const rx = deg2rad(rotX);
  const xz = x * Math.cos(rz) - y * Math.sin(rz);
  const yz = (x * Math.sin(rz) + y * Math.cos(rz)) * Math.cos(rx);
  return { x: xz * scale, y: yz * scale };
}

/** Screen position of a world point, including the camera translate. */
export function toScreen(
  x: number,
  y: number,
  camera: { x: number; y: number; scale: number },
  rotX: number,
  rotZ: number,
): Point {
  const p = projectPoint(x, y, camera.scale, rotX, rotZ);
  return { x: camera.x + p.x, y: camera.y + p.y };
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

/** Projected bounding box of a `w × h` floor rect at the origin. */
export function projectedBounds(
  w: number,
  h: number,
  rotX: number,
  rotZ: number,
): Bounds {
  const corners: Point[] = [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: 0, y: h },
    { x: w, y: h },
  ].map((c) => projectPoint(c.x, c.y, 1, rotX, rotZ));

  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/**
 * Centre a tilted floor in the viewport at a scale that fits it.
 * Returns the same camera shape the pan/zoom code uses.
 */
export function fitTilted(
  worldW: number,
  worldH: number,
  viewW: number,
  viewH: number,
  rotX: number,
  rotZ: number,
  pad = 56,
  maxScale = 1.35,
): { x: number; y: number; scale: number } {
  if (worldW <= 0 || worldH <= 0 || viewW <= 0 || viewH <= 0) {
    return { x: 0, y: 0, scale: 1 };
  }
  const b = projectedBounds(worldW, worldH, rotX, rotZ);
  const scale = Math.min(
    maxScale,
    Math.max(0.15, Math.min((viewW - pad * 2) / b.width, (viewH - pad * 2) / b.height)),
  );
  const centreX = ((b.minX + b.maxX) / 2) * scale;
  const centreY = ((b.minY + b.maxY) / 2) * scale;
  return { scale, x: viewW / 2 - centreX, y: viewH / 2 - centreY };
}

/** Camera that puts a world rect in the middle of the viewport, tilted. */
export function focusTilted(
  rect: { x: number; y: number; w: number; h: number },
  viewW: number,
  viewH: number,
  rotX: number,
  rotZ: number,
  preferredScale = 1,
  pad = 90,
): { x: number; y: number; scale: number } {
  if (rect.w <= 0 || rect.h <= 0 || viewW <= 0 || viewH <= 0) {
    return { x: 0, y: 0, scale: 1 };
  }
  const b = projectedBounds(rect.w, rect.h, rotX, rotZ);
  const scale = Math.max(
    0.15,
    Math.min(preferredScale, (viewW - pad * 2) / b.width, (viewH - pad * 2) / b.height),
  );
  // centre of the rect in world space, then its projected position
  const centre = projectPoint(rect.x + rect.w / 2, rect.y + rect.h / 2, scale, rotX, rotZ);
  return { scale, x: viewW / 2 - centre.x, y: viewH / 2 - centre.y };
}
