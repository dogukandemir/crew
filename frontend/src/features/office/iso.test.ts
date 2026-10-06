import { describe, expect, it } from 'vitest';
import { DESK_W } from '../../sim/floorplan';
import {
  FACE_SHADE,
  ISO,
  UNITS_PER_METRE,
  boxCentre,
  boxFaces,
  fitCamera,
  floorRect,
  isoBounds,
  mh,
  polyPoints,
  project,
  screenOf,
} from './iso';

const num = (p: string) => p.split(' ').map((pair) => pair.split(',').map(Number));

describe('projection', () => {
  it('puts the world origin at the screen origin', () => {
    expect(project(0, 0)).toEqual({ x: 0, y: 0 });
    expect(project(0, 0, 40)).toEqual({ x: 0, y: -40 });
  });

  it('spreads the two floor axes symmetrically at a 2:1 ratio', () => {
    expect(project(100, 0)).toEqual({ x: 100 * ISO.kx, y: 100 * ISO.ky });
    expect(project(0, 100)).toEqual({ x: -100 * ISO.kx, y: 100 * ISO.ky });
    // 2:1 — a unit square is a diamond twice as wide as it is tall.
    expect(ISO.kx / ISO.ky).toBe(2);
  });

  it('keeps verticals vertical', () => {
    // The whole point of the rewrite: height must not move anything sideways.
    const ground = project(120, 80);
    const raised = project(120, 80, 90);
    expect(raised.x).toBe(ground.x);
    expect(ground.y - raised.y).toBe(90 * ISO.kz);
  });
});

describe('floor geometry', () => {
  it('draws a floor rectangle as a diamond, and rounds it for SVG', () => {
    const points = num(floorRect(0, 0, 10, 10));
    expect(points).toHaveLength(4);
    // Near corner is furthest down the screen.
    const lowest = points.reduce((a, b) => (b[1] > a[1] ? b : a));
    expect(lowest).toEqual([0, 10]);
    expect(floorRect(0, 0, 10, 10)).toBe(polyPoints([
      { x: 0, y: 0 },
      { x: 10, y: 5 },
      { x: 0, y: 10 },
      { x: -10, y: 5 },
    ]));
  });

  it('lifts a rectangle by exactly its height, without moving it sideways', () => {
    const ground = num(floorRect(20, 30, 10, 10, 0));
    const raised = num(floorRect(20, 30, 10, 10, 50));
    for (let i = 0; i < 4; i += 1) {
      expect(raised[i][0]).toBeCloseTo(ground[i][0], 6);
      expect(raised[i][1]).toBeCloseTo(ground[i][1] - 50, 6);
    }
  });
});

describe('volumes', () => {
  const x = 40;
  const y = 20;
  const w = 60;
  const d = 40;
  const h = 30;

  it('builds a top face and two side faces', () => {
    const box = boxFaces(x, y, w, d, h);
    for (const face of [box.top, box.right, box.front]) {
      expect(num(face), face).toHaveLength(4);
    }
  });

  it('gives each side face the full height of the box', () => {
    const box = boxFaces(x, y, w, d, h);
    const front = num(box.front);
    const right = num(box.right);
    // The vertical edges: the ground corner minus the lifted one above it. Height
    // lifts a point up the screen, so the ground corner has the larger y.
    expect(front[3][1] - front[0][1]).toBeCloseTo(h, 6);
    expect(front[2][1] - front[1][1]).toBeCloseTo(h, 6);
    expect(right[3][1] - right[0][1]).toBeCloseTo(h, 6);
    expect(right[2][1] - right[1][1]).toBeCloseTo(h, 6);
  });

  it('darkens the sides so the volume reads', () => {
    expect(FACE_SHADE.top).toBe(1);
    expect(FACE_SHADE.right).toBeLessThan(FACE_SHADE.top);
    expect(FACE_SHADE.front).toBeLessThan(FACE_SHADE.right);
  });

  it('sits the top face above its own footprint', () => {
    const top = num(boxFaces(x, y, w, d, h).top);
    const foot = num(floorRect(x, y, w, d, 0));
    for (let i = 0; i < 4; i += 1) {
      expect(top[i][1]).toBeCloseTo(foot[i][1] - h, 6);
    }
  });

  it('places a label above the middle of a box', () => {
    const centre = boxCentre(0, 0, 10, 10, 0);
    expect(centre).toEqual(project(5, 5, 0));
    expect(boxCentre(0, 0, 10, 10, 20).y).toBe(centre.y - 20);
  });
});

describe('real-world scale', () => {
  it('derives the units-per-metre from the desk in the floor plan', () => {
    expect(UNITS_PER_METRE).toBeCloseTo(DESK_W / 1.45, 6);
  });

  it('makes a person taller than a desk, which is what was missing', () => {
    const desk = mh(0.74);
    const person = mh(1.7);
    expect(person).toBeGreaterThan(desk * 2);
    // And a person is about as tall as a desk is across.
    expect(person).toBeGreaterThan(DESK_W);
  });

  it('scales a wall to something a character can be seen over', () => {
    const wall = mh(0.8);
    const person = mh(1.7);
    expect(wall).toBeLessThan(person);
    expect(wall).toBeGreaterThan(20);
  });
});

describe('camera', () => {
  const viewport = { w: 1000, h: 600 };

  it('bounds a world rectangle into a diamond wider than it is tall', () => {
    const b = isoBounds(720, 480);
    expect(b.w).toBeCloseTo(720 + 480, 6);
    expect(b.h).toBeCloseTo((720 + 480) / 2, 6);
  });

  it('lifts the box by the headroom so signage is not cropped', () => {
    const plain = isoBounds(720, 480);
    const roomy = isoBounds(720, 480, 200);
    expect(roomy.y).toBeCloseTo(plain.y - 200, 6);
    expect(roomy.h).toBeCloseTo(plain.h + 200, 6);
  });

  it('fits the whole floor inside the viewport with padding', () => {
    const b = isoBounds(720, 480, 200, 46);
    const cam = fitCamera(b, viewport);
    expect(cam.scale).toBeGreaterThan(0);
    const left = b.x * cam.scale + cam.x;
    const right = (b.x + b.w) * cam.scale + cam.x;
    const top = b.y * cam.scale + cam.y;
    const bottom = (b.y + b.h) * cam.scale + cam.y;
    expect(left).toBeGreaterThanOrEqual(17);
    expect(right).toBeLessThanOrEqual(viewport.w - 17);
    expect(top).toBeGreaterThanOrEqual(17);
    expect(bottom).toBeLessThanOrEqual(viewport.h - 17);
  });

  it('centres what it fits', () => {
    const b = isoBounds(720, 480, 200, 46);
    const cam = fitCamera(b, viewport);
    const midX = (b.x + b.w / 2) * cam.scale + cam.x;
    const midY = (b.y + b.h / 2) * cam.scale + cam.y;
    expect(midX).toBeCloseTo(viewport.w / 2, 6);
    expect(midY).toBeCloseTo(viewport.h / 2, 6);
  });

  it('maps a world point through the camera consistently', () => {
    const cam = { x: 40, y: -12, scale: 0.5 };
    const p = screenOf(200, 100, cam);
    expect(p.x).toBeCloseTo(project(200, 100).x * 0.5 + 40, 6);
    expect(p.y).toBeCloseTo(project(200, 100).y * 0.5 - 12, 6);
  });
});
