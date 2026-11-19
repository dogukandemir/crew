import { animateFrames, useCalmMotion } from '../../app/animation';
import { MotionControl } from '../../app/MotionControl';
/**
 * The HQ floor (ADR 0011): the whole company drawn on one isometric plate.
 *
 * Same one-metre discipline as the office: this file owns the pixels, `hqScene.ts`
 * owns the layout and the routes, and the record owns the words. People walk only
 * along routes the model staged from real events; a note on a walker is a line the
 * record already wrote, the scene never improvises a sentence.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as RPointerEvent, WheelEvent as RWheelEvent } from 'react';
import type { Hq } from '../../api/types';
import { fitCamera, floorRect, isoBounds, mh, polyPoints, project, type Camera } from '../office/iso';
import { Box, MeetingTable, Plant, Workstation, mix } from '../office/props';
import { SpriteCharacter, type SpriteMotionRef } from '../sprites/SpriteCharacter';
import { Sprite as AtlasSprite } from '../sprites/Sprite';
import { scaleForWidth } from '../sprites/sprites';
import { DESK_W } from '../../sim/floorplan';
import {
  BOARD_TABLE,
  M,
  VERDICT_COLOR,
  buildHqWorld,
  type HqPerson,
  type HqPoint,
  type HqRoom,
  type HqWorld,
} from './hqScene';

const HEADROOM = 320;
const WALK_SPEED = 150; // floor units per second
const FEET_SINK = 1;

interface Walker {
  pos: HqPoint;
  path: HqPoint[];
  idx: number;
  moving: boolean;
  facing: 1 | -1;
  motion: SpriteMotionRef;
  /** First-placement done? Until then the walker sits wherever the record puts it. */
  placed: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

const newWalker = (person: HqPerson): Walker => ({
  pos: { ...person.home }, path: [], idx: 0, moving: false, facing: 1, placed: false,
  motion: { current: { facing: 1, moving: false, speed: WALK_SPEED, x: person.home.x, y: person.home.y } },
});

