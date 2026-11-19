/**
 * Volumetric props for the 2.5D floor.
 *
 * Everything here is drawn as a **volume**, never as a flat rectangle: a lit top
 * face plus the two visible side faces, darker in the order the light would hit
 * them. That contrast is the whole difference between a floor plan and a place
 * that looks inhabited, a flat rectangle of the right colour still reads as
 * lying down, which is exactly what was wrong with the previous version.
 *
 * Screen-up is negative y, so a prop's height is drawn by lifting its points;
 * nothing is rotated, and verticals stay vertical.
 */
import type { ReactNode } from 'react';
import { DESK_TOP_D, DESK_W } from '../../sim/floorplan';
import { UNITS_PER_METRE, boxFaces, floorRect, mh, polyPoints, project } from './iso';
import { Sprite } from '../sprites/Sprite';
import { scaleForWidth, spriteCentreOffset, spriteFootprint } from '../sprites/sprites';

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

/** The desk's top surface: 0.74 m, which is a desk. */
export const DESK_H_M = 0.74;
export const DESK_Z = mh(DESK_H_M);
/** The seated hip height, a chair's seat has to meet it exactly. */
export const SEAT_Z = mh(0.5);

/**
 * An office chair, placed where its occupant actually is.
 *
 * The pose table puts a seated body's hips at 0.5 m off the floor, so the seat's top
 * face is set to exactly that height and the chair is centred on the sitter. Getting
 * either wrong is what makes a character look like they are sitting in mid-air next
 * to their own chair.
 */
export function Chair({ at, color: _color = '#1c1f26', turned = false }: { at: { x: number; y: number }; color?: string; turned?: boolean }) {
  // `at` is the seat itself: the point the simulation uses. The art is placed by its
  // anchor, so it comes back by half its own footprint, read out of the atlas, since
  // a hand-typed half-metre is how the chair ended up 30 cm from its sitter.
  //
  // `turned` is the chair facing the table rather than the viewer. A chair at a
  // desk faces the desk, so what the room shows is its back; a chair on the near
  // side of a meeting table faces away too, and one on the far side faces us.
  const c = spriteCentreOffset(turned ? 'prop.chair.turned' : 'prop.chair');
  return (
    <g>
      <GroundShadow cx={at.x} cy={at.y} r={14} opacity={0.28} />
      <Sprite name={turned ? 'prop.chair.turned' : 'prop.chair'} x={at.x - c.x} y={at.y - c.y} />
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
  seat,
  color: _color = '#2b3242',
  busy = false,
  glow: _glow = '#7cc4ff',
  screen = true,
}: {
  x: number;
  y: number;
  /** Where the person who works here sits, `deskSeat()` in the floor plan. */
  seat: { x: number; y: number };
  color?: string;
  busy?: boolean;
  glow?: string;
  screen?: boolean;
}) {
  // The desk, its monitor, the lit screen and the keyboard are one sprite, in two
  // states, and `busy` is exactly the distinction the atlas carries a second cell
  // for.
  //
  // It is placed at the bay's own origin, because that is where the sprite's anchor
  // is: a sprite is anchored at its footprint's far corner (see Sprite.tsx), and so
  // is a bay. This used to offset the art by a metre and a half a metre, computed
  // from the art's DECLARED half-footprint while the art was drawn at two thirds of
  // it, so every desk sat 30 cm up and to the left of the bay it belonged to, and
  // the chair, which came from the bay, was no longer under it.
  // A working monitor is the only light source on the floor besides the lamps.
  // The pool under the desk and the halo at screen height are what make a typing
  // agent read across the room without anybody labelling them.
  const halo = project(x + DESK_W / 2, y + DESK_TOP_D / 2, mh(1.02));
  const pool = project(x + DESK_W / 2, y + DESK_TOP_D / 2, 2);
  return (
    <g>
      <GroundShadow cx={x + DESK_W / 2} cy={y + DESK_TOP_D} r={DESK_W * 0.42} />
      {busy && (
        <ellipse
          cx={pool.x}
          cy={pool.y}
          rx={86}
          ry={42}
          fill="url(#office-screen-glow)"
          opacity={0.5}
          style={{ mixBlendMode: 'screen' }}
        />
      )}
      {/* The chair's own sprite: the sim seats a body on it, so it has to be
          placeable on its own. It faces the desk, like every chair at a desk. */}
      <Chair at={seat} turned />
      <Sprite name={screen && busy ? 'prop.desk.busy' : 'prop.desk'} x={x} y={y} />
      {busy && (
        <ellipse
          cx={halo.x}
          cy={halo.y}
          rx={54}
          ry={30}
          fill="url(#office-screen-glow)"
          opacity={0.55}
          style={{ mixBlendMode: 'screen' }}
        />
      )}
    </g>
  );
}

/** A potted plant, the cheapest way to make an office look alive. */
export function Plant({ x, y, scale: _scale = 1 }: { x: number; y: number; scale?: number }) {
  // `x, y` is the middle of the plant; the art is anchored at a corner.
  const c = spriteCentreOffset('prop.plant');
  return (
    <g>
      <GroundShadow cx={x} cy={y} r={17} />
      <Sprite name="prop.plant" x={x - c.x} y={y - c.y} />
    </g>
  );
}

