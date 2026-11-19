import { animateFrames, useCalmMotion } from '../../app/animation';
import { MotionControl } from '../../app/MotionControl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EventRow, Task } from '../../api/types';
import { useOrg, useProject, useTasks } from '../../app/hooks';
import { currentWork } from '../../sim/currentWork';
import { Select } from '../../components/ui/Field';
import { Modal } from '../../components/ui/Drawer';
import { selectEventLog, useEventLog } from '../../stores/eventLog';
import { Button } from '../../components/ui/Button';
import { Chip } from '../../components/ui/Chip';
import { EmptyState, SkeletonRows } from '../../components/ui/EmptyState';
import { PanelError } from '../../components/PanelError';
import { cn } from '../../lib/cn';
import { AgentWorkstation } from './AgentWorkstation';
import { OfficeScene } from './OfficeScene';
import { buildOffice, placementOf, type Placement, type Room } from '../../sim/floorplan';
import { currentTaskFor, deriveActivity, type Activity } from '../../sim/activity';
import { floorPulse } from '../../sim/rooms';
import { computeTargets } from '../../sim/targets';
import { liveCouncil } from '../../sim/meeting';
import { routeBetween } from '../../sim/paths';
import { fitCamera, isoBounds, project, screenOf, type Camera } from './iso';
import type { Point } from '../../sim/geometry';
import { panBy, zoomAt } from './viewport';
import { newWalker, setRoute, step, type Walker } from '../../sim/walkers';
import type { SpriteMotionRef as SvgMotionRef } from '../sprites/SpriteCharacter';
import type { Target } from '../../sim/targets';
import { SPRITE_SCALES, setSpriteScale, useSpriteScale } from '../sprites/viewScale';
import './office2d.css';

const ARRIVAL_MS = 3200;
const EVENT_LOOKBACK_MS = 120_000;
const PANEL_W = 380;
/** How long a department that just appeared is flagged as new. */
const NEW_ROOM_MS = 25_000;
/** Room to leave above the floor for signage and speech bubbles when fitting. */
const HEADROOM = 140;

/**
 * Where the API is, and whether it is the zero-key mock. The demo clock the reset
 * control drives lives in `dev/mock` only, the control renders only when the mock is
 * what's behind the API, so a real deployment never shows a button that does nothing.
 */
const API_BASE = (import.meta.env as Record<string, string | undefined>).VITE_API_BASE
  ?? 'http://127.0.0.1:8787';
const MOCK_BEHIND = API_BASE.includes('8788');

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

/**
 * The office floor.
 *
 * Domain state decides *where* everyone should be (targets.ts); a single rAF
 * loop walks them there along the corridor network and writes transforms
 * straight to the DOM, so 30 characters move at 60fps without re-rendering
 * React. The view holds only presentation state, never domain truth.
 */
