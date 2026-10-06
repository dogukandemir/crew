/**
 * The office, drawn as one flat SVG scene.
 *
 * Every wall, desk, chair and monitor is a **volume**: a lit top face plus two
 * shaded side faces built by `iso.ts`. Verticals stay vertical, so people stand
 * up — the failure mode of the previous version, where a tilted 3D plane squashed
 * the vertical axis and made everyone look like they were lying on the floor.
 *
 * Order is painter's order: the earth slab, then the floor and walkways, then the
 * rooms (far to near), then the people (far to near, by where they are headed),
 * so somebody standing behind a desk is drawn behind it.
 */
import { useMemo } from 'react';
import type { OrgNode } from '../../api/types';
import type { Activity } from '../../sim/activity';
import {
  BREAK_TABLE_R,
  DESK_W,
  ROOM_PAD,
  ROOM_HEADER,
  SPINE_W,
  breakSeats,
  deskSeat,
  type Office,
  type Room,
} from '../../sim/floorplan';
import type { FloorPulse } from '../../sim/rooms';
import type { Target } from '../../sim/targets';
import type { SpriteMotionRef as SvgMotionRef } from '../sprites/SpriteCharacter';
import { SPRITE_UNIT, scaleForWidth, spriteCentreOffset } from '../sprites/sprites';
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

const FLOOR = '#161c27';
const WALK = '#212a3a';
/** The kerb along a road: what makes a corridor read as a way, not a gap. */
const KERB = '#3f4d67';
const WALL_H = mh(0.72);
const WALL_T = 7;
const SLAB = 34;
/** Air around the building, so the slab reads as a thing sitting in space. */
const PAD = 46;

/**
 * The lab bench's worktop height, in world units.
 *
 * Stated here as well as in spriteforge — `props/lab.ts` draws the worktop at 0.92 m
 * — because a thing standing ON the bench needs it, and the atlas does not carry a
 * height per entry. It is in the audit's open list: the honest fix is a `height`
 * field in the manifest, so the two cannot drift.
 */
const LAB_BENCH_TOP = mh(0.92);

/**
 * How tall a person is, in world units, at the atlas's own scale.
 *
 * Derived the way every sprite is: 40 px of figure at `SPRITE_UNIT` — 1.67 m. It
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

function Sign({ room, pulse, stagger = 0 }: { room: Room; pulse?: FloorPulse['rooms'][string]; stagger?: number }) {
  // Boards on the same shelf row are lifted in turn, so neighbours never cover
  // each other's name.
  const p = project(room.x + room.w / 2, room.y, WALL_H + 30 + stagger * 34);
  const busy = (pulse?.producing ?? 0) > 0;
  const name = room.name.length > 20 ? `${room.name.slice(0, 19)}…` : room.name;
  const w = Math.max(88, name.length * 7.4 + 30);
  const h = 30;

  return (
    <g>
      {/* The board. */}
      <rect x={p.x - w / 2} y={p.y - h} width={w} height={h} rx={5} fill="#101725" opacity={0.96} />
      <rect x={p.x - w / 2} y={p.y - h} width={w} height={3} rx={1.5} fill={room.accent} />
      <rect
        x={p.x - w / 2}
        y={p.y - h}
        width={w}
        height={h}
        rx={5}
        fill="none"
        stroke={mix('#101725', room.accent, 0.5)}
        strokeWidth={1}
      />
      <text x={p.x} y={p.y - h + 15} fontSize={12} fontWeight={700} fill="#e8edf5" textAnchor="middle">
        {name}
      </text>
      <text x={p.x} y={p.y - h + 27} fontSize={9} fill="#8b98ad" textAnchor="middle">
        {room.subtitle ?? ''}
      </text>

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

      {/* What the room has shipped: the count, and the newest thing by name. */}
      {pulse && (pulse.shipped > 0 || pulse.seats > 0) && (
        <g transform={`translate(${p.x} ${p.y + 3})`}>
          <text fontSize={9} textAnchor="middle" fill={pulse?.blocked ? '#e2a0a0' : '#7d8ba1'}>
            {pulse.seats} seats
            {pulse.working > 0 ? ` · ${pulse.working} working` : ''}
            {pulse.blocked > 0 ? ` · ${pulse.blocked} stuck` : ''}
          </text>
        </g>
      )}
      {pulse?.shipped ? (
        <g transform={`translate(${p.x} ${p.y + 15})`}>
          <text fontSize={9} textAnchor="middle" fill="#8ed7ac">
            ✓ {pulse.shipped} shipped
            {pulse.lastOutput ? ` · ${pulse.lastOutput.title.slice(0, 26)}` : ''}
          </text>
        </g>
      ) : null}
    </g>
  );
}

