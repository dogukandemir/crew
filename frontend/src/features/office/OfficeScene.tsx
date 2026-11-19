/**
 * The office, drawn as one flat SVG scene.
 *
 * Every wall, desk, chair and monitor is a **volume**: a lit top face plus two
 * shaded side faces built by `iso.ts`. Verticals stay vertical, so people stand
 * up, the failure mode of the previous version, where a tilted 3D plane squashed
 * the vertical axis and made everyone look like they were lying on the floor.
 *
 * Order is painter's order: the earth slab, then the floor and walkways, then the
 * rooms (far to near), then the people (far to near, by where they are headed),
 * so somebody standing behind a desk is drawn behind it.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { OrgNode } from '../../api/types';
import type { Activity, Speech, SpeechKind } from '../../sim/activity';
import {
  BREAK_TABLE_R,
  DESK_W,
  ROOM_PAD,
  ROOM_HEADER,
  SPINE_W,
  breakSeats,
  deskSeat,
  meetingLayout,
  type Office,
  type Room,
} from '../../sim/floorplan';
import type { FloorPulse } from '../../sim/rooms';
import { deskInUse, type Target } from '../../sim/targets';
import type { SpriteMotionRef as SvgMotionRef } from '../sprites/SpriteCharacter';
import { SPRITE_UNIT, scaleForWidth, spriteTiles, spriteCentreOffset, spriteFootprint } from '../sprites/sprites';
import { Bubble } from './Bubble';
import { SpriteCharacter } from '../sprites/SpriteCharacter';
import type { ReactNode } from 'react';
import { mh, boxFaces, floorRect, polyPoints, project } from './iso';
import {
  Box,
  Cabinet,
  Chair,
  CoffeeBar,
  Crate,
  FloorLamp,
  FoosballTable,
  GroundShadow,
  MeetingTable,
  Panel,
  Plant,
  Printer,
  RoundTable,
  VendingMachine,
  Whiteboard,
  Workstation,
  mix,
  shade,
} from './props';
import { Partition, UNITS_PER_METRE } from './props';
import { Sprite as AtlasSprite } from '../sprites/Sprite';
import { spriteScaleFactor } from '../sprites/viewScale';
import { routeBetween } from '../../sim/paths';
import { cn } from '../../lib/cn';

const FLOOR = '#1b2536';
const WALK = '#2b3852';
/** The kerb along a road: what makes a corridor read as a way, not a gap. */
const KERB = '#5b7095';
const WALL_H = mh(0.98);
const WALL_T = 7;
const SLAB = 34;
/** Air around the building, so the slab reads as a thing sitting in space. */
const PAD = 46;

/**
 * The lab bench's worktop height, in world units.
 *
 * Stated here as well as in the atlas generator, `props/lab.ts` draws the worktop at 0.92 m
 *, because a thing standing ON the bench needs it, and the atlas does not carry a
 * height per entry. It is in the audit's open list: the honest fix is a `height`
 * field in the manifest, so the two cannot drift.
 */
const LAB_BENCH_TOP = mh(0.92);

/**
 * How tall a person is, in world units, at the atlas's own scale.
 *
 * Derived the way every sprite is: 40 px of figure at `SPRITE_UNIT`, 1.67 m. It
 * used to be `mh(1.5) × 100 / 92`, a number inherited from the hand-drawn vector
 * rig the atlas replaced, which the character sprite then divided by 40 and
 * multiplied by a view factor, drawing people 0.56 m tall beside full-size desks.
 */
export const FIGURE_H = 40 * SPRITE_UNIT;
const CHAR_W = FIGURE_H * 0.64;
const FEET_Y = FIGURE_H;
/** How far the feet sink into their own contact shadow. */
const FEET_SINK = 2;

/** The emoji bubble's skin, so a blocked character does not look chatty. */
function emojiKind(activity: Activity): 'talk' | 'report' | 'escalation' {
  if (activity.kind === 'blocked' || activity.kind === 'waiting') return 'escalation';
  if (activity.kind === 'celebrating') return 'report';
  return 'talk';
}

/* ── Signage ──────────────────────────────────────────────────────────────── */

export interface SignRow {
  text: string;
  fill: string;
}

export interface SignLayout {
  name: string;
  rows: SignRow[];
  w: number;
  h: number;
}

/** Status lines are not mission statements: they are clamped to fit the board. */
const ROW_CHARS = 32;
/** 9 px font, plus the board's padding. */
const ROW_W = (t: string) => t.length * 5 + 26;
/** 16 px bold, plus the board's padding. */
const NAME_W = (t: string) => t.length * 7.4 + 32;

const clampText = (t: string, max = ROW_CHARS) => (t.length > max ? `${t.slice(0, max - 1)}…` : t);

/**
 * The board's own layout: one stack of lines, one plate measured around them.
 *
 * The status lines used to be drawn AT the plate's bottom edge with no width of
 * their own, "3 seats · 2 working · 1 stuck" ran wider than the board it belonged
 * to, so it hung out over both sides and through the edge, and a department's
 * mission collided with it from above. A line is a row now: the plate's width is
 * the widest row's, its height is the stack's, and no row can leave the plate
 * because every row is clamped before it is measured.
 */
export function signLayout(
  room: { name: string; subtitle?: string },
  pulse?: FloorPulse['rooms'][string],
): SignLayout {
  const name = room.name.length > 20 ? `${room.name.slice(0, 19)}…` : room.name;
  const rows: SignRow[] = [];
  if (room.subtitle) rows.push({ text: clampText(room.subtitle), fill: '#8b98ad' });
  if (pulse && (pulse.shipped > 0 || pulse.seats > 0)) {
    rows.push({
      text: clampText(
        `${pulse.seats} seats${pulse.working > 0 ? ` · ${pulse.working} working` : ''}${
          pulse.blocked > 0 ? ` · ${pulse.blocked} stuck` : ''
        }`,
      ),
      fill: pulse.blocked ? '#e2a0a0' : '#7d8ba1',
    });
  }
  if (pulse?.shipped) {
    rows.push({
      text: clampText(
        `✓ ${pulse.shipped} shipped${pulse.lastOutput ? ` · ${pulse.lastOutput.title}` : ''}`,
      ),
      fill: '#8ed7ac',
    });
  }
  const w = Math.max(96, NAME_W(name), ...rows.map((r) => ROW_W(r.text)));
  const h = 30 + rows.length * 11;
  return { name, rows, w, h };
}

