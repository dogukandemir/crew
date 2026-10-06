/**
 * The office, in WebGL.
 *
 * The simulation decides who is where and what they are doing (src/sim, pure and
 * tested); this file only draws it. Characters walk the corridors the simulation
 * routed them along, and every pose they strike is a projection of real domain
 * state — nothing here is decorative animation.
 *
 * Performance shape: React renders the scene graph once per *state* change, and
 * a single rAF loop per character writes transforms and limbs directly to the
 * object graph. A floor of twenty animated people therefore costs no React
 * reconciliation per frame.
 */
import { OrbitControls } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useSceneFrame } from '../../app/useSceneFrame';
import { PanelError } from '../../components/PanelError';
import { EmptyState } from '../../components/ui/EmptyState';
import type { ActivityKind } from '../../sim/activity';
import type { Office } from '../../sim/floorplan';
import type { Point } from '../../sim/geometry';
import { routeBetween } from '../../sim/paths';
import type { SceneAgent } from '../../sim/scene';
import { WALK_SPEED, newWalker, setRoute, step, type Walker } from '../../sim/walkers';
import { AgentWorkstation } from '../office/AgentWorkstation';
import { CharacterRig, type RigMotion } from './Character';
import { UNIT, OFFICE as P, matte } from './assets';
import { lookFor } from '../characters/look';
import { Room3D, RoomDesks, corridorTexture, makeToWorld, nameTagTexture } from './scenery';

/** Activity → colour. Same language as the 2D floor and the status dots. */
const TONE: Record<ActivityKind, string> = {
  offline: '#6b7280',
  blocked: '#e05d5d',
  waiting: '#e0a458',
  celebrating: '#5fbf8f',
  walking: '#6fc3d0',
  tool: '#5b8def',
  talking: '#c97bb6',
  typing: '#5fbf8f',
  thinking: '#8b93a7',
  idle: '#4a5160',
};

interface ViewPreset {
  label: string;
  theta: number;
  phi: number;
  /** Multiplier on the distance needed to fit the floor. */
  zoom: number;
}

const PRESETS: Record<string, ViewPreset> = {
  iso: { label: 'Isometric', theta: 0.62, phi: 0.86, zoom: 1.0 },
  steep: { label: 'Steep', theta: 0.34, phi: 0.6, zoom: 1.02 },
  plan: { label: 'Plan', theta: 0.04, phi: 0.24, zoom: 1.0 },
  close: { label: 'Desks', theta: 0.56, phi: 0.94, zoom: 0.5 },
};

/** Ease the shortest way round, so nobody spins 350° to turn 10°. */
function turnTo(current: number, target: number, k: number): number {
  let delta = (target - current) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return current + delta * k;
}

// ── One character ───────────────────────────────────────────────────────────