export function HqFloor({ hq }: { hq: Hq }) {
  const calm = useCalmMotion();
  const world = useMemo(() => buildHqWorld(hq), [hq]);
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SVGGElement>(null);
  const gRefs = useRef(new Map<string, SVGGElement>());
  const walkersRef = useRef(new Map<string, Walker>());
  const [size, setSize] = useState({ w: 900, h: 560 });
  const [cam, setCam] = useState<Camera>({ x: 0, y: 0, scale: 0.35 });
  const fitScaleRef = useRef(0.35);
  const [zoomPct, setZoomPct] = useState(100);
  const [dragging, setDragging] = useState(false);
  const fittedViewport = useRef('');
  const castRef = useRef<SVGGElement>(null);

  // Resize → keep the fit honest.
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth || 900;
      const h = el.clientHeight || 560;
      setSize({ w, h });
      const c = fitCamera(isoBounds(world.w, world.h, HEADROOM, 46), { w, h }, { zoom: 1.12 });
      fitScaleRef.current = c.scale;
      const key = `${hq.company.id}:${w}:${h}`;
      if (fittedViewport.current !== key) {
        fittedViewport.current = key;
        setCam(c);
        setZoomPct(100);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [world.w, world.h, hq.company.id]);

  const fitView = useCallback(() => {
    const c = fitCamera(isoBounds(world.w, world.h, HEADROOM, 46), size, { zoom: 1.12 });
    fitScaleRef.current = c.scale;
    setCam(c);
    setZoomPct(100);
  }, [world, size]);

  // A walker exists from the first render, created lazily, because the rAF loop
  // writes straight to the DOM element the render registers.
  const getWalker = (person: HqPerson): Walker => {
    let w = walkersRef.current.get(person.id);
    if (!w) {
      w = newWalker(person);
      walkersRef.current.set(person.id, w);
    }
    return w;
  };

  const zoomAt = useCallback(
    (factor: number, cx: number, cy: number) => {
      setCam((c) => {
        const fit = fitScaleRef.current || 1;
        const scale = clamp(c.scale * factor, fit * 0.55, fit * 4.5);
        const k = scale / c.scale;
        setZoomPct(Math.round((scale / fit) * 100));
        return { scale, x: cx - (cx - c.x) * k, y: cy - (cy - c.y) * k };
      });
    },
    [],
  );

  // (Re)stage walkers when the record changes.
  useEffect(() => {
    const walkers = walkersRef.current;
    const staged = new Map(world.stages.map((s) => [s.personId, s]));
    const known = new Set(world.people.map((p) => p.id));
    for (const key of [...walkers.keys()]) if (!known.has(key)) walkers.delete(key);
    for (const person of world.people) {
      const w = getWalker(person);
      const stage = staged.get(person.id);
      const target = stage ? stage.at : person.home;
      if (!w.placed) {
        // First appearance shows the CURRENT state in place, a board that is sitting
        // is found seated, not watched shuffling in. Walking is for transitions seen
        // live (and it is also the only honest thing to do when the tab cannot paint:
        // see the hidden-tab note below). The lazy creation in render means map
        // membership cannot tell "new", that is what `placed` is for.
        w.placed = true;
        w.pos = { ...target };
        w.motion.current.x = target.x;
        w.motion.current.y = target.y;
        w.moving = false;
        continue;
      }
      if (w.moving) continue; // finish the current walk; re-route at the next poll
      if (w.pos.x !== target.x || w.pos.y !== target.y) {
        w.path = stage ? stage.path : [person.home];
        w.idx = 0;
        w.moving = true;
      }
    }
    // Paint the staged positions now: the rAF loop repaints every frame, but a tab
    // that never produces frames (headless, backgrounded) must still show the state
    // the record describes, initial layout is React's, not the loop's, business.
    for (const person of world.people) {
      const w = walkers.get(person.id);
      const el = gRefs.current.get(person.id);
      if (!w || !el) continue;
      const p = project(w.pos.x, w.pos.y);
      el.setAttribute('transform', `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`);
    }
  }, [world]);

  // The one rAF loop: advance walkers, write transforms straight to the DOM.
  useEffect(() => {
    let last = performance.now();
    const tick = (now: number, reducedMotion: boolean) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      for (const person of world.people) {
        const w = walkersRef.current.get(person.id);
        if (!w) continue;
        if (reducedMotion && w.moving && w.path.length) {
          w.pos = { ...w.path[w.path.length - 1] };
          w.path = []; w.idx = 0; w.moving = false;
        }
        if (w.moving && w.path.length) {
          const t = w.path[Math.min(w.idx, w.path.length - 1)];
          const dx = t.x - w.pos.x;
          const dy = t.y - w.pos.y;
          const d = Math.hypot(dx, dy);
          const step = WALK_SPEED * dt;
          if (d <= step) {
            w.pos = { x: t.x, y: t.y };
            w.idx += 1;
            if (dx !== 0) w.facing = dx >= 0 ? 1 : -1;
            if (w.idx >= w.path.length) {
              w.moving = false;
              w.idx = 0;
              w.path = [];
            }
          } else {
            w.pos = { x: w.pos.x + (dx / d) * step, y: w.pos.y + (dy / d) * step };
            w.facing = dx >= 0 ? 1 : -1;
          }
        }
        w.motion.current.x = w.pos.x;
        w.motion.current.y = w.pos.y;
        w.motion.current.moving = w.moving;
        w.motion.current.facing = w.facing;
        w.motion.current.seated = !w.moving && ((!!person.anchors && w.pos.x === person.home.x && w.pos.y === person.home.y)
          || (person.kind === 'board' && world.inSession));
        const el = gRefs.current.get(person.id);
        if (el) {
          const p = project(w.pos.x, w.pos.y);
          const transform = `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`;
          if (el.getAttribute('transform') !== transform) el.setAttribute('transform', transform);
          el.setAttribute('data-depth', String(w.pos.x + w.pos.y));
        }
      }
      const layer = castRef.current;
      if (layer) {
        const children = [...layer.children];
        const depth = (element: Element) => Number(element.getAttribute('data-depth') ?? 0);
        if (children.some((element, index) => index > 0 && depth(element) < depth(children[index - 1]))) {
          children.sort((a, b) => depth(a) - depth(b)).forEach(element => layer.appendChild(element));
        }
      }
    };
    return animateFrames(tick);
  }, [world]);

  const stagedNow = useMemo(() => new Set(world.stages.map((s) => s.personId)), [world]);
  const stageOf = useMemo(() => new Map(world.stages.map((s) => [s.personId, s])), [world]);

  // Dev probe, same contract as the office's __office: what did the walkers see?
  useEffect(() => {
    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>).__hq = {
        world,
        pos: () =>
          Object.fromEntries(
            [...walkersRef.current.entries()].map(([id, w]) => [
              id,
              { x: Math.round(w.pos.x), y: Math.round(w.pos.y), moving: w.moving, path: w.path.length, idx: w.idx },
            ]),
          ),
      };
    }
    return () => {
      if (import.meta.env.DEV) delete (window as unknown as Record<string, unknown>).__hq;
    };
  }, [world]);

  // Labels hold their screen size: world-scaled text at the fitted zoom of a whole
  // headquarters is 3 px tall, a name tag nobody can read is a name tag nobody has.
  const labelScale = clamp(0.9 / cam.scale, 1, 4.5);

  // Board members share one table, so their name tags stack on top of each other at
  // the fitted zoom. Stagger them by seat order, one readable name per row.
  // (the translate sits OUTSIDE the label scale, so the step is in world units:
  //  14 screen px ÷ the camera zoom.)
  const boardTagDy = useMemo(() => {
    const dy = new Map<string, number>();
    // 18 screen px per row clears a 10 pt tag at the label scale, and the stack
    // goes UP (see Person), so the names sit above the board rather than across
    // the table they are describing.
    const step = 18 / cam.scale;
    world.people
      .filter((p) => p.kind === 'board')
      .sort((a, b) => a.home.x - b.home.x)
      .forEach((p, i) => dy.set(p.id, i * step));
    return dy;
  }, [world, cam.scale]);

  const onWheel = (e: RWheelEvent) => {
    const rect = hostRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Match the project floor: scroll pans, Alt+scroll zooms.
    if (e.altKey || e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - rect.left, e.clientY - rect.top);
    else setCam(camera => ({ ...camera, x: camera.x - e.deltaX, y: camera.y - e.deltaY }));
  };
  const dragRef = useRef<{ px: number; py: number } | null>(null);
  const onPointerDown = (e: RPointerEvent) => {
    if ((e.target as Element).closest('button')) return;
    dragRef.current = { px: e.clientX, py: e.clientY };
    setDragging(true);
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: RPointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.px;
    const dy = e.clientY - d.py;
    d.px = e.clientX;
    d.py = e.clientY;
    setCam((c) => ({ ...c, x: c.x + dx, y: c.y + dy }));
  };
  const onPointerUp = () => {
    dragRef.current = null;
    setDragging(false);
  };

  return (
    <div
      ref={hostRef}
      className={`relative h-full min-h-[280px] w-full touch-none overflow-hidden bg-[#0a0d13] ${calm ? 'is-calm' : 'is-animated'}`}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onLostPointerCapture={onPointerUp}
      onPointerLeave={onPointerUp}
      tabIndex={0} role="region" aria-label="Company floor, arrow keys pan, plus and minus zoom, F fits"
      onKeyDown={event => {
        if ((event.target as Element).closest('button')) return;
        const shifts: Record<string, [number, number]> = { ArrowLeft: [70, 0], ArrowRight: [-70, 0], ArrowUp: [0, 70], ArrowDown: [0, -70] };
        if (shifts[event.key]) {
          const [x, y] = shifts[event.key]; setCam(camera => ({ ...camera, x: camera.x + x, y: camera.y + y }));
        } else if (event.key === 'f' || event.key === '0') fitView();
        else if (event.key === '+' || event.key === '=') zoomAt(1.25, size.w / 2, size.h / 2);
        else if (event.key === '-') zoomAt(1 / 1.25, size.w / 2, size.h / 2);
        else return;
        event.preventDefault();
      }}
      style={{ cursor: dragging ? 'grabbing' : 'grab' }}
    >
      <svg width={size.w} height={size.h} viewBox={`0 0 ${size.w} ${size.h}`} role="img"
           aria-label={`${hq.company.name} headquarters`}>
        <defs>
          <radialGradient id="hq-warm" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#ffcf8f" stopOpacity="0.3" />
            <stop offset="55%" stopColor="#ffb45e" stopOpacity="0.11" />
            <stop offset="100%" stopColor="#ffb45e" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="hq-cool" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#9fd4ff" stopOpacity="0.26" />
            <stop offset="60%" stopColor="#6fa6dd" stopOpacity="0.1" />
            <stop offset="100%" stopColor="#6fa6dd" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="hq-ambient" cx="50%" cy="26%" r="72%">
            <stop offset="0%" stopColor="#243654" stopOpacity="0.8" />
            <stop offset="55%" stopColor="#101827" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#05070c" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="hq-window" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#24466e" />
            <stop offset="50%" stopColor="#3b7194" />
            <stop offset="72%" stopColor="#2a4b68" />
            <stop offset="100%" stopColor="#0f2034" />
          </linearGradient>
        </defs>
        <rect x={0} y={0} width={size.w} height={size.h} fill="url(#hq-ambient)" pointerEvents="none" />
        <g ref={sceneRef} transform={`translate(${cam.x.toFixed(2)} ${cam.y.toFixed(2)}) scale(${cam.scale.toFixed(4)})`}>
          <polygon points={floorRect(-260, -260, world.w + 520, world.h + 520)} fill="#090d15"
                    stroke="#25344c" strokeWidth={2} />
          <polygon
            points={floorRect(-260, -260, world.w + 520, world.h + 520)}
            fill="none"
            stroke="#324764"
            strokeOpacity={0.35}
            strokeWidth={1}
          />

          {world.rooms.map((r) => (
            <HqRoomShell key={r.id} room={r} />
          ))}

          {/* the board table: the very chairs the model seats the board on */}
          <g ref={castRef}>
          <g data-depth={BOARD_TABLE.x + BOARD_TABLE.y + BOARD_TABLE.w / 2}><MeetingTable x={BOARD_TABLE.x} y={BOARD_TABLE.y} w={BOARD_TABLE.w} seats={4} /></g>

          {/* owned desks: one per anchored person, the seat is their home point */}
          {world.people.filter((p) => p.anchors).map((p) => (
            <g key={`desk-${p.id}`} data-depth={p.home.x + p.home.y}><Workstation x={p.home.x - DESK_W / 2} y={p.home.y - 74}
                         seat={p.home} busy /></g>
          ))}
          {/* the cast */}
          {world.people.map((person) => (
            <Person
              key={person.id}
              person={person}
              walker={getWalker(person)}
              staged={stagedNow.has(person.id)}
              note={stageOf.get(person.id)?.note}
              offFloor={person.kind === 'board' && !world.inSession && !stagedNow.has(person.id)}
              scale={labelScale}
              tagDy={boardTagDy.get(person.id) ?? 0}
              hideTagAtHome={person.kind === 'exec'}
              register={(el) => {
                if (el) gRefs.current.set(person.id, el);
                else gRefs.current.delete(person.id);
              }}
            />
          ))}
          </g>

          {/* Room plates above the furniture and the cast: a label that a chair can
              cover is not a label. Notes stay on their person. */}
          <g pointerEvents="none">
            {world.rooms.map((r) => (
              <Plate
                key={`plate-${r.id}`}
                at={{ x: r.x + r.w / 2, y: r.y + r.d + 4 }}
                w={r.kind === 'pod' ? 178 : r.kind === 'exec' ? 132 : 150}
                label={r.label}
                sub={r.sub}
                accent={r.accent}
                scale={labelScale}
              />
            ))}
          </g>
        </g>
      </svg>

      {world.banner && (
        <div className="pointer-events-none absolute left-3 top-3 flex max-w-[440px] items-start gap-2 rounded-lg border border-white/10 bg-slate-950/80 px-3 py-2 text-[11px] leading-snug text-slate-200 shadow-lg backdrop-blur">
          <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]" />
          <span>{world.banner}</span>
        </div>
      )}

      <div className="absolute bottom-16 right-3 flex items-center gap-1 rounded-lg border border-white/10 bg-slate-950/70 px-1.5 py-1 text-xs text-slate-400 shadow-lg backdrop-blur">
        <MotionControl />
        <button className="rounded border border-white/5 px-2 py-0.5 text-[11px] text-slate-300 hover:border-white/20 hover:bg-white/5" onClick={() => zoomAt(1 / 1.25, size.w / 2, size.h / 2)} aria-label="Zoom out">−</button>
        <span className="w-10 text-center tabular-nums">{zoomPct}%</span>
        <button className="rounded border border-white/5 px-2 py-0.5 text-[11px] text-slate-300 hover:border-white/20 hover:bg-white/5" onClick={() => zoomAt(1.25, size.w / 2, size.h / 2)} aria-label="Zoom in">＋</button>
        <button className="rounded border border-white/5 px-2 py-0.5 text-[11px] text-slate-300 hover:border-white/20 hover:bg-white/5" onClick={fitView}>Fit</button>
      </div>
    </div>
  );
}

