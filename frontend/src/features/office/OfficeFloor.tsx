import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { EventRow, Task } from '../../api/types';
import { useOrg, useTasks } from '../../app/hooks';
import { selectEventLog, useEventLog } from '../../stores/eventLog';
import { Button } from '../../components/ui/Button';
import { Chip } from '../../components/ui/Chip';
import { EmptyState, SkeletonRows } from '../../components/ui/EmptyState';
import { PanelError } from '../../components/PanelError';
import { cn } from '../../lib/cn';
import { AgentWorkstation } from './AgentWorkstation';
import { RoomView } from './Room';
import { Sprite } from './Sprite';
import { SPINE_W, buildOffice, type Room } from '../../sim/floorplan';
import { currentTaskFor, deriveActivity, type Activity } from '../../sim/activity';
import { computeTargets } from '../../sim/targets';
import { routeBetween } from '../../sim/paths';
import {
  CAMERA_PRESETS,
  cameraLabel,
  fitTilted,
  focusTilted,
  toScreen,
  type CameraPreset,
} from './camera';
import { distance, type Point } from '../../sim/geometry';
import { panBy, zoomAt, type Transform } from './viewport';
import { newWalker, setRoute, step, type Walker } from '../../sim/walkers';
import type { SvgMotionRef } from '../characters/SvgCharacter';
import type { Target } from '../../sim/targets';
import './office2d.css';

const ARRIVAL_MS = 3200;
const EVENT_LOOKBACK_MS = 120_000;
const PANEL_W = 380;
const WALK_LANE = 78;

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
 * React. The view holds only presentation state — never domain truth.
 */
