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
  type Office,
  type Room,
} from '../../sim/floorplan';
import type { FloorPulse } from '../../sim/rooms';
import type { Target } from '../../sim/targets';
import type { SvgMotionRef } from '../characters/SvgCharacter';
import { Bubble } from './Bubble';
import { SvgCharacter } from '../characters/SvgCharacter';
import { lookFor } from '../characters/look';
import { mh, boxFaces, floorRect, polyPoints, project } from './iso';
import {
  Cabinet,
  Chair,
  CoffeeBar,
  Crate,
  FloorLamp,
  GroundShadow,
  MeetingTable,
  Plant,
  Printer,
  RoundTable,
  Whiteboard,
  Workstation,
  mix,
  shade,
} from './props';
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

/** How tall a person is on screen: 1.5 m in world units, as the SVG's box. */
export const CHAR_SIZE = (mh(1.5) * 100) / 92;
const CHAR_W = CHAR_SIZE * 0.64;
const FEET_Y = CHAR_SIZE * 0.92;

/** The emoji bubble's skin, so a blocked character does not look chatty. */
function emojiKind(activity: Activity): 'talk' | 'report' | 'escalation' {
  if (activity.kind === 'blocked' || activity.kind === 'waiting') return 'escalation';
  if (activity.kind === 'celebrating') return 'report';
  return 'talk';
}

/* ── Signage ──────────────────────────────────────────────────────────────── */

function Sign({ room, pulse }: { room: Room; pulse?: FloorPulse['rooms'][string] }) {
  const p = project(room.x + room.w / 2, room.y, WALL_H + 30);
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

function RoomShell({
  room,
  office,
  pulse,
  activities,
  focused,
  newRoom,
}: {
  room: Room;
  office: Office;
  pulse?: FloorPulse['rooms'][string];
  activities: Record<string, Activity>;
  focused: boolean;
  newRoom: boolean;
}) {
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

      {room.kind === 'department' || room.kind === 'orchestrator' ? (
        <RoomDesks room={room} activities={activities} accent={room.accent} />
      ) : null}

      <RoomFurniture room={room} office={office} />
      <Sign room={room} pulse={pulse} />
    </g>
  );
}

/** A department's workstations, with the corner dressing that makes it a place. */
function RoomDesks({
  room,
  activities,
  accent,
}: {
  room: Room;
  activities: Record<string, Activity>;
  accent: string;
}) {
  return (
    <g>
      {room.desks.map((desk) => {
        const act = activities[desk.agentId];
        const busy = act?.kind === 'typing' || act?.kind === 'tool';
        return (
          <Workstation
            key={desk.agentId}
            x={room.x + desk.x}
            y={room.y + desk.y}
            busy={busy}
            glow={mix('#7cc4ff', accent, 0.5)}
          />
        );
      })}
      {/* Corner dressing: every real office has a sad plant and a cabinet. */}
      <Plant x={room.x + room.w - ROOM_PAD - 14} y={room.y + room.h - 26} />
      {room.seats > 3 && <Cabinet x={room.x + ROOM_PAD} y={room.y + room.h - 40} />}
      <FloorLamp x={room.x + ROOM_PAD + 10} y={room.y + ROOM_HEADER + 20} accent="#ffcf8f" />
      {room.seats > 5 && <Whiteboard x={room.x + room.w - 90} y={room.y + WALL_T + 6} w={110} h={50} />}
    </g>
  );
}