function Agent({
  agent,
  office,
  map,
  selected,
  onSelect,
}: {
  agent: SceneAgent;
  office: Office;
  map: ReturnType<typeof makeToWorld>;
  selected: boolean;
  onSelect: (id: string | null) => void;
}) {
  const group = useRef<THREE.Group>(null);
  const look = useMemo(() => lookFor(agent.id, agent.role, agent.grade, agent.name), [agent.id, agent.role, agent.grade, agent.name]);
  const motion = useRef<RigMotion>({ moving: false, speed: 0, selected });
  motion.current.selected = selected;
  const walker = useRef<Walker>(newWalker(agent.desk.x, agent.desk.y));
  const yaw = useRef(Math.PI);
  const prev = useRef<Point>({ ...agent.desk });

  // Sitting at their own desk is what decides chair versus corridor posture.
  const seated =
    agent.intent.roomId === agent.homeRoomId &&
    Math.hypot(agent.intent.point.x - agent.desk.x, agent.intent.point.y - agent.desk.y) < 1.5;

  // Re-route whenever the simulation moves the goalposts.
  useEffect(() => {
    const w = walker.current;
    const route = routeBetween(office, agent.fromRoomId, agent.intent.roomId, { x: w.x, y: w.y }, agent.intent.point);
    setRoute(w, route);
  }, [office, agent.fromRoomId, agent.intent.roomId, agent.intent.point.x, agent.intent.point.y]);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.05);
    const w = step(walker.current, dt, WALK_SPEED);

    const dx = w.x - prev.current.x;
    const dy = w.y - prev.current.y;
    const travelled = Math.hypot(dx, dy);

    motion.current.moving = w.moving;
    // Speed in metres per second, so the walk cycle matches the ground covered.
    motion.current.speed = dt > 0 ? (travelled * UNIT) / dt : 0;

    if (travelled > 0.2) yaw.current = turnTo(yaw.current, Math.atan2(dx, dy), Math.min(1, dt * 6));
    else if (seated) yaw.current = turnTo(yaw.current, Math.PI, Math.min(1, dt * 4));

    if (group.current) {
      const [wx, wz] = map.p({ x: w.x, y: w.y });
      group.current.position.set(wx, 0, wz);
      group.current.rotation.y = yaw.current;
    }
    prev.current = { x: w.x, y: w.y };
  });

  const tone = TONE[agent.activity];

  return (
    <group ref={group}>
      <CharacterRig look={look} activity={agent.activity} atDesk={seated} motion={motion} />
      <NameTag agent={agent} tone={tone} />

      {/* A generous invisible hit target — clicking a thin arm should still work. */}
      <mesh
        position={[0, 0.95, 0]}
        onClick={(e) => {
          e.stopPropagation();
          onSelect(agent.id);
        }}
        onPointerOver={(e) => {
          e.stopPropagation();
          document.body.style.cursor = 'pointer';
        }}
        onPointerOut={() => {
          document.body.style.cursor = '';
        }}
      >
        <capsuleGeometry args={[0.36, 1.25, 4, 8]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>

      {selected && (
        <mesh position={[0, 0.03, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.38, 0.46, 28]} />
          <meshBasicMaterial color={tone} toneMapped={false} transparent opacity={0.95} side={THREE.DoubleSide} />
        </mesh>
      )}
    </group>
  );
}

/** The name plate over a character. `sprites` always face the camera. */
function NameTag({ agent, tone }: { agent: SceneAgent; tone: string }) {
  const texture = useMemo(() => nameTagTexture(agent.name, agent.role, tone), [agent.name, agent.role, tone]);
  const sprite = useRef<THREE.Sprite>(null);
  const { camera } = useThree();

  // A sprite is a fixed size in the world, so zooming in would make the plates
  // swallow the scene. Scale with distance instead, which keeps them a constant
  // size on screen at any zoom, and fade out the far ones so a full floor of
  // names does not turn into soup.
  useFrame(() => {
    const s = sprite.current;
    if (!s) return;
    const d = camera.position.distanceTo(s.getWorldPosition(TAG_AT));
    s.scale.set(d * 0.07, d * 0.0195, 1);
    const material = s.material as THREE.SpriteMaterial;
    material.opacity = d > 34 ? 0 : d > 26 ? (34 - d) / 8 : 1;
  });

  return (
    <sprite ref={sprite} position={[0, 1.95, 0]} renderOrder={10}>
      <spriteMaterial map={texture} transparent depthTest={false} toneMapped={false} />
    </sprite>
  );
}

/** Scratch vector for tag distance maths — allocating per frame is not free. */
const TAG_AT = new THREE.Vector3();

// ── Camera ──────────────────────────────────────────────────────────────────

/** The little bit of OrbitControls this file actually drives. */
interface OrbitLike {
  target: THREE.Vector3;
  update: () => void;
}

/** What the camera needs to know about the floor to fit it on screen. */
interface FitBox {
  aspect: number;
  /** Half the vertical field of view, in radians. */
  vHalf: number;
  worldW: number;
  worldD: number;
}

