/**
 * A character, drawn as SVG.
 *
 * Chibi proportions, an outline, big eyes — this is the version that has to be
 * charming at 45 pixels tall, because it is the office users actually look at.
 *
 * Three things are deliberate:
 *
 *  1. **Identity is shared with the 3D office.** The same `CharacterLook` drives
 *     both, so the person you see on the 2D floor is the person you find in the
 *     WebGL view, down to the hair colour and the lanyard.
 *  2. **The pose table is shared too.** `to2d` projects the one pose the whole
 *     app agrees on, so nobody walks one way here and another way there.
 *  3. **React never re-renders for motion.** The SVG is built once and a single
 *     rAF loop writes limb rotations onto the groups, exactly like the 3D rig.
 */
import { useEffect, useMemo, useRef } from 'react';
import type { ActivityKind } from '../../sim/activity';
import { blendPose, motionOffset, poseForContext, type Pose } from './poses';
import type { CharacterLook } from './look';
import {
  FACE,
  INK,
  VIEW,
  collarKind,
  figureFor,
  hairKind,
  lift,
  shade,
  to2d,
  uniformColour,
  type Figure,
} from './svg';

/** Per-frame movement the parent mutates in place. */
export interface SvgMotion {
  facing: 1 | -1;
  moving: boolean;
  /** Simulation units per second. */
  speed: number;
}

export interface SvgMotionRef {
  current: SvgMotion;
}

export interface SvgCharacterProps {
  look: CharacterLook;
  activity: ActivityKind;
  atDesk: boolean;
  motion: SvgMotionRef;
  /** Drawn height in pixels. */
  size?: number;
  /** Dimmed for an archived agent. */
  faded?: boolean;
}

/** Pose settle rate, in pose-fractions per second. */
const POSE_RATE = 3.4;
/** Radians of walk cycle per simulation unit travelled (96 u/s ≈ a brisk walk). */
const STRIDE_PER_UNIT = 0.048;