function Sign({ room, pulse, stagger = 0 }: { room: Room; pulse?: FloorPulse['rooms'][string]; stagger?: number }) {
  // Boards on the same shelf row are lifted in turn, so neighbours never cover
  // each other's name.
  const p = project(room.x + room.w / 2, room.y, WALL_H + 30 + stagger * 34);
  const busy = (pulse?.producing ?? 0) > 0;
  const { name, w, h, rows } = signLayout(room, pulse);

  // The board hangs from the wall rather than floating above it. The post is what
  // gives a plate at that height a reason to be there.
  const wallTop = project(room.x + room.w / 2, room.y, WALL_H);
  return (
    <g>
      {/* A soft aura, the board's shadow, and its post. */}
      <rect
        x={p.x - w / 2 - 5}
        y={p.y - h - 5}
        width={w + 10}
        height={h + 10}
        rx={9}
        fill={room.accent}
        opacity={0.08}
      />
      <line x1={p.x} y1={wallTop.y} x2={p.x} y2={p.y} stroke="#1b2537" strokeWidth={3} />
      <line x1={p.x - 1} y1={wallTop.y} x2={p.x - 1} y2={p.y} stroke={mix('#3a4a63', room.accent, 0.35)} strokeWidth={1} />
      <rect x={p.x - w / 2 + 2} y={p.y - h + 3} width={w} height={h} rx={5} fill="#05080d" opacity={0.45} />
      {/* The board. */}
      <rect x={p.x - w / 2} y={p.y - h} width={w} height={h} rx={5} fill="#101725" opacity={0.97} />
      <rect x={p.x - w / 2} y={p.y - h} width={w} height={3} rx={1.5} fill={room.accent} />
      <rect
        x={p.x - w / 2}
        y={p.y - h}
        width={w}
        height={h}
        rx={5}
        fill="none"
        stroke={mix('#101725', room.accent, 0.55)}
        strokeWidth={1}
      />
      {/* A screw in each corner: the plate is mounted, not drawn on the air. */}
      {[[p.x - w / 2 + 6, p.y - h + 9], [p.x + w / 2 - 6, p.y - h + 9]].map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={1.4} fill={mix('#5b6c88', room.accent, 0.4)} />
      ))}
      <text x={p.x} y={p.y - h + 17} fontSize={16} fontWeight={700} fill="#eef2f8" textAnchor="middle" stroke="#0b0e14" strokeWidth={3.2} paintOrder="stroke">
        {name}
      </text>
      {rows.map((row, i) => (
        <text key={row.text} x={p.x} y={p.y - h + 28 + i * 11} fontSize={9} fill={row.fill} textAnchor="middle">
          {row.text}
        </text>
      ))}

      {/* The production marker: this department is making something right now. */}
      {busy && (
        <g className="room-producing" transform={`translate(${p.x - w / 2 + 10} ${p.y - h - 12})`}>
          <rect x={0} y={-9} width={62} height={16} rx={8} fill={mix('#0f1a16', '#5fbf8f', 0.3)} stroke="#5fbf8f" />
          <circle cx={9} cy={-1} r={3.2} fill="#7ce0a8" className="pulse-dot" />
          <text x={17} y={3} fontSize={8.5} fill="#bff0d4">
            producing{pulse && pulse.producing > 1 ? ` ×${pulse.producing}` : ''}
          </text>
        </g>
      )}

      {/* Newly opened department. */}
      {pulse?.brandNew && (
        <g transform={`translate(${p.x + w / 2 - 4} ${p.y - h - 12})`}>
          <rect x={-34} y={-9} width={38} height={16} rx={8} fill="#3b2a12" stroke="#e0a458" />
          <text x={-15} y={3} fontSize={8.5} fill="#f2cd94" textAnchor="middle">
            new
          </text>
        </g>
      )}

      {/* The seats / shipped lines live INSIDE the board now, laid out with the name
          by `signLayout`, drawn at the plate's edge they overhung it. */}
    </g>
  );
}

/* ── One room ─────────────────────────────────────────────────────────────── */

/** A quad on a wall running along x (the far/left wall's inner face). */
function wallX(x0: number, x1: number, y: number, z0: number, z1: number): string {
  return polyPoints([
    project(x0, y, z0),
    project(x1, y, z0),
    project(x1, y, z1),
    project(x0, y, z1),
  ]);
}

/** A quad on a wall running along y (the far/right wall's inner face). */
function wallY(x: number, y0: number, y1: number, z0: number, z1: number): string {
  return polyPoints([
    project(x, y0, z0),
    project(x, y1, z0),
    project(x, y1, z1),
    project(x, y0, z1),
  ]);
}

/**
 * A window onto the city at night.
 *
 * The office had no outside at all: every wall was a coloured panel, and the
 * floor read as a room in a box. One window with a sky, a moon and a skyline
 * gives it a world, and the warm windows in the buildings echo the warm lamps
 * inside. It is drawn on the wall's own face, in metres, not as a floating panel.
 */
function CityWindow({ room, x0, x1 }: { room: Room; x0: number; x1: number }) {
  const y = room.y + WALL_T + 0.4;
  const z0 = mh(0.32);
  const z1 = mh(0.86);
  const inner = { x0: x0 + mh(0.035), x1: x1 - mh(0.035), z0: z0 + mh(0.03), z1: z1 - mh(0.03) };
  const midX = (inner.x0 + inner.x1) / 2;
  const midZ = (inner.z0 + inner.z1) / 2;
  // A deterministic skyline per room: the glass is the same frame, the city is
  // built from the room's own id, so a rebuild does not shuffle the skyline.
  const seed = [...room.id].reduce((n, ch) => n + ch.charCodeAt(0), 0);
  const buildings = Array.from({ length: 9 }, (_, i) => {
    const w = (inner.x1 - inner.x0) / 9;
    const x = inner.x0 + i * w;
    const top = inner.z0 + mh(0.07 + ((seed + i * 13) % 17) / 100);
    return { x, w, top };
  });
  const moonX = inner.x1 - mh(0.12);
  const moonZ = inner.z1 - mh(0.1);
  const moon = project(moonX, y, moonZ);

  return (
    <g>
      <polygon points={wallX(x0, x1, y, z0, z1)} fill="#0a0f18" />
      <polygon
        points={wallX(x0 + 1, x1 - 1, y, z0 + 1, z1 - 1)}
        fill="#0d1726"
        stroke={mix('#3d4c63', room.accent, 0.2)}
        strokeWidth={2}
      />
      <polygon points={wallX(inner.x0, inner.x1, y, inner.z0, inner.z1)} fill="url(#office-window)" />
      {/* A warm haze at the horizon, so the glass reads as sky behind a city and
          not as a dark monitor on the wall. */}
      <polygon
        points={wallX(inner.x0, inner.x1, y, inner.z0, inner.z0 + (inner.z1 - inner.z0) * 0.32)}
        fill="#c08a55"
        opacity={0.22}
      />
      <circle cx={moon.x} cy={moon.y} r={mh(0.055)} fill="#f4ebd0" opacity={0.95} />
      <circle cx={moon.x} cy={moon.y} r={mh(0.13)} fill="#f4ebd0" opacity={0.08} />
      {buildings.map((b, i) => (
        <g key={i}>
          <polygon
            points={wallX(b.x, b.x + b.w * 0.86, y, inner.z0, b.top)}
            fill={i % 3 === 0 ? '#101b2c' : '#0d1b2e'}
          />
          <polygon
            points={wallX(b.x, b.x + b.w * 0.86, y, b.top - mh(0.012), b.top)}
            fill="#4f6d8d"
            opacity={0.5}
          />
          {/* Two or three lit windows in a dark tower. */}
          {Array.from({ length: 2 }, (_, k) => (
            <polygon
              key={k}
              points={wallX(
                b.x + b.w * (0.16 + k * 0.28),
                b.x + b.w * (0.16 + k * 0.28) + b.w * 0.12,
                y,
                inner.z0 + mh(0.05 + k * 0.1),
                inner.z0 + mh(0.075 + k * 0.1),
              )}
              fill="#d9a75b"
              opacity={0.55}
            />
          ))}
        </g>
      ))}
      {/* Mullions: one vertical, one horizontal, with the frame's own thickness. */}
      <polygon points={wallX(midX - 2, midX + 2, y, inner.z0, inner.z1)} fill="#0a0f18" opacity={0.9} />
      <polygon points={wallX(inner.x0, inner.x1, y, midZ - 1.5, midZ + 1.5)} fill="#0a0f18" opacity={0.9} />
      {/* The sill, and the light it catches from the room. */}
      <polygon points={wallX(x0 - 2, x1 + 2, y, z0 - mh(0.035), z0)} fill={shade(mix('#3a4964', room.accent, 0.3), 1.15)} />
      <polygon
        points={wallX(inner.x0, inner.x1, y, inner.z0, inner.z0 + mh(0.02))}
        fill={mix('#7fb4d8', '#e8dfc4', 0.35)}
        opacity={0.25}
      />
    </g>
  );
}

/** A framed print on the side wall: two bands and a sun, which is enough. */
function WallArt({ room, x, y0, y1 }: { room: Room; x: number; y0: number; y1: number }) {
  const z0 = mh(0.44);
  const z1 = mh(0.84);
  const inner = { y0: y0 + mh(0.04), y1: y1 - mh(0.04), z0: z0 + mh(0.04), z1: z1 - mh(0.04) };
  return (
    <g>
      <polygon points={wallY(x, y0, y1, z0, z1)} fill="#0a0f17" />
      <polygon
        points={wallY(x, inner.y0, inner.y1, inner.z0, inner.z1)}
        fill={mix('#20334a', room.accent, 0.25)}
      />
      {/* A horizon and a low sun, in the accent's own warm complement. */}
      <polygon
        points={wallY(x, inner.y0, inner.y1, inner.z0, inner.z0 + (inner.z1 - inner.z0) * 0.36)}
        fill={mix('#8d5a3c', room.accent, 0.3)}
      />
      <polygon
        points={wallY(
          x,
          inner.y0 + (inner.y1 - inner.y0) * 0.1,
          inner.y1 - (inner.y1 - inner.y0) * 0.35,
          inner.z0 + (inner.z1 - inner.z0) * 0.3,
          inner.z0 + (inner.z1 - inner.z0) * 0.7,
        )}
        fill="#d9a75b"
        opacity={0.7}
      />
      <polygon points={wallY(x, inner.y0, inner.y1, inner.z0 + 1, inner.z0 + 2)} fill="#e8dfc4" opacity={0.25} />
    </g>
  );
}