/* ── Room dressing ─────────────────────────────────────────────────────────── */

const HQ_WALL_T = 8;
const HQ_WALL_H = mh(0.82);

function hqWallX(x0: number, x1: number, y: number, z0: number, z1: number): string {
  return polyPoints([
    project(x0, y, z0),
    project(x1, y, z0),
    project(x1, y, z1),
    project(x0, y, z1),
  ]);
}

function hqWallY(x: number, y0: number, y1: number, z0: number, z1: number): string {
  return polyPoints([
    project(x, y0, z0),
    project(x, y1, z0),
    project(x, y1, z1),
    project(x, y0, z1),
  ]);
}

/** A window on the room's long wall, with a city at night behind it. */
function HqWindow({ room }: { room: HqRoom }) {
  const y = room.y + HQ_WALL_T + 0.4;
  const x0 = room.x + room.w * 0.58;
  const x1 = room.x + room.w * 0.93;
  const z0 = mh(0.27);
  const z1 = mh(0.7);
  const inner = { x0: x0 + mh(0.03), x1: x1 - mh(0.03), z0: z0 + mh(0.025), z1: z1 - mh(0.025) };
  const midX = (inner.x0 + inner.x1) / 2;
  const midZ = (inner.z0 + inner.z1) / 2;
  const moon = project(inner.x1 - mh(0.1), y, inner.z1 - mh(0.08));
  return (
    <g>
      <polygon points={hqWallX(x0, x1, y, z0, z1)} fill="#0a0f18" />
      <polygon points={hqWallX(inner.x0, inner.x1, y, inner.z0, inner.z1)} fill="url(#hq-window)" />
      <circle cx={moon.x} cy={moon.y} r={mh(0.045)} fill="#f4ebd0" opacity={0.9} />
      <polygon
        points={hqWallX(midX - 1.5, midX + 1.5, y, inner.z0, inner.z1)}
        fill="#0a0f18"
        opacity={0.85}
      />
      <polygon
        points={hqWallX(inner.x0, inner.x1, y, midZ - 1.2, midZ + 1.2)}
        fill="#0a0f18"
        opacity={0.85}
      />
      <polygon
        points={hqWallX(x0 - 2, x1 + 2, y, z0 - mh(0.03), z0)}
        fill={mix('#3a4964', room.accent, 0.35)}
      />
    </g>
  );
}