function CameraRig({
  preset,
  controls,
  fit,
  focus,
}: {
  preset: keyof typeof PRESETS;
  controls: React.RefObject<OrbitLike | null>;
  fit: FitBox;
  focus: [number, number] | null;
}) {
  const { camera } = useThree();
  const goal = useRef<THREE.Vector3 | null>(null);
  const goalTarget = useRef<THREE.Vector3 | null>(null);

  const place = useCallback(
    (name: keyof typeof PRESETS) => {
      const p = PRESETS[name];
      const hHalf = Math.atan(Math.tan(fit.vHalf) * fit.aspect);
      // Looking down at an angle compresses the floor's depth on screen by
      // cos(phi) — at 76° of elevation almost none, at a shallow angle a lot.
      const depth = (fit.worldD * Math.cos(p.phi) + 2.8) / 2;
      const width = (fit.worldW + 1.4) / 2;
      const distance =
        Math.max(depth / Math.tan(fit.vHalf), width / Math.tan(hHalf)) * 1.06 * p.zoom;
      const r = Math.max(6, distance);
      goal.current = new THREE.Vector3(
        r * Math.sin(p.phi) * Math.sin(p.theta),
        r * Math.cos(p.phi),
        r * Math.sin(p.phi) * Math.cos(p.theta),
      );
    },
    [fit],
  );

  useEffect(() => {
    place(preset);
  }, [preset, place]);

  useEffect(() => {
    // Pan toward the character rather than centring on them: the whole floor
    // stays in frame, but whoever you clicked comes in from the edge.
    if (focus) goalTarget.current = new THREE.Vector3(focus[0] * 0.6, 0.9, focus[1] * 0.6);
  }, [focus]);

  useFrame((_, delta) => {
    const controls1 = controls.current;
    if (goal.current) {
      camera.position.lerp(goal.current, Math.min(1, delta * 3.4));
      if (camera.position.distanceTo(goal.current) < 0.06) goal.current = null;
    }
    if (goalTarget.current && controls1) {
      // OrbitControls derives the camera from target + offset, so easing the
      // target glides the camera without breaking the orbit angle.
      controls1.target.lerp(goalTarget.current, Math.min(1, delta * 3));
      if (controls1.target.distanceTo(goalTarget.current) < 0.06) goalTarget.current = null;
    }
    controls1?.update();
  });

  return null;
}

// ── Lighting ────────────────────────────────────────────────────────────────

function Lighting({ span }: { span: number }) {
  const dir = useRef<THREE.DirectionalLight>(null);
  const half = span * 0.62;

  return (
    <>
      <ambientLight intensity={0.55} />
      <hemisphereLight args={['#93a7c4', '#131720', 0.55]} />
      <directionalLight
        ref={dir}
        position={[span * 0.45, span * 0.85, span * 0.5]}
        intensity={1.55}
        color="#fff4e2"
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-left={-half}
        shadow-camera-right={half}
        shadow-camera-top={half}
        shadow-camera-bottom={-half}
        shadow-camera-near={1}
        shadow-camera-far={span * 3}
        shadow-bias={-0.0012}
      />
      {/* Warm ceiling pools so the floor is not lit like a car park. */}
      {[-1, 0, 1].map((row) => (
        <pointLight
          key={row}
          position={[row * (span * 0.3), 3.1, row * (span * 0.18)]}
          intensity={9}
          distance={14}
          decay={2}
          color={P.lampGlow}
        />
      ))}
    </>
  );
}

// ── The scene ───────────────────────────────────────────────────────────────