/**
 * A rug.
 *
 * The office floor is a hard surface; a rug is what makes a meeting corner read
 * as a place to sit rather than a rectangle with a table in it. Drawn at floor
 * level in the room's own coordinates, so furniture stands on it.
 */
function Rug({ room }: { room: Room }) {
  const centre = project(room.x + room.w / 2, room.y + room.h / 2, 1);
  if (room.kind === 'meeting') {
    const rx = room.w * 0.34;
    const ry = rx * 0.5;
    return (
      <g opacity={0.95}>
        <ellipse cx={centre.x} cy={centre.y} rx={rx} ry={ry} fill={mix('#3b2a42', room.accent, 0.25)} />
        <ellipse cx={centre.x} cy={centre.y} rx={rx - 6} ry={ry - 3} fill="none" stroke="#b98a52" strokeWidth={1.4} opacity={0.7} />
        <ellipse cx={centre.x} cy={centre.y} rx={rx * 0.7} ry={ry * 0.7} fill="none" stroke="#7e5d38" strokeWidth={1} opacity={0.6} />
        {/* A woven diamond field, two lines deep. */}
        {Array.from({ length: 6 }, (_, i) => {
          const t = (i + 1) / 7;
          return (
            <ellipse
              key={i}
              cx={centre.x}
              cy={centre.y}
              rx={rx * t}
              ry={ry * t}
              fill="none"
              stroke="#8f6c44"
              strokeWidth={0.8}
              opacity={0.3}
            />
          );
        })}
      </g>
    );
  }
  if (room.kind === 'commons' || room.kind === 'break') {
    const insetX = room.w * 0.16;
    const insetY = room.h * 0.18;
    return (
      <g opacity={0.95}>
        <polygon
          points={floorRect(room.x + insetX, room.y + insetY, room.w - insetX * 2, room.h - insetY * 2, 1)}
          fill={mix('#3b2a42', room.accent, 0.2)}
        />
        <polygon
          points={floorRect(room.x + insetX + 5, room.y + insetY + 4, room.w - insetX * 2 - 10, room.h - insetY * 2 - 8, 1)}
          fill="none"
          stroke="#b98a52"
          strokeWidth={1.2}
          opacity={0.55}
        />
        <polygon
          points={floorRect(room.x + insetX + 12, room.y + insetY + 9, room.w - insetX * 2 - 24, room.h - insetY * 2 - 18, 1)}
          fill="none"
          stroke={mix('#8f6c44', room.accent, 0.4)}
          strokeWidth={0.8}
          opacity={0.5}
        />
      </g>
    );
  }
  return null;
}

/** The shell: floor, rug, walls and their dressing. Behind everything a room contains. */
function RoomShell({ room, focused, newRoom }: { room: Room; focused: boolean; newRoom: boolean }) {
  const wall = mix('#3a4964', room.accent, 0.34);
  const accentSoft = mix('#12161f', room.accent, 0.55);
  const inner = mix('#263346', room.accent, 0.17);
  const yFace = room.y + WALL_T + 0.4;
  const xFace = room.x + WALL_T + 0.4;
  const warm = room.kind === 'lab' || room.kind === 'bench' ? 'url(#office-cool)' : 'url(#office-lamp)';
  const floorCentre = project(room.x + room.w / 2, room.y + room.h / 2, 2);

  // A window on the long wall for the rooms people sit in; a print for the rest.
  const windowRoom = ['department', 'orchestrator', 'meeting', 'commons', 'lab'].includes(room.kind);
  const windowX0 = room.x + room.w * 0.5;
  const windowX1 = room.x + room.w * 0.94;
  const artY0 = room.y + room.h * 0.3;
  const artY1 = artY0 + mh(0.9);

  const grid: string[] = [];
  for (let gx = 52; gx < room.w - 12; gx += 52) {
    grid.push(polyPoints([project(room.x + gx, room.y + 4, 1), project(room.x + gx, room.y + room.h - 4, 1)]));
  }
  for (let gy = 52; gy < room.h - 12; gy += 52) {
    grid.push(polyPoints([project(room.x + 4, room.y + gy, 1), project(room.x + room.w - 4, room.y + gy, 1)]));
  }

  return (
    <g className={cn('room', focused && 'is-focused', newRoom && 'is-new')}>
      {/* The room sits a couple of centimetres proud of the corridor, and this is
          the shadow that says so. A room drawn flush with the floor reads as a
          colour, not a place. */}
      <polygon points={floorRect(room.x + 3, room.y + 4, room.w, room.h, 0)} fill="#05080d" opacity={0.7} />
      {/* The room's own floor, a warm tinted slab under everything. */}
      <polygon points={floorRect(room.x, room.y, room.w, room.h, 0)} fill={inner} />
      <polygon
        points={floorRect(room.x + 5, room.y + 5, room.w - 10, room.h - 10, 1)}
        fill={room.accent}
        opacity={focused ? 0.2 : 0.13}
      />
      {/* Tile joints: a floor is a surface with seams, not a flat colour. */}
      {grid.map((points, i) => (
        <polyline
          key={`g${i}`}
          points={points}
          fill="none"
          stroke={mix('#9fb0cb', room.accent, 0.35)}
          strokeWidth={0.7}
          opacity={0.06}
        />
      ))}
      <Rug room={room} />
      {/* A lit pool from the room's own ceiling light. It sits OVER the rug and
          UNDER the furniture, which is what makes the floor feel lit rather than
          tinted, and stops a dark rug swallowing the room's glow. */}
      <ellipse
        cx={floorCentre.x}
        cy={floorCentre.y}
        rx={room.w * 0.6}
        ry={room.h * 0.45}
        fill={warm}
        opacity={0.8}
        style={{ mixBlendMode: 'screen' }}
      />
      <polygon
        points={floorRect(room.x + 9, room.y + 9, room.w - 18, room.h - 18, 1)}
        fill="none"
        stroke={room.accent}
        strokeWidth={focused ? 2.2 : 1.2}
        opacity={focused ? 0.9 : 0.55}
      />
      {/* The doorway: a threshold and the light spilling out of the room. */}
      <ellipse
        cx={project(room.door.x, room.y + room.h, 2).x}
        cy={project(room.door.x, room.y + room.h, 2).y}
        rx={44}
        ry={20}
        fill={warm}
        opacity={0.4}
        style={{ mixBlendMode: 'screen' }}
      />
      <polygon
        points={floorRect(room.door.x - 28, room.y + room.h - 9, 56, 18, 2)}
        fill="#0b1119"
        stroke={room.accent}
        strokeWidth={1}
        opacity={0.85}
      />
      <polygon
        points={floorRect(room.door.x - 23, room.y + room.h - 6, 46, 12, 2)}
        fill={room.accent}
        opacity={0.16}
      />

      {/* Two partition walls on the far edges, so they never hide the room.
          Taller and lighter than before: the wall is a room's edge, not a bar. */}
      <polygon points={boxFaces(room.x, room.y, room.w, WALL_T, WALL_H).front} fill={shade(wall, 0.68)} />
      <polygon points={boxFaces(room.x, room.y, room.w, WALL_T, WALL_H).right} fill={shade(wall, 0.84)} />
      <polygon
        points={boxFaces(room.x, room.y, room.w, WALL_T, WALL_H).top}
        fill={shade(wall, 1.3)}
        stroke={accentSoft}
        strokeWidth={1.5}
      />
      <polygon points={boxFaces(room.x, room.y, WALL_T, room.h, WALL_H).front} fill={shade(wall, 0.66)} />
      <polygon points={boxFaces(room.x, room.y, WALL_T, room.h, WALL_H).right} fill={shade(wall, 0.82)} />
      <polygon
        points={boxFaces(room.x, room.y, WALL_T, room.h, WALL_H).top}
        fill={shade(wall, 1.3)}
        stroke={accentSoft}
        strokeWidth={1.5}
      />

      {/* Skirting and crown: the two horizontal lines that read as fit-out. */}
      <polygon points={wallX(room.x, room.x + room.w, yFace, 0, mh(0.07))} fill="#090e16" opacity={0.9} />
      <polygon
        points={wallX(room.x, room.x + room.w, yFace, WALL_H - mh(0.055), WALL_H)}
        fill={mix('#4b5d7c', room.accent, 0.4)}
        opacity={0.9}
      />
      <polygon points={wallY(xFace, room.y, room.y + room.h, 0, mh(0.07))} fill="#090e16" opacity={0.9} />
      <polygon
        points={wallY(xFace, room.y, room.y + room.h, WALL_H - mh(0.055), WALL_H)}
        fill={mix('#4b5d7c', room.accent, 0.4)}
        opacity={0.9}
      />
      {/* Panel joints, at the same pitch as the floor tiles. */}
      {Array.from({ length: Math.max(1, Math.floor(room.w / 76)) }, (_, i) => {
        const x = room.x + 38 + i * 76;
        return (
          <line
            key={`sx${i}`}
            x1={project(x, yFace, mh(0.08)).x}
            y1={project(x, yFace, mh(0.08)).y}
            x2={project(x, yFace, WALL_H - mh(0.08)).x}
            y2={project(x, yFace, WALL_H - mh(0.08)).y}
            stroke="#0b1119"
            strokeWidth={1}
            opacity={0.4}
          />
        );
      })}
      {Array.from({ length: Math.max(1, Math.floor(room.h / 76)) }, (_, i) => {
        const y = room.y + 38 + i * 76;
        return (
          <line
            key={`sy${i}`}
            x1={project(xFace, y, mh(0.08)).x}
            y1={project(xFace, y, mh(0.08)).y}
            x2={project(xFace, y, WALL_H - mh(0.08)).x}
            y2={project(xFace, y, WALL_H - mh(0.08)).y}
            stroke="#0b1119"
            strokeWidth={1}
            opacity={0.4}
          />
        );
      })}
      <polygon
        points={wallX(room.x, room.x + room.w, yFace, WALL_H - mh(0.16), WALL_H - mh(0.145))}
        fill={room.accent}
        opacity={0.4}
      />
      <polygon
        points={wallY(xFace, room.y, room.y + room.h, WALL_H - mh(0.16), WALL_H - mh(0.145))}
        fill={room.accent}
        opacity={0.4}
      />

      {windowRoom && <CityWindow room={room} x0={windowX0} x1={windowX1} />}
      {!windowRoom && (
        <WallArt room={room} x={xFace} y0={artY0} y1={artY1} />
      )}
      {room.kind === 'department' || room.kind === 'orchestrator' || room.kind === 'meeting' ? (
        <WallArt room={room} x={xFace} y0={room.y + room.h * 0.52} y1={room.y + room.h * 0.52 + mh(0.7)} />
      ) : null}
    </g>
  );
}