export function OfficeFloor({ projectId }: { projectId: string; tabId: string }) {
  const org = useOrg(projectId);
  const tasksQuery = useTasks(projectId);
  const log = useEventLog(selectEventLog(projectId));
  const now = useNow(1000);

  const [preset, setPreset] = useState<CameraPreset>('iso');
  const [cam, setCam] = useState<Transform>({ x: 0, y: 0, scale: 1 });
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [showArchived, setShowArchived] = useState(false);
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [follow, setFollow] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [focusRoomId, setFocusRoomId] = useState<string | null>(null);
  const [panning, setPanning] = useState(false);

  const canvasRef = useRef<HTMLDivElement>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const panRef = useRef<{ id: number; x: number; y: number; moved: number } | null>(null);
  const fittedFor = useRef<string | null>(null);
  const lastFollow = useRef(0);

  const walkers = useRef<Map<string, Walker>>(new Map());
  const spriteEls = useRef<Map<string, HTMLDivElement>>(new Map());
  /** Per-character frame data the SVG rig reads; never React state. */
  const motions = useRef<Map<string, SvgMotionRef>>(new Map());
  /** Latest targets, for the walk loop to read who is facing whom. */
  const targetsRef = useRef<Record<string, Target>>({});

  /** One stable motion box per agent, created on first use. */
  const motionFor = useCallback((id: string): SvgMotionRef => {
    const existing = motions.current.get(id);
    if (existing) return existing;
    const box: SvgMotionRef = { current: { facing: 1, moving: false, speed: 0 } };
    motions.current.set(id, box);
    return box;
  }, []);
  const lastTargetKey = useRef<Map<string, string>>(new Map());
  const lastRoom = useRef<Map<string, string>>(new Map());
  const idleSince = useRef<Map<string, number>>(new Map());
  const arrivals = useRef<Map<string, number>>(new Map());
  const rosterReady = useRef(false);

  const { rotX, rotZ } = CAMERA_PRESETS[preset];

  const office = useMemo(
    () => buildOffice(org.data?.root, { showArchived }),
    [org.data, showArchived],
  );
  const visibleIds = useMemo(() => Object.keys(office.deskOf).sort(), [office]);
  const rosterKey = visibleIds.join(',');
  const tasks = tasksQuery.data?.items;

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
    setCam(fitTilted(office.width, office.height, size.w, size.h, rotX, rotZ, 36, 1.7));
  }, [office.width, office.height, size.w, size.h, rotX, rotZ]);

  useEffect(() => {
    if (size.w === 0 || office.width === 0) return;
    const key = `${projectId}:${preset}:${size.w}x${size.h}`;
    if (fittedFor.current === key) return;
    fittedFor.current = key;
    setCam(fitTilted(office.width, office.height, size.w, size.h, rotX, rotZ, 36, 1.7));
  }, [projectId, preset, size, office.width, office.height, rotX, rotZ]);

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
      });
    }
    return out;
  }, [visibleIds, office, tasks, recentByAgent, now]);

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
      }),
    [office, activities, tasks, now, arrivingIds],
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
      }
    }
  }, [targets, visibleIds, office, arrivingIds]);

  // ── The walk loop: one rAF for every character ─────────────────────────────
  targetsRef.current = targets;

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const tick = (t: number) => {
      // Clamp dt so a backgrounded tab does not teleport everyone on return.
      const dt = Math.min(0.05, Math.max(0, (t - last) / 1000));
      last = t;
      for (const [id, w] of walkers.current) {
        const next = w.moving ? step(w, dt) : w;
        if (next !== w) walkers.current.set(id, next);
        const el = spriteEls.current.get(id);
        if (!el) continue;
        el.style.transform = `translate3d(${next.x.toFixed(2)}px, ${next.y.toFixed(2)}px, 0)`;
        if (next.moving !== el.classList.contains('is-walking')) {
          el.classList.toggle('is-walking', next.moving);
        }
        const facingAt = !next.moving ? targetsRef.current[id]?.faceTowards : undefined;
        const flip = String(facingAt ? (facingAt.x >= next.x ? 1 : -1) : next.facing);
        if (el.style.getPropertyValue('--flip') !== flip) el.style.setProperty('--flip', flip);

        // Hand the same movement to the character rig, so the walk cycle is
        // driven by ground actually covered rather than by a timer.
        const m = motionFor(id);
        const travelled = Math.hypot(next.x - w.x, next.y - w.y);
        m.current.moving = next.moving;
        m.current.speed = dt > 0 ? travelled / dt : 0;
        m.current.facing = next.facing < 0 ? -1 : 1;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const registerSprite = useCallback(
    (id: string) => (el: HTMLDivElement | null) => {
      if (!el) {
        spriteEls.current.delete(id);
        return;
      }
      spriteEls.current.set(id, el);
      const w = walkers.current.get(id);
      if (w) el.style.transform = `translate3d(${w.x.toFixed(2)}px, ${w.y.toFixed(2)}px, 0)`;
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
      if (Number.isNaN(ts)) continue;
      if (!best || ts > best.ts) best = { id: e.agent_id, ts };
    }
    if (!best) return;
    if (Date.now() - lastFollow.current < 3000) return;
    const seat = office.deskOf[best.id];
    lastFollow.current = Date.now();
    setCam(focusTilted({ x: seat.x - 300, y: seat.y - 190, w: 600, h: 380 }, size.w, size.h, rotX, rotZ, 1.05));
  }, [follow, log.items, office, size.w, size.h, rotX, rotZ]);

  // ── Camera interaction ─────────────────────────────────────────────────────
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const factor = Math.exp(-e.deltaY * 0.0015);
      setCam((c) => zoomAt(c, factor, e.clientX - rect.left, e.clientY - rect.top));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const focusRoom = useCallback(
    (room: Room) => {
      setFocusRoomId(room.id);
      setCam(
        focusTilted(
          { x: room.x, y: room.y, w: room.w, h: room.h },
          size.w,
          size.h,
          rotX,
          rotZ,
          1.15,
        ),
      );
    },
    [size.w, size.h, rotX, rotZ],
  );

  const selectAgent = useCallback(
    (id: string) => {
      setSelected(id);
      setFocusRoomId(null);
      const at = office.deskOf[id];
      const walker = walkers.current.get(id);
      const pos = walker ? { x: walker.x, y: walker.y } : at;
      if (!pos || size.w === 0) return;
      const screen = toScreen(pos.x, pos.y, cam, rotX, rotZ);
      const visibleW = Math.max(160, size.w - PANEL_W);
      const margin = 120;
      let dx = 0;
      let dy = 0;
      if (screen.x > visibleW - margin) dx = visibleW - margin - screen.x;
      else if (screen.x < margin) dx = margin - screen.x;
      if (screen.y > size.h - margin) dy = size.h - margin - screen.y;
      else if (screen.y < margin) dy = margin - screen.y;
      if (dx !== 0 || dy !== 0) setCam((c) => panBy(c, dx, dy));
    },
    [office, size.w, size.h, cam, rotX, rotZ],
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

  const corridorBands = useMemo(
    () => Array.from(new Set(Object.values(office.corridorY))).sort((a, b) => a - b),
    [office.corridorY],
  );

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
  const far = cam.scale < 0.42;
  const mid = cam.scale < 0.62;
  const camStyle: CSSProperties = {
    transform: `translate3d(${cam.x}px, ${cam.y}px, 0) scale(${cam.scale})`,
  };
  const worldStyle: CSSProperties = {
    width: office.width,
    height: office.height,
    transform: `rotateX(${rotX}deg) rotateZ(${rotZ}deg)`,
  };

  return (
    <div className="office">
      <div className="office-toolbar">
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

        <span className="office-sep" />

        {(Object.keys(CAMERA_PRESETS) as CameraPreset[]).map((p) => (
          <Chip key={p} selected={preset === p} onClick={() => setPreset(p)} tone={preset === p ? 'success' : 'neutral'}>
            {cameraLabel(p)}
          </Chip>
        ))}

        <span className="office-sep" />

        {office.rooms
          .filter((r) => r.kind === 'department' || r.kind === 'orchestrator')
          .map((r) => (
            <Chip
              key={r.id}
              tone={focusRoomId === r.id ? 'success' : 'neutral'}
              selected={focusRoomId === r.id}
              onClick={() => focusRoom(r)}
            >
              <span
                aria-hidden
                className="mr-1 inline-block h-1.5 w-1.5 rounded-full"
                style={{ background: r.accent }}
              />
              {r.name}
            </Chip>
          ))}

        <span className="office-sep" />

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

        <span className="office-stat">
          <b>{counts.agents}</b> seats · <b>{counts.working}</b> working · <b>{counts.thinking}</b> thinking
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

      <div className="flex min-h-0 flex-1">
        <div
          ref={attachCanvas}
          className={cn('office-canvas', panning && 'is-panning')}
          tabIndex={0}
          role="application"
          aria-label="Office floor — drag to pan, scroll to zoom, click a character to see their thinking"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onKeyDown={onKeyDown}
        >
          <div className="office-camera" style={camStyle}>
            <div className={cn('office-world', mid && 'is-mid', far && 'is-far')} style={worldStyle}>
              <div className="office-floor" />
              <div
                className="corridor is-vertical"
                style={{ left: 0, top: 0, width: SPINE_W, height: office.height }}
              />
              {corridorBands.map((y) => (
                <div
                  key={y}
                  className="corridor"
                  style={{ left: 0, top: y - WALK_LANE / 2, width: office.width, height: WALK_LANE }}
                />
              ))}

              {office.rooms.map((room) => (
                <RoomView
                  key={room.id}
                  room={room}
                  rotX={rotX}
                  rotZ={rotZ}
                  activities={activities}
                  selectedId={selected}
                  focused={focusRoomId === room.id}
                  onFocusRoom={focusRoom}
                  onSelectAgent={selectAgent}
                />
              ))}

              {visibleIds.map((id) => {
                const act = activities[id];
                if (!act) return null;
                const target = targets[id];
                const desk = office.deskOf[id];
                const atDesk =
                  !!target && target.roomId === office.roomOf[id] && distance(target.point, desk) < 1.5;
                return (
                  <Sprite
                    key={id}
                    agent={office.agentOf[id]}
                    activity={act}
                    motion={motionFor(id)}
                    atDesk={atDesk}
                    selected={selected === id}
                    dimmed={attentionOnly && act.kind !== 'blocked' && act.kind !== 'waiting'}
                    walkingTo={
                      target && target.roomId !== office.roomOf[id]
                        ? office.rooms.find((r) => r.id === target.roomId)?.name
                        : undefined
                    }
                    onSelect={() => selectAgent(id)}
                    register={registerSprite(id)}
                  />
                );
              })}
            </div>
          </div>

          <div className="office-hint">
            drag to pan · scroll to zoom · click a character for thinking &amp; output · <kbd>F</kbd> fit ·{' '}
            <kbd>Esc</kbd> deselect
          </div>

          {empty && (
            <div className="office-overlay">
              <EmptyState
                icon="🏢"
                title="The office is empty"
                description="Nobody has been hired yet. Start a run on Overview — the orchestrator works out the capabilities the goal needs, then hires the agents and their desks appear here."
              />
            </div>
          )}
        </div>

        {selected && (
          <div className="w-[380px] shrink-0 border-l border-slate-700/60 bg-slate-950/50">
            <AgentWorkstation
              agentId={selected}
              projectId={projectId}
              activity={activities[selected]}
              onClose={() => setSelected(null)}
            />
          </div>
        )}
      </div>
    </div>
  );
}