/* ── One room ─────────────────────────────────────────────────────────────── */

/** The shell: floor and walls. Always behind everything a room contains. */
function RoomShell({ room, focused, newRoom }: { room: Room; focused: boolean; newRoom: boolean }) {
  const wall = mix('#2a3346', room.accent, 0.3);
  const accentSoft = mix('#12161f', room.accent, 0.45);
  const inner = mix('#1e2634', room.accent, 0.16);

  return (
    <g className={cn('room', focused && 'is-focused', newRoom && 'is-new')}>
      {/* The room's own floor, lighter than the walkway outside it, so a
          department reads as a place with edges. */}
      <polygon points={floorRect(room.x, room.y, room.w, room.h, 0)} fill={inner} />
      <polygon
        points={floorRect(room.x + 5, room.y + 5, room.w - 10, room.h - 10, 1)}
        fill={room.accent}
        opacity={focused ? 0.24 : 0.17}
      />
      <polygon
        points={floorRect(room.x + 5, room.y + 5, room.w - 10, room.h - 10, 1)}
        fill="none"
        stroke={room.accent}
        strokeWidth={focused ? 2 : 1}
        opacity={focused ? 0.85 : 0.55}
      />

      {/* Two partition walls on the far edges, so they never hide the room.
          Kept light: a dark wall reads as a bar across the floor, not a room. */}
      <polygon points={boxFaces(room.x, room.y, room.w, WALL_T, WALL_H).front} fill={shade(wall, 0.74)} />
      <polygon points={boxFaces(room.x, room.y, room.w, WALL_T, WALL_H).right} fill={shade(wall, 0.88)} />
      <polygon
        points={boxFaces(room.x, room.y, room.w, WALL_T, WALL_H).top}
        fill={shade(wall, 1.22)}
        stroke={accentSoft}
        strokeWidth={1.5}
      />
      <polygon points={boxFaces(room.x, room.y, WALL_T, room.h, WALL_H).front} fill={shade(wall, 0.72)} />
      <polygon points={boxFaces(room.x, room.y, WALL_T, room.h, WALL_H).right} fill={shade(wall, 0.86)} />
      <polygon
        points={boxFaces(room.x, room.y, WALL_T, room.h, WALL_H).top}
        fill={shade(wall, 1.22)}
        stroke={accentSoft}
        strokeWidth={1.5}
      />

    </g>
  );
}

/**
 * A conveyor: two rails and the ties across them. StarNet's floor is a station.
 *
 * The ties are far apart and the lines thin on purpose. At a tie every 30 units
 * across a 22-unit-wide path this was a ladder over the whole corridor network, and
 * a floor covered in ladder reads as clutter long before it reads as a conveyor —
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
      <polyline points={rail(-half)} fill="none" stroke="#3b4a68" strokeWidth={1.2} />
      <polyline points={rail(half)} fill="none" stroke="#3b4a68" strokeWidth={1.2} />
      {ties.map((points, i) => (
        <polyline key={i} points={points} fill="none" stroke="#2f3a51" strokeWidth={0.9} />
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
   * does — larger is nearer — which means a prop and a person can be compared
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
 * — everything inside it painted as a unit — and that is what made somebody walking
 * behind a department paint over its furniture. At group granularity there is no
 * answer to "is this person in front of that desk or behind it"; per thing there is.
 */
