/**
 * A character: a small humanoid rig, posed and animated procedurally.
 *
 * Two decouplings make this cheap and glitch-free:
 *
 *  1. Geometry and materials are shared (see assets.ts), so a floor of twenty
 *     people costs a couple of dozen GPU buffers, not hundreds.
 *  2. Nothing here re-renders React. Limb motion is written straight onto the
 *     object graph inside one `useFrame`, so animation costs no reconciliation
 *     and a fast walk stays at frame rate.
 *
 * Sign conventions come from poses.ts: a thigh swings forward on a *negative* X
 * rotation, an elbow bends *forward* (so the rig negates the pose value), and a
 * knee bends on a *positive* X rotation.
 */
import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { ActivityKind } from '../../sim/activity';
import { BODY, GEOM, JOINT, matte } from './assets';
import { frameScale, type CharacterLook } from './characters';
import { blendPose, motionOffset, poseForContext, type Pose } from './poses';

/** What the rig needs to know about movement. The parent mutates this in place. */
export interface RigMotion {
  moving: boolean;
  /** Metres per second. */
  speed: number;
  selected: boolean;
}

/** A mutable box, so per-frame data never travels through React state. */
export interface MotionRef {
  current: RigMotion;
}

export interface CharacterRigProps {
  look: CharacterLook;
  activity: ActivityKind;
  atDesk: boolean;
  motion: MotionRef;
}

/** How fast a pose change settles, in pose-fractions per second. */
const POSE_RATE = 3.4;
/** Walk-cycle radians per metre travelled — roughly one stride per step. */
const STRIDE = 3.4;
/** The head mesh sits this far above the top of the neck. */
const NECK_TOP = 0.07;