/** A print on the room's side wall. */
function HqArt({ room }: { room: HqRoom }) {
  const x = room.x + HQ_WALL_T + 0.4;
  const y0 = room.y + room.d * 0.42;
  const y1 = y0 + mh(0.72);
  const z0 = mh(0.38);
  const z1 = mh(0.68);
  return (
    <g>
      <polygon points={hqWallY(x, y0, y1, z0, z1)} fill="#0a0f17" />
      <polygon
        points={hqWallY(x, y0 + mh(0.03), y1 - mh(0.03), z0 + mh(0.03), z1 - mh(0.03))}
        fill={mix('#20334a', room.accent, 0.3)}
      />
      <polygon
        points={hqWallY(x, y0 + mh(0.03), y1 - mh(0.03), z0 + mh(0.03), z0 + (z1 - z0) * 0.45)}
        fill={mix('#8d5a3c', room.accent, 0.3)}
      />
    </g>
  );
}

/** A rug, sized to the room, in the room's own accent. */
function HqRug({ room }: { room: HqRoom }) {
  const centre = project(room.x + room.w / 2, room.y + room.d / 2, mh(0.06));
  if (room.kind === 'board') {
    return (
      <g>
        <ellipse cx={centre.x} cy={centre.y} rx={room.w * 0.34} ry={room.w * 0.17} fill={mix('#3b2a42', room.accent, 0.35)} />
        <ellipse cx={centre.x} cy={centre.y} rx={room.w * 0.3} ry={room.w * 0.15} fill="none" stroke="#b98a52" strokeWidth={1.4} opacity={0.6} />
      </g>
    );
  }
  return (
    <g>
      <polygon
        points={floorRect(room.x + room.w * 0.18, room.y + room.d * 0.2, room.w * 0.64, room.d * 0.56, mh(0.06))}
        fill={mix('#1e2839', room.accent, 0.38)}
        opacity={0.75}
      />
      <polygon
        points={floorRect(room.x + room.w * 0.19, room.y + room.d * 0.22, room.w * 0.62, room.d * 0.52, mh(0.06))}
        fill="none"
        stroke={room.accent}
        strokeWidth={1.1}
        opacity={0.55}
      />
    </g>
  );
}