/**
 * A conveyor: two rails and the ties across them. StarNet's floor is a station.
 *
 * The ties are far apart and the lines thin on purpose. At a tie every 30 units
 * across a 22-unit-wide path this was a ladder over the whole corridor network, and
 * a floor covered in ladder reads as clutter long before it reads as a conveyor,
 * the concept is a floor that moves work around, not one that shouts about it.
 */
function Conveyor({ from, to, half = 11, tie = 96 }: { from: { x: number; y: number }; to: { x: number; y: number }; half?: number; tie?: number }) {
  const dir = { x: to.x - from.x, y: to.y - from.y };
  const len = Math.hypot(dir.x, dir.y) || 1;
  const n = { x: -dir.y / len, y: dir.x / len };
  const rail = (s: number) =>
    polyPoints([
      project(from.x + n.x * s, from.y + n.y * s, 1),
      project(to.x + n.x * s, to.y + n.y * s, 1),
    ]);
  const count = Math.max(2, Math.round(len / tie));
  const ties: string[] = [];
  for (let i = 0; i <= count; i += 1) {
    const t = i / count;
    const px = from.x + dir.x * t;
    const py = from.y + dir.y * t;
    ties.push(
      polyPoints([
        project(px + n.x * half, py + n.y * half, 1),
        project(px - n.x * half, py - n.y * half, 1),
      ]),
    );
  }
  return (
    <g>
      <polyline points={rail(-half)} fill="none" stroke="#48608a" strokeWidth={1.2} />
      <polyline points={rail(half)} fill="none" stroke="#48608a" strokeWidth={1.2} />
      {ties.map((points, i) => (
        <polyline key={i} points={points} fill="none" stroke="#3b4d70" strokeWidth={0.9} />
      ))}
    </g>
  );
}

/* ── The shared rooms: the review table, the coffee corner, the bench ─────── */

/* ── One thing on the floor ───────────────────────────────────────────────── */

/** One thing standing on the floor, and how far into the screen it stands. */
interface Drawable {
  key: string;
  /**
   * World x + y of the thing's base.
   *
   * The projection is linear in both, so this orders things exactly as the screen
   * does, larger is nearer, which means a prop and a person can be compared
   * without either of them knowing the other exists.
   */
  depth: number;
  node: ReactNode;
}

/**
 * Everything that stands in a room, as one drawable per thing.
 *
 * Returning a LIST rather than nesting JSX is the whole point: these are drawn in
 * one order together with the people, sorted by position. A room used to be a group
 *, everything inside it painted as a unit, and that is what made somebody walking
 * behind a department paint over its furniture. At group granularity there is no
 * answer to "is this person in front of that desk or behind it"; per thing there is.
 */