export function CharacterRig({ look, activity, atDesk, motion }: CharacterRigProps) {
  const body = useRef<THREE.Group>(null);
  const torso = useRef<THREE.Group>(null);
  const head = useRef<THREE.Group>(null);
  const armL = useRef<THREE.Group>(null);
  const armR = useRef<THREE.Group>(null);
  const foreL = useRef<THREE.Group>(null);
  const foreR = useRef<THREE.Group>(null);
  const legL = useRef<THREE.Group>(null);
  const legR = useRef<THREE.Group>(null);
  const shinL = useRef<THREE.Group>(null);
  const shinR = useRef<THREE.Group>(null);

  const frame = frameScale(look.frame);

  // The blended pose is state the rig owns between frames. It starts at the pose
  // the agent's activity asks for, so there is no visible stand-up on first paint.
  const current = useRef<Pose>(poseForContext(activity, atDesk));
  const phase = useRef(Math.random() * Math.PI * 2);

  const skin = useMemo(() => matte(look.skin, { roughness: 0.68 }), [look.skin]);
  const topMat = useMemo(() => matte(look.top.color, { roughness: 0.86 }), [look.top.color]);
  const bottomMat = useMemo(() => matte(look.bottom.color, { roughness: 0.88 }), [look.bottom.color]);
  const shoeMat = useMemo(() => matte(look.shoes, { roughness: 0.6 }), [look.shoes]);
  const hairMat = useMemo(() => matte(look.hair.color, { roughness: 0.55 }), [look.hair.color]);
  const badgeMat = useMemo(() => matte(look.badge ?? '#8a8f99', { roughness: 0.7 }), [look.badge]);
  const darkMat = useMemo(() => matte('#1f232b', { roughness: 0.7 }), []);

  const bareSleeves = look.top.sleeve === 'short';
  const bareLegs = look.bottom.kind !== 'trousers';

  useFrame((_, delta) => {
    // A long frame (hidden tab, GC pause) must not teleport the pose.
    const dt = Math.min(delta, 0.05);

    // 1. Settle toward the pose the current activity asks for. While the walker
    //    is still in transit the walk cycle wins, so a body crossing the floor
    //    can never be sitting at a desk.
    const poseNow = motion.current.moving
      ? poseForContext('walking', false)
      : poseForContext(activity, atDesk);
    current.current = blendPose(current.current, poseNow, Math.min(1, dt * POSE_RATE));
    const pose = current.current;

    // 2. Advance the animation clock. A walking body's phase is driven by speed,
    //    so a stroll and a stride read differently.
    const speed = motion.current.speed;
    const moving = motion.current.moving;
    phase.current += dt * (moving ? Math.max(0.6, speed * STRIDE) : 1.6);

    const off = motionOffset(pose, phase.current);

    // 3. Write it straight onto the graph.
    if (body.current) body.current.position.y = pose.hipY + off.hipY;
    if (torso.current) {
      torso.current.rotation.x = pose.hipPitch + off.hipPitch;
      torso.current.rotation.y = off.yaw;
    }
    if (head.current) {
      head.current.rotation.x = pose.headPitch;
      head.current.rotation.y = pose.headYaw;
    }

    if (armL.current) {
      armL.current.rotation.x = pose.armL[0] + off.armL[0];
      armL.current.rotation.z = pose.armL[1] + off.armL[1];
      armL.current.rotation.y = pose.armL[2] + off.armL[2];
    }
    if (armR.current) {
      armR.current.rotation.x = pose.armR[0] + off.armR[0];
      armR.current.rotation.z = pose.armR[1] + off.armR[1];
      armR.current.rotation.y = pose.armR[2] + off.armR[2];
    }
    // Elbows bend forward, hence the negation.
    if (foreL.current) foreL.current.rotation.x = -(pose.elbowL + off.elbowL);
    if (foreR.current) foreR.current.rotation.x = -(pose.elbowR + off.elbowR);

    if (legL.current) legL.current.rotation.x = pose.hipL + off.hipL;
    if (legR.current) legR.current.rotation.x = pose.hipR + off.hipR;
    if (shinL.current) shinL.current.rotation.x = pose.kneeL + off.kneeL;
    if (shinR.current) shinR.current.rotation.x = pose.kneeR + off.kneeR;
  });

  const upperArmLen = BODY.upperArmL + BODY.upperArmR * 2;
  const forearmLen = BODY.forearmL + BODY.forearmR * 2;
  const thighLen = BODY.thighL + BODY.thighR * 2;
  const shinLen = BODY.shinL + BODY.shinR * 2;

  return (
    <group scale={look.height}>
      {/* Hips: the root of the body, dropped when seated. */}
      <group ref={body} position={[0, BODY.hipStanding, 0]}>
        <mesh geometry={GEOM.pelvis} material={bottomMat} position={[0, 0.02, 0]} scale={[frame, 1, frame]} castShadow />

        <group ref={torso}>
          <mesh
            geometry={GEOM.torso}
            material={topMat}
            position={[0, JOINT.shoulderY - 0.16, 0]}
            scale={[frame, 1, frame * 0.86]}
            castShadow
          />
          {/* A dress is one piece; a skirt hangs below a separate top. */}
          {look.bottom.kind === 'dress' && (
            <mesh geometry={GEOM.skirt} material={topMat} position={[0, -0.16, 0]} scale={[frame, 1, 1]} />
          )}
          {look.bottom.kind === 'skirt' && (
            <mesh geometry={GEOM.skirt} material={bottomMat} position={[0, -0.16, 0]} scale={[frame, 1, 1]} />
          )}

          {/* The lanyard hangs on the chest, so it must not follow the head. */}
          {look.badge && (
            <group position={[0, 0.26, 0.15]}>
              <mesh geometry={GEOM.lanyard} material={badgeMat} position={[0, 0.1, 0]} />
              <mesh geometry={GEOM.badge} material={badgeMat} />
            </group>
          )}

          <Head look={look} headRef={head} hairMat={hairMat} skinMat={skin} darkMat={darkMat} frame={frame} />

          <Arm
            side={1}
            rootRef={armL}
            foreRef={foreL}
            upperLen={upperArmLen}
            foreLen={forearmLen}
            topMat={topMat}
            skinMat={skin}
            bareSleeves={bareSleeves}
            frame={frame}
          />
          <Arm
            side={-1}
            rootRef={armR}
            foreRef={foreR}
            upperLen={upperArmLen}
            foreLen={forearmLen}
            topMat={topMat}
            skinMat={skin}
            bareSleeves={bareSleeves}
            frame={frame}
          />
        </group>

        <Leg
          side={1}
          rootRef={legL}
          shinRef={shinL}
          thighLen={thighLen}
          shinLen={shinLen}
          material={bareLegs ? skin : bottomMat}
          shoeMat={shoeMat}
          frame={frame}
        />
        <Leg
          side={-1}
          rootRef={legR}
          shinRef={shinR}
          thighLen={thighLen}
          shinLen={shinLen}
          material={bareLegs ? skin : bottomMat}
          shoeMat={shoeMat}
          frame={frame}
        />
      </group>
    </group>
  );
}