export function SvgCharacter({ look, activity, atDesk, motion, size = 46, faded }: SvgCharacterProps) {
  const fig = useMemo(() => figureFor(look), [look]);
  const hue = useMemo(
    () => ({
      skin: lift(look.skin, 0.04),
      top: lift(uniformColour(look.top.kind) ?? look.top.color, 0.08),
      bottom: lift(look.bottom.color, 0.08),
      hair: lift(look.hair.color, 0.06),
      shoes: lift(look.shoes, 0.06),
      badge: look.badge ? lift(look.badge, 0.1) : '#8a8f99',
      hivis: '#e8a33d',
    }),
    [look],
  );

  const body = useRef<SVGGElement>(null);
  const mirror = useRef<SVGGElement>(null);
  const torso = useRef<SVGGElement>(null);
  const head = useRef<SVGGElement>(null);
  const armL = useRef<SVGGElement>(null);
  const armR = useRef<SVGGElement>(null);
  const foreL = useRef<SVGGElement>(null);
  const foreR = useRef<SVGGElement>(null);
  const legL = useRef<SVGGElement>(null);
  const legR = useRef<SVGGElement>(null);
  const shinL = useRef<SVGGElement>(null);
  const shinR = useRef<SVGGElement>(null);

  const current = useRef<Pose>(poseForContext(activity, atDesk));
  const phase = useRef(Math.random() * Math.PI * 2);

  useEffect(() => {
    let raf = 0;
    let last = performance.now();

    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;

      const mov = motion.current;
      const poseNow = mov.moving ? poseForContext('walking', false) : poseForContext(activity, atDesk);
      current.current = blendPose(current.current, poseNow, Math.min(1, dt * POSE_RATE));

      const p = to2d(current.current, fig);
      const off = motionOffset(current.current, phase.current);
      const DEG = 180 / Math.PI;

      phase.current += dt * (mov.moving ? Math.max(0.6, mov.speed * STRIDE_PER_UNIT) : 1.6);

      const cx = VIEW.w / 2;
      const bob = off.hipY * 100;

      // Facing: mirror the figure about its own centre. Doing it here rather
      // than on the caller's container keeps the name tag and the speech bubble
      // the right way round.
      if (mirror.current) {
        mirror.current.setAttribute(
          'transform',
          `translate(${cx} 0) scale(${mov.facing < 0 ? -1 : 1} 1) translate(${-cx} 0)`,
        );
      }

      if (body.current) {
        body.current.setAttribute('transform', `translate(0 ${(p.drop + bob).toFixed(2)})`);
      }
      if (torso.current) {
        torso.current.setAttribute('transform', `rotate(${(p.lean + off.hipPitch * DEG).toFixed(1)} ${cx} ${fig.hipY})`);
      }
      if (head.current) {
        head.current.setAttribute('transform', `rotate(${p.headPitch.toFixed(1)} ${cx} ${fig.neckTop})`);
      }

      const swing = (base: number, extra: number) => base + extra * DEG;

      if (armL.current) armL.current.setAttribute('transform', `rotate(${swing(p.armL, off.armL[0]).toFixed(1)} ${cx + fig.armX} ${fig.shoulderY})`);
      if (armR.current) armR.current.setAttribute('transform', `rotate(${swing(p.armR, off.armR[0]).toFixed(1)} ${cx - fig.armX} ${fig.shoulderY})`);
      const elbowY = fig.shoulderY + fig.armUpper;
      if (foreL.current) foreL.current.setAttribute('transform', `rotate(${swing(p.elbowL, off.elbowL).toFixed(1)} ${cx + fig.armX} ${elbowY})`);
      if (foreR.current) foreR.current.setAttribute('transform', `rotate(${swing(p.elbowR, off.elbowR).toFixed(1)} ${cx - fig.armX} ${elbowY})`);

      if (legL.current) legL.current.setAttribute('transform', `rotate(${swing(p.thighL, off.hipL).toFixed(1)} ${cx + fig.hipSep} ${fig.hipY})`);
      if (legR.current) legR.current.setAttribute('transform', `rotate(${swing(p.thighR, off.hipR).toFixed(1)} ${cx - fig.hipSep} ${fig.hipY})`);
      const kneeY = fig.hipY + fig.thigh;
      if (shinL.current) shinL.current.setAttribute('transform', `rotate(${swing(p.kneeL, off.kneeL).toFixed(1)} ${cx + fig.hipSep} ${kneeY})`);
      if (shinR.current) shinR.current.setAttribute('transform', `rotate(${swing(p.kneeR, off.kneeR).toFixed(1)} ${cx - fig.hipSep} ${kneeY})`);

      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [activity, atDesk, fig, motion]);

  const cx = VIEW.w / 2;
  const height = size;
  const width = (size * VIEW.w) / VIEW.h;

  return (
    <svg
      viewBox={`0 0 ${VIEW.w} ${VIEW.h}`}
      width={width}
      height={height}
      style={{ overflow: 'visible', opacity: faded ? 0.45 : 1 }}
      aria-hidden
    >

      {/* The mirror lives here, inside the figure, and NOT on the caller's
          container: flipping the container also flips anything else in it, so
          the name tag and the speech bubble came out backwards. */}
      <g ref={mirror}>
        <g transform={`scale(${fig.stature.toFixed(3)}) translate(${(cx * (1 / fig.stature - 1)).toFixed(2)} ${(VIEW.h * (1 / fig.stature - 1) * 0.62).toFixed(2)})`}>
          <g ref={body}>
            {/* Legs, behind the torso. */}
            <Leg side={1} fig={fig} bottom={hue.bottom} skin={hue.skin} shoe={hue.shoes} bare={look.bottom.kind !== 'trousers'} refs={{ root: legL, shin: shinL }} />
            <Leg side={-1} fig={fig} bottom={hue.bottom} skin={hue.skin} shoe={hue.shoes} bare={look.bottom.kind !== 'trousers'} refs={{ root: legR, shin: shinR }} />

            <g ref={torso}>
              <Torso look={look} fig={fig} top={hue.top} bottom={hue.bottom} badge={hue.badge} skin={hue.skin} />
            </g>

            <Arm side={1} fig={fig} colour={hue.top} skin={hue.skin} sleeve={look.top.sleeve} refs={{ root: armL, fore: foreL }} />
            <Arm side={-1} fig={fig} colour={hue.top} skin={hue.skin} sleeve={look.top.sleeve} refs={{ root: armR, fore: foreR }} />

            <g ref={head}>
              <Head look={look} fig={fig} skin={hue.skin} hair={hue.hair} badge={hue.badge} hivis={hue.hivis} />
            </g>
          </g>
        </g>
      </g>
    </svg>
  );
}

// ── Anatomy ─────────────────────────────────────────────────────────────────

function Head({
  look,
  fig,
  skin,
  hair,
  badge,
  hivis,
}: {
  look: CharacterLook;
  fig: Figure;
  skin: string;
  hair: string;
  badge: string;
  hivis: string;
}) {
  const cx = VIEW.w / 2;
  const r = fig.headR;
  const cy = fig.headCy;
  const kind = hairKind(look.hair.style);
  const hairInk = shade(hair, 0.42);

  /**
   * The hair cap.
   *
   * Its lower edge has to stay clear of the eyes. A fringe that dips into the
   * middle of the face is what made every character look like they were wearing
   * a dark band across their eyes, so the sweep stops above them.
   */
  const capPath = (depth: number) => {
    const edge = cy - 6 + depth * 0.3;
    return (
      `M ${cx - r - 1} ${cy - 6} A ${r + 1} ${r + 1} 0 0 1 ${cx + r + 1} ${cy - 6}` +
      ` L ${cx + r - 2} ${edge} Q ${cx} ${edge + 1.6} ${cx - r + 2} ${edge} Z`
    );
  };

  return (
    <g>
      {/* Hair behind the head: the styles that hang. */}
      {(kind === 'long' || kind === 'ponytail') && (
        <path
          d={`M ${cx - r - 2} ${cy} Q ${cx - r - 5} ${cy + 26} ${cx - 4} ${cy + 30} L ${cx + 4} ${cy + 30} Q ${cx + r + 1} ${cy + 24} ${cx + r + 2} ${cy} Z`}
          fill={hair}
          stroke={hairInk}
          strokeWidth={1.2}
        />
      )}
      {kind === 'bun' && <circle cx={cx + 2} cy={cy - r - 1} r={5.6} fill={hair} stroke={hairInk} strokeWidth={1.2} />}

      {/* Neck */}
      <rect x={cx - 4} y={fig.neckTop - 4} width={8} height={9} rx={3} fill={shade(skin, 0.18)} />

      {/* Head */}
      <circle cx={cx} cy={cy} r={r} fill={skin} stroke={INK} strokeWidth={1.4} />
      {/* Ears */}
      <circle cx={cx - r + 1} cy={cy + 1} r={2.6} fill={skin} stroke={INK} strokeWidth={1.1} />
      <circle cx={cx + r - 1} cy={cy + 1} r={2.6} fill={skin} stroke={INK} strokeWidth={1.1} />

      {/* Hair on top */}
      {kind !== 'none' && (
        <path
          d={capPath(kind === 'cap' ? 5 : 8)}
          fill={hair}
          stroke={hairInk}
          strokeWidth={1.2}
          strokeLinejoin="round"
        />
      )}
      {kind === 'sideSweep' && (
        <path d={`M ${cx - r - 1} ${cy - 3} Q ${cx - 2} ${cy - 12} ${cx + r + 1} ${cy - 4} Q ${cx + 4} ${cy - 2} ${cx - r - 1} ${cy - 3} Z`} fill={hair} stroke={hairInk} strokeWidth={1.1} />
      )}
      {kind === 'curly' && (
        <>
          <circle cx={cx - 9} cy={cy - 12} r={5} fill={hair} stroke={hairInk} strokeWidth={1.1} />
          <circle cx={cx - 1} cy={cy - 16} r={5.6} fill={hair} stroke={hairInk} strokeWidth={1.1} />
          <circle cx={cx + 8} cy={cy - 12} r={5} fill={hair} stroke={hairInk} strokeWidth={1.1} />
        </>
      )}
      {kind === 'ponytail' && (
        <path d={`M ${cx + r - 1} ${cy - 2} Q ${cx + r + 9} ${cy + 6} ${cx + r + 5} ${cy + 18} Q ${cx + r + 1} ${cy + 8} ${cx + r - 3} ${cy + 2} Z`} fill={hair} stroke={hairInk} strokeWidth={1.1} />
      )}

      {/* Face: two big eyes, a small smile, blush. No brows — at the size this
          is actually drawn, brows plus a fringe are a band across the eyes. */}
      {[1, -1].map((side) => (
        <g key={side}>
          <ellipse cx={cx + side * 5.9} cy={cy + 1.8} rx={3.3} ry={3.7} fill={FACE.eyeWhite} stroke={INK} strokeWidth={0.9} />
          <ellipse cx={cx + side * 5.7} cy={cy + 2.2} rx={1.9} ry={2.2} fill={FACE.pupil} />
          <circle cx={cx + side * 4.9} cy={cy + 1} r={0.85} fill="#fff" opacity={0.95} />
          <ellipse cx={cx + side * 10.2} cy={cy + 6.8} rx={2.6} ry={1.4} fill={FACE.blush} opacity={0.38} />
        </g>
      ))}
      <path
        d={`M ${cx - 2.6} ${cy + 8.2} Q ${cx} ${cy + 11} ${cx + 2.6} ${cy + 8.2}`}
        fill="none"
        stroke={FACE.mouth}
        strokeWidth={1.4}
        strokeLinecap="round"
      />

      {/* Facial hair */}
      {look.facialHair === 'beard' && (
        <path d={`M ${cx - r + 2} ${cy + 2} Q ${cx} ${cy + r + 5} ${cx + r - 2} ${cy + 2} Q ${cx} ${cy + r - 1} ${cx - r + 2} ${cy + 2} Z`} fill={hair} stroke={hairInk} strokeWidth={1.1} opacity={0.95} />
      )}
      {look.facialHair === 'stubble' && (
        <path d={`M ${cx - r + 2} ${cy + 3} Q ${cx} ${cy + r + 3} ${cx + r - 2} ${cy + 3} Q ${cx} ${cy + r - 2} ${cx - r + 2} ${cy + 3} Z`} fill={hair} opacity={0.28} />
      )}
      {look.facialHair === 'goatee' && (
        <ellipse cx={cx} cy={cy + 10.5} rx={3.6} ry={2.4} fill={hair} stroke={hairInk} strokeWidth={1} />
      )}

      {/* Glasses: thin, with a translucent lens. Anything heavier turns the
          pair into a visor at the size these are drawn. */}
      {look.glasses && (
        <g fill="none" stroke={INK} strokeWidth={1.05} opacity={0.92}>
          <circle cx={cx - 5.9} cy={cy + 1.8} r={4.5} fill="rgba(176,208,236,0.16)" />
          <circle cx={cx + 5.9} cy={cy + 1.8} r={4.5} fill="rgba(176,208,236,0.16)" />
          <path d={`M ${cx - 1.4} ${cy + 1.6} Q ${cx} ${cy + 0.7} ${cx + 1.4} ${cy + 1.6}`} />
          <path d={`M ${cx - 10.3} ${cy + 1} L ${cx - r + 0.5} ${cy - 0.6}`} />
          <path d={`M ${cx + 10.3} ${cy + 1} L ${cx + r - 0.5} ${cy - 0.6}`} />
        </g>
      )}

      {/* Cap */}
      {look.cap && (
        <g>
          <path d={`M ${cx - r - 1} ${cy - 6} A ${r + 1} ${r + 1} 0 0 1 ${cx + r + 1} ${cy - 6} Z`} fill={hivis} stroke={shade(hivis, 0.5)} strokeWidth={1.2} />
          <path d={`M ${cx - 2} ${cy - 5.4} Q ${cx + 9} ${cy - 7} ${cx + 15} ${cy - 2.6} Q ${cx + 9} ${cy - 1.2} ${cx - 2} ${cy - 3} Z`} fill={shade(hivis, 0.18)} stroke={shade(hivis, 0.5)} strokeWidth={1.1} />
        </g>
      )}

      {/* Headset — support lives in these. */}
      {look.headset && (
        <g stroke={INK} strokeWidth={1.3} fill="none">
          <path d={`M ${cx - r + 0.5} ${cy - 2} Q ${cx} ${cy - r - 6} ${cx + r - 0.5} ${cy - 2}`} />
          <rect x={cx + r - 2.4} y={cy - 1} width={3.6} height={5} rx={1.4} fill={INK} />
          <path d={`M ${cx + r - 1} ${cy + 4} Q ${cx + r + 3} ${cy + 8} ${cx + 3} ${cy + 9}`} />
        </g>
      )}

      {/* Lanyard, so a badge is visible on everyone. */}
      {look.badge && (
        <g>
          <path d={`M ${cx - 4} ${fig.neckTop - 1} L ${cx - 1} ${fig.neckTop + 9}`} stroke={badge} strokeWidth={1.6} fill="none" />
          <path d={`M ${cx + 4} ${fig.neckTop - 1} L ${cx + 1} ${fig.neckTop + 9}`} stroke={badge} strokeWidth={1.6} fill="none" />
          <rect x={cx - 2.5} y={fig.neckTop + 9} width={5} height={6.5} rx={1} fill={badge} stroke={shade(badge, 0.4)} strokeWidth={0.9} />
        </g>
      )}
    </g>
  );
}

function Torso({
  look,
  fig,
  top,
  bottom,
  badge,
  skin,
}: {
  look: CharacterLook;
  fig: Figure;
  top: string;
  bottom: string;
  badge: string;
  skin: string;
}) {
  const cx = VIEW.w / 2;
  const w = fig.torsoHalfW * 2;
  const collar = collarKind(look.top.kind);
  const dress = look.bottom.kind === 'dress';
  const skirt = look.bottom.kind === 'skirt';

  return (
    <g>
      {/* Top */}
      <rect
        x={cx - fig.torsoHalfW}
        y={fig.torsoTop}
        width={w}
        height={fig.torsoBottom - fig.torsoTop + 4}
        rx={7}
        fill={top}
        stroke={shade(top, 0.45)}
        strokeWidth={1.4}
      />
      {collar === 'collar' && (
        <path d={`M ${cx - 6} ${fig.torsoTop + 0.5} L ${cx} ${fig.torsoTop + 7} L ${cx + 6} ${fig.torsoTop + 0.5}`} fill={shade(top, 0.28)} stroke={shade(top, 0.5)} strokeWidth={1.1} />
      )}
      {collar === 'hood' && (
        <path d={`M ${cx - 9} ${fig.torsoTop + 2} Q ${cx} ${fig.torsoTop + 10} ${cx + 9} ${fig.torsoTop + 2} Q ${cx} ${fig.torsoTop - 4} ${cx - 9} ${fig.torsoTop + 2} Z`} fill={shade(top, 0.16)} stroke={shade(top, 0.45)} strokeWidth={1.1} />
      )}
      {collar === 'coat' && (
        <path d={`M ${cx} ${fig.torsoTop} L ${cx} ${fig.torsoBottom + 4} M ${cx - 5} ${fig.torsoTop + 2} L ${cx} ${fig.torsoTop + 8} L ${cx + 5} ${fig.torsoTop + 2}`} stroke={shade(top, 0.35)} strokeWidth={1.1} fill="none" />
      )}
      {collar === 'vest' && (
        <g>
          <rect x={cx - 4} y={fig.torsoTop} width={8} height={fig.torsoBottom - fig.torsoTop + 4} rx={2} fill="#f2f4f7" stroke={shade('#f2f4f7', 0.3)} strokeWidth={0.9} />
          <rect x={cx - fig.torsoHalfW + 3} y={fig.torsoTop + 9} width={4} height={fig.torsoBottom - fig.torsoTop - 8} rx={1.6} fill="#f2c14e" />
          <rect x={cx + fig.torsoHalfW - 7} y={fig.torsoTop + 9} width={4} height={fig.torsoBottom - fig.torsoTop - 8} rx={1.6} fill="#f2c14e" />
        </g>
      )}

      {/* Skirt or dress */}
      {(skirt || dress) && (
        <path
          d={`M ${cx - fig.torsoHalfW + 2} ${fig.torsoBottom - 6} L ${cx + fig.torsoHalfW - 2} ${fig.torsoBottom - 6} L ${cx + fig.torsoHalfW + 5} ${fig.hipY + 6} Q ${cx} ${fig.hipY + 9} ${cx - fig.torsoHalfW - 5} ${fig.hipY + 6} Z`}
          fill={dress ? top : bottom}
          stroke={shade(dress ? top : bottom, 0.45)}
          strokeWidth={1.3}
        />
      )}
      {!skirt && !dress && (
        <rect x={cx - fig.torsoHalfW + 1} y={fig.torsoBottom - 4} width={w - 2} height={10} rx={3} fill={bottom} stroke={shade(bottom, 0.45)} strokeWidth={1.2} />
      )}

      {/* Badge clipped to the chest. */}
      <g>
        <rect x={cx + 4} y={fig.torsoTop + 8} width={5.5} height={7} rx={1.2} fill={badge} stroke={shade(badge, 0.4)} strokeWidth={0.9} />
      </g>
      <path d={`M ${cx - 4} ${fig.torsoTop + 1} L ${cx - 1.5} ${fig.torsoTop + 7} M ${cx + 4} ${fig.torsoTop + 1} L ${cx + 1.5} ${fig.torsoTop + 7}`} stroke={badge} strokeWidth={1.4} fill="none" opacity={0.9} />
      {/* Neck gap so the head does not look pasted on. */}
      <rect x={cx - 5} y={fig.torsoTop - 5} width={10} height={7} rx={3} fill={skin} />
    </g>
  );
}

function Arm({
  side,
  fig,
  colour,
  skin,
  sleeve,
  refs,
}: {
  side: 1 | -1;
  fig: Figure;
  colour: string;
  skin: string;
  sleeve: 'long' | 'short';
  refs: { root: React.RefObject<SVGGElement | null>; fore: React.RefObject<SVGGElement | null> };
}) {
  const cx = VIEW.w / 2;
  const x = cx + side * fig.armX;
  const upperEnd = fig.shoulderY + fig.armUpper;
  const lowerEnd = upperEnd + fig.armFore;

  return (
    <g ref={refs.root}>
      <rect x={x - 3.4} y={fig.shoulderY - 1} width={6.8} height={fig.armUpper + 2} rx={3.4} fill={colour} stroke={shade(colour, 0.45)} strokeWidth={1.3} />
      <g ref={refs.fore}>
        <rect x={x - 3} y={upperEnd} width={6} height={fig.armFore + 1} rx={3} fill={sleeve === 'short' ? skin : colour} stroke={sleeve === 'short' ? shade(skin, 0.35) : shade(colour, 0.45)} strokeWidth={1.3} />
        <circle cx={x} cy={lowerEnd + 1} r={3.6} fill={skin} stroke={shade(skin, 0.35)} strokeWidth={1.2} />
      </g>
    </g>
  );
}

function Leg({
  side,
  fig,
  bottom,
  skin,
  shoe,
  bare,
  refs,
}: {
  side: 1 | -1;
  fig: Figure;
  bottom: string;
  skin: string;
  shoe: string;
  bare: boolean;
  refs: { root: React.RefObject<SVGGElement | null>; shin: React.RefObject<SVGGElement | null> };
}) {
  const cx = VIEW.w / 2;
  const x = cx + side * fig.hipSep;
  const knee = fig.hipY + fig.thigh;
  const legFill = bare ? skin : bottom;
  const legStroke = shade(legFill, 0.4);

  return (
    <g ref={refs.root}>
      <rect x={x - 5} y={fig.hipY - 2} width={10} height={fig.thigh + 4} rx={5} fill={legFill} stroke={legStroke} strokeWidth={1.3} />
      <g ref={refs.shin}>
        <rect x={x - 4.4} y={knee} width={8.8} height={fig.shin + 2} rx={4.4} fill={legFill} stroke={legStroke} strokeWidth={1.3} />
        <path
          d={`M ${x - fig.shoeW / 2} ${fig.footY - 4.4} h ${fig.shoeW} q 1.6 0 1.6 1.6 v 2 q 0 0.8 -0.9 0.8 h ${-fig.shoeW - 1.4} q -0.9 0 -0.9 -0.9 Z`}
          fill={shoe}
          stroke={shade(shoe, 0.45)}
          strokeWidth={1.2}
        />
      </g>
    </g>
  );
}