/**
 * One room on the HQ plate.
 *
 * The floor is the same idea as the office: a tinted slab, a lit pool, a low wall
 * with a window, and enough furniture that an executive office reads as a place
 * and a pod reads as a pod rather than a rectangle with a desk.
 */
function HqRoomShell({ room }: { room: HqRoom }) {
  const wall = mix('#3a4964', room.accent, 0.34);
  const centre = project(room.x + room.w / 2, room.y + room.d / 2, mh(0.08));
  const warm = 'url(#hq-warm)';
  const door = { x: room.x + room.w / 2, y: room.y + room.d };
  const isPod = room.kind === 'pod';
  const isExec = room.kind === 'exec';

  return (
    <g>
      {/* The raised floor slab, its light pool and its rug. */}
      <Box x={room.x} y={room.y} w={room.w} d={room.d} h={mh(0.055)} color="#1a2331" top={mix('#202c3e', room.accent, 0.16)} />
      <polygon
        points={floorRect(room.x + 4, room.y + 4, room.w - 8, room.d - 8, mh(0.058))}
        fill={room.accent}
        opacity={0.1}
      />
      <ellipse
        cx={centre.x}
        cy={centre.y}
        rx={room.w * 0.55}
        ry={room.d * 0.42}
        fill={warm}
        opacity={0.8}
        style={{ mixBlendMode: 'screen' }}
      />
      <HqRug room={room} />
      <polygon
        points={floorRect(room.x + 5, room.y + 5, room.w - 10, room.d - 10, mh(0.059))}
        fill="none"
        stroke={room.accent}
        strokeOpacity={0.7}
        strokeWidth={1.4}
      />

      {/* Low walls on the far edges, with a window and a print. */}
      <Box x={room.x} y={room.y} w={room.w} d={HQ_WALL_T} h={HQ_WALL_H} color={mix('#243146', wall, 0.4)} top={mix('#4a5d7a', room.accent, 0.3)} />
      <Box x={room.x} y={room.y} w={HQ_WALL_T} d={room.d} h={HQ_WALL_H} color={mix('#1e2a3e', wall, 0.4)} top={mix('#41546f', room.accent, 0.3)} />
      <polygon
        points={hqWallX(room.x, room.x + room.w, room.y + HQ_WALL_T + 0.4, 0, mh(0.06))}
        fill="#090e16"
        opacity={0.85}
      />
      <polygon
        points={hqWallY(room.x + HQ_WALL_T + 0.4, room.y, room.y + room.d, 0, mh(0.06))}
        fill="#090e16"
        opacity={0.85}
      />
      <HqWindow room={room} />
      <HqArt room={room} />

      {/* The door threshold and its light. */}
      <polygon
        points={floorRect(door.x - 26, door.y - 8, 52, 16, mh(0.06))}
        fill="#0b1119"
        stroke={room.accent}
        strokeWidth={1}
        opacity={0.9}
      />
      <ellipse
        cx={project(door.x, door.y, mh(0.06)).x}
        cy={project(door.x, door.y, mh(0.06)).y}
        rx={40}
        ry={18}
        fill={warm}
        opacity={0.5}
        style={{ mixBlendMode: 'screen' }}
      />

      {/* Dressing. One plant stays on the corner; the shelf and lamp are what make
          the office read as owned rather than assigned. */}
      {room.kind !== 'board' && <Plant x={room.x + room.w - 22} y={room.y + room.d - 16} />}
      <AtlasSprite
        name="prop.bookshelf"
        x={room.x + 26}
        y={room.y + HQ_WALL_T + 2}
        scale={scaleForWidth('prop.bookshelf', isPod ? 100 : 82)}
      />
      <g>
        <ellipse
          cx={project(room.x + 30, room.y + room.d - 30, 2).x}
          cy={project(room.x + 30, room.y + room.d - 30, 2).y}
          rx={62}
          ry={30}
          fill={warm}
          opacity={0.55}
          style={{ mixBlendMode: 'screen' }}
        />
        <AtlasSprite name="prop.floorlamp" x={room.x + 30} y={room.y + room.d - 30} />
      </g>
      {isPod && (
        <g>
          <AtlasSprite
            name="prop.sofa"
            x={room.x + room.w - 185}
            y={room.y + HQ_WALL_T + 2}
          />
          <AtlasSprite
            name="prop.coffeetable"
            x={room.x + room.w - 160}
            y={room.y + HQ_WALL_T + 92}
          />
        </g>
      )}
      {isExec && (
        <AtlasSprite
          name="prop.cabinet"
          x={room.x + room.w - 74}
          y={room.y + HQ_WALL_T + 2}
          scale={scaleForWidth('prop.cabinet', 62)}
        />
      )}
    </g>
  );
}