/** One arm: upper, forearm and hand, pivoting at the shoulder and the elbow. */
function Arm({
  side,
  rootRef,
  foreRef,
  upperLen,
  foreLen,
  topMat,
  skinMat,
  bareSleeves,
  frame,
}: {
  side: 1 | -1;
  rootRef: React.RefObject<THREE.Group | null>;
  foreRef: React.RefObject<THREE.Group | null>;
  upperLen: number;
  foreLen: number;
  topMat: THREE.Material;
  skinMat: THREE.Material;
  bareSleeves: boolean;
  frame: number;
}) {
  return (
    <group ref={rootRef} position={[side * BODY.shoulderSep, JOINT.shoulderY, 0]}>
      <mesh
        geometry={GEOM.upperArm}
        material={topMat}
        position={[0, -upperLen / 2, 0]}
        scale={[frame, 1, frame]}
        castShadow
      />
      <group ref={foreRef} position={[0, -upperLen, 0]}>
        <mesh
          geometry={GEOM.forearm}
          material={bareSleeves ? skinMat : topMat}
          position={[0, -foreLen / 2, 0]}
          scale={[frame, 1, frame]}
          castShadow
        />
        <mesh geometry={GEOM.hand} material={skinMat} position={[0, -foreLen - 0.02, 0]} />
      </group>
    </group>
  );
}

/** One leg: thigh, shin and a foot whose sole rests on the floor. */
function Leg({
  side,
  rootRef,
  shinRef,
  thighLen,
  shinLen,
  material,
  shoeMat,
  frame,
}: {
  side: 1 | -1;
  rootRef: React.RefObject<THREE.Group | null>;
  shinRef: React.RefObject<THREE.Group | null>;
  thighLen: number;
  shinLen: number;
  material: THREE.Material;
  shoeMat: THREE.Material;
  frame: number;
}) {
  return (
    <group ref={rootRef} position={[side * BODY.hipSep, 0, 0]}>
      <mesh
        geometry={GEOM.thigh}
        material={material}
        position={[0, -thighLen / 2, 0]}
        scale={[frame, 1, frame]}
        castShadow
      />
      <group ref={shinRef} position={[0, -thighLen, 0]}>
        <mesh
          geometry={GEOM.shin}
          material={material}
          position={[0, -shinLen / 2, 0]}
          scale={[frame, 1, frame]}
          castShadow
        />
        <mesh geometry={GEOM.foot} material={shoeMat} position={[0, -shinLen - BODY.footH / 2, 0.04]} />
      </group>
    </group>
  );
}

