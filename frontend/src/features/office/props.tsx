/**
 * Volumetric props for the 2.5D floor.
 *
 * Everything here is drawn as a **volume**, never as a flat rectangle: a lit top
 * face plus the two visible side faces, darker in the order the light would hit
 * them. That contrast is the whole difference between a floor plan and a place
 * that looks inhabited — a flat rectangle of the right colour still reads as
 * lying down, which is exactly what was wrong with the previous version.
 *
 * Screen-up is negative y, so a prop's height is drawn by lifting its points;
 * nothing is rotated, and verticals stay vertical.
 */
import type { ReactNode } from 'react';
import { DESK_H, DESK_W } from '../../sim/floorplan';
import { UNITS_PER_METRE, boxFaces, floorRect, mh, polyPoints, project } from './iso';
import { Sprite } from '../sprites/Sprite';

/** Scale a hex colour's brightness. */
export function shade(hex: string, factor: number): string {
  const n = parseInt(hex.replace('#', ''), 16);
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  const r = clamp(((n >> 16) & 255) * factor);
  const g = clamp(((n >> 8) & 255) * factor);
  const b = clamp((n & 255) * factor);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

/** Mix a colour toward another (0 = a, 1 = b). */
export function mix(a: string, b: string, t: number): string {
  const pa = parseInt(a.replace('#', ''), 16);
  const pb = parseInt(b.replace('#', ''), 16);
  const lerp = (sa: number, sb: number) => Math.round(sa + (sb - sa) * t);
  const r = lerp((pa >> 16) & 255, (pb >> 16) & 255);
  const g = lerp((pa >> 8) & 255, (pb >> 8) & 255);
  const bl = lerp(pa & 255, pb & 255);
  return `#${((r << 16) | (g << 8) | bl).toString(16).padStart(6, '0')}`;
}

/** A solid box standing on the floor, optionally lifted off it. */
export function Box({
  x,
  y,
  w,
  d,
  h,
  color,
  top,
  lift = 0,
  opacity = 1,
  ink = true,
}: {
  x: number;
  y: number;
  w: number;
  d: number;
  h: number;
  color: string;
  /** Override the lit top face (e.g. a polished surface). */
  top?: string;
  /** Raise the box off the ground (a seat on a stem, a counter top). */
  lift?: number;
  opacity?: number;
  /** Outline the shape, which is what makes the props match the drawn cast. */
  ink?: boolean;
}) {
  const faces = boxFaces(x, y, w, d, h, lift);
  const stroke = ink ? shade(color, 0.42) : undefined;
  return (
    <g opacity={opacity} stroke={stroke} strokeWidth={ink ? 0.8 : undefined} strokeLinejoin="round">
      {/* Sides first so the lit top face wins any overlap at the shared edges. */}
      <polygon points={faces.front} fill={shade(color, 0.58)} />
      <polygon points={faces.right} fill={shade(color, 0.76)} />
      <polygon points={faces.top} fill={top ?? shade(color, 1.06)} />
    </g>
  );
}

/** A soft contact shadow, squashed to the floor plane. */
export function GroundShadow({
  cx,
  cy,
  r,
  opacity = 0.34,
}: {
  cx: number;
  cy: number;
  r: number;
  opacity?: number;
}) {
  const p = project(cx, cy);
  return <ellipse cx={p.x} cy={p.y} rx={r} ry={r * 0.5} fill="#05070c" opacity={opacity} />;
}

/** An upright panel (a screen, a whiteboard, a sign) standing at a floor point. */
export function Panel({
  at,
  w,
  h,
  tilt = 0,
  fill,
  edge,
  children,
}: {
  at: { x: number; y: number };
  w: number;
  h: number;
  /** World height the panel's base sits at. */
  tilt?: number;
  fill: string;
  edge?: string;
  children?: ReactNode;
}) {
  const p = project(at.x, at.y);
  const baseY = p.y - tilt;
  return (
    <g>
      <rect x={p.x - w / 2} y={baseY - h} width={w} height={h} rx={3} fill={fill} />
      {edge && (
        <rect
          x={p.x - w / 2}
          y={baseY - h}
          width={w}
          height={h}
          rx={3}
          fill="none"
          stroke={edge}
          strokeWidth={1.5}
        />
      )}
      {/* Children live in the panel's own space: (0,0) is its top-left corner,
          whatever the projection did to place it. */}
      <g transform={`translate(${(p.x - w / 2).toFixed(2)} ${(baseY - h).toFixed(2)})`}>{children}</g>
    </g>
  );
}

const DESK_SLAB_D = 58;
export const DESK_H_M = 0.74;
export const DESK_Z = mh(DESK_H_M);
/** How far south of the desk cell its occupant sits. */
export const SIT_BACK = 30;
/** The seated hip height from the pose table — a chair has to meet it exactly. */
export const SEAT_Z = mh(0.5);

/**
 * An office chair, placed where its occupant actually is.
 *
 * The pose table puts a seated body's hips at `HIP_SIT` (0.5 m) off the floor, so
 * the seat's top face is set to exactly that height and the chair is centred on
 * the sitter. Getting either wrong is what makes a character look like they are
 * sitting in mid-air next to their own chair.
 */
export function Chair({ at, color: _color = '#1c1f26' }: { at: { x: number; y: number }; color?: string }) {
  // One sprite, anchored where the sitter is. The chair used to be built from the
  // pose table's hip height so it could never disagree with a seated body; the
  // sprite carries that relationship in its own pixels, which is the same
  // guarantee with less to keep in sync.
  return (
    <g>
      <GroundShadow cx={at.x} cy={at.y} r={22} opacity={0.28} />
      <Sprite name="prop.chair" x={at.x} y={at.y} />
    </g>
  );
}

/**
 * A workstation. One per agent, and only its owner is ever drawn seated here:
 * visiting a colleague means standing beside their desk, not taking their chair.
 *
 * `busy` means the owner is using the computer right now, which is the only
 * thing that lights the screen. Everybody else's monitor reads as powered down.
 */
export function Workstation({
  x,
  y,
  color: _color = '#2b3242',
  busy = false,
  glow: _glow = '#7cc4ff',
  screen = true,
}: {
  x: number;
  y: number;
  color?: string;
  busy?: boolean;
  glow?: string;
  screen?: boolean;
}) {
  // The desk, its monitor, the lit screen and the keyboard are one sprite, in two
  // states — and `busy` is exactly the distinction the atlas carries a second cell
  // for. The old drawing built that out of a panel, four rectangles and a standby
  // dot, and had to keep them all agreeing.
  const mid = x + DESK_W / 2;
  const sitY = y + DESK_H - SIT_BACK;
  return (
    <g>
      <GroundShadow cx={mid} cy={y + DESK_SLAB_D / 2} r={DESK_W * 0.42} />
      {/* The chair is its own sprite: the sim seats a body on it, so it has to be
          placeable on its own. */}
      <Chair at={{ x: mid, y: sitY }} />
      {/* The atlas desk is drawn at its own size — 2 m across, in its own
          proportions — so it is centred on the desk the simulation actually
          assigned rather than aligned to its corner. The offset is the sprite's own
          half-footprint: one metre along x, half a metre along y. The chair and the
          sitter still come from DESK_W, which is what the sim moves around. */}
      <Sprite
        name={screen && busy ? 'prop.desk.busy' : 'prop.desk'}
        x={x + DESK_W / 2 - UNITS_PER_METRE}
        y={y + DESK_SLAB_D / 2 - UNITS_PER_METRE / 2}
      />
    </g>
  );
}

/** A potted plant — the cheapest way to make an office look alive. */
export function Plant({ x, y, scale: _scale = 1 }: { x: number; y: number; scale?: number }) {
  return (
    <g>
      <GroundShadow cx={x} cy={y} r={17} />
      <Sprite name="prop.plant" x={x} y={y} />
    </g>
  );
}

/** A whiteboard / glass board on a wall, with scribbles. */
export function Whiteboard({ x, y, w: _w = 120, h: _h = 56 }: { x: number; y: number; w?: number; h?: number }) {
  // The board's height comes from the sprite now, not from the caller. A caller
  // that asked for 168 units gets a board 2 m across, which is what the atlas has;
  // if a wall ever needs a different board it belongs in the atlas too.
  return <Sprite name="prop.whiteboard" x={x} y={y} />;
}

/** The coffee counter idle characters gather at. */
export function CoffeeBar({ x, y, w = 150 }: { x: number; y: number; w?: number }) {
  const z = mh(0.95);
  return (
    <g>
      <GroundShadow cx={x + w / 2} cy={y + 14} r={w * 0.5} />
      {/* The counter stays a box — a counter is a box — and the machine on it is a
          sprite, placed where the machine was: half its own footprint in from the
          counter's left, at the counter's back edge. */}
      <Box x={x} y={y} w={w} d={30} h={z} color="#3a3026" top="#4d4033" />
      <Sprite name="prop.coffee" x={x + 39} y={y + 7} z={z} />
      <Box x={x + w - 52} y={y + 6} w={18} d={16} h={z + 10} color="#7d8798" />
      <Box x={x + w - 28} y={y + 6} w={16} d={16} h={z + 10} color="#98a2b3" />
      <Box x={x + 78} y={y + 4} w={30} d={20} h={z + 22} color="#4a5468" />
    </g>
  );
}

/** A table with chairs, for review and stand-ups. */
export function MeetingTable({ x, y, w = 210, d = 96, seats = 4 }: { x: number; y: number; w?: number; d?: number; seats?: number }) {
  const z = mh(0.75);
  const chairZ = mh(0.45);
  const step = w / (seats + 1);
  return (
    <g>
      <GroundShadow cx={x + w / 2} cy={y + d / 2} r={Math.max(w, d) * 0.5} />
      <Box x={x} y={y} w={w} d={d} h={z} color="#3b3428" top="#5a4f3c" />
      {/* Papers and a mug ring left on the table. */}
      <Box x={x + w * 0.3} y={y + d * 0.3} w={34} d={26} h={z + 3} color="#e8edf5" />
      <Box x={x + w * 0.62} y={y + d * 0.5} w={16} d={16} h={z + 10} color="#8a93a5" />
      {Array.from({ length: seats }, (_, i) => (
        <g key={i}>
          <Chair at={{ x: x + step * (i + 1), y: y + d + 26 }} color="#22262f" />
        </g>
      ))}
      <Chair at={{ x: x + step, y: y - 26 }} />
      <Chair at={{ x: x + w - step, y: y - 26 }} />
    </g>
  );
}

/**
 * A round table: a cylinder, so it has a lit elliptical top and a visible side.
 *
 * Used in the break corner, where the point is that people sit *together* — the
 * chairs come from `breakSeats()` in the floor plan, which is the same list the
 * simulation seats people on, so a chair and its sitter can never disagree.
 */
export function RoundTable({ at, r = 34, color = '#4a3f2e' }: { at: { x: number; y: number }; r?: number; color?: string }) {
  const c = project(at.x, at.y);
  const ry = r * 0.5;
  const h = mh(0.74);
  const top = c.y - h;
  return (
    <g>
      <ellipse cx={c.x} cy={c.y} rx={r} ry={ry} fill="#05070c" opacity={0.34} />
      {/* The visible side: the lower half of the top swept down to the floor. */}
      <path
        d={`M ${c.x - r} ${top} A ${r} ${ry} 0 0 0 ${c.x + r} ${top} L ${c.x + r} ${c.y} A ${r} ${ry} 0 0 1 ${c.x - r} ${c.y} Z`}
        fill={shade(color, 0.62)}
        stroke={shade(color, 0.42)}
        strokeWidth={0.8}
      />
      <ellipse
        cx={c.x}
        cy={top}
        rx={r}
        ry={ry}
        fill={shade(color, 1.3)}
        stroke={shade(color, 0.5)}
        strokeWidth={0.8}
      />
      <ellipse cx={c.x} cy={top} rx={r * 0.66} ry={ry * 0.66} fill={shade(color, 1.06)} />
      {/* A mug and a plate: a table in an office is never clear. */}
      <ellipse cx={c.x - r * 0.42} cy={top - ry * 0.32} rx={5.4} ry={2.7} fill="#b8c2d0" stroke="#7d8798" strokeWidth={0.6} />
      <ellipse cx={c.x + r * 0.4} cy={top + ry * 0.3} rx={6.8} ry={3.2} fill="#9aa5b8" stroke="#6d7788" strokeWidth={0.6} />
    </g>
  );
}

/** A filling cabinet / shelf, which is what makes a wall look like an office. */
export function Cabinet({ x, y, w = 54, h = mh(1.2) }: { x: number; y: number; w?: number; h?: number }) {
  const d = 34;
  return (
    <g>
      <Box x={x} y={y} w={w} d={d} h={h} color="#333b4b" />
      {[0, 1, 2].map((row) => (
        <rect
          key={row}
          x={project(x + w / 2, y + d).x - w * 0.36}
          y={project(x + w / 2, y + d).y - h + 12 + row * (h / 3.4)}
          width={w * 0.72}
          height={4}
          rx={2}
          fill="#586177"
        />
      ))}
    </g>
  );
}

/** A floor lamp with a warm pool of light, which is what sells an evening office. */
export function FloorLamp({ x, y, accent = '#ffcf8f' }: { x: number; y: number; accent?: string }) {
  const p = project(x, y);
  const h = mh(1.5);
  return (
    <g>
      <ellipse cx={p.x} cy={p.y} rx={54} ry={27} fill={accent} opacity={0.13} />
      <ellipse cx={p.x} cy={p.y} rx={30} ry={15} fill={accent} opacity={0.1} />
      <rect x={p.x - 2} y={p.y - h} width={4} height={h} fill="#3a4152" />
      <path
        d={`M ${p.x - 16} ${p.y - h} L ${p.x + 16} ${p.y - h} L ${p.x + 10} ${p.y - h - 18} L ${p.x - 10} ${p.y - h - 18} Z`}
        fill={mix('#2b3242', accent, 0.45)}
      />
    </g>
  );
}

/** A crate / supply box. */
export function Crate({ x, y, w = 42, h = mh(0.42) }: { x: number; y: number; w?: number; h?: number }) {
  return (
    <g>
      <GroundShadow cx={x + w / 2} cy={y + w / 2} r={w * 0.6} />
      <Box x={x} y={y} w={w} d={w} h={h} color="#4a3f2e" top="#6b5a41" />
      <polygon points={floorRect(x, y, w, w, h)} fill="none" stroke="#8a7351" strokeWidth={1} opacity={0.6} />
    </g>
  );
}

/** A printer, which everyone visits and nobody likes. */
export function Printer({ x, y }: { x: number; y: number }) {
  return (
    <g>
      <Box x={x} y={y} w={62} d={46} h={mh(0.55)} color="#39414f" />
      <Box x={x + 8} y={y + 6} w={46} d={30} h={mh(0.75)} color="#2b3242" top="#4a5468" />
      <Box x={x + 22} y={y + 12} w={18} d={12} h={mh(0.85)} color="#e8edf5" />
    </g>
  );
}

/**
 * A vending machine: the one genuinely lit thing in a break corner.
 *
 * The glass front shows shelves of snacks, and the brand strip glows, so at a
 * glance you can see somebody standing at it getting something.
 */
export function VendingMachine({ x, y, accent: _accent = '#5b8def' }: { x: number; y: number; accent?: string }) {
  // The machine's lit front, its shelves of snacks and its glow all live in the
  // sprite now. One atlas cell, anchored at the machine's near corner.
  return (
    <g>
      <GroundShadow cx={x + 28} cy={y + 17} r={32} />
      <Sprite name="prop.vending" x={x} y={y} />
    </g>
  );
}

/**
 * A foosball table: a cabinet, a pitch, and rods of little players.
 *
 * Drawn with real rods across the pitch so it reads as something two people
 * stand at either end of, which is what makes it useful on a floor.
 */
export function FoosballTable({ x, y, w: _w = 176, d: _d = 104 }: { x: number; y: number; w?: number; d?: number }) {
  // The cabinet, the pitch, the rods and the little players are one sprite: they
  // have to be, or the rods drift off the pitch the moment either is edited.
  return (
    <g>
      <GroundShadow cx={x + 88} cy={y + 52} r={88} />
      <Sprite name="prop.foosball" x={x} y={y} />
    </g>
  );
}

export { DESK_H, DESK_W, UNITS_PER_METRE };