export function OfficeFloor({ projectId }: { projectId: string; tabId: string }) {
  const org = useOrg(projectId);
  const projectQuery = useProject(projectId);
  const calm = useCalmMotion();
  const tasksQuery = useTasks(projectId);
  const log = useEventLog(selectEventLog(projectId));
  const now = useNow(1000);

  const [cam, setCam] = useState<Camera>({ x: 0, y: 0, scale: 1 });
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [showArchived, setShowArchived] = useState(false);
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [follow, setFollow] = useState(false);
  // Which of the offered sprite sizes is in force. Presentation only: the office
  // is the same office at every size, and the shape never changes.
  const spriteScale = useSpriteScale();
  const [selected, setSelected] = useState<string | null>(null);
  const [focusRoomId, setFocusRoomId] = useState<string | null>(null);
  const [panning, setPanning] = useState(false);
  const [newRoomIds, setNewRoomIds] = useState<Set<string>>(new Set());
  const newRoomAt = useRef(new Map<string, number>());

  const canvasRef = useRef<HTMLDivElement>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const panRef = useRef<{ id: number; x: number; y: number; moved: number } | null>(null);
  const fittedFor = useRef<string | null>(null);
  const lastFollow = useRef(0);

  const walkers = useRef<Map<string, Walker>>(new Map());
  const spriteEls = useRef<Map<string, SVGGElement>>(new Map());
  /** One striped route element per character, written by the walk loop. */
  const trailEls = useRef<Map<string, SVGPathElement>>(new Map());
  /** Per-character frame data the SVG rig reads; never React state. */
  const motions = useRef<Map<string, SvgMotionRef>>(new Map());
  /** Latest targets, for the walk loop to read who is facing whom. */
  const targetsRef = useRef<Record<string, Target>>({});

  /** The group every drawable lives in: what the walk loop keeps in depth order. */
  const depthLayer = useRef<SVGGElement | null>(null);

  const registerDepthLayer = useCallback((el: SVGGElement | null) => {
    depthLayer.current = el;
  }, []);

  /**
   * Keep the floor in position order.
   *
   * SVG has no z-index: element order IS paint order. Every prop and every person in
   * a room is a child of the depth layer carrying `data-depth`, the world x + y of
   * its base, which the projection turns into height on screen, larger being nearer
   *, so this walks that list once a frame and re-appends it only when something has
   * actually crossed something else. A person walking behind a desk is behind it,
   * and in front of it on the way back, without anybody deciding so.
   */
  const sortDepthLayer = useCallback(() => {
    const layer = depthLayer.current;
    if (!layer) return;
    const kids = Array.from(layer.children) as SVGGElement[];
    const depthOf = (el: SVGGElement) => Number(el.getAttribute('data-depth') ?? 0);
    for (let i = 1; i < kids.length; i += 1) {
      if (depthOf(kids[i]) < depthOf(kids[i - 1])) {
        kids.sort((a, b) => depthOf(a) - depthOf(b));
        for (const el of kids) layer.appendChild(el);
        return;
      }
    }
  }, []);

  /** One stable motion box per agent, created on first use. */
  const motionFor = useCallback((id: string): SvgMotionRef => {
    const existing = motions.current.get(id);
    if (existing) return existing;
    const box: SvgMotionRef = { current: { facing: 1, moving: false, speed: 0, x: 0, y: 0 } };
    motions.current.set(id, box);
    return box;
  }, []);

  const lastTargetKey = useRef<Map<string, string>>(new Map());
  const lastRoom = useRef<Map<string, string>>(new Map());
  const idleSince = useRef<Map<string, number>>(new Map());
  const arrivals = useRef<Map<string, number>>(new Map());
  const rosterReady = useRef(false);
  /** The slots the last build produced, fed back into the next one. */
  const placement = useRef<Placement['slots']>({});

  // ── The council in session, if any ─────────────────────────────────────────
  // Straight off the event log (sim/meeting): a sitting is live from
  // `council.convened` until a decision, or until it goes quiet. Its panel meets
  // at the meeting room's table, and showing that is the floor's job for them.
  const council = useMemo(() => liveCouncil(log.items, now), [log.items, now]);
  const councilMembers = useMemo(() => new Set(council?.members ?? []), [council]);
  const councilKey = council ? `${council.id}|${council.members.length}|${council.question}` : '';

  const office = useMemo(() => {
    // The floor is EXTENDED, never re-packed: the slots from the last build go back in,
    // so a room that already exists keeps its place and only new rooms are allocated.
    // That is what makes a hire a local event, the department it joins re-grids its
    // own desks and nobody else in the building moves.
    //
    // The ref is written inside the memo on purpose: it is the memo's own output that
    // the next build needs. StrictMode calling this twice is harmless, the second call
    // restores the slots the first one just produced, which is the same placement.
    const built = buildOffice(org.data?.root, {
      showArchived,
      prev: placement.current,
      meeting: council ? { question: council.question } : null,
    });
    placement.current = placementOf(built);
    return built;
    // `councilKey` and not `council`: the room has to appear when a sitting opens,
    // and the memo must NOT rebuild on every clock tick.
  }, [org.data, showArchived, councilKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const visibleIds = useMemo(() => Object.keys(office.deskOf).sort(), [office]);
  const rosterKey = visibleIds.join(',');
  const seenRooms = useRef<Set<string>>(new Set());
  const tasks = useMemo(() => currentWork(tasksQuery.data?.items ?? [], projectQuery.data), [tasksQuery.data, projectQuery.data]);

  /** The screen box the whole building occupies, signage included. */
  const bounds = useMemo(
    () => isoBounds(office.width, office.height, HEADROOM, 46),
    [office.width, office.height],
  );

  // The scene reads its per-character animation state from this map, so every
  // seated agent needs a box before the first paint; the walk loop fills them in.
  useEffect(() => {
    for (const id of visibleIds) motionFor(id);
  }, [visibleIds, motionFor]);

  // ── Canvas size ────────────────────────────────────────────────────────────
  const attachCanvas = useCallback((el: HTMLDivElement | null) => {
    canvasRef.current = el;
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    observerRef.current = ro;
  }, []);
  useEffect(() => () => observerRef.current?.disconnect(), []);

  const fit = useCallback(() => {
    setCam(fitCamera(bounds, size, { zoom: 1.04 }));
  }, [bounds, size]);

  useEffect(() => {
    if (size.w === 0 || office.width === 0) return;
    const key = `${projectId}:${size.w}x${size.h}`;
    if (fittedFor.current === key) return;
    fittedFor.current = key;
    // A touch closer than a pure fit on first paint. The bounds carry the slab's
    // margin and the sign headroom; spending all of that on empty space made the
    // cast forty pixels tall on a wide screen. Fit still exists and returns the
    // whole building exactly.
    setCam(fitCamera(bounds, size, { zoom: 1.1 }));
  }, [projectId, size, office.width, bounds]);

  // A department the org just opened: say so on the floor for a while.
  useEffect(() => {
    const ids = office.rooms.map((r) => r.id);
    const known = seenRooms.current;
    if (known.size === 0) {
      ids.forEach((id) => known.add(id));
      return;
    }
    const fresh = ids.filter((id) => !known.has(id));
    if (fresh.length === 0) return;
    ids.forEach((id) => known.add(id));
    fresh.forEach(id => newRoomAt.current.set(id, Date.now()));
    setNewRoomIds((prev) => new Set([...prev, ...fresh]));
  }, [office.rooms]);
  useEffect(() => {
    setNewRoomIds(previous => {
      const next = new Set([...previous].filter(id => now - (newRoomAt.current.get(id) ?? 0) < NEW_ROOM_MS));
      return next.size === previous.size ? previous : next;
    });
  }, [now]);

  useEffect(() => {
    setSelected(null);
    setFocusRoomId(null);
    fittedFor.current = null;
  }, [projectId]);

  // ── Live state → activity ──────────────────────────────────────────────────
  const recentByAgent = useMemo(() => {
    const cutoff = now - EVENT_LOOKBACK_MS;
    const map = new Map<string, EventRow[]>();
    for (const e of log.items) {
      if (!e.agent_id) continue;
      const ts = Date.parse(e.ts);
      if (Number.isNaN(ts) || ts < cutoff) continue;
      const bucket = map.get(e.agent_id);
      if (bucket) bucket.push(e);
      else map.set(e.agent_id, [e]);
    }
    return map;
  }, [log.items, now]);

  const activities = useMemo(() => {
    const out: Record<string, Activity> = {};
    const list = tasks ?? [];
    for (const id of visibleIds) {
      const at = arrivals.current.get(id);
      out[id] = deriveActivity({
        agent: office.agentOf[id],
        task: currentTaskFor(id, list),
        events: recentByAgent.get(id) ?? [],
        now,
        arriving: at !== undefined && now - at < ARRIVAL_MS,
        inCouncil: councilMembers.has(id),
      });
    }
    return out;
  }, [visibleIds, office, tasks, recentByAgent, now, councilMembers]);

  // A department's pulse: who is producing, what it has shipped, is it new.
  const pulse = useMemo(
    () => floorPulse({ office, activities, events: log.items, now, showArchived }),
    [office, activities, log.items, now, showArchived],
  );

  // ── Roster bookkeeping ─────────────────────────────────────────────────────
  useEffect(() => {
    const ids = visibleIds;
    if (!rosterReady.current) {
      if (ids.length === 0) return;
      rosterReady.current = true;
      for (const id of ids) arrivals.current.set(id, Number.NEGATIVE_INFINITY);
      return;
    }
    const t = Date.now();
    for (const id of ids) if (!arrivals.current.has(id)) arrivals.current.set(id, t);
    for (const id of Array.from(arrivals.current.keys())) {
      if (!ids.includes(id)) arrivals.current.delete(id);
    }
  }, [rosterKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const t = Date.now();
    for (const id of visibleIds) {
      if (activities[id]?.kind === 'idle') {
        if (!idleSince.current.has(id)) idleSince.current.set(id, t);
      } else {
        idleSince.current.delete(id);
      }
    }
  }, [rosterKey, activities]); // eslint-disable-line react-hooks/exhaustive-deps

  const arrivingIds = useMemo(() => {
    const set = new Set<string>();
    for (const [id, at] of arrivals.current) {
      if (now - at < ARRIVAL_MS) set.add(id);
    }
    return set;
  }, [now]); // eslint-disable-line react-hooks/exhaustive-deps

  const targets = useMemo(
    () =>
      computeTargets({
        office,
        activities,
        tasks: tasks ?? [],
        now,
        idleSince: idleSince.current,
        arriving: arrivingIds,
        meeting: council,
      }),
    [office, activities, tasks, now, arrivingIds, council],
  );

  // ── Route reconciliation (only when a destination actually changes) ────────
  useEffect(() => {
    for (const id of visibleIds) {
      const t = targets[id];
      if (!t) continue;
      const key = `${t.roomId}:${Math.round(t.point.x)}:${Math.round(t.point.y)}`;
      const previous = lastTargetKey.current.get(id);
      if (previous === key) continue;

      const existing = walkers.current.get(id);
      if (existing) {
        const fromRoom = lastRoom.current.get(id) ?? t.roomId;
        const route = routeBetween(office, fromRoom, t.roomId, { x: existing.x, y: existing.y }, t.point);
        walkers.current.set(id, setRoute(existing, route));
      } else {
        // First sighting: everyone starts at their own desk (a new hire walks in
        // from the entrance), so a character whose destination differs from home
        // visibly walks there instead of blinking into place.
        const incoming = arrivingIds.has(id);
        const from: Point = incoming ? office.entrance : office.deskOf[id];
        const fromRoom = incoming ? '__entrance' : office.roomOf[id];
        const route = routeBetween(office, fromRoom, t.roomId, from, t.point);
        walkers.current.set(id, setRoute(newWalker(from.x, from.y), route));
      }
      lastTargetKey.current.set(id, key);
      lastRoom.current.set(id, t.roomId);
    }

    for (const id of Array.from(walkers.current.keys())) {
      if (!visibleIds.includes(id)) {
        walkers.current.delete(id);
        lastTargetKey.current.delete(id);
        lastRoom.current.delete(id);
        motions.current.delete(id);
        idleSince.current.delete(id);
      }
    }
  }, [targets, visibleIds, office, arrivingIds]);

  // ── The walk loop: one rAF for every character ─────────────────────────────
  targetsRef.current = targets;

  useEffect(() => {
    let last = performance.now();
    const tick = (t: number, reducedMotion: boolean) => {
      // Clamp dt so a backgrounded tab does not teleport everyone on return.
      const dt = Math.min(0.05, Math.max(0, (t - last) / 1000));
      last = t;
      // Dev probe: is this loop alive, and does it have anything to drive? Three
      // stacked things can stop the office dead, a dead rAF, an empty walker map,
      // a sprite map with no elements in it, and from outside they look identical.
      // `targets` adds the one piece pixels cannot answer: WHERE each character is
      // headed and why (a council that failed to seat its panel looks exactly like
      // an empty meeting room).
      if (import.meta.env.DEV) {
        const w = window as unknown as { __office?: Record<string, unknown> };
        w.__office = {
          ticks: ((w.__office?.ticks as number) ?? 0) + 1,
          walkers: walkers.current.size,
          sprites: spriteEls.current.size,
          targets: Object.fromEntries(
            Object.entries(targetsRef.current).map(([id, tg]) => [
              id,
              `${tg.roomId}${tg.reason ? ' · ' + tg.reason.slice(0, 48) : ''}`,
            ]),
          ),
        };
      }
      for (const [id, w] of walkers.current) {
        const next = w.moving ? step(w, reducedMotion ? 1_000_000 : dt) : w;
        if (next !== w) walkers.current.set(id, next);
        const el = spriteEls.current.get(id);
        if (!el) continue;
        // World position → screen position → the SVG transform. Nothing is
        // rotated: a character is drawn upright wherever the floor puts them.
        const p = project(next.x, next.y);
        const facingAt = !next.moving ? targetsRef.current[id]?.faceTowards : undefined;
        const flip = facingAt ? (facingAt.x >= next.x ? 1 : -1) : next.facing;
        // Only the position is written here. The figure mirrors itself, so the
        // name tag and the speech bubble above it stay readable.
        const transform = `translate(${p.x.toFixed(2)} ${p.y.toFixed(2)})`;
        if (el.getAttribute('transform') !== transform) el.setAttribute('transform', transform);
        if (next.moving !== el.classList.contains('is-walking')) {
          el.classList.toggle('is-walking', next.moving);
        }

        // The route ahead of them, as a striped line on the floor. Only while
        // they are actually walking; a person standing still has no route.
        const trail = trailEls.current.get(id);
        if (trail) {
          if (next.moving && next.route.length > next.seg + 1) {
            const points = [{ x: next.x, y: next.y }, ...next.route.slice(next.seg + 1)];
            trail.setAttribute(
              'd',
              points
                .map((p, i) => {
                  const sp = project(p.x, p.y);
                  return `${i === 0 ? 'M' : 'L'} ${sp.x.toFixed(1)} ${sp.y.toFixed(1)}`;
                })
                .join(' '),
            );
            // CSS owns the default opacity; an SVG presentation attribute cannot
            // override it. Use inline style so a walking route is actually visible.
            if (trail.style.opacity !== '0.75') trail.style.opacity = '0.75';
          } else if (trail.style.opacity !== '0') {
            trail.style.opacity = '0';
          }
        }

        // Hand the same movement to the character rig, so the walk cycle is
        // driven by ground actually covered rather than by a timer.
        const m = motionFor(id);
        const travelled = Math.hypot(next.x - w.x, next.y - w.y);
        m.current.moving = next.moving;
        m.current.speed = dt > 0 ? travelled / dt : 0;
        m.current.facing = flip < 0 ? -1 : 1;
        // The floor's order is a property of where things stand, so it is written
        // where positions are written, here, and not in React.
        m.current.x = next.x;
        m.current.y = next.y;
        m.current.seated = !next.moving && !!targetsRef.current[id]?.seated;
        const depth = String(next.x + next.y);
        if (el.getAttribute('data-depth') !== depth) el.setAttribute('data-depth', depth);
      }
      sortDepthLayer();
    };
    return animateFrames(tick);
  }, []);

  const registerSprite = useCallback(
    (id: string) => (el: SVGGElement | null) => {
      if (!el) {
        spriteEls.current.delete(id);
        return;
      }
      spriteEls.current.set(id, el);
      const w = walkers.current.get(id);
      if (w) {
        const p = project(w.x, w.y);
        el.setAttribute('transform', `translate(${p.x.toFixed(2)} ${p.y.toFixed(2)})`);
      }
    },
    [],
  );

  const registerTrail = useCallback(
    (id: string) => (el: SVGPathElement | null) => {
      if (!el) {
        trailEls.current.delete(id);
        return;
      }
      trailEls.current.set(id, el);
    },
    [],
  );

  // ── Follow the action ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!follow || size.w === 0) return;
    let best: { id: string; ts: number } | null = null;
    for (const e of log.items.slice(-80)) {
      if (!e.agent_id || !office.deskOf[e.agent_id]) continue;
      const ts = Date.parse(e.ts);
      if (Number.isNaN(ts) || Date.now() - ts > EVENT_LOOKBACK_MS) continue;
      if (!best || ts > best.ts) best = { id: e.agent_id, ts };
    }
    if (!best) return;
    if (Date.now() - lastFollow.current < 3000) return;
    const seat = office.deskOf[best.id];
    lastFollow.current = Date.now();
    setCam(
      fitCamera(isoBounds(360, 360, HEADROOM, 40), size, { zoom: 1.35 }),
    );
    // Centre on the seat itself rather than on the world origin.
    const corner = project(Math.max(0, seat.x - 180), Math.max(0, seat.y - 180));
    setCam((c) => ({ ...c, x: c.x - corner.x * c.scale, y: c.y - corner.y * c.scale }));
  }, [follow, log.items, office, size]);

  // ── Camera interaction ─────────────────────────────────────────────────────
  useEffect(() => {
    // The frame is resolved FROM THE EVENT, on every wheel, and never captured at mount.
    // The captured version came back null, the office's labelled element does not exist
    // yet when this effect first runs, so every wheel was rejected, no preventDefault
    // was called, and the browser took the gesture as its own page zoom, in Chrome and
    // Firefox alike. The handler's own trace said exactly that:
    //   { mounted: true, frameTag: null, sawEvent: true, inFrame: false }
    const onWheel = (e: WheelEvent, host: HTMLElement) => {
      e.preventDefault();
      const rect = host.getBoundingClientRect();
      // Ctrl (or ⌘) is the zoom modifier, the same one the browser itself uses. A plain
      // wheel scrolls the floor instead of zooming it: without the modifier, a trackpad
      // two-finger scroll flung the zoom about while the reader was only trying to look
      // around, which is not what that gesture means anywhere else.
      // Alt is a first-class zoom modifier here, not a fallback. Firefox handles its
      // own Ctrl+wheel page zoom INSIDE the browser, and no preventDefault, in any
      // phase, from any element, cancels it. A Ctrl-only binding therefore still zooms
      // the page in Firefox however early we listen, which is exactly what was
      // reported. Alt+wheel is unclaimed by Firefox, Chrome and Edge alike, so it means
      // the floor in all three; Ctrl+wheel keeps working where the browser allows it.
      if (e.ctrlKey || e.metaKey || e.altKey) {
        const factor = Math.exp(-e.deltaY * 0.0015);
        setCam((c) => zoomAt(c, factor, e.clientX - rect.left, e.clientY - rect.top));
        return;
      }
      setCam((c) => ({ ...c, x: c.x - e.deltaX, y: c.y - e.deltaY }));
    };
    // Capture phase, on the window: a browser decides its own page zoom from a Ctrl+wheel
    // event, so preventDefault has to land before the default action, and a dropped
    // wheel is not a no-op, the browser takes it as page zoom. That is what was
    // happening: the gesture was rejected here, not by the browser.
    // The guard resolves the game frame FROM THE EVENT (see captureWheel), never from a
    // value captured when this effect ran. The captured one was null, because the office's
    // labelled element does not exist yet at first mount, so every wheel was rejected.
    const captureWheel = (e: WheelEvent) => {
      const target = e.target;
      // Walk up from whatever the wheel landed on. `closest` finds the game frame (or the
      // scene svg, which carries the same label) whatever the mount order was, and
      // whatever `canvasRef` happens to point at.
      const host = target instanceof Element
        ? (target.closest('[aria-label^="Office floor"]') as HTMLElement | null)
        : null;
      if (import.meta.env.DEV) {
        (window as unknown as { __officeWheel?: Record<string, unknown> }).__officeWheel = {
          sawEvent: true,
          inGame: !!host,
          ctrl: e.ctrlKey,
          alt: e.altKey,
          targetTag: target instanceof Element ? target.tagName : typeof target,
          at: new Date().toISOString(),
        };
      }
      if (!host) return;
      onWheel(e, host);
    };
    window.addEventListener('wheel', captureWheel, { passive: false, capture: true });
    return () => {
      window.removeEventListener('wheel', captureWheel, { capture: true });
    };
  }, []);

  const focusRoom = useCallback(
    (room: Room) => {
      setFocusRoomId(room.id);
      const box = isoBounds(room.w, room.h, HEADROOM, 40);
      const base = fitCamera(box, size, { zoom: 1.1 });
      // The box is measured from the world origin, so shift it onto the room.
      const corner = project(room.x, room.y);
      setCam({ ...base, x: base.x - corner.x * base.scale, y: base.y - corner.y * base.scale });
    },
    [size],
  );

  const selectAgent = useCallback(
    (id: string) => {
      setSelected(id);
      setFocusRoomId(null);
      const at = office.deskOf[id];
      const walker = walkers.current.get(id);
      const pos = walker ? { x: walker.x, y: walker.y } : at;
      if (!pos || size.w === 0) return;
      // Zoom to an inspectable size, preserving the selected person's location.
      const visibleW = size.w < 640 ? size.w : Math.max(160, size.w - PANEL_W);
      const scale = Math.max(cam.scale, 0.55);
      const projected = project(pos.x, pos.y);
      setCam({ scale, x: visibleW / 2 - projected.x * scale, y: size.h / 2 - projected.y * scale });
    },
    [office, size.w, size.h, cam],
  );

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest('[data-sprite]') || target.closest('button')) return;
    panRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: 0 };
    setPanning(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = panRef.current;
    if (!p || p.id !== e.pointerId) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    p.moved += Math.abs(dx) + Math.abs(dy);
    setCam((c) => panBy(c, dx, dy));
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = panRef.current;
    if (!p || p.id !== e.pointerId) return;
    panRef.current = null;
    setPanning(false);
    if (p.moved < 4) {
      setSelected(null);
      setFocusRoomId(null);
    }
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const cx = size.w / 2;
    const cy = size.h / 2;
    const lane = 70;
    switch (e.key) {
      case '0':
      case 'f':
        fit();
        break;
      case '+':
      case '=':
        setCam((c) => zoomAt(c, 1.25, cx, cy));
        break;
      case '-':
        setCam((c) => zoomAt(c, 1 / 1.25, cx, cy));
        break;
      case 'ArrowLeft':
        setCam((c) => panBy(c, lane, 0));
        break;
      case 'ArrowRight':
        setCam((c) => panBy(c, -lane, 0));
        break;
      case 'ArrowUp':
        setCam((c) => panBy(c, 0, lane));
        break;
      case 'ArrowDown':
        setCam((c) => panBy(c, 0, -lane));
        break;
      case 'Escape':
        setSelected(null);
        setFocusRoomId(null);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const counts = useMemo(() => {
    const all = Object.values(activities);
    return {
      agents: all.length,
      working: all.filter((a) => ['typing', 'tool', 'talking', 'walking'].includes(a.kind)).length,
      thinking: all.filter((a) => a.kind === 'thinking').length,
      attention: all.filter((a) => a.kind === 'blocked' || a.kind === 'waiting').length,
    };
  }, [activities]);

  if (org.isLoading) return <SkeletonRows rows={6} />;
  if (org.isError) {
    return <PanelError error={org.error} onRetry={() => void org.refetch()} label="Office" />;
  }

  const empty = visibleIds.length === 0;
  const shipped = Object.values(pulse.rooms).reduce((sum, room) => sum + room.shipped, 0);

  return (
    <div className={cn('office', calm ? 'is-calm' : 'is-animated')}>
      {tasksQuery.isError && <PanelError error={tasksQuery.error} label="Task status" onRetry={() => void tasksQuery.refetch()} />}
      <div className="office-toolbar">
        <div className="office-brand">
          <span className="office-live-dot" />
          <span>Live floor</span>
        </div>

        <div className="office-group">
          <Button
            size="xs"
            variant="ghost"
            aria-label="Zoom out"
            onClick={() => setCam((c) => zoomAt(c, 1 / 1.25, size.w / 2, size.h / 2))}
          >
            −
          </Button>
          <span className="office-stat w-11 text-center">{Math.round(cam.scale * 100)}%</span>
          <Button
            size="xs"
            variant="ghost"
            aria-label="Zoom in"
            onClick={() => setCam((c) => zoomAt(c, 1.25, size.w / 2, size.h / 2))}
          >
            ＋
          </Button>
          <Button size="xs" variant="secondary" onClick={fit} title="Fit the floor (F)">
            ⤢ Fit
          </Button>
        </div>

        {/* How big the sprites are drawn. Every option is the same geometry at a
            different size, one factor on both axes, so this is a choice about
            scale, never about shape. */}
        <div className="office-group office-selects">
          <Select aria-label="Character size" className="w-32 text-xs" value={spriteScale}
            onChange={event => setSpriteScale(event.target.value as typeof spriteScale)}>
            {SPRITE_SCALES.map(scale => <option key={scale.name} value={scale.name}>{scale.label.replace('Sprite · ', '')}</option>)}
          </Select>
          <MotionControl />
          <Select aria-label="Inspect an agent" className="w-44 text-xs" value={selected ?? ''}
            onChange={event => { if (event.target.value) selectAgent(event.target.value); else setSelected(null); }}>
            <option value="">Inspect an agent…</option>
            {visibleIds.map(id => <option key={id} value={id}>{office.agentOf[id]?.name}</option>)}
          </Select>
          <Select aria-label="Focus a room" className="w-44 text-xs" value={focusRoomId ?? ''}
            onChange={event => {
              const room = office.rooms.find(room => room.id === event.target.value);
              if (room) focusRoom(room); else { setFocusRoomId(null); fit(); }
            }}>
            <option value="">Whole office</option>
            {office.rooms.filter(room => room.kind !== 'bench').map(room => <option key={room.id} value={room.id}>
              {room.name}{(pulse.rooms[room.id]?.producing ?? 0) > 0 ? ' · working' : ''}
            </option>)}
          </Select>
        </div>

        <div className="office-group office-filters">
          <Chip tone="muted" selected={showArchived} onClick={() => setShowArchived((v) => !v)}>
            archived
          </Chip>
          <Chip
            tone={attentionOnly ? 'danger' : 'muted'}
            selected={attentionOnly}
            onClick={() => setAttentionOnly((v) => !v)}
          >
            needs attention
          </Chip>
          <Chip tone={follow ? 'success' : 'muted'} selected={follow} onClick={() => setFollow((v) => !v)}>
            follow live
          </Chip>
        </div>

        <div className="office-statusbar">
          <span className="office-stat office-summary">
            <b>{counts.agents}</b> seats · <b>{counts.working}</b> working · <b>{counts.thinking}</b> thinking
            {shipped > 0 && (
              <>
                {' · '}
                <b className="text-emerald-300">{shipped}</b> shipped
              </>
            )}
            {counts.attention > 0 && (
              <>
                {' · '}
                <b className="text-rose-300">{counts.attention}</b> need you
              </>
            )}
          </span>

          <div className="office-legend">
            <span>
              <i className="inline-block h-1.5 w-1.5 rounded-full bg-sky-400" /> working
            </span>
            <span>
              <i className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" /> done
            </span>
            <span>
              <i className="inline-block h-1.5 w-1.5 rounded-full bg-rose-400" /> needs you
            </span>
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div
          ref={attachCanvas}
          className={cn('office-canvas', panning && 'is-panning')}
          tabIndex={0}
          role="region"
          aria-label="Office floor, drag or use arrow keys to pan, Alt plus scroll to zoom, inspect an agent for activity and output"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onKeyDown={onKeyDown}
        >
          {size.w > 0 && (
            <OfficeScene
              office={office}
              activities={activities}
              targets={targets}
              pulse={pulse}
              selected={selected}
              attentionOnly={attentionOnly}
              focusRoomId={focusRoomId}
              newRoomIds={newRoomIds}
              motions={motions.current}
              registerSprite={registerSprite}
              registerDepthLayer={registerDepthLayer}
              registerTrail={registerTrail}
              onSelectAgent={selectAgent}
              viewport={size}
              camera={cam}
            />
          )}

          <div className="office-hint">
            drag to pan · <kbd>Alt</kbd>+scroll to zoom · scroll to pan · click a character for thinking &amp; output · <kbd>F</kbd> fit ·{' '}
            <kbd>Esc</kbd> deselect
          </div>

          {/* Restart the mock backend's hiring clock and reload, so the growth can be
              watched from t=0. The clock lives in the mock (`dev/mock`), this renders
              only when the mock is behind the API, never against a real backend. */}
          {MOCK_BEHIND && (
            <button
              type="button"
              style={{ position: 'absolute', left: 'auto', right: 12, top: 12, bottom: 'auto', zIndex: 5, pointerEvents: 'auto', cursor: 'pointer' }}
              className="office-hint office-reset"
              title="Restart the mock's hiring clock and reload"
              onClick={() => {
                void fetch(`${API_BASE}/api/dev/reset`, { method: 'POST' }).then(() => window.location.reload());
              }}
            >
              ⟲ reset clock
            </button>
          )}

          {empty && (
            <div className="office-overlay">
              <EmptyState
                icon="🏢"
                title="The office is empty"
                description="Start a run from Overview. Your company manager will plan the work and hire the agents it needs. Try Demo first, or connect a provider and enable Live for real work."
              />
            </div>
          )}
        </div>

        {selected && size.w >= 640 && (
          <div className="w-[380px] shrink-0 border-l border-slate-700/60 bg-slate-950/50">
            <AgentWorkstation
              key={selected} agentId={selected}
              projectId={projectId}
              activity={activities[selected]}
              onClose={() => setSelected(null)}
            />
          </div>
        )}
        <Modal open={!!selected && size.w < 640} title="Agent activity and output" onClose={() => setSelected(null)}>
          {selected && <div className="h-[60dvh]"><AgentWorkstation key={selected} agentId={selected}
            projectId={projectId} activity={activities[selected]} onClose={() => setSelected(null)} /></div>}
        </Modal>
      </div>
    </div>
  );
}