/**
 * A bay partition: the low panel that bounds one unit's workspace.
 *
 * StarNet's unit is a bay, and a bay is what its own partitions enclose, a room
 * only says which department, not where one person's place ends and the next
 * begins. `prop.partition.1` is one bay's worth, `.2` two, `prop.partition` a run
 * of three, all of them drawn from the atlas like everything else here.
 */
export function Partition({ at, tiles = 1 }: { at: { x: number; y: number }; tiles?: 1 | 2 | 3 }) {
  const name = tiles === 1 ? 'prop.partition.1' : tiles === 2 ? 'prop.partition.2' : 'prop.partition';
  return <Sprite name={name} x={at.x} y={at.y} />;
}

/** A whiteboard / glass board on a wall, with scribbles. */
export function Whiteboard({ x, y, w = 120, h: _h = 56 }: { x: number; y: number; w?: number; h?: number }) {
  // The atlas has ONE board, and `scaleForWidth` reads its actual width out of the
  // entry: the caller's width becomes a scale. Without this the lab's 74-unit board
  // was drawn at its art's two metres and read as a wall of its own, the board
  // stopping respecting its caller is what "why did the lab change" was. The height
  // is the atlas's: a board of a different SHAPE belongs in the atlas, not in a
  // stretched sprite.
  //
  // The width used to be divided by a hand-typed `2 × UNITS_PER_METRE`, a number
  // that was supposed to be the art's width, was wrong by 17%, and would have been
  // wrong again the moment the art changed.
  return <Sprite name="prop.whiteboard" x={x} y={y} scale={scaleForWidth('prop.whiteboard', w)} />;
}

/** The coffee counter idle characters gather at. */
export function CoffeeBar({ x, y, w = 150 }: { x: number; y: number; w?: number }) {
  const z = mh(0.95);
  return (
    <g>
      <GroundShadow cx={x + w / 2} cy={y + 14} r={w * 0.5} />
      {/* The counter stays a box, a counter is a box, and the machine on it is a
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

/**
 * A table with chairs, for review and stand-ups.
 *
 * A SURFACE, in StarNet's taxonomy, the thing you place that gives a place to work
 *, so it is a sprite, and the chairs around it are the same chair sprite the desks
 * use. The caller's width becomes a scale: the atlas has one table, three metres
 * across, and a room that asks for two gets two.
 */
export function MeetingTable({ x, y, w = 210, d: _d = 96, seats = 4 }: { x: number; y: number; w?: number; d?: number; seats?: number }) {
  const step = w / (seats + 1);
  const s = scaleForWidth('prop.table.3', w);
  // The chairs stand against the ART's own near and far edges, not against the bay
  // the caller described. The table is 3 × 1 m of art scaled to `w`, so its depth is
  // `b × s`; a chair sits half a chair outside that. Hand-placed offsets are what put
  // a row of chairs 20 cm clear of their own table the moment the table moved.
  const fp = spriteFootprint('prop.table.3');
  const depth = (fp?.b ?? 100) * s;
  const clear = spriteCentreOffset('prop.chair.turned').y * 1.2;
  return (
    <g>
      <GroundShadow cx={x + w / 2} cy={y + depth / 2} r={Math.max(w, depth) * 0.5} />
      <Sprite name="prop.table.3" x={x} y={y} scale={s} />
      {Array.from({ length: seats }, (_, i) => (
        <Chair key={`s${i}`} at={{ x: x + step * (i + 1), y: y + depth + clear }} color="#22262f" turned />
      ))}
      <Chair at={{ x: x + step, y: y - clear }} />
      <Chair at={{ x: x + w - step, y: y - clear }} />
    </g>
  );
}

/**
 * A round table: a cylinder, so it has a lit elliptical top and a visible side.
 *
 * Used in the break corner, where the point is that people sit *together*, the
 * chairs come from `breakSeats()` in the floor plan, which is the same list the
 * simulation seats people on, so a chair and its sitter can never disagree.
 */
export function RoundTable({ at, r = 34, color: _color = '#4a3f2e' }: { at: { x: number; y: number }; r?: number; color?: string }) {
  // A surface like the rest: round in plan is what the atlas draws, and the radius
  // the floor plan hands out (the same one the simulation seats people around)
  // becomes the scale.
  const s = scaleForWidth('prop.roundtable', 2 * r);
  // `at` is the table's centre; the art is anchored at its footprint's far corner,
  // so it comes back by half the footprint, scaled with it.
  const c = spriteCentreOffset('prop.roundtable');
  return (
    <g>
      <GroundShadow cx={at.x} cy={at.y} r={r * 1.1} />
      <Sprite name="prop.roundtable" x={at.x - c.x * s} y={at.y - c.y * s} scale={s} />
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

export { DESK_W, UNITS_PER_METRE };
