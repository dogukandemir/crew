import type { CSSProperties } from 'react';
import type { OrgNode } from '../../api/types';
import { cn } from '../../lib/cn';
import { deviceFor } from './avatars';
import type { Activity } from './activity';
import type { Room } from './floorplan';
import { formatMicros, formatPercent } from '../../lib/format';

function Desk({
  desk,
  activity,
  selected,
  onSelect,
}: {
  desk: { agentId: string; agent: OrgNode; x: number; y: number };
  activity: Activity;
  selected: boolean;
  onSelect: () => void;
}) {
  const offline = activity.kind === 'offline';
  const live = activity.kind === 'typing' || activity.kind === 'tool';
  const alert = activity.kind === 'blocked' || activity.kind === 'waiting';

  return (
    <div
      className={cn('desk', live && 'is-live', alert && 'is-alert')}
      style={{ left: desk.x, top: desk.y }}
    >
      <div className="desk-base" />
      <div className="desk-top">
        <span className={cn('desk-device', live && 'is-live')}>
          {deviceFor(desk.agent.role, offline)}
        </span>
        {!offline && <span className="desk-cup">☕</span>}
      </div>
      <button
        type="button"
        className="sprite-hit"
        style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', opacity: 0 }}
        onClick={onSelect}
        aria-pressed={selected}
        aria-label={`${desk.agent.name}, ${desk.agent.role ?? 'agent'}`}
        tabIndex={-1}
      />
    </div>
  );
}

/**
 * One department = one room: a floor plane with a partition wall standing on its
 * far edge, a floating billboarded sign, and desks raised off the floor so the
 * extra height reads as real furniture under the angled camera.
 */
export function RoomView({
  room,
  rotX,
  rotZ,
  activities,
  selectedId,
  focused,
  onFocusRoom,
  onSelectAgent,
}: {
  room: Room;
  rotX: number;
  rotZ: number;
  activities: Record<string, Activity>;
  selectedId: string | null;
  focused: boolean;
  onFocusRoom: (room: Room) => void;
  onSelectAgent: (id: string) => void;
}) {
  const deskActivities = room.desks.map((d) => activities[d.agentId]).filter(Boolean);
  const active = deskActivities.filter(
    (a) => a.kind === 'typing' || a.kind === 'tool' || a.kind === 'talking' || a.kind === 'walking',
  ).length;
  const attention = deskActivities.filter(
    (a) => a.kind === 'blocked' || a.kind === 'waiting',
  ).length;

  const dept = room.dept;
  const spend = dept?.spend_micros ?? dept?.cost_micros;

  return (
    <section
      className={cn('room', focused && 'is-focus')}
      style={
        {
          left: room.x,
          top: room.y,
          width: room.w,
          height: room.h,
          '--accent': room.accent,
        } as CSSProperties
      }
      aria-label={`${room.name} area`}
    >
      <div className="room-floor" />
      <div className="room-wall" />

      <div
        className="room-sign"
        style={{ '--rot-x': `${rotX}deg`, '--rot-z': `${rotZ}deg` } as CSSProperties}
      >
        <div className="room-sign-plate">
          <span className="room-dot" aria-hidden />
          <button
            type="button"
            className="room-name"
            onClick={() => onFocusRoom(room)}
            title="Zoom to this area"
          >
            {room.name}
          </button>
          <span className="room-meta">
            {room.seats > 0 && <span>{room.seats} seats</span>}
            {active > 0 && <span title="working now">● {active}</span>}
            {attention > 0 && (
              <span className="text-rose-300" title="need attention">
                ⚑ {attention}
              </span>
            )}
            {spend !== undefined && <span title="department spend">{formatMicros(spend)}</span>}
            {dept?.success_rate !== undefined && (
              <span title="success rate">{formatPercent(dept.success_rate)}</span>
            )}
          </span>
        </div>
      </div>

      {room.kind === 'commons' && (
        <div className="room-prop" style={{ '--rot-x': `${rotX}deg`, '--rot-z': `${rotZ}deg` } as CSSProperties}>
          🗣️
          <small>stand-up</small>
        </div>
      )}
      {room.kind === 'break' && (
        <div className="room-prop" style={{ '--rot-x': `${rotX}deg`, '--rot-z': `${rotZ}deg` } as CSSProperties}>
          ☕
          <small>coffee</small>
        </div>
      )}

      {room.desks.map((desk) => (
        <Desk
          key={desk.agentId}
          desk={desk}
          activity={activities[desk.agentId]}
          selected={selectedId === desk.agentId}
          onSelect={() => onSelectAgent(desk.agentId)}
        />
      ))}
    </section>
  );
}
