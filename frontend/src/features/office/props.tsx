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
import { UNITS_PER_METRE, boxFaces, floorRect, mh, project } from './iso';

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

/** A solid box standing on the floor. */
export function Box({
  x,
  y,
  w,
  d,
  h,
  color,
  top,
  opacity = 1,
  stroke,
}: {
  x: number;
  y: number;
  w: number;
  d: number;
  h: number;
  color: string;
  /** Override the lit top face (e.g. a polished surface). */
  top?: string;
  opacity?: number;
  stroke?: string;
}) {
  const faces = boxFaces(x, y, w, d, h);
  return (
    <g opacity={opacity} stroke={stroke} strokeWidth={stroke ? 1 : undefined}>
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
      {children}
    </g>
  );
}

const DESK_SLAB_D = 58;
export const DESK_H_M = 0.74;
export const DESK_Z = mh(DESK_H_M);

/**
 * A workstation: the desk, the monitor on it, and the chair the occupant sits on.
 * `busy` lights the monitor, which is how a glance tells you who is working.
 */
export function Workstation({
  x,
  y,
  color = '#2b3242',
  busy = false,
  glow = '#7cc4ff',
  screen = true,
}: {
  x: number;
  y: number;
  color?: string;
  busy?: boolean;
  glow?: string;
  screen?: boolean;
}) {
  const mid = x + DESK_W / 2;
  const chairZ = mh(0.45);
  return (
    <g>
      <GroundShadow cx={x + DESK_W / 2} cy={y + DESK_SLAB_D / 2} r={DESK_W * 0.42} />
      {/* Chair behind the occupant (the +y side is nearer the viewer). */}
      <Box x={mid - 26} y={y + 64} w={52} d={44} h={chairZ} color="#1c1f26" />
      <Box x={mid - 26} y={y + 100} w={52} d={8} h={chairZ + 46} color="#1c1f26" />
      {/* Desk. */}
      <Box x={x} y={y} w={DESK_W} d={DESK_SLAB_D} h={DESK_Z} color={color} top={shade(color, 1.2)} />
      {screen && (
        <>
          {/* Monitor: a stand, then an upright panel facing the room. */}
          <Box x={mid - 12} y={y + 12} w={24} d={10} h={DESK_Z + 6} color="#20242e" />
          <Panel
            at={{ x: mid, y: y + 17 }}
            w={80}
            h={46}
            tilt={DESK_Z + 6}
            fill={busy ? mix('#101b2c', glow, 0.4) : '#131c29'}
            edge="#4d5a73"
          >
            {/* A screen is never quite off: a lit line or two reads as content. */}
            <rect x={mid - 36} y={y + 17 - 46 + 6} width={72} height={34} rx={2} fill={busy ? glow : '#2b6ea8'} opacity={busy ? 0.3 : 0.22} />
            {[0, 1, 2].map((row) => (
              <rect
                key={row}
                x={mid - 32}
                y={y + 17 - 46 + 11 + row * 9}
                width={(busy ? 58 : 44) * [1, 0.8, 0.62][row]}
                height={3}
                rx={1.5}
                fill={busy ? '#cfe6ff' : '#7ea6c9'}
                opacity={busy ? 0.85 : 0.5}
              />
            ))}
          </Panel>
        </>
      )}
      {/* Keyboard and the small desk clutter that makes a desk feel used. */}
      <Box x={mid - 34} y={y + 30} w={68} d={20} h={DESK_Z + 3} color="#232935" top="#3a4354" />
      <Box x={x + 6} y={y + 8} w={13} d={13} h={DESK_Z + 15} color={busy ? '#e0a458' : '#3a4152'} />
      <Box x={x + DESK_W - 26} y={y + 10} w={22} d={30} h={DESK_Z + 4} color="#333b4b" top="#5a6478" />
    </g>
  );
}

/** A potted plant — the cheapest way to make an office look alive. */
export function Plant({ x, y, scale = 1 }: { x: number; y: number; scale?: number }) {
  const pot = 20 * scale;
  return (
    <g>
      <GroundShadow cx={x} cy={y} r={pot * 0.85} />
      <Box x={x - pot / 2} y={y - pot / 2} w={pot} d={pot} h={mh(0.3)} color="#43352a" />
      {[
        [-14, -8, 22],
        [12, -12, 20],
        [-2, -22, 26],
        [18, 4, 17],
        [-20, 6, 15],
      ].map(([dx, dy, s], i) => (
        <ellipse
          key={i}
          cx={project(x + dx * scale, y + dy * scale).x}
          cy={project(x + dx * scale, y + dy * scale).y - mh(0.34) - (3 - (i % 3)) * 5 * scale}
          rx={s * 0.62 * scale}
          ry={s * 0.5 * scale}
          fill={i % 2 === 0 ? '#2f7a4f' : '#3d9160'}
        />
      ))}
    </g>
  );
}

/** A whiteboard / glass board on a wall, with scribbles. */
export function Whiteboard({ x, y, w = 120, h = 56 }: { x: number; y: number; w?: number; h?: number }) {
  const p = project(x, y);
  const base = p.y - mh(0.5);
  return (
    <g>
      <rect x={p.x - w / 2} y={base - h} width={w} height={h} rx={4} fill="#1b2331" stroke="#4a566d" strokeWidth={1.5} />
      <rect x={p.x - w / 2 + 3} y={base - h + 3} width={w - 6} height={h - 6} rx={3} fill="#151c28" />
      {[0, 1, 2].map((row) => (
        <rect
          key={row}
          x={p.x - w / 2 + 12}
          y={base - h + 14 + row * 13}
          width={(w - 34) * [1, 0.72, 0.86][row]}
          height={3.5}
          rx={2}
          fill={row === 0 ? '#6f9de0' : '#8b98ad'}
          opacity={row === 0 ? 0.9 : 0.55}
        />
      ))}
      <rect x={p.x + w / 2 - 24} y={base - h + 32} width={14} height={14} rx={2} fill="#e0a458" opacity={0.75} />
    </g>
  );
}

/** The coffee counter idle characters gather at. */
export function CoffeeBar({ x, y, w = 150 }: { x: number; y: number; w?: number }) {
  const z = mh(0.95);
  return (
    <g>
      <GroundShadow cx={x + w / 2} cy={y + 14} r={w * 0.5} />
      <Box x={x} y={y} w={w} d={30} h={z} color="#3a3026" top="#4d4033" />
      {/* Machine. */}
      <Box x={x + 12} y={y - 6} w={54} d={26} h={z + 42} color="#232935" top="#39435a" />
      <rect
        x={project(x + 39, y + 7).x - 20}
        y={project(x + 39, y + 7).y - z - 30}
        width={40}
        height={20}
        rx={3}
        fill="#0d1117"
      />
      <rect
        x={project(x + 39, y + 7).x - 16}
        y={project(x + 39, y + 7).y - z - 12}
        width={32}
        height={6}
        rx={3}
        fill="#e0a458"
      />
      {/* Cups and a kettle. */}
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
          <Box x={x + step * (i + 1) - 22} y={y + d + 6} w={44} d={40} h={chairZ} color="#1c1f26" />
        </g>
      ))}
      <Box x={x + step - 22} y={y - 46} w={44} d={40} h={chairZ} color="#1c1f26" />
      <Box x={x + w - step - 22} y={y - 46} w={44} d={40} h={chairZ} color="#1c1f26" />
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

export { DESK_H, DESK_W, UNITS_PER_METRE };