function roomItems(
  room: Room,
  office: Office,
  activities: Record<string, Activity>,
  targets: Record<string, Target>,
  motions: Map<string, SvgMotionRef>,
): Drawable[] {
  const out: Drawable[] = [];
  // Each thing is wrapped in a group that carries its depth: the layer's children
  // are what get compared, so the attribute has to be on them and not on the
  // component inside, which knows nothing about the floor around it.
  const at = (key: string, x: number, y: number, node: ReactNode) =>
    out.push({ key, depth: x + y, node: <g key={key} data-depth={x + y}>{node}</g> });

  if (room.kind === 'department' || room.kind === 'orchestrator') {
    if (room.seats > 5) {
      const bx = room.x + room.w - 90;
      const by = room.y + WALL_T + 6;
      at(`${room.id}-board`, bx, by, <Whiteboard key={`${room.id}-board`} x={bx} y={by} w={110} h={50} />);
    }
    for (const desk of room.desks) {
      const deskX = room.x + desk.x;
      const deskY = room.y + desk.y;
      const act = activities[desk.agentId];
      // Lit only when its owner is sitting at THIS desk, working, see `deskInUse`
      // for why activity alone was the wrong question. `moving` matters because the
      // target says "seated" the moment somebody is ON THEIR WAY to a seat, after
      // the floor re-grids, that walk can be long, and a screen burning over an
      // empty chair for the length of it is the same lie in miniature.
      const busy = deskInUse(
        targets[desk.agentId],
        act,
        office.roomOf[desk.agentId],
        motions.get(desk.agentId)?.current.moving ?? false,
      );
      at(
        `desk-${desk.agentId}`,
        deskX,
        deskY,
        <g key={`desk-${desk.agentId}`} data-desk={desk.agentId} data-busy={busy ? '1' : '0'}>
          {/* The bay this desk sits in: ONE partition, at the desk's left, which is
              what makes one place end and the next begin. Two per desk read as a
              room full of panels, bays are a run, not a cage. */}
          <Partition at={{ x: deskX - 14, y: deskY + mh(0.4) }} />
          <Workstation
            x={deskX}
            y={deskY}
            seat={deskSeat(room, desk)}
            busy={busy}
            glow={mix('#7cc4ff', room.accent, 0.5)}
          />
        </g>,
      );
    }
    // Dressing, in the room's header strip, the band `roomSize()` reserves above
    // the first row of desks for exactly this. In the room's corner it stood inside
    // the desk grid: a plant drawn through the workstation of whoever had the last
    // bay, which is what a green mass on top of a desk is.
    const px = room.x + 16;
    const py = room.y + WALL_T + 14;
    at(`${room.id}-plant`, px, py, <Plant key={`${room.id}-plant`} x={px} y={py} />);
    // A shelf and a lamp in the header strip. Both are small enough for the band
    // the plan already reserves, and together they turn the strip from padding
    // into the wall of a room somebody works in.
    const bx = room.x + 140;
    const by = room.y + WALL_T + 2;
    at(
      `${room.id}-shelf`,
      bx,
      by,
      <AtlasSprite key={`${room.id}-shelf`} name="prop.bookshelf" x={bx} y={by} scale={scaleForWidth('prop.bookshelf', 100)} />,
    );
    const lx = room.x + 50;
    const ly = room.y + WALL_T + 4;
    at(
      `${room.id}-lamp`,
      lx,
      ly,
      <g key={`${room.id}-lamp`}>
        <ellipse
          cx={project(lx + 18, ly + 18, 2).x}
          cy={project(lx + 18, ly + 18, 2).y}
          rx={72}
          ry={34}
          fill="url(#office-lamp)"
          opacity={0.7}
          style={{ mixBlendMode: 'screen' }}
        />
        <AtlasSprite name="prop.floorlamp" x={lx} y={ly} />
      </g>,
    );
  }

  if (room.kind === 'lab') {
    // Every placement here is derived from a footprint in the manifest, and that is
    // not tidiness: the room is 2.1 m of usable depth, the fume hood is 1 m and the
    // bench 0.7 m. At the y they used to have, the hood's own footprint ran 0.67 m
    // into the bench, which is what a bench disappearing under a tall cabinet is.
    const hood = spriteFootprint('prop.fumehood');
    const benchFoot = spriteFootprint('prop.labbench');
    const hoodD = hood?.b ?? UNITS_PER_METRE;
    const benchD = benchFoot?.b ?? UNITS_PER_METRE;
    const hoodY = room.y + 16;
    // The bench along the room's south edge, as far down as its own depth allows.
    const benchY = room.y + room.h - ROOM_PAD - benchD - 4;
    const benchW = room.w - 44;
    const benchX = room.x + 22;
    const boardX = room.x + room.w - 46;
    const boardY = room.y + 8;
    at(`${room.id}-board`, boardX, boardY, <Whiteboard key={`${room.id}-board`} x={boardX} y={boardY} w={74} h={38} />);
    at(`${room.id}-hood`, room.x + 18, hoodY, <AtlasSprite key={`${room.id}-hood`} name="prop.fumehood" x={room.x + 18} y={hoodY} />);
    at(`${room.id}-shelf`, room.x + room.w - 40, room.y + 30, <AtlasSprite key={`${room.id}-shelf`} name="prop.bottleshelf" x={room.x + room.w - 40} y={room.y + 30} />);
    // TILED, not stretched. `scaleForWidth` scales both axes, so asking the 2 m bench
    // to span this room drew a 1.7 m tall pale slab, the brightest object on the
    // floor, in a dark office. Copies of the art stay a bench at every room width, and
    // one tile per stool means the stools still line a bench rather than the floor.
    const benchRun = spriteTiles('prop.labbench', benchW);
    const benchLeft = benchX + benchRun.start;
    for (let i = 0; i < benchRun.count; i += 1) {
      const bx = benchLeft + i * benchRun.tile;
      at(`${room.id}-bench-${i}`, bx, benchY, <AtlasSprite key={`${room.id}-bench-${i}`} name="prop.labbench" x={bx} y={benchY} />);
    }
    // Gear stands ON the bench, which is what the anchor's `z` is for: the worktop's
    // height, at a point on the worktop. Drawn on the floor it was a microscope
    // hovering at the cupboard doors, and placed off the run it floats in the air.
    const benchRight = benchLeft + benchRun.span;
    at(`${room.id}-scope`, benchLeft + 44, benchY + mh(0.25), <AtlasSprite key={`${room.id}-scope`} name="prop.microscope" x={benchLeft + 44} y={benchY + mh(0.25)} z={LAB_BENCH_TOP} />);
    at(`${room.id}-centrifuge`, benchRight - 26, benchY + mh(0.3), <AtlasSprite key={`${room.id}-centrifuge`} name="prop.centrifuge" x={benchRight - 26} y={benchY + mh(0.3)} z={LAB_BENCH_TOP} />);
    // Stools on the bench's OPEN side, which is the room's interior: a stool pushed
    // back from the bench, not one inside it. A stool is drawn around its own centre,
    // so the seat comes back by half a stool before the art goes down.
    const stool = spriteCentreOffset('prop.stool');
    const stoolY = benchY - mh(0.35);
    for (let i = 0; i < benchRun.count; i += 1) {
      const sx = benchLeft + i * benchRun.tile + benchRun.tile / 2;
      at(`${room.id}-stool-${i}`, sx, stoolY, <AtlasSprite key={`${room.id}-stool-${i}`} name="prop.stool" x={sx - stool.x} y={stoolY - stool.y} />);
    }
  }

  if (room.kind === 'meeting') {
    // The table and its eight chairs come from ONE derivation the simulation also
    // seats people with, `meetingLayout`, so a chair and its sitter cannot drift
    // apart. The table is drawn at its art's own size: the room was sized FOR it.
    const layout = meetingLayout(room);
    at(
      `${room.id}-table`,
      layout.table.x,
      layout.table.y,
      <AtlasSprite key={`${room.id}-table`} name="prop.table.3" x={layout.table.x} y={layout.table.y} />,
    );
    layout.seats.forEach((s, i) => {
      at(
        `${room.id}-chair-${i}`,
        s.x,
        s.y,
        <Chair key={`${room.id}-chair-${i}`} at={{ x: s.x, y: s.y }} turned={s.chairTurned} />,
      );
    });
    // The room's own dressing, exactly like a department gets: a board on the far
    // wall and a plant in the corner, so an empty meeting room still reads as a
    // room rather than a rectangle with a table.
    const bw = Math.min(150, room.w - 60);
    const bx = room.x + (room.w - bw) / 2;
    at(`${room.id}-board`, bx, room.y + 10, <Whiteboard key={`${room.id}-board`} x={bx} y={room.y + 10} w={bw} />);
    at(`${room.id}-plant`, room.x + 14, room.y + 48, <Plant key={`${room.id}-plant`} x={room.x + 14} y={room.y + 48} />);
    // A lamp in the corner the chairs leave free: the meeting room reads as a
    // boardroom at night instead of a table in a box.
    const lx = room.x + room.w - 22;
    const ly = room.y + room.h - 26;
    at(
      `${room.id}-lamp`,
      lx,
      ly,
      <g key={`${room.id}-lamp`}>
        <ellipse
          cx={project(lx + 8, ly + 8, 2).x}
          cy={project(lx + 8, ly + 8, 2).y}
          rx={66}
          ry={32}
          fill="url(#office-lamp)"
          opacity={0.65}
          style={{ mixBlendMode: 'screen' }}
        />
        <AtlasSprite name="prop.floorlamp" x={lx} y={ly} />
      </g>,
    );
  }

  if (room.kind === 'commons') {
    const bx = room.x + room.w / 2;
    const by = room.y + WALL_T + 4;
    at(`${room.id}-board`, bx, by, <Whiteboard key={`${room.id}-board`} x={bx} y={by} w={140} h={58} />);
    const tx = room.x + 24;
    const ty = room.y + room.h - 124;
    at(`${room.id}-table`, tx, ty, <MeetingTable key={`${room.id}-table`} x={tx} y={ty} w={room.w - 48} d={92} seats={3} />);
    const px = room.x + room.w - 26;
    const py = room.y + 30;
    at(`${room.id}-plant`, px, py, <Plant key={`${room.id}-plant`} x={px} y={py} />);
    // A shelf and a lamp against the left wall, clear of the long table.
    const sx = room.x + 18;
    const sy = room.y + WALL_T + 4;
    at(`${room.id}-shelf`, sx, sy, <AtlasSprite key={`${room.id}-shelf`} name="prop.bookshelf" x={sx} y={sy} scale={scaleForWidth('prop.bookshelf', 90)} />);
    const lx = room.x + 26;
    const ly = room.y + 74;
    at(
      `${room.id}-lamp`,
      lx,
      ly,
      <g key={`${room.id}-lamp`}>
        <ellipse
          cx={project(lx + 10, ly + 10, 2).x}
          cy={project(lx + 10, ly + 10, 2).y}
          rx={62}
          ry={30}
          fill="url(#office-lamp)"
          opacity={0.55}
          style={{ mixBlendMode: 'screen' }}
        />
        <AtlasSprite name="prop.floorlamp" x={lx} y={ly} />
      </g>,
    );
  }

  if (room.kind === 'break') {
    const layout = office.breakLayout;
    const cx = room.x + room.w - 124;
    const cy = room.y + 14;
    at(`${room.id}-coffee`, cx, cy, <CoffeeBar key={`${room.id}-coffee`} x={cx} y={cy} w={112} />);
    at(`${room.id}-vending`, layout.vending.x, layout.vending.y, <VendingMachine key={`${room.id}-vending`} x={layout.vending.x} y={layout.vending.y} accent="#5b8def" />);
    at(
      `${room.id}-foosball`,
      layout.foosball.x,
      layout.foosball.y,
      <FoosballTable key={`${room.id}-foosball`} x={layout.foosball.x} y={layout.foosball.y} w={layout.foosball.w} d={layout.foosball.d} />,
    );
    layout.tables.forEach((table, i) => {
      at(
        `${room.id}-table-${i}`,
        table.x,
        table.y,
        <g key={`${room.id}-table-${i}`}>
          <RoundTable at={table} r={BREAK_TABLE_R} />
          {/* The chairs come from the same list the simulation seats people on, so
              a chair is never empty while somebody sits beside it. */}
          {breakSeats([table]).map((seat) => (
            <Chair key={`${i}-${seat.index}`} at={seat.point} color="#2a2f3a" />
          ))}
        </g>,
      );
    });
    const px = room.x + 16;
    const py = room.y + room.h - 26;
    at(`${room.id}-plant`, px, py, <Plant key={`${room.id}-plant`} x={px} y={py} />);
    const kx = room.x + room.w - 58;
    const ky = room.y + room.h - 52;
    at(`${room.id}-crate`, kx, ky, <Crate key={`${room.id}-crate`} x={kx} y={ky} w={32} h={mh(0.4)} />);
    // The fridge, between the vending machine and the coffee bar: the three
    // machines together are what makes a break corner read at a glance.
    const fx = room.x + room.w * 0.4;
    const fy = room.y + WALL_T + 2;
    at(`${room.id}-fridge`, fx, fy, <AtlasSprite key={`${room.id}-fridge`} name="prop.fridge" x={fx} y={fy} />);
  }

  if (room.kind === 'bench') {
    at(`${room.id}-crate-a`, room.x + 22, room.y + 24, <Crate key={`${room.id}-crate-a`} x={room.x + 22} y={room.y + 24} w={46} h={mh(0.5)} />);
    at(`${room.id}-crate-b`, room.x + 76, room.y + 30, <Crate key={`${room.id}-crate-b`} x={room.x + 76} y={room.y + 30} w={36} h={mh(0.36)} />);
    at(`${room.id}-printer`, room.x + room.w - 76, room.y + 24, <Printer key={`${room.id}-printer`} x={room.x + room.w - 76} y={room.y + 24} />);
    at(`${room.id}-plant`, room.x + 24, room.y + room.h - 28, <Plant key={`${room.id}-plant`} x={room.x + 24} y={room.y + room.h - 28} />);
    // A rack in the working corner and a lamp by the wall: the bench is where
    // spare hardware lives, and it should look like it.
    const rx = room.x + 18;
    const ry = room.y + room.h - 118;
    at(
      `${room.id}-server`,
      rx,
      ry,
      <g key={`${room.id}-server`}>
        <ellipse
          cx={project(rx + 20, ry + 16, 2).x}
          cy={project(rx + 20, ry + 16, 2).y}
          rx={50}
          ry={26}
          fill="url(#office-cool)"
          opacity={0.55}
          style={{ mixBlendMode: 'screen' }}
        />
        <AtlasSprite name="prop.server" x={rx} y={ry} />
      </g>,
    );
  }

  return out;
}

