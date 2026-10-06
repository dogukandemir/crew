import { describe, expect, it } from 'vitest';
import { WALK_SPEED, hasArrived, newWalker, routeLength, setRoute, simplify, step } from './walkers';

describe('walkers', () => {
  it('starts still', () => {
    const w = newWalker(10, 20);
    expect(w.moving).toBe(false);
    expect(hasArrived(w)).toBe(true);
    expect(w.x).toBe(10);
    expect(w.y).toBe(20);
  });

  it('sets off when given a route', () => {
    // A single point at your feet is not a journey.
    expect(setRoute(newWalker(0, 0), [{ x: 0, y: 0 }]).moving).toBe(false);
    // A single point somewhere else is: go and stand there.
    const away = setRoute(newWalker(0, 0), [{ x: 100, y: 0 }]);
    expect(away.moving).toBe(true);
    expect(away.route).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ]);
  });

  it('walks the route at the given speed', () => {
    const start = setRoute(newWalker(0, 0), [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ]);
    const half = step(start, 0.5, 100);
    expect(half.x).toBeCloseTo(50, 6);
    const done = step(half, 0.5, 100);
    expect(done.x).toBeCloseTo(100, 6);
    expect(done.moving).toBe(false);
    expect(hasArrived(done)).toBe(true);
  });

  it('never overshoots the end of the route', () => {
    const start = setRoute(newWalker(0, 0), [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ]);
    const far = step(start, 10, 100);
    expect(far.x).toBe(100);
    expect(far.y).toBe(0);
    expect(far.moving).toBe(false);
  });

  it('consumes several segments in one step', () => {
    // 50 + 50 + 50 = 150px of route: 1s at 100px/s lands exactly on the corner.
    const route = [
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 50, y: 50 },
      { x: 100, y: 50 },
    ];
    const w = setRoute(newWalker(0, 0), route);
    const corner = step(w, 1, 100);
    expect(corner.x).toBe(50);
    expect(corner.y).toBeCloseTo(50, 6);
    expect(corner.moving).toBe(true);
    expect(corner.seg).toBe(2);

    const arrived = step(w, 1.5, 100);
    expect(arrived.x).toBeCloseTo(100, 6);
    expect(arrived.y).toBeCloseTo(50, 6);
    expect(arrived.moving).toBe(false);
  });

  it('walks a multi-segment route to the very end', () => {
    const route = [
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      { x: 200, y: 300 },
      { x: 40, y: 300 },
    ];
    let w = setRoute(newWalker(0, 0), route);
    const total = routeLength(route);
    let guard = 0;
    while (w.moving && guard < 500) {
      w = step(w, 0.1, WALK_SPEED);
      guard += 1;
    }
    expect(w.moving).toBe(false);
    expect(w.x).toBeCloseTo(40, 4);
    expect(w.y).toBeCloseTo(300, 4);
    expect(guard * 0.1 * WALK_SPEED).toBeGreaterThanOrEqual(total - 0.01);
  });

  it('faces the way it is walking', () => {
    const right = step(
      setRoute(newWalker(0, 0), [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ]),
      0.2,
      100,
    );
    expect(right.facing).toBe(1);
    const left = step(
      setRoute(newWalker(100, 0), [
        { x: 100, y: 0 },
        { x: 0, y: 0 },
      ]),
      0.2,
      100,
    );
    expect(left.facing).toBe(-1);
  });

  it('does not flip facing on pure vertical movement', () => {
    const w = step(
      setRoute(newWalker(0, 0), [
        { x: 0, y: 0 },
        { x: 0, y: 100 },
      ]),
      0.2,
      100,
    );
    expect(w.facing).toBe(1);
  });

  it('sets off from where it stands when the route starts elsewhere', () => {
    // A character mid-walk getting a new destination must not teleport.
    const w = setRoute(newWalker(30, 0), [
      { x: 200, y: 0 },
      { x: 200, y: 100 },
    ]);
    expect(w.route[0]).toEqual({ x: 30, y: 0 });
    expect(w.route[1]).toEqual({ x: 200, y: 0 });
    expect(w.x).toBe(30);
    expect(w.y).toBe(0);
  });

  it('ignores an empty route', () => {
    const w = setRoute(newWalker(5, 5), []);
    expect(w.x).toBe(5);
    expect(w.moving).toBe(false);
  });

  it('does nothing when the clock is not moving', () => {
    const w = setRoute(newWalker(0, 0), [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ]);
    expect(step(w, 0)).toEqual(w);
    expect(step(w, -1)).toEqual(w);
  });

  it('drops duplicate consecutive points', () => {
    const s = simplify([
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0.1 },
      { x: 50, y: 0 },
    ]);
    expect(s).toEqual([
      { x: 0, y: 0 },
      { x: 50, y: 0 },
    ]);
  });

  it('measures route length', () => {
    expect(
      routeLength([
        { x: 0, y: 0 },
        { x: 3, y: 4 },
        { x: 3, y: 14 },
      ]),
    ).toBeCloseTo(15, 6);
  });
});
