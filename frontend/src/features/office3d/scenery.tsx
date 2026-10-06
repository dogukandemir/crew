/**
 * Scenery: the building itself.
 *
 * Everything here is generated — textures are drawn onto canvases at runtime and
 * furniture is built from the shared primitives in assets.ts. That keeps the
 * repository free of binary assets, the initial load small, and the look
 * identical on every machine.
 *
 * Coordinate note: the simulation works in flat "units" and the renderer works
 * in metres, with the floor centred on the origin. `makeToWorld` is the only
 * place that conversion happens.
 */
import { useMemo } from 'react';
import * as THREE from 'three';
import type { Office, Room } from '../../sim/floorplan';
import { DESK_H, DESK_W } from '../../sim/floorplan';
import type { Point } from '../../sim/geometry';
import { BODY, GEOM, OFFICE as P, UNIT, matte } from './assets';

/**
 * Depth of the desk as *drawn*. The simulation places a body 30 units above the
 * desk's south edge, so the drawn desk stops there and the character sits at its
 * edge with the desk in front of them.
 */
export const VISUAL_DESK_H = DESK_H - 30;

export interface WorldMap {
  x: (simX: number) => number;
  z: (simY: number) => number;
  p: (pt: Point) => [number, number];
}

export function makeToWorld(office: Office): WorldMap {
  const cx = office.width / 2;
  const cy = office.height / 2;
  return {
    x: (simX) => (simX - cx) * UNIT,
    z: (simY) => (simY - cy) * UNIT,
    p: (pt) => [(pt.x - cx) * UNIT, (pt.y - cy) * UNIT],
  };
}

// ── Procedural textures ─────────────────────────────────────────────────────

const textureCache = new Map<string, THREE.CanvasTexture>();