/** The shared rooms: the review table, the coffee corner, the bench. */
function RoomFurniture({ room, office }: { room: Room; office: Office }) {
  if (room.kind === 'commons') {
    return (
      <g>
        <MeetingTable x={room.x + 24} y={room.y + room.h - 124} w={room.w - 48} d={92} seats={3} />
        <Whiteboard x={room.x + room.w / 2} y={room.y + WALL_T + 8} w={168} h={58} />
        <Plant x={room.x + room.w - 26} y={room.y + 30} />
      </g>
    );
  }
  if (room.kind === 'break') {
    return (
      <g>
        <CoffeeBar x={room.x + 18} y={room.y + 16} w={Math.min(150, room.w - 40)} />
        {office.breakTables.map((table, i) => (
          <g key={`t${i}`}>
            <RoundTable at={table} r={BREAK_TABLE_R} />
            {/* The chairs come from the same list the simulation seats people
                on, so a chair is never empty while somebody sits beside it. */}
            {breakSeats([table]).map((seat) => (
              <Chair key={`${i}-${seat.index}`} at={seat.point} color="#2a2f3a" />
            ))}
          </g>
        ))}
        <Plant x={room.x + 26} y={room.y + room.h - 26} />
        <Crate x={room.x + room.w - 58} y={room.y + 24} w={34} h={mh(0.4)} />
      </g>
    );
  }
  if (room.kind === 'bench') {
    return (
      <g>
        <Crate x={room.x + 22} y={room.y + 24} w={46} h={mh(0.5)} />
        <Crate x={room.x + 76} y={room.y + 30} w={36} h={mh(0.36)} />
        <Printer x={room.x + room.w - 76} y={room.y + 24} />
        <Plant x={room.x + 24} y={room.y + room.h - 28} />
      </g>
    );
  }
  return null;
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
}) {
  const look = useMemo(
    () => lookFor(agent.id, agent.role ?? 'agent', agent.grade),
    [agent.id, agent.role, agent.grade],
  );

  const speech = activity.speech;

  return (
    <g
      ref={register}
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

      <g className="sprite-body" transform={`translate(${(-CHAR_W / 2).toFixed(2)} ${(-FEET_Y).toFixed(2)})`}>
        <SvgCharacter
          look={look}
          activity={activity.kind}
          atDesk={atDesk}
          motion={motion}
          size={CHAR_SIZE}
          faded={activity.kind === 'offline'}
        />
      </g>

      {/* A hit area, so clicking anywhere on the figure works. */}
      <rect x={-CHAR_W / 2} y={-FEET_Y} width={CHAR_W} height={FEET_Y} fill="transparent" />

      <text className="sprite-tag" x={0} y={-FEET_Y - 7} textAnchor="middle">
        {agent.name}
      </text>

      {speech ? (
        <g className="sprite-speech" transform={`translate(0 ${(-FEET_Y - 34).toFixed(0)})`}>
          <Bubble kind={speech.kind} text={speech.text} />
          {speech.to && (
            <text y={4} fontSize={8.5} textAnchor="middle" fill="#93a1b8">
              → {speech.to}
            </text>
          )}
        </g>
      ) : activity.bubble ? (
        <g className="sprite-speech" transform={`translate(0 ${(-FEET_Y - 30).toFixed(0)})`}>
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
  onSelectAgent,
  viewport,
  camera,
}: OfficeSceneProps) {
  const rooms = useMemo(
    () => [...office.rooms].sort((a, b) => a.x + a.y - (b.x + b.y)),
    [office.rooms],
  );

  // People are drawn after the furniture, ordered by where they are headed, so
  // the floor reads front-to-back without re-sorting every animation frame.
  const people = useMemo(() => {
    const ids = Object.keys(office.deskOf);
    return ids.sort((a, b) => {
      const pa = targets[a]?.point ?? office.deskOf[a];
      const pb = targets[b]?.point ?? office.deskOf[b];
      return pa.x + pa.y - (pb.x + pb.y);
    });
  }, [office, targets]);

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

        {/* Roads: the spine and one lane per shelf row, kerbed so they read as
            the ways between units rather than as gaps in the floor. */}
        <polygon
          points={floorRect(6, -8, SPINE_W - 12, office.height + 16, 1)}
          fill={WALK}
          stroke={KERB}
          strokeWidth={1.5}
        />
        <polyline
          points={polyPoints([project(SPINE_W / 2, -8, 1), project(SPINE_W / 2, office.height + 8, 1)])}
          fill="none"
          stroke="#5b6b8a"
          strokeWidth={2}
          strokeDasharray="14 12"
        />
        {corridors.map((y) => (
          <g key={`c${y}`}>
            <polygon
              points={floorRect(-8, y - aisle / 2, office.width + 16, aisle, 1)}
              fill={WALK}
              stroke={KERB}
              strokeWidth={1.5}
            />
            <polyline
              points={polyPoints([project(-8, y, 1), project(office.width + 8, y, 1)])}
              fill="none"
              stroke="#5b6b8a"
              strokeWidth={2}
              strokeDasharray="14 12"
            />
          </g>
        ))}

        {/* A spur from every unit's door to the lane that serves it, so each
            department is visibly plugged into the same road network. */}
        {office.rooms.map((room) => {
          const lane = office.corridorY[room.id];
          const from = room.door.y;
          if (!Number.isFinite(lane) || lane <= from) return null;
          return (
            <polygon
              key={`spur-${room.id}`}
              points={floorRect(room.door.x - 19, from - 4, 38, lane - from + 6, 1)}
              fill={WALK}
              stroke={KERB}
              strokeWidth={1.2}
            />
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
            office={office}
            pulse={pulse.rooms[room.id]}
            activities={activities}
            focused={focusRoomId === room.id}
            newRoom={newRoomIds.has(room.id)}
          />
        ))}

        {/* Somebody working in another department: show the route they took. */}
        {people.map((id) => {
          const target = targets[id];
          const homeId = office.roomOf[id];
          if (!target || target.roomId === homeId) return null;
          const home = office.rooms.find((r) => r.id === homeId);
          const away = office.rooms.find((r) => r.id === target.roomId);
          if (!home || !away) return null;
          const a = project(home.x + home.w / 2, home.y + home.h / 2, 2);
          const b = project(away.x + away.w / 2, away.y + away.h / 2, 2);
          return (
            <path
              key={`link-${id}`}
              d={`M ${a.x} ${a.y} Q ${(a.x + b.x) / 2} ${Math.min(a.y, b.y) - 60} ${b.x} ${b.y}`}
              fill="none"
              stroke={away.accent}
              strokeWidth={1.5}
              strokeDasharray="6 6"
              opacity={0.5}
            />
          );
        })}

        {people.map((id) => {
          const agent = office.agentOf[id];
          const activity = activities[id];
          const motion = motions.get(id);
          if (!agent || !activity || !motion) return null;
          const target = targets[id];
          return (
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
            />
          );
        })}
      </g>

      <rect x={0} y={0} width={viewport.w} height={viewport.h} fill="url(#office-vignette)" pointerEvents="none" />
    </svg>
  );
}