/**
 * The room labels, in their own layer above the furniture.
 *
 * They used to be drawables, sorted by depth with everything else, which meant a
 * fridge, a bookshelf or somebody walking past could cover the name of the room
 * they were standing in. A label is interface, not a physical object: it is drawn
 * last, in the same world coordinates, so it can never be occluded.
 */
function SignLayer({
  rooms,
  pulse,
  staggers,
}: {
  rooms: Room[];
  pulse: FloorPulse;
  staggers: Record<string, number>;
}) {
  return (
    <g pointerEvents="none">
      {rooms.map((room) => (
        <Sign
          key={room.id}
          room={room}
          pulse={pulse.rooms[room.id]}
          stagger={staggers[room.id] ?? 0}
        />
      ))}
    </g>
  );
}

/* ── One character ────────────────────────────────────────────────────────── */

function Sprite({
  agent,
  activity,
  reason,
  motion,
  atDesk,
  selected,
  dimmed,
  onSelect,
  register,
  /** World x + y of their feet: what orders them against the furniture. */
  depth,
}: {
  agent: OrgNode;
  activity: Activity;
  reason?: string;
  motion: SvgMotionRef;
  atDesk: boolean;
  selected: boolean;
  dimmed: boolean;
  onSelect: () => void;
  register: (el: SVGGElement | null) => void;
  depth: number;
}) {
  const speech = activity.speech;

  return (
    <g
      ref={register}
      data-depth={depth}
      className={cn('sprite', `act-${activity.kind}`, dimmed && 'is-dim', selected && 'is-selected')}
      data-sprite={agent.id}
      onClick={onSelect}
      role="button"
      tabIndex={-1}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); onSelect(); }
      }}
      aria-label={`${agent.name}, ${agent.role ?? 'agent'}, ${activity.note}`}
    >
      <title>{`${agent.name}${agent.grade !== undefined ? ` · G${agent.grade}` : ''}, ${
        agent.role ?? 'agent'
      }\n${activity.note}${reason ? `\n${reason}` : ''}\nclick for thinking & output`}</title>

      <ellipse className="sprite-shadow" cx={0} cy={0} rx={CHAR_W * 0.34} ry={CHAR_W * 0.17} />
      {selected && <ellipse className="sprite-ring" cx={0} cy={0} rx={CHAR_W * 0.46} ry={CHAR_W * 0.23} />}

      {/* SpriteCharacter draws with the figure's feet on its OWN origin, the anchor
          is the pixel that touches the floor, so this group must not carry the
          vector rig's offsets. It carried both, from when the figure was drawn from
          its top-left corner inside a 24×40 view: half the sprite's width across and
          FEET_Y up, which left every person walking half a metre above the floor.
          All that is left is the small sink the old feet had, into the shadow. */}
      <g className="sprite-body" transform={`translate(0 ${FEET_SINK})`}>
        <SpriteCharacter
          name={agent.id}
          activity={activity.kind}
          atDesk={atDesk}
          motion={motion}
          faded={activity.kind === 'offline'}
        />
      </g>

      {/* A hit area, so clicking anywhere on the figure works. */}
      <rect x={-CHAR_W / 2} y={-FEET_Y * spriteScaleFactor()} width={CHAR_W} height={FEET_Y * spriteScaleFactor()} fill="transparent" />

      <text className="sprite-tag" x={0} y={-FEET_Y * spriteScaleFactor() - 7} textAnchor="middle">
        {agent.name}
      </text>

      {/* One bubble, revealed by content, see SpeechBubble for why it is a component. */}
      {(speech || activity.bubble) && (
        <SpeechBubble
          speech={speech}
          emoji={activity.bubble}
          emojiKind={activity.bubble ? emojiKind(activity) : undefined}
          y={-FEET_Y * spriteScaleFactor() - (speech ? 32 : 28)}
        />
      )}
    </g>
  );
}

/**
 * Shows a bubble once per CONTENT change, never per DOM move.
 *
 * The reveal is a transition (see `.sprite-speech` in office2d.css) and this hook is the
 * only thing that toggles it: it drops the class for exactly one frame when the content
 * changes, then puts it back, so the fade plays for a new bubble and never for an old one
 * whose group happened to be re-appended by the depth sort.
 */