function draw(width: number, height: number, paint: (ctx: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx) paint(ctx);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

function cached(key: string, build: () => THREE.CanvasTexture): THREE.CanvasTexture {
  const hit = textureCache.get(key);
  if (hit) return hit;
  const made = build();
  textureCache.set(key, made);
  return made;
}

/** Carpet: a dark weave tinted with the department accent, plus wear speckle. */
export function carpetTexture(accent: string): THREE.CanvasTexture {
  return cached(`carpet:${accent}`, () => {
    const tex = draw(128, 128, (ctx) => {
      ctx.fillStyle = '#2b3140';
      ctx.fillRect(0, 0, 128, 128);
      // accent wash, low enough that the floor stays dark but the room reads
      ctx.fillStyle = accent;
      ctx.globalAlpha = 0.13;
      ctx.fillRect(0, 0, 128, 128);
      ctx.globalAlpha = 1;

      // weave
      ctx.strokeStyle = 'rgba(0,0,0,0.20)';
      ctx.lineWidth = 1;
      for (let i = 0; i < 128; i += 4) {
        ctx.beginPath();
        ctx.moveTo(i, 0);
        ctx.lineTo(i, 128);
        ctx.moveTo(0, i);
        ctx.lineTo(128, i);
        ctx.stroke();
      }
      // wear
      for (let i = 0; i < 260; i += 1) {
        ctx.fillStyle = i % 2 ? 'rgba(255,255,255,0.022)' : 'rgba(0,0,0,0.10)';
        ctx.fillRect(Math.random() * 128, Math.random() * 128, 2, 2);
      }
    });
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    return tex;
  });
}

/** Corridor floor: poured concrete, cooler and smoother than the carpet. */
export const corridorTexture = (): THREE.CanvasTexture =>
  cached('corridor', () => {
    const tex = draw(128, 128, (ctx) => {
      ctx.fillStyle = '#2b3140';
      ctx.fillRect(0, 0, 128, 128);
      for (let i = 0; i < 200; i += 1) {
        ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.03})`;
        ctx.fillRect(Math.random() * 128, Math.random() * 128, 3, 3);
      }
      // expansion joints
      ctx.strokeStyle = 'rgba(0,0,0,0.28)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, 64);
      ctx.lineTo(128, 64);
      ctx.stroke();
    });
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    return tex;
  });

const FONT = '"Segoe UI", system-ui, -apple-system, sans-serif';

/** A department sign: accent bar, name, and the numbers the org chart shows. */
export function signTexture(name: string, subtitle: string | undefined, accent: string): THREE.CanvasTexture {
  return cached(`sign:${name}:${subtitle ?? ''}:${accent}`, () =>
    draw(640, 160, (ctx) => {
      ctx.fillStyle = '#171b23';
      ctx.fillRect(0, 0, 640, 160);

      ctx.fillStyle = accent;
      ctx.fillRect(0, 0, 14, 160);

      ctx.fillStyle = '#eef1f6';
      ctx.font = `600 52px ${FONT}`;
      ctx.textBaseline = 'middle';
      ctx.fillText(clip(ctx, name, 590), 44, subtitle ? 62 : 80);

      if (subtitle) {
        ctx.fillStyle = '#8b93a7';
        ctx.font = `400 32px ${FONT}`;
        ctx.fillText(clip(ctx, subtitle, 590), 44, 116);
      }

      ctx.strokeStyle = 'rgba(255,255,255,0.10)';
      ctx.lineWidth = 4;
      ctx.strokeRect(2, 2, 636, 156);
    }),
  );
}

/** The name plate that floats over a character. */
export function nameTagTexture(name: string, role: string, tone: string): THREE.CanvasTexture {
  return cached(`tag:${name}:${role}:${tone}`, () =>
    draw(320, 88, (ctx) => {
      // pill
      const r = 44;
      ctx.beginPath();
      ctx.moveTo(r, 0);
      ctx.lineTo(320 - r, 0);
      ctx.arcTo(320, 0, 320, r, r);
      ctx.lineTo(320, 88 - r);
      ctx.arcTo(320, 88, 320 - r, 88, r);
      ctx.lineTo(r, 88);
      ctx.arcTo(0, 88, 0, 88 - r, r);
      ctx.lineTo(0, r);
      ctx.arcTo(0, 0, r, 0, r);
      ctx.closePath();
      ctx.fillStyle = 'rgba(15,18,24,0.88)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.lineWidth = 3;
      ctx.stroke();

      // status dot
      ctx.beginPath();
      ctx.arc(40, 44, 11, 0, Math.PI * 2);
      ctx.fillStyle = tone;
      ctx.fill();

      ctx.fillStyle = '#eef1f6';
      ctx.font = `600 34px ${FONT}`;
      ctx.textBaseline = 'middle';
      ctx.fillText(clip(ctx, name, 220), 62, 32);

      ctx.fillStyle = '#8b93a7';
      ctx.font = `400 24px ${FONT}`;
      ctx.fillText(clip(ctx, role, 240), 62, 64);
    }),
  );
}

function clip(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let out = text;
  while (out.length > 1 && ctx.measureText(`${out}…`).width > max) out = out.slice(0, -1);
  return `${out}…`;
}

// ── Shared prop materials ───────────────────────────────────────────────────

export const PROPS = {
  deskTop: matte(P.deskTop, { roughness: 0.62 }),
  deskFrame: matte(P.metal, { roughness: 0.45, metalness: 0.5 }),
  bezel: matte(P.monitorBezel, { roughness: 0.5 }),
  screen: matte(P.screen, { emissive: P.screenGlow, emissiveIntensity: 0.5, roughness: 0.3 }),
  chair: matte('#1c1f26', { roughness: 0.92 }),
  wall: matte(P.wall, { roughness: 0.95 }),
  trim: matte(P.wallTrim, { roughness: 0.8 }),
  plant: matte(P.plant, { roughness: 0.9 }),
  pot: matte(P.pot, { roughness: 0.85 }),
  board: matte('#6d7482', { roughness: 0.45 }),
  kitchen: matte(P.kitchen, { roughness: 0.7 }),
  paper: matte('#d8dbe2', { roughness: 0.9 }),
  mug: matte('#c8ccd4', { roughness: 0.55 }),
  laptop: matte('#3b4150', { roughness: 0.5, metalness: 0.35 }),
};

// ── One workstation ─────────────────────────────────────────────────────────

function Workstation({ deskX, deskZ }: { deskX: number; deskZ: number }) {
  const w = DESK_W * UNIT;
  const d = VISUAL_DESK_H * UNIT;
  const top = 0.72;
  const sideH = top - 0.04;

  return (
    <group position={[deskX, 0, deskZ]}>
      {/* Top, with the desk's north edge away from the camera. */}
      <mesh geometry={GEOM.deskTop} material={PROPS.deskTop} position={[0, top, 0]} scale={[1, 1, d / 1.05]} castShadow receiveShadow />
      {/* Two end panels rather than four fiddly legs. */}
      <mesh geometry={GEOM.deskLeg} material={PROPS.deskFrame} position={[-w / 2 + 0.06, sideH / 2, 0]} scale={[1.2, sideH / 0.72, d / 0.05]} />
      <mesh geometry={GEOM.deskLeg} material={PROPS.deskFrame} position={[w / 2 - 0.06, sideH / 2, 0]} scale={[1.2, sideH / 0.72, d / 0.05]} />

      {/* Monitor on the far edge, screen towards the seated agent. */}
      <group position={[0, top, -d / 2 + 0.18]}>
        <mesh geometry={GEOM.monitorFoot} material={PROPS.bezel} position={[0, 0.01, 0]} />
        <mesh geometry={GEOM.monitorArm} material={PROPS.bezel} position={[0, 0.1, 0]} />
        <mesh geometry={GEOM.monitor} material={PROPS.bezel} position={[0, 0.26, 0]} rotation={[0.06, 0, 0]} castShadow />
        <mesh
          geometry={GEOM.monitor}
          material={PROPS.screen}
          position={[0, 0.26, 0.018]}
          rotation={[0.06, 0, 0]}
          scale={[0.94, 0.88, 0.2]}
        />
      </group>

      {/* Keyboard and mouse in front of the agent, on the near edge. */}
      <mesh geometry={GEOM.keyboard} material={PROPS.bezel} position={[0, top + 0.02, d / 2 - 0.22]} />
      <mesh geometry={GEOM.mug} material={PROPS.mug} position={[w / 2 - 0.22, top + 0.05, -d / 2 + 0.36]} castShadow />
      <mesh geometry={GEOM.papers} material={PROPS.paper} position={[-w / 2 + 0.3, top + 0.02, -0.02]} rotation={[0, 0.2, 0]} />
    </group>
  );
}

/** The chair the agent sits on, tucked just south of the desk. */
function Chair({ x, z, angle = Math.PI }: { x: number; z: number; angle?: number }) {
  const seat = BODY.seatHeight;
  return (
    <group position={[x, 0, z]} rotation={[0, angle, 0]}>
      <mesh geometry={GEOM.chairBase} material={PROPS.chair} position={[0, 0.022, 0]} scale={[0.86, 1, 0.86]} />
      <mesh geometry={GEOM.chairPost} material={PROPS.deskFrame} position={[0, 0.19, 0]} scale={[0.8, 1, 0.8]} />
      <mesh geometry={GEOM.chairSeat} material={PROPS.chair} position={[0, seat - 0.04, 0]} scale={[0.94, 1, 0.92]} castShadow />
      {/* Backrest sits behind the sitter, which is south of the desk. */}
      <mesh
        geometry={GEOM.chairBack}
        material={PROPS.chair}
        position={[0, seat + 0.24, 0.21]}
        rotation={[-0.1, 0, 0]}
        scale={[0.86, 0.82, 0.7]}
        castShadow
      />
    </group>
  );
}

// ── Props ───────────────────────────────────────────────────────────────────

function Plant({ x, z }: { x: number; z: number }) {
  return (
    <group position={[x, 0, z]}>
      <mesh geometry={GEOM.plantPot} material={PROPS.pot} position={[0, 0.13, 0]} castShadow />
      <mesh geometry={GEOM.plantLeaf} material={PROPS.plant} position={[0, 0.46, 0]} scale={[1, 0.9, 1]} castShadow />
    </group>
  );
}

function Whiteboard({ x, z, accent, width = 2 }:{ x: number; z: number; accent: string; width?: number }) {
  return (
    <group position={[x, 0, z]}>
      <mesh geometry={GEOM.whiteboard} material={PROPS.board} position={[0, 0.72, 0]} scale={[width / 2.2, 0.42, 1]} castShadow />
      <mesh geometry={GEOM.whiteboard} material={matte(accent, { roughness: 0.6 })} position={[0, 0.72, 0.03]} scale={[width / 2.2 * 0.985, 0.405, 1]} />
    </group>
  );
}

function BreakCorner({ x, z }: { x: number; z: number }) {
  return (
    <group position={[x, 0, z]}>
      {/* Counter against the north wall, with the coffee machine on it. */}
      <mesh geometry={GEOM.counter} material={PROPS.kitchen} position={[0, 0.9, 0]} scale={[0.7, 1, 1]} castShadow receiveShadow />
      <mesh geometry={GEOM.counter} material={matte('#3f4652', { roughness: 0.6 })} position={[0, 0.93, 0]} scale={[0.72, 0.2, 1]} />
      <mesh geometry={GEOM.coffeeMachine} material={matte('#22262f', { roughness: 0.5, metalness: 0.3 })} position={[-0.4, 1.13, 0]} castShadow />
      <mesh geometry={GEOM.mug} material={PROPS.mug} position={[0.35, 1.0, 0.05]} />
      <mesh geometry={GEOM.fridge} material={matte('#4a5160', { roughness: 0.45, metalness: 0.25 })} position={[1.5, 0.85, 0]} castShadow />
    </group>
  );
}

function ReviewTable({ x, z }: { x: number; z: number }) {
  return (
    <group position={[x, 0, z]}>
      <mesh geometry={GEOM.tableTop} material={PROPS.deskTop} position={[0, 0.74, 0]} castShadow receiveShadow />
      <mesh geometry={GEOM.deskLeg} material={PROPS.deskFrame} position={[-1.1, 0.36, 0]} scale={[1.2, 1, 1.6]} />
      <mesh geometry={GEOM.deskLeg} material={PROPS.deskFrame} position={[1.1, 0.36, 0]} scale={[1.2, 1, 1.6]} />
      <mesh geometry={GEOM.laptop} material={PROPS.laptop} position={[-0.7, 0.77, 0]} />
      <mesh geometry={GEOM.laptopLid} material={PROPS.laptop} position={[-0.7, 0.87, -0.1]} rotation={[-1.2, 0, 0]} />
      <mesh geometry={GEOM.papers} material={PROPS.paper} position={[0.6, 0.78, 0.05]} rotation={[0, -0.3, 0]} />
      <mesh geometry={GEOM.mug} material={PROPS.mug} position={[1.0, 0.81, -0.2]} />
    </group>
  );
}

// ── A whole room ────────────────────────────────────────────────────────────

const WALL_H = 0.72;

/**
 * One department. Walls stand on the north and the sides only — the south face
 * stays open, both because that is where the door and corridor are and because a
 * wall between the camera and the room would hide the work.
 */
export function Room3D({ room, map, children }: { room: Room; map: WorldMap; children?: React.ReactNode }) {
  const [cx, cz] = map.p({ x: room.x + room.w / 2, y: room.y + room.h / 2 });
  const w = room.w * UNIT;
  const h = room.h * UNIT;
  const north = -h / 2;

  const carpet = useMemo(() => {
    const tex = carpetTexture(room.accent);
    return tex;
  }, [room.accent]);

  const carpetRepeat = useMemo(() => {
    const t = carpet.clone();
    t.needsUpdate = true;
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(Math.max(1, Math.round(w / 1.4)), Math.max(1, Math.round(h / 1.4)));
    return t;
  }, [carpet, w, h]);

  const sign = useMemo(() => signTexture(room.name, room.subtitle, room.accent), [room.name, room.subtitle, room.accent]);
  const accentMat = useMemo(() => matte(room.accent, { roughness: 0.6, emissive: room.accent, emissiveIntensity: 0.12 }), [room.accent]);
  const carpetMat = useMemo(() => new THREE.MeshStandardMaterial({ map: carpetRepeat, roughness: 0.98 }), [carpetRepeat]);

  return (
    <>
      <group position={[cx, 0, cz]}>
        {/* Carpet, floating a hair above the corridor slab, with an accent rim. */}
        <mesh position={[0, 0.01, 0]} geometry={GEOM.unit} material={accentMat} scale={[w + 0.18, 0.02, h + 0.18]} receiveShadow />
        <mesh position={[0, 0.028, 0]} geometry={GEOM.unit} material={carpetMat} scale={[w, 0.02, h]} receiveShadow />

        {/* North wall, its skirting and a lit accent strip along the top. */}
        <mesh geometry={GEOM.unit} material={PROPS.wall} position={[0, WALL_H / 2, north]} scale={[w, WALL_H, 0.1]} castShadow receiveShadow />
        <mesh geometry={GEOM.unit} material={accentMat} position={[0, 0.09, north + 0.06]} scale={[w, 0.18, 0.04]} />
        <mesh geometry={GEOM.unit} material={accentMat} position={[0, WALL_H - 0.03, north + 0.06]} scale={[w, 0.05, 0.03]} />

        {/* Side walls, only half-depth so the room stays readable from above. */}
        {[-1, 1].map((side) => (
          <mesh
            key={side}
            geometry={GEOM.unit}
            material={PROPS.wall}
            position={[(side * w) / 2, WALL_H / 2, north + h / 4]}
            scale={[0.1, WALL_H, h / 2]}
            castShadow
          />
        ))}

        {/* Floating department sign, hanging above the partition. */}
        <mesh position={[0, WALL_H + 0.52, north + 0.1]}>
          <planeGeometry args={[Math.min(2.0, Math.max(1.0, w * 0.5)), 0.5]} />
          <meshBasicMaterial map={sign} toneMapped={false} transparent />
        </mesh>
      </group>

      {/* Furniture and props work in absolute world coordinates, so they stay
          outside the translated group above. */}
      <RoomProps room={room} map={map} />
      {children}
    </>
  );
}

/** Furniture that depends on what the room is for. */
function RoomProps({ room, map }: { room: Room; map: WorldMap }) {
  const [cx, cz] = map.p({ x: room.x + room.w / 2, y: room.y + room.h / 2 });
  const h = room.h * UNIT;
  const w = room.w * UNIT;
  const north = -h / 2;
  const boardZ = north + 0.12;
  const inset = Math.min(1.4, w / 2 - 0.5);

  if (room.kind === 'break') {
    return (
      <group position={[cx, 0, cz]}>
        <BreakCorner x={0} z={north + 0.5} />
        <Plant x={-inset} z={north + 0.6} />
        <Plant x={inset} z={north + 0.6} />
      </group>
    );
  }

  if (room.kind === 'commons') {
    return (
      <group position={[cx, 0, cz]}>
        <ReviewTable x={0} z={0.1} />
        <Whiteboard x={0} z={boardZ} accent={room.accent} width={Math.min(3, w * 0.7)} />
        <Plant x={-inset} z={north + 0.7} />
        {/* Chairs around the shared table. */}
        {[-1.0, 1.0].map((dx) => (
          <Chair key={`n${dx}`} x={dx} z={-0.75} angle={Math.PI} />
        ))}
        {[-1.0, 1.0].map((dx) => (
          <Chair key={`s${dx}`} x={dx} z={0.95} angle={0} />
        ))}
      </group>
    );
  }

  // Departments, the bench and the orchestrator office all get a board.
  return (
    <group position={[cx, 0, cz]}>
      <Whiteboard x={0} z={boardZ} accent={room.accent} width={Math.min(2.8, w * 0.6)} />
      <Plant x={w / 2 - 0.4} z={h / 2 - 0.5} />
      {room.kind === 'orchestrator' && <Plant x={-w / 2 + 0.4} z={h / 2 - 0.5} />}
    </group>
  );
}

/** Every desk in a room: workstation plus the chair the agent sits on. */
export function RoomDesks({ room, map }: { room: Room; map: WorldMap }) {
  return (
    <>
      {room.desks.map((desk) => {
        // Centre of the drawn desk, and the south edge of it — where the body is.
        const [dx, dz] = map.p({
          x: room.x + desk.x + DESK_W / 2,
          y: room.y + desk.y + VISUAL_DESK_H / 2,
        });
        const chairX = map.x(room.x + desk.x + DESK_W / 2);
        const chairZ = map.z(room.y + desk.y + VISUAL_DESK_H);
        return (
          <group key={desk.agentId}>
            <Workstation deskX={dx} deskZ={dz} />
            <Chair x={chairX} z={chairZ} />
          </group>
        );
      })}
    </>
  );
}