/** Head, face, hair and the accessories that make people recognisable. */
function Head({
  look,
  headRef,
  hairMat,
  skinMat,
  darkMat,
  frame,
}: {
  look: CharacterLook;
  headRef: React.RefObject<THREE.Group | null>;
  hairMat: THREE.Material;
  skinMat: THREE.Material;
  darkMat: THREE.Material;
  frame: number;
}) {
  const R = BODY.headR;
  const lensMat = useMemo(() => matte('#0f1216', { roughness: 0.25, metalness: 0.1 }), []);
  const issuedMat = useMemo(
    () => matte(look.top.kind === 'hivis' ? '#e8a33d' : '#eef1f5', { roughness: 0.9 }),
    [look.top.kind],
  );
  const facialHairMat = useMemo(
    () => matte(look.hair.color, { roughness: 0.7, opacity: look.facialHair === 'stubble' ? 0.42 : 1 }),
    [look.hair.color, look.facialHair],
  );
  const s = look.hair.style;

  const hairScale: [number, number, number] = [
    frame,
    s === 'buzz' ? 0.72 : s === 'short' ? 0.86 : 0.94,
    s === 'curly' ? 1.16 : 1.02,
  ];

  return (
    <group ref={headRef} position={[0, JOINT.headY, 0]}>
      <mesh geometry={GEOM.neck} material={skinMat} position={[0, 0.04, 0]} />
      <group position={[0, 0.04 + NECK_TOP, 0]}>
        <mesh geometry={GEOM.head} material={skinMat} scale={[frame, 1, frame]} castShadow />

        {/* Eyes and brows are what read at any zoom. */}
        <mesh geometry={GEOM.eye} material={lensMat} position={[0.043, 0.018, R * 0.9]} />
        <mesh geometry={GEOM.eye} material={lensMat} position={[-0.043, 0.018, R * 0.9]} />
        <mesh geometry={GEOM.brow} material={facialHairMat} position={[0.043, 0.052, R * 0.88]} rotation={[0, 0, -0.12]} />
        <mesh geometry={GEOM.brow} material={facialHairMat} position={[-0.043, 0.052, R * 0.88]} rotation={[0, 0, 0.12]} />

        {s !== 'bald' && (
          <mesh
            geometry={GEOM.hairCap}
            material={hairMat}
            position={[0, s === 'buzz' ? 0.004 : 0.014, -0.018]}
            scale={hairScale}
          />
        )}
        {s === 'bun' && <mesh geometry={GEOM.bun} material={hairMat} position={[0, 0.05, -0.1]} />}
        {s === 'ponytail' && (
          <mesh geometry={GEOM.ponytail} material={hairMat} position={[0, -0.02, -0.11]} rotation={[0.5, 0, 0]} />
        )}
        {s === 'long' && (
          <mesh geometry={GEOM.longHair} material={hairMat} position={[0, -0.09, -0.075]} scale={[1, 1.25, 0.72]} />
        )}

        {look.facialHair === 'stubble' && (
          <mesh geometry={GEOM.head} material={facialHairMat} scale={[1.01, 0.86, 1.01]} position={[0, -0.045, 0.004]} />
        )}
        {look.facialHair === 'beard' && (
          <mesh geometry={GEOM.head} material={facialHairMat} scale={[1.02, 0.74, 1.02]} position={[0, -0.06, 0.006]} />
        )}
        {look.facialHair === 'goatee' && (
          <mesh geometry={GEOM.brow} material={facialHairMat} position={[0, -0.062, R * 0.82]} scale={[1, 1, 3]} />
        )}

        {look.glasses && (
          <group position={[0, 0.016, R * 0.86]}>
            <mesh geometry={GEOM.glassesFrame} material={darkMat} />
            <mesh geometry={GEOM.lens} material={lensMat} position={[0.05, 0, 0.004]} />
            <mesh geometry={GEOM.lens} material={lensMat} position={[-0.05, 0, 0.004]} />
          </group>
        )}

        {look.cap && (
          <group>
            <mesh geometry={GEOM.capTop} material={issuedMat} position={[0, 0.012, -0.006]} scale={[frame, 1, 1]} />
            <mesh geometry={GEOM.capBrim} material={issuedMat} position={[0, 0.014, R * 0.95]} />
          </group>
        )}

        {/* Support people live in headsets. */}
        {look.headset && (
          <group>
            <mesh geometry={GEOM.headsetBand} material={darkMat} position={[0, 0.01, 0]} />
            <mesh geometry={GEOM.headsetCup} material={darkMat} position={[R * 0.92, -0.01, 0.01]} />
            <mesh geometry={GEOM.headsetCup} material={darkMat} position={[-R * 0.92, -0.01, 0.01]} />
          </group>
        )}
      </group>
    </group>
  );
}
