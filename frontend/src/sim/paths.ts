/**
 * Corridor routing (pure).
 *
 * Turns "this agent should end up over there" into a polyline that follows the
 * building: out of your room's door, down the spur into the row corridor, along
 * the corridor, up the vertical spine if the destination is on another row, and
 * finally in through the destination's door.
 *
 * Straight lines are only used *inside* a room, which is what makes movement
 * read as walking the halls rather than drifting across walls.
 */
import type { Point } from './geometry';
import type { Office, Room } from './floorplan';
import { simplify } from './walkers';

export function roomById(office: Office, id: string | null | undefined): Room | undefined {
  if (!id) return undefined;
  return office.rooms.find((r) => r.id === id);
}

/** The point inside a room a visitor should stand at. */
export function anchorOf(office: Office, roomId: string): Point {
  const room = roomById(office, roomId);
  if (!room) return { x: office.spineX, y: office.height / 2 };
  switch (room.kind) {
    case 'commons':
      return office.reviewTable;
    case 'break':
      return office.breakSpot;
    default:
      return { x: room.x + room.w / 2, y: room.y + room.h - 26 };
  }
}

/**
 * Route between two rooms. Returns the full polyline from just inside the start
 * room to the anchor inside the destination (the caller prepends wherever the
 * walker currently stands).
 */
export function routeBetween(
  office: Office,
  fromRoomId: string,
  toRoomId: string,
  fromPoint: Point,
  toPoint: Point,
): Point[] {
  if (fromRoomId === toRoomId) {
    return simplify([fromPoint, toPoint]);
  }

  const from = roomById(office, fromRoomId);
  const to = roomById(office, toRoomId);

  // No destination room → straight line.
  if (!to) return simplify([fromPoint, toPoint]);

  const corrTo = office.corridorY[to.id] ?? to.y + to.h + 40;

  // Unknown origin (e.g. someone walking in off the street): come up the spine.
  if (!from) {
    return simplify([
      fromPoint,
      { x: office.spineX, y: corrTo },
      { x: to.door.x, y: corrTo },
      to.door,
      toPoint,
    ]);
  }

  const corrFrom = office.corridorY[from.id] ?? from.y + from.h + 40;

  const via: Point[] = [
    fromPoint,
    from.door,
    { x: from.door.x, y: corrFrom },
    { x: to.door.x, y: corrTo },
    to.door,
    toPoint,
  ];

  // Different shelf rows: detour through the vertical spine.
  if (from.row !== to.row) {
    via.splice(
      2,
      2,
      { x: from.door.x, y: corrFrom },
      { x: office.spineX, y: corrFrom },
      { x: office.spineX, y: corrTo },
      { x: to.door.x, y: corrTo },
    );
  }

  return simplify(via);
}

/** Whether a route leaves the room it started in (used to label "out visiting"). */
export function leavesRoom(fromRoomId: string, toRoomId: string): boolean {
  return fromRoomId !== toRoomId;
}