function roomItems(
  room: Room,
  office: Office,
  activities: Record<string, Activity>,
  pulse: FloorPulse['rooms'][string] | undefined,
  stagger: number,
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
      const busy = act?.kind === 'typing' || act?.kind === 'tool';
      at(
        `desk-${desk.agentId}`,
        deskX,
        deskY,
        <g key={`desk-${desk.agentId}`}>
          {/* The bay this desk sits in: ONE partition, at the desk's left, which is
              what makes one place end and the next begin. Two per desk read as a
              room full of panels — bays are a run, not a cage. */}
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
    // Dressing, in the room's header strip — the band `roomSize()` reserves above
    // the first row of desks for exactly this. In the room's corner it stood inside
    // the desk grid: a plant drawn through the workstation of whoever had the last
    // bay, which is what a green mass on top of a desk is.
    const px = room.x + 16;
    const py = room.y + WALL_T + 14;
    at(`${room.id}-plant`, px, py, <Plant key={`${room.id}-plant`} x={px} y={py} />);
  }

  if (room.kind === 'lab') {
    // The bench runs along the room with its stools on the open side. The caller's
    // width becomes a scale read out of the art, so the bench that is drawn is the
    // bench the room asked for.
    const benchW = room.w - 44;
    const benchX = room.x + 22;
    const benchY = room.y + 64;
    const boardX = room.x + room.w - 46;
    const boardY = room.y + 8;
    at(`${room.id}-board`, boardX, boardY, <Whiteboard key={`${room.id}-board`} x={boardX} y={boardY} w={74} h={38} />);
    at(`${room.id}-hood`, room.x + 34, room.y + 40, <AtlasSprite key={`${room.id}-hood`} name="prop.fumehood" x={room.x + 34} y={room.y + 40} />);
    at(`${room.id}-shelf`, room.x + room.w - 40, room.y + 30, <AtlasSprite key={`${room.id}-shelf`} name="prop.bottleshelf" x={room.x + room.w - 40} y={room.y + 30} />);
    at(`${room.id}-bench`, benchX, benchY, <AtlasSprite key={`${room.id}-bench`} name="prop.labbench" x={benchX} y={benchY} scale={scaleForWidth('prop.labbench', benchW)} />);
    // Gear stands ON the bench, which is what the anchor's `z` is for: the worktop's
    // height, at a point on the worktop. Drawn on the floor it was a microscope
    // hovering at the cupboard doors.
    at(`${room.id}-scope`, room.x + 44, benchY + mh(0.25), <AtlasSprite key={`${room.id}-scope`} name="prop.microscope" x={room.x + 44} y={benchY + mh(0.25)} z={LAB_BENCH_TOP} />);
    at(`${room.id}-centrifuge`, room.x + benchW - 20, benchY + mh(0.3), <AtlasSprite key={`${room.id}-centrifuge`} name="prop.centrifuge" x={room.x + benchW - 20} y={benchY + mh(0.3)} z={LAB_BENCH_TOP} />);
    // Stools along the bench's open side. A stool is drawn around its own centre, so
    // the seat comes back by half a stool before the art goes down.
    const stool = spriteCentreOffset('prop.stool');
    const stoolY = benchY + mh(0.7 + 0.18);
    for (const dx of [70, 130, 190]) {
      at(`${room.id}-stool-${dx}`, room.x + dx, stoolY, <AtlasSprite key={`${room.id}-stool-${dx}`} name="prop.stool" x={room.x + dx - stool.x} y={stoolY - stool.y} />);
    }
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
  }

  if (room.kind === 'bench') {
    at(`${room.id}-crate-a`, room.x + 22, room.y + 24, <Crate key={`${room.id}-crate-a`} x={room.x + 22} y={room.y + 24} w={46} h={mh(0.5)} />);
    at(`${room.id}-crate-b`, room.x + 76, room.y + 30, <Crate key={`${room.id}-crate-b`} x={room.x + 76} y={room.y + 30} w={36} h={mh(0.36)} />);
    at(`${room.id}-printer`, room.x + room.w - 76, room.y + 24, <Printer key={`${room.id}-printer`} x={room.x + room.w - 76} y={room.y + 24} />);
    at(`${room.id}-plant`, room.x + 24, room.y + room.h - 28, <Plant key={`${room.id}-plant`} x={room.x + 24} y={room.y + room.h - 28} />);
  }

  // The nameplate is the room's own label: it sits over the room's furniture but
  // under anybody standing in front of it.
  at(`${room.id}-sign`, room.x, room.y + room.h + 1, <Sign key={`${room.id}-sign`} room={room} pulse={pulse} stagger={stagger} />);
  return out;
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
      aria-label={`${agent.name} — ${agent.role ?? 'agent'} — ${activity.note}`}
    >
      <title>{`${agent.name}${agent.grade !== undefined ? ` · G${agent.grade}` : ''} — ${
        agent.role ?? 'agent'
      }\n${activity.note}${reason ? `\n${reason}` : ''}\nclick for thinking & output`}</title>

      <ellipse className="sprite-shadow" cx={0} cy={0} rx={CHAR_W * 0.34} ry={CHAR_W * 0.17} />
      {selected && <ellipse className="sprite-ring" cx={0} cy={0} rx={CHAR_W * 0.46} ry={CHAR_W * 0.23} />}

      {/* SpriteCharacter draws with the figure's feet on its OWN origin — the anchor
          is the pixel that touches the floor — so this group must not carry the
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

      {speech ? (
        <g className="sprite-speech" transform={`translate(0 ${(-FEET_Y * spriteScaleFactor() - 32).toFixed(0)})`}>
          <Bubble kind={speech.kind} text={speech.text} />
          {speech.to && (
            <text y={4} fontSize={8.5} textAnchor="middle" fill="#93a1b8">
              → {speech.to}
            </text>
          )}
        </g>
      ) : activity.bubble ? (
        <g className="sprite-speech" transform={`translate(0 ${(-FEET_Y * spriteScaleFactor() - 28).toFixed(0)})`}>
          <Bubble kind={emojiKind(activity)} text={activity.bubble} maxWidth={60} />
        </g>
      ) : null}
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
   * and the loop keeps the DOM in order between renders — React never sees a walker
   * move, because positions are written straight to the elements.
   */
  const drawables = useMemo(() => {
    const out: Drawable[] = [];
    for (const room of rooms) {
      out.push(...roomItems(room, office, activities, pulse.rooms[room.id], staggers[room.id] ?? 0));
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
  }, [rooms, office, activities, pulse, staggers, people, motions, targets, selected, attentionOnly, onSelectAgent, registerSprite]);

  const aisle = 78;
  const corridors = useMemo(
    () => Array.from(new Set(Object.values(office.corridorY))).sort((a, b) => a - b),
    [office.corridorY],
  );

  const far = camera.scale < 0.4;

  return (
    <svg
      className={cn('office-scene', far && 'is-far')}
      width={viewport.w}
      height={viewport.h}
      role="img"
      aria-label="Office floor"
    >
      <defs>
        <radialGradient id="office-vignette" cx="50%" cy="45%" r="72%">
          <stop offset="55%" stopColor="#000000" stopOpacity="0" />
          <stop offset="100%" stopColor="#000000" stopOpacity="0.55" />
        </radialGradient>
        <radialGradient id="office-lamp" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#ffcf8f" stopOpacity="0.22" />
          <stop offset="100%" stopColor="#ffcf8f" stopOpacity="0" />
        </radialGradient>
      </defs>

      <g transform={`translate(${camera.x.toFixed(2)} ${camera.y.toFixed(2)}) scale(${camera.scale.toFixed(3)})`}>
        {/* The ground, as a slab with an edge — the building sits in space. */}
        <polygon points={boxFaces(-PAD, -PAD, office.width + PAD * 2, office.height + PAD * 2, -SLAB).front} fill="#080b11" />
        <polygon points={boxFaces(-PAD, -PAD, office.width + PAD * 2, office.height + PAD * 2, -SLAB).right} fill="#0b0f16" />
        <polygon points={floorRect(-PAD, -PAD, office.width + PAD * 2, office.height + PAD * 2, -SLAB)} fill="#0a0d14" />
        <polygon
          points={floorRect(-PAD, -PAD, office.width + PAD * 2, office.height + PAD * 2, -1)}
          fill="#0f141d"
        />
        <polygon points={floorRect(0, 0, office.width, office.height, 0)} fill={FLOOR} />

        {/* Floor boards: long runs along one axis, which is what reads as a floor. */}
        {Array.from({ length: Math.ceil(office.height / 128) }, (_, i) => (
          <polyline
            key={`b${i}`}
            points={polyPoints([
              project(0, (i + 1) * 128, 0),
              project(office.width, (i + 1) * 128, 0),
            ])}
            fill="none"
            stroke="#1d2432"
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
        <Conveyor from={{ x: SPINE_W / 2, y: -8 }} to={{ x: SPINE_W / 2, y: office.height + 8 }} half={18} />
        {corridors.map((y) => (
          <g key={`c${y}`}>
            <polygon
              points={floorRect(-8, y - aisle / 2, office.width + 16, aisle, 1)}
              fill={WALK}
              stroke={KERB}
              strokeWidth={1.5}
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
            This was a quadratic curve arcing over the furniture — which is a cable
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
      </g>

      <rect x={0} y={0} width={viewport.w} height={viewport.h} fill="url(#office-vignette)" pointerEvents="none" />
    </svg>
  );
}