function Person({
  person,
  walker,
  staged,
  note,
  offFloor,
  scale,
  tagDy,
  hideTagAtHome,
  register,
}: {
  person: HqPerson;
  walker: Walker | undefined;
  staged: boolean;
  note: string | undefined;
  offFloor: boolean;
  scale: number;
  tagDy: number;
  hideTagAtHome: boolean;
  register: (el: SVGGElement | null) => void;
}) {
  if (!walker) return null;
  const p = project(walker.pos.x, walker.pos.y);
  const atDesk = person.anchors && !staged && !walker.moving
    && walker.pos.x === person.home.x && walker.pos.y === person.home.y;
  const activity = walker.moving ? 'walking' : atDesk ? 'typing' : 'idle';
  // an executive's office plate carries their name; while seated the floating tag
  // just collided with it. Show the tag only while they move.
  const showTag = !(hideTagAtHome && !walker.moving);
  return (
    <g ref={register} data-depth={walker.pos.x + walker.pos.y} transform={`translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`} opacity={offFloor ? 0.35 : 1}>
      <ellipse cx={0} cy={0} rx={16} ry={8} fill="#05070c" opacity={0.35} />
      <g transform={`translate(0 ${FEET_SINK})`}>
        <SpriteCharacter name={person.id} activity={activity} atDesk={atDesk}
                         motion={walker.motion} faded={offFloor} />
      </g>
      {showTag && (
        <g transform={`translate(0 ${-62 - tagDy}) scale(${scale.toFixed(3)})`}>
          <text y={0} textAnchor="middle" fontSize={10} fill="#9db0c8">{person.name}</text>
        </g>
      )}
      {/* A note rides on a WALKER, which is what the scene's contract says it is.
          Sitting board members carried the same sentence each, so six identical
          bubbles stacked over the board table and hid the room they were about. */}
      {staged && note && walker.moving && (
        <g transform={`translate(0 -84) scale(${scale.toFixed(3)})`} pointerEvents="none">
          <rect x={-noteWidth(note) / 2} y={-12} width={noteWidth(note)} height={17} rx={5}
                fill="#0d1119" stroke="#2c3547" strokeOpacity={0.9} />
          <text x={0} y={1} textAnchor="middle" fontSize={9.5} fill="#cdd8e6">{clip(note, 64)}</text>
        </g>
      )}
    </g>
  );
}

function Plate({
  at,
  w,
  label,
  sub,
  accent,
  scale,
}: {
  at: { x: number; y: number };
  w: number;
  label: string;
  sub: string;
  accent: string;
  scale: number;
}) {
  const p = project(at.x, at.y);
  const h = 28;
  return (
    <g transform={`translate(${(p.x - w / 2).toFixed(1)} ${(p.y - h).toFixed(1)}) scale(${scale.toFixed(3)})`}>
      <rect width={w} height={h} rx={4} fill="#0e131c" stroke="#2e3849" />
      <rect width={4} height={h} rx={2} fill={accent} />
      <text x={10} y={11.5} fontSize={10} fill="#dbe4ef">{clip(label, 24)}</text>
      <text x={10} y={22.5} fontSize={8.5} fill="#8296ae">{clip(sub, 38)}</text>
    </g>
  );
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const noteWidth = (s: string) => Math.max(90, clip(s, 64).length * 4.9 + 16);

export type { HqWorld, HqPerson };
export { VERDICT_COLOR, M };