function Scene({
  office,
  agents,
  selectedId,
  onSelect,
  preset,
  focus,
}: {
  office: Office;
  agents: SceneAgent[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  preset: keyof typeof PRESETS;
  focus: [number, number] | null;
}) {
  const map = useMemo(() => makeToWorld(office), [office]);
  const span = Math.max(office.width, office.height) * UNIT;
  const controls = useRef<OrbitLike | null>(null);
  const { size } = useThree();
  const floorMat = useMemo(() => {
    const tex = corridorTexture().clone();
    tex.needsUpdate = true;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(Math.round(office.width * UNIT) / 3, Math.round(office.height * UNIT) / 3);
    return new THREE.MeshStandardMaterial({ map: tex, roughness: 0.98 });
  }, [office.width, office.height]);

  // Fit the floor to whichever axis actually runs out first, per camera angle.
  const aspect = size.width / Math.max(1, size.height);
  const fit: FitBox = useMemo(
    () => ({
      aspect,
      vHalf: ((36 * Math.PI) / 180) / 2,
      worldW: office.width * UNIT + 2.5,
      worldD: office.height * UNIT + 2.5,
    }),
    [aspect, office.width, office.height],
  );

  return (
    <>
      <CameraRig preset={preset} controls={controls} fit={fit} focus={focus} />
      <fog attach="fog" args={['#0e1117', span * 1.1, span * 3.4]} />
      <Lighting span={span} />

      {/* One corridor slab under everything; the rooms sit on top of it. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <planeGeometry args={[office.width * UNIT + 2, office.height * UNIT + 2]} />
        <primitive object={floorMat} attach="material" />
      </mesh>

      {office.rooms.map((room) => (
        <Room3D key={room.id} room={room} map={map}>
          <RoomDesks room={room} map={map} />
        </Room3D>
      ))}

      {agents.map((agent) => (
        <Agent
          key={agent.id}
          agent={agent}
          office={office}
          map={map}
          selected={agent.id === selectedId}
          onSelect={onSelect}
        />
      ))}

      <OrbitControls
        ref={(instance) => {
          controls.current = (instance as unknown as OrbitLike | null) ?? null;
        }}
        makeDefault
        enableDamping
        dampingFactor={0.08}
        minPolarAngle={0.18}
        maxPolarAngle={1.25}
        minAzimuthAngle={-1.15}
        maxAzimuthAngle={1.15}
        minDistance={3}
        maxDistance={span * 3}
        panSpeed={0.8}
        zoomSpeed={0.9}
        screenSpacePanning
      />
    </>
  );
}

// ── The view ────────────────────────────────────────────────────────────────

export function Office3D({
  projectId,
  onUse2D,
}: {
  projectId: string;
  tabId: string;
  /** Offered when the browser cannot give us a WebGL context. */
  onUse2D?: () => void;
}) {
  const [showArchived, setShowArchived] = useState(false);
  const frame = useSceneFrame(projectId, showArchived);
  const [preset, setPreset] = useState<keyof typeof PRESETS>('iso');
  const [selected, setSelected] = useState<string | null>(null);
  const [focus, setFocus] = useState<[number, number] | null>(null);

  useEffect(() => {
    setSelected(null);
    setFocus(null);
  }, [projectId]);

  const map = useMemo(() => makeToWorld(frame.office), [frame.office]);

  const select = useCallback(
    (id: string | null) => {
      setSelected(id);
      if (!id) return setFocus(null);
      const agent = frame.scene.agents.find((a) => a.id === id);
      if (agent) setFocus(map.p(agent.desk));
    },
    [frame.scene.agents, map],
  );

  const selectedAgent = selected ? frame.scene.agents.find((a) => a.id === selected) : undefined;
  const stats = frame.scene.stats;

  if (frame.error) {
    return <PanelError error={frame.error} onRetry={frame.refetch} label="The office" />;
  }

  if (frame.isLoading) {
    return <EmptyState title="Building the floor plan…" description="Waiting for the org tree and task list." />;
  }

  if (frame.scene.agents.length === 0) {
    return (
      <EmptyState
        title="Nobody has a desk yet"
        description="Hire an agent or start a run and the floor will fill up."
      />
    );
  }

  return (
    <div className="relative h-full w-full bg-[#0e1117]">
      <Canvas
        shadows={{ type: THREE.PCFShadowMap }}
        dpr={[1, 1.75]}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
        camera={{ fov: 36, near: 0.4, far: 400, position: [12, 16, 16] }}
        onPointerMissed={() => select(null)}
      >
        <color attach="background" args={['#0e1117']} />
        <Scene
          office={frame.office}
          agents={frame.scene.agents}
          selectedId={selected}
          onSelect={select}
          preset={preset}
          focus={focus}
        />
      </Canvas>

      {/* ── HUD ─────────────────────────────────────────────────────────── */}
      <div className="pointer-events-none absolute inset-0 flex flex-col justify-between p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="pointer-events-auto flex flex-wrap items-center gap-2 rounded-lg border border-white/10 bg-[#12151c]/85 px-3 py-2 text-xs text-slate-300 backdrop-blur">
            <span className="font-semibold text-slate-100">{stats.seats}</span> seated
            <span className="text-white/15">|</span>
            <span className="font-semibold text-emerald-300">{stats.working}</span> working
            <span className="text-white/15">|</span>
            <span className="font-semibold text-slate-200">{stats.thinking}</span> thinking
            <span className="text-white/15">|</span>
            <span className="font-semibold text-cyan-300">{stats.walking}</span> in transit
            {stats.attention > 0 && (
              <>
                <span className="text-white/15">|</span>
                <span className="font-semibold text-red-300">{stats.attention}</span> need attention
              </>
            )}
          </div>

          <div className="pointer-events-auto flex flex-col items-end gap-2">
            <div className="flex gap-1 rounded-lg border border-white/10 bg-[#12151c]/85 p-1 backdrop-blur">
              {Object.entries(PRESETS).map(([key, value]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setPreset(key as keyof typeof PRESETS)}
                  className={
                    'rounded px-2 py-1 text-xs transition ' +
                    (preset === key ? 'bg-white/10 text-slate-100' : 'text-slate-400 hover:text-slate-200')
                  }
                >
                  {value.label}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-2 rounded-lg border border-white/10 bg-[#12151c]/85 px-2 py-1 text-xs text-slate-400 backdrop-blur">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(e) => setShowArchived(e.target.checked)}
                className="accent-slate-400"
              />
              former staff
            </label>
            {onUse2D && (
              <button
                type="button"
                onClick={onUse2D}
                className="rounded-lg border border-white/10 bg-[#12151c]/85 px-2 py-1 text-xs text-slate-400 backdrop-blur hover:text-slate-200"
              >
                2.5D office
              </button>
            )}
          </div>
        </div>

        <div className="flex items-end justify-between gap-3">
          <div className="pointer-events-auto flex flex-wrap items-center gap-3 rounded-lg border border-white/10 bg-[#12151c]/85 px-3 py-2 text-[11px] text-slate-400 backdrop-blur">
            {(['typing', 'thinking', 'tool', 'talking', 'walking', 'waiting', 'blocked', 'celebrating'] as ActivityKind[]).map(
              (kind) => (
                <span key={kind} className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full" style={{ background: TONE[kind] }} />
                  {kind}
                </span>
              ),
            )}
          </div>
          <div className="rounded-lg border border-white/10 bg-[#12151c]/85 px-3 py-2 text-[11px] text-slate-400 backdrop-blur">
            drag to pan · scroll to zoom · right-drag to orbit · click a character
          </div>
        </div>
      </div>

      {selectedAgent && (
        <div className="absolute right-3 top-3 bottom-3 w-[380px] max-w-[calc(100%-24px)]">
          <AgentWorkstation
            agentId={selectedAgent.id}
            projectId={projectId}
            activity={frame.activities[selectedAgent.id]}
            onClose={() => select(null)}
          />
        </div>
      )}
    </div>
  );
}
