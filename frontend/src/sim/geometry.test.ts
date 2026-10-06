import { describe, expect, it } from 'vitest';
import { distance, heading, lerpPoint } from './geometry';

describe('floor geometry', () => {
  it('measures distance', () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBeCloseTo(5, 10);
    expect(distance({ x: 5, y: 5 }, { x: 5, y: 5 })).toBe(0);
  });

  it('interpolates and clamps', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 10, y: 20 };
    expect(lerpPoint(a, b, 0)).toEqual(a);
    expect(lerpPoint(a, b, 1)).toEqual(b);
    expect(lerpPoint(a, b, 0.5)).toEqual({ x: 5, y: 10 });
    expect(lerpPoint(a, b, 5)).toEqual(b);
    expect(lerpPoint(a, b, -3)).toEqual(a);
  });

  it('reports the heading of travel', () => {
    expect(heading({ x: 0, y: 0 }, { x: 1, y: 0 })).toBeCloseTo(0, 10);
    expect(heading({ x: 0, y: 0 }, { x: 0, y: 1 })).toBeCloseTo(Math.PI / 2, 10);
    expect(heading({ x: 0, y: 0 }, { x: -1, y: 0 })).toBeCloseTo(Math.PI, 10);
  });
});
