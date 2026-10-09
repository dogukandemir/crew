/**
 * The HQ floor (ADR 0011): the whole company drawn on one isometric plate.
 *
 * Same one-metre discipline as the office: this file owns the pixels, `hqScene.ts`
 * owns the layout and the routes, and the record owns the words. People walk only
 * along routes the model staged from real events; a note on a walker is a line the
 * record already wrote — the scene never improvises a sentence.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as RPointerEvent, WheelEvent as RWheelEvent } from 'react';
import type { Hq } from '../../api/types';
import { fitCamera, floorRect, isoBounds, mh, project, type Camera } from '../office/iso';
import { Box, MeetingTable, Plant, Workstation } from '../office/props';
import { SpriteCharacter, type SpriteMotionRef } from '../sprites/SpriteCharacter';
import { DESK_W } from '../../sim/floorplan';
import {
  BOARD_TABLE,
  M,
  VERDICT_COLOR,
  buildHqWorld,
  type HqPerson,
  type HqPoint,
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

  // Resize → keep the fit honest.
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth || 900;
      const h = el.clientHeight || 560;
      setSize({ w, h });
      const c = fitCamera(isoBounds(world.w, world.h, HEADROOM, 46), { w, h });
      fitScaleRef.current = c.scale;
      setCam(c);
      setZoomPct(100);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [world]);

  const fitView = useCallback(() => {
    const c = fitCamera(isoBounds(world.w, world.h, HEADROOM, 46), size);
    fitScaleRef.current = c.scale;
    setCam(c);
    setZoomPct(100);
  }, [world, size]);

  // A walker exists from the first render — created lazily, because the rAF loop
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
        // First appearance shows the CURRENT state in place — a board that is sitting
        // is found seated, not watched shuffling in. Walking is for transitions seen
        // live (and it is also the only honest thing to do when the tab cannot paint:
        // see the hidden-tab note below). The lazy creation in render means map
        // membership cannot tell "new" — that is what `placed` is for.
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
    // the record describes — initial layout is React's, not the loop's, business.
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
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      for (const person of world.people) {
        const w = walkersRef.current.get(person.id);
        if (!w) continue;
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
        const el = gRefs.current.get(person.id);
        if (el) {
          const p = project(w.pos.x, w.pos.y);
          el.setAttribute('transform', `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
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
  // headquarters is 3 px tall — a name tag nobody can read is a name tag nobody has.
  const labelScale = clamp(0.9 / cam.scale, 1, 4.5);

  // Board members share one table, so their name tags stack on top of each other at
  // the fitted zoom. Stagger them by seat order — one readable name per row.
  // (the translate sits OUTSIDE the label scale, so the step is in world units:
  //  14 screen px ÷ the camera zoom.)
  const boardTagDy = useMemo(() => {
    const dy = new Map<string, number>();
    const step = 14 / cam.scale;
    world.people
      .filter((p) => p.kind === 'board')
      .sort((a, b) => a.home.x - b.home.x)
      .forEach((p, i) => dy.set(p.id, i * step));
    return dy;
  }, [world, cam.scale]);

  const onWheel = (e: RWheelEvent) => {
    e.preventDefault();
    const rect = hostRef.current?.getBoundingClientRect();
    if (!rect) return;
    zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - rect.left, e.clientY - rect.top);
  };
  const dragRef = useRef<{ px: number; py: number } | null>(null);
  const onPointerDown = (e: RPointerEvent) => {
    dragRef.current = { px: e.clientX, py: e.clientY };
    setDragging(true);
    (e.target as Element).setPointerCapture?.(e.pointerId);
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
      className="relative h-full w-full touch-none overflow-hidden bg-[#0a0d13]"
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
      style={{ cursor: dragging ? 'grabbing' : 'grab' }}
    >
      <svg width={size.w} height={size.h} viewBox={`0 0 ${size.w} ${size.h}`} role="img"
           aria-label={`${hq.company.name} headquarters`}>
        <g ref={sceneRef} transform={`translate(${cam.x.toFixed(2)} ${cam.y.toFixed(2)}) scale(${cam.scale.toFixed(4)})`}>
          <polygon points={floorRect(-260, -260, world.w + 520, world.h + 520)} fill="#0b0e14"
                    stroke="#1b2130" strokeWidth={2} />

          {world.rooms.map((r) => (
            <g key={r.id}>
              <Box x={r.x} y={r.y} w={r.w} d={r.d} h={mh(0.055)} color="#161d29" top="#1d2532" />
              <polygon points={floorRect(r.x, r.y, r.w, r.d, mh(0.056))} fill="none"
                       stroke={r.accent} strokeOpacity={0.85} strokeWidth={1.6} />
              {r.kind !== 'board' && <Plant x={r.x + r.w - 22} y={r.y + r.d - 16} />}
              <Plate at={{ x: r.x + r.w / 2, y: r.y + r.d + 4 }} w={r.kind === 'pod' ? 190 : 150}
                     label={r.label} sub={r.sub} accent={r.accent} scale={labelScale} />
            </g>
          ))}

          {/* the board table: the very chairs the model seats the board on */}
          <MeetingTable x={BOARD_TABLE.x} y={BOARD_TABLE.y} w={BOARD_TABLE.w} seats={4} />

          {/* owned desks: one per anchored person, the seat is their home point */}
          {world.people.filter((p) => p.anchors).map((p) => (
            <Workstation key={`desk-${p.id}`} x={p.home.x - DESK_W / 2} y={p.home.y - 74}
                         seat={p.home} busy />
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
      </svg>

      {world.banner && (
        <div className="pointer-events-none absolute left-3 top-3 max-w-[420px] rounded-md border border-slate-700 bg-slate-950/85 px-2.5 py-1.5 text-[11px] text-slate-200">
          {world.banner}
        </div>
      )}

      <div className="absolute bottom-16 right-3 flex items-center gap-1 text-xs text-slate-400">
        <button className="rounded border border-slate-700 px-2 py-0.5 text-[11px] text-slate-300 hover:border-slate-500" onClick={() => zoomAt(1 / 1.25, size.w / 2, size.h / 2)} aria-label="Zoom out">−</button>
        <span className="w-10 text-center tabular-nums">{zoomPct}%</span>
        <button className="rounded border border-slate-700 px-2 py-0.5 text-[11px] text-slate-300 hover:border-slate-500" onClick={() => zoomAt(1.25, size.w / 2, size.h / 2)} aria-label="Zoom in">＋</button>
        <button className="rounded border border-slate-700 px-2 py-0.5 text-[11px] text-slate-300 hover:border-slate-500" onClick={fitView}>Fit</button>
      </div>
    </div>
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
    <g ref={register} transform={`translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`} opacity={offFloor ? 0.35 : 1}>
      <ellipse cx={0} cy={0} rx={16} ry={8} fill="#05070c" opacity={0.35} />
      <g transform={`translate(0 ${FEET_SINK})`}>
        <SpriteCharacter name={person.id} activity={activity} atDesk={atDesk}
                         motion={walker.motion} faded={offFloor} />
      </g>
      {showTag && (
        <g transform={`translate(0 ${-62 + tagDy}) scale(${scale.toFixed(3)})`}>
          <text y={0} textAnchor="middle" fontSize={10} fill="#9db0c8">{person.name}</text>
        </g>
      )}
      {staged && note && (
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
  const h = 32;
  return (
    <g transform={`translate(${(p.x - w / 2).toFixed(1)} ${(p.y - h).toFixed(1)}) scale(${scale.toFixed(3)})`}>
      <rect width={w} height={h} rx={4} fill="#10141c" stroke="#2e3849" />
      <rect width={5} height={h} rx={2} fill={accent} />
      <text x={12} y={13} fontSize={10.5} fill="#dbe4ef">{clip(label, 28)}</text>
      <text x={12} y={26} fontSize={9} fill="#8296ae">{clip(sub, 44)}</text>
    </g>
  );
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const noteWidth = (s: string) => Math.max(90, clip(s, 64).length * 4.9 + 16);

export type { HqWorld, HqPerson };
export { VERDICT_COLOR, M };
