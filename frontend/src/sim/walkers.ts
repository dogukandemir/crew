/**
 * Path following (pure).
 *
 * A walker holds a polyline route and a position along it. The rAF driver in
 * the view just calls `step` and writes the transform; all the interesting
 * behaviour (speed, segment transitions, which way someone is facing, whether
 * they are still moving) is here and tested.
 */
import { distance, type Point } from './geometry';

export interface Walker {
  x: number;
  y: number;
  route: Point[];
  /** Index of the segment currently being walked (route[seg] → route[seg+1]). */
  seg: number;
  /** True while there is still a segment to walk. */
  moving: boolean;
  /** -1 when walking left on screen, 1 otherwise (used to mirror the sprite). */
  facing: 1 | -1;
}

/** Pixels per second. Slow enough to read as a walk, not a dash. */
export const WALK_SPEED = 96;

export function newWalker(x: number, y: number): Walker {
  return { x, y, route: [{ x, y }], seg: 0, moving: false, facing: 1 };
}

/** Drop consecutive duplicate points so we never divide by zero. */
export function simplify(route: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of route) {
    const last = out[out.length - 1];
    if (!last || Math.abs(last.x - p.x) > 0.5 || Math.abs(last.y - p.y) > 0.5) out.push(p);
  }
  return out;
}

export function routeLength(route: Point[]): number {
  let total = 0;
  for (let i = 1; i < route.length; i += 1) total += distance(route[i - 1], route[i]);
  return total;
}

/**
 * Give the walker a new route.
 *
 * If the new route does not begin where the walker currently is, the current
 * position is prepended — so a mid-walk change of plan never teleports the
 * character, they just set off from where they stand.
 */
export function setRoute(w: Walker, route: Point[]): Walker {
  const clean = simplify(route);
  if (clean.length === 0) return w;
  const start = clean[0];
  const detour = distance(w, start) > 3 ? [{ x: w.x, y: w.y }, ...clean] : clean;
  const merged = simplify(detour);
  return { ...w, route: merged, seg: 0, moving: merged.length > 1 };
}

/** Advance `dt` seconds along the route. Consumes whole segments as needed. */
export function step(w: Walker, dt: number, speed: number = WALK_SPEED): Walker {
  if (!w.moving || dt <= 0) return w;

  let budget = Math.max(0, dt) * speed;
  let seg = w.seg;
  let x = w.x;
  let y = w.y;
  let facing = w.facing;

  while (budget > 0 && seg < w.route.length - 1) {
    const target = w.route[seg + 1];
    const remaining = distance({ x, y }, target);
    if (remaining <= 1e-6) {
      seg += 1;
      continue;
    }
    const take = Math.min(budget, remaining);
    const ratio = take / remaining;
    const nx = x + (target.x - x) * ratio;
    const ny = y + (target.y - y) * ratio;
    // Mirror the sprite only for genuine horizontal travel.
    const screenTravel = (nx - x) - (ny - y);
    if (Math.abs(screenTravel) > 0.4) facing = screenTravel < 0 ? -1 : 1;
    x = nx;
    y = ny;
    budget -= take;
    if (take >= remaining - 1e-6) seg += 1;
  }

  const moving = seg < w.route.length - 1;
  const settled = w.route[w.route.length - 1];
  if (!moving) {
    x = settled.x;
    y = settled.y;
  }

  return { ...w, x, y, seg, moving, facing };
}

/** True once the walker has arrived at the end of its route. */
export function hasArrived(w: Walker): boolean {
  return !w.moving;
}