function useBubbleReveal(contentKey: string): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    setShown(false);
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, [contentKey]);
  return shown;
}

/** One character's bubble. Its own component so the reveal hook has a home. */
function SpeechBubble({
  speech,
  emoji,
  emojiKind,
  y,
}: {
  speech?: Speech;
  emoji?: string;
  emojiKind?: SpeechKind;
  y: number;
}) {
  const contentKey = speech
    ? `${speech.kind}|${speech.text}|${speech.to ?? ''}`
    : `emoji|${emoji ?? ''}`;
  const shown = useBubbleReveal(contentKey);
  return (
    <g className={cn('sprite-speech', shown && 'is-in')} transform={`translate(0 ${y.toFixed(0)})`}>
      {speech ? (
        <>
          <Bubble kind={speech.kind} text={speech.text} />
          {speech.to && (
            <text y={4} fontSize={8.5} textAnchor="middle" fill="#93a1b8">
              → {speech.to}
            </text>
          )}
        </>
      ) : (
        <Bubble kind={emojiKind ?? 'talk'} text={emoji ?? ''} maxWidth={60} />
      )}
    </g>
  );
}

/* ── The scene ────────────────────────────────────────────────────────────── */

export interface OfficeSceneProps {
  office: Office;
  activities: Record<string, Activity>;
  targets: Record<string, Target>;
  pulse: FloorPulse;
  selected: string | null;
  attentionOnly: boolean;
  focusRoomId: string | null;
  /** Agent ids whose desk did not exist before this session. */
  newRoomIds: Set<string>;
  motions: Map<string, SvgMotionRef>;
  registerSprite: (id: string) => (el: SVGGElement | null) => void;
  /** The group every drawable lives in, so the walk loop can keep it in depth order. */
  registerDepthLayer: (el: SVGGElement | null) => void;
  /** The striped route each walker is currently taking, written by the rAF loop. */
  registerTrail: (id: string) => (el: SVGPathElement | null) => void;
  onSelectAgent: (id: string) => void;
  viewport: { w: number; h: number };
  camera: { x: number; y: number; scale: number };
}

export function OfficeScene({
  office,
  activities,
  targets,
  pulse,
  selected,
  attentionOnly,
  focusRoomId,
  newRoomIds,
  motions,
  registerSprite,
  registerDepthLayer,
  registerTrail,
  onSelectAgent,
  viewport,
  camera,
}: OfficeSceneProps) {
  const rooms = useMemo(
    () => [...office.rooms].sort((a, b) => a.x + a.y - (b.x + b.y)),
    [office.rooms],
  );

  /** Boards on one shelf row are lifted alternately so they cannot overlap. */
  const staggers = useMemo(() => {
    const byRow: Record<number, string[]> = {};
    for (const room of office.rooms) byRow[room.row] = [...(byRow[room.row] ?? []), room.id];
    const out: Record<string, number> = {};
    for (const ids of Object.values(byRow)) {
      const sorted = ids
        .map((id) => office.rooms.find((r) => r.id === id)!)
        .sort((a, b) => a.x - b.x)
        .map((r) => r.id);
      sorted.forEach((id, i) => {
        out[id] = i % 2;
      });
    }
    return out;
  }, [office.rooms]);

  // People used to be sorted here, and drawn after every room. That is the ordering
  // a group can give you; it cannot answer "in front of this desk, or behind it".
  // They are entries in `drawables` now, compared with the furniture by position.
  const people = useMemo(() => {
    const ids = Object.keys(office.deskOf);
    return ids;
  }, [office]);

  /**
   * Everything that stands on the floor, in one list, ordered by how near it is.
   *
   * Room furniture and people together: a desk and the person walking behind it have
   * to be compared with each other, and the only thing that can compare them is a
   * list that contains both. The people's depths come from the last walk-loop frame,
   * and the loop keeps the DOM in order between renders, React never sees a walker
   * move, because positions are written straight to the elements.
   */
  const drawables = useMemo(() => {
    const out: Drawable[] = [];
    for (const room of rooms) {
      out.push(...roomItems(room, office, activities, targets, motions));
    }
    for (const id of people) {
      const agent = office.agentOf[id];
      const activity = activities[id];
      const motion = motions.get(id);
      if (!agent || !activity || !motion) continue;
      const target = targets[id];
      const m = motion.current;
      out.push({
        key: id,
        depth: m.x + m.y,
        node: (
          <Sprite
            key={id}
            agent={agent}
            activity={activity}
            reason={target?.reason}
            motion={motion}
            atDesk={!!target?.seated}
            selected={selected === id}
            dimmed={attentionOnly && activity.kind !== 'blocked' && activity.kind !== 'waiting'}
            onSelect={() => onSelectAgent(id)}
            register={registerSprite(id)}
            depth={m.x + m.y}
          />
        ),
      });
    }
    // Ties broken by key so the order is stable between renders: two things at the
    // same depth must not swap places every time React re-renders.
    out.sort((a, b) => a.depth - b.depth || (a.key < b.key ? -1 : 1));
    return out;
    // Labels are drawn in their own layer now, so a change in pulse or stagger
    // updates the signs and must not rebuild every desk on the floor.
  }, [rooms, office, activities, people, motions, targets, selected, attentionOnly, onSelectAgent, registerSprite]);

  const aisle = 78;
  const corridors = useMemo(
    () => Array.from(new Set(Object.values(office.corridorY))).sort((a, b) => a - b),
    [office.corridorY],
  );

  // Hysteresis, not a threshold. Tags and bubbles are hidden when the floor is far
  // away, and with a single cut-off they blink on and off while the reader sits right
  // on it, the second flicker this scene had. The state is sticky until the zoom is
  // clearly on the other side, so nothing blinks at the boundary.
  const farRef = useRef(camera.scale < 0.4);
  if (camera.scale < 0.38) farRef.current = true;
  else if (camera.scale > 0.44) farRef.current = false;
  const far = farRef.current;

  return (
    <svg
      className={cn('office-scene', far && 'is-far')}
      width={viewport.w}
      height={viewport.h}
      role="group"
      aria-label="Office floor"
    >
      <defs>
        <radialGradient id="office-vignette" cx="50%" cy="45%" r="72%">
          <stop offset="55%" stopColor="#000000" stopOpacity="0" />
          <stop offset="100%" stopColor="#000000" stopOpacity="0.55" />
        </radialGradient>
        <radialGradient id="office-lamp" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#ffcf8f" stopOpacity="0.3" />
          <stop offset="55%" stopColor="#ffb45e" stopOpacity="0.12" />
          <stop offset="100%" stopColor="#ffb45e" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="office-cool" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#9fd4ff" stopOpacity="0.26" />
          <stop offset="60%" stopColor="#6fa6dd" stopOpacity="0.1" />
          <stop offset="100%" stopColor="#6fa6dd" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="office-screen-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#b7e0ff" stopOpacity="0.5" />
          <stop offset="55%" stopColor="#6fa6dd" stopOpacity="0.16" />
          <stop offset="100%" stopColor="#6fa6dd" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="office-ambient" cx="50%" cy="30%" r="70%">
          <stop offset="0%" stopColor="#243654" stopOpacity="0.75" />
          <stop offset="55%" stopColor="#101827" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#05070c" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="office-window" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#24466e" />
          <stop offset="48%" stopColor="#3b7194" />
          <stop offset="72%" stopColor="#2a4b68" />
          <stop offset="100%" stopColor="#0f2034" />
        </linearGradient>
        <linearGradient id="office-slab-side" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#0c121c" />
          <stop offset="100%" stopColor="#05070c" />
        </linearGradient>
      </defs>

      {/* The room's air: a soft wash behind the building, so the floor sits in a
          place with light rather than in pure void. */}
      <rect x={0} y={0} width={viewport.w} height={viewport.h} fill="url(#office-ambient)" pointerEvents="none" />
      <g transform={`translate(${camera.x.toFixed(2)} ${camera.y.toFixed(2)}) scale(${camera.scale.toFixed(3)})`}>
        {/* The ground, as a slab with an edge, the building sits in space. */}
        <polygon points={boxFaces(-PAD, -PAD, office.width + PAD * 2, office.height + PAD * 2, -SLAB).front} fill="url(#office-slab-side)" />
        <polygon points={boxFaces(-PAD, -PAD, office.width + PAD * 2, office.height + PAD * 2, -SLAB).right} fill="#080c13" />
        <polygon points={floorRect(-PAD, -PAD, office.width + PAD * 2, office.height + PAD * 2, -SLAB)} fill="#090c12" />
        <polygon
          points={floorRect(-PAD, -PAD, office.width + PAD * 2, office.height + PAD * 2, -1)}
          fill="#101722"
        />
        {/* A rim light along the slab's top edge: the building is lit from outside. */}
        <polygon
          points={floorRect(-PAD, -PAD, office.width + PAD * 2, office.height + PAD * 2, -1)}
          fill="none"
          stroke="#2b3c58"
          strokeWidth={1.5}
          opacity={0.7}
        />
        <polygon points={floorRect(0, 0, office.width, office.height, 0)} fill={FLOOR} />

        {/* Floor boards: long runs along one axis, which is what reads as a floor,
            and short cross-joints on the other so the planks have length. */}
        {Array.from({ length: Math.ceil(office.height / 128) }, (_, i) => (
          <polyline
            key={`b${i}`}
            points={polyPoints([
              project(0, (i + 1) * 128, 0),
              project(office.width, (i + 1) * 128, 0),
            ])}
            fill="none"
            stroke="#263145"
            strokeWidth={1}
          />
        ))}
        {Array.from({ length: Math.ceil(office.width / 128) }, (_, i) => (
          <polyline
            key={`bw${i}`}
            points={polyPoints([
              project((i + 1) * 128, 0, 0),
              project((i + 1) * 128, office.height, 0),
            ])}
            fill="none"
            stroke="#1c2534"
            strokeWidth={1}
          />
        ))}

        {/* Roads: the spine and one lane per shelf row, kerbed and railed so
            they read as the ways between units rather than as gaps in the floor. */}
        <polygon
          points={floorRect(6, -8, SPINE_W - 12, office.height + 16, 1)}
          fill={WALK}
          stroke={KERB}
          strokeWidth={1.5}
        />
        <line
          x1={project(SPINE_W / 2, 4, 2).x}
          y1={project(SPINE_W / 2, 4, 2).y}
          x2={project(SPINE_W / 2, office.height - 4, 2).x}
          y2={project(SPINE_W / 2, office.height - 4, 2).y}
          stroke="#c79a5d"
          strokeWidth={1.5}
          strokeDasharray="16 24"
          opacity={0.24}
        />
        <Conveyor from={{ x: SPINE_W / 2, y: -8 }} to={{ x: SPINE_W / 2, y: office.height + 8 }} half={18} />
        {corridors.map((y) => (
          <g key={`c${y}`}>
            <polygon
              points={floorRect(-8, y - aisle / 2, office.width + 16, aisle, 1)}
              fill={WALK}
              stroke={KERB}
              strokeWidth={1.5}
            />
            <line
              x1={project(4, y, 2).x}
              y1={project(4, y, 2).y}
              x2={project(office.width - 4, y, 2).x}
              y2={project(office.width - 4, y, 2).y}
              stroke="#c79a5d"
              strokeWidth={1.5}
              strokeDasharray="16 24"
              opacity={0.2}
            />
            <Conveyor from={{ x: -8, y }} to={{ x: office.width + 8, y }} half={18} />
          </g>
        ))}

        {/* A spur from every unit's door to the lane that serves it, so each
            department is visibly plugged into the same network. */}
        {office.rooms.map((room) => {
          const lane = office.corridorY[room.id];
          const from = room.door.y;
          if (!Number.isFinite(lane) || lane <= from) return null;
          return (
            <g key={`spur-${room.id}`}>
              <polygon
                points={floorRect(room.door.x - 19, from - 4, 38, lane - from + 6, 1)}
                fill={WALK}
                stroke={KERB}
                strokeWidth={1.2}
              />
              <Conveyor
                from={{ x: room.door.x, y: from }}
                to={{ x: room.door.x, y: lane + 4 }}
                half={13}
                tie={72}
              />
            </g>
          );
        })}

        {/* The walkway's own lights: pools where the lanes meet the spine, and a
            low bollard light every few bays. They give the black between rooms a
            scale, which is what stops a wide floor reading as empty. */}
        {corridors.map((y) => {
          const p = project(SPINE_W / 2, y, 1);
          return (
            <ellipse
              key={`pool-${y}`}
              cx={p.x}
              cy={p.y}
              rx={150}
              ry={64}
              fill="url(#office-lamp)"
              opacity={0.3}
              style={{ mixBlendMode: 'screen' }}
            />
          );
        })}
        {Array.from({ length: Math.max(1, Math.floor(office.height / 240)) }, (_, i) => {
          const y = 120 + i * 240;
          const p = project(12, y, 1);
          const dot = project(12, y, mh(0.06));
          return (
            <g key={`bollard-${i}`}>
              <ellipse
                cx={p.x}
                cy={p.y}
                rx={54}
                ry={24}
                fill="url(#office-lamp)"
                opacity={0.34}
                style={{ mixBlendMode: 'screen' }}
              />
              <circle cx={dot.x} cy={dot.y} r={3.2} fill="#e8c48d" opacity={0.9} />
              <circle cx={dot.x} cy={dot.y} r={7} fill="#e8c48d" opacity={0.15} />
            </g>
          );
        })}

        {/* Where new hires come in. */}
        <GroundShadow cx={office.entrance.x} cy={office.entrance.y} r={26} opacity={0.5} />
        <text
          x={project(office.entrance.x, office.entrance.y - 26).x}
          y={project(office.entrance.x, office.entrance.y - 26).y}
          fontSize={9}
          fill="#5d6a80"
          textAnchor="middle"
        >
          entrance
        </text>

        {rooms.map((room) => (
          <RoomShell
            key={room.id}
            room={room}
            focused={focusRoomId === room.id}
            newRoom={newRoomIds.has(room.id)}
          />
        ))}

        {/* Somebody working in another department: the route they took, ON THE FLOOR.
            This was a quadratic curve arcing over the furniture, which is a cable
            between two rooms, not a walk. It is now the same polyline the walker
            actually follows, corridor corner by corridor corner, projected tile by
            tile and laid a hair above the floor. */}
        {people.map((id) => {
          const target = targets[id];
          const homeId = office.roomOf[id];
          if (!target || !homeId || target.roomId === homeId) return null;
          const home = office.rooms.find((r) => r.id === homeId);
          const away = office.rooms.find((r) => r.id === target.roomId);
          if (!home || !away) return null;
          const route = routeBetween(
            office,
            homeId,
            target.roomId,
            // DOORS, not centres. A room's centre is where its desks are, so a
            // route drawn to it ran up onto the furniture. A route is door to door
            // along the corridors, which is also the only part of it anybody walks
            // twice.
            { x: home.door.x, y: home.door.y },
            { x: away.door.x, y: away.door.y },
          );
          if (route.length < 2) return null;
          const d = route
            .map((p, i) => {
              const s = project(p.x, p.y, 1);
              return `${i === 0 ? 'M' : 'L'} ${s.x} ${s.y}`;
            })
            .join(' ');
          return (
            <path
              key={`link-${id}`}
              d={d}
              fill="none"
              stroke={away.accent}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray="5 5"
              opacity={0.55}
            />
          );
        })}

        {/* Where people are walking: a striped route on the floor, so a glance
            shows not just that somebody is moving but where they are going.
            Drawn under the cast, written by the walk loop, never by React. */}
        {people.map((id) => (
          <path key={`trail-${id}`} className="sprite-trail" ref={registerTrail(id)} fill="none" />
        ))}

        {/* ONE list, ordered by position. Props and people together, because the
            only way a person can be behind a desk is if the desk and the person are
            compared, and the only way to compare them is to draw them from the same
            list. The walk loop keeps this in order between renders, since positions
            are written straight to the DOM and React never sees a walker move. */}
        <g ref={registerDepthLayer}>
          {drawables.map((d) => d.node)}
        </g>
        <SignLayer rooms={rooms} pulse={pulse} staggers={staggers} />
      </g>

      <rect x={0} y={0} width={viewport.w} height={viewport.h} fill="url(#office-vignette)" pointerEvents="none" />
    </svg>
  );
}
