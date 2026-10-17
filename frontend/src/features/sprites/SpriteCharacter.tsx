import { animateFrames } from '../../app/animation';
/**
 * A character, drawn as one cell of the atlas on the office floor.
 *
 * The same activity, the same motion ref and the same local space as every other
 * thing standing on the floor: the feet at the origin, the figure growing upward
 * in negative y, and one atlas cell placed by the anchor that cell carries.
 *
 * Identity is by name-hash into the atlas's 64 looks, so a look is a *member of a
 * cast* rather than a formula. It is still deterministic per agent, the same
 * person every session.
 *
 * The rAF loop writes the cell's x/y/width/height attributes directly, so React
 * does not re-render for animation, and a two-frame walk cycle is what four
 * hand-drawn poses buy.
 */
import { useEffect, useId, useRef } from 'react';
import type { ActivityKind } from '../../sim/activity';
import atlasUrl from '../sprites/atlas.png';
import { ATLAS, type AtlasEntry } from '../sprites/atlas.gen';
import { SPRITE_UNIT, lookIndex } from '../sprites/sprites';
import { spriteScaleFactor } from '../sprites/viewScale';

export interface SpriteMotion {
  facing: 1 | -1;
  moving: boolean;
  /** Simulation units per second. */
  speed: number;
  /**
   * Where the walker is, in floor units. Written by the walk loop, read by the
   * scene to order things by position, the one thing about a person that React
   * never sees, because moving is written straight to the elements.
   */
  x: number;
  y: number;
  /** Updated by the floor when the character actually reaches a seat. */
  seated?: boolean;
}

export interface SpriteMotionRef {
  current: SpriteMotion;
}

/** Seconds per frame of the two-frame walk. */
const STRIDE = 0.22;

/**
 * Which atlas cell a figure shows, the floor's one rule about faces.
 *
 * Only somebody WORKING at their own desk faces it: you see their back, which is
 * what sitting at a monitor looks like. Everybody else sits facing the room,
 * idle, thinking, blocked, waiting, talking, in a meeting, and anyone on their
 * feet faces the camera, walkers included. A back turned all day is exactly what
 * "some characters look permanently turned away" was.
 *
 * The lab is untouched by this and stays as it was: nobody sits at the bench, so
 * its people never were the ones with their backs to the room.
 */
export function figureCell(
  activity: ActivityKind,
  atDesk: boolean,
  moving: boolean,
  phase: number,
): { face: 'front' | 'back'; pose: 'stand' | 'walkA' | 'walkB' | 'sit' } {
  if (moving) return { face: 'front', pose: Math.floor(phase / STRIDE) % 2 === 0 ? 'walkA' : 'walkB' };
  if (atDesk) {
    const working = activity === 'typing' || activity === 'tool';
    return { face: working ? 'back' : 'front', pose: 'sit' };
  }
  return { face: 'front', pose: 'stand' };
}

const atlasCells = new Map<string, AtlasEntry>(ATLAS.entries.map(entry => [entry.name, entry]));

export function SpriteCharacter({
  name,
  activity,
  atDesk,
  motion,
  faded,
}: {
  name: string;
  activity: ActivityKind;
  atDesk: boolean;
  motion: SpriteMotionRef;
  faded?: boolean;
}) {
  const img = useRef<SVGImageElement>(null);
  const clipRect = useRef<SVGRectElement>(null);
  const mirror = useRef<SVGGElement>(null);
  const clipId = `char-${useId().replace(/:/g, '')}`;

  useEffect(() => {
    const look = lookIndex(name);
    const cell = (facing: string, pose: string): AtlasEntry | undefined =>
      atlasCells.get(`char.${look}.${facing}.${pose}`);

    let last = performance.now();
    let phase = 0;
    let painted = '';
    let mirrored: number | undefined;

    const tick = (now: number, reducedMotion: boolean) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      const mov = motion.current;
      phase = reducedMotion ? 0 : phase + dt;

      // `walking` is a destination as much as a movement: an agent sent to the
      // review table keeps that activity after it arrives. Only real movement
      // plays the walk cycle, exactly as the rig did.
      //
      // Which way the figure faces, and in what pose, is one rule, see figureCell.
      const { face, pose } = figureCell(activity, mov.seated ?? atDesk, !reducedMotion && mov.moving, phase);
      const e = cell(face, pose) ?? cell('front', 'stand');
      const k = SPRITE_UNIT * spriteScaleFactor();
      const key = `${e?.name}:${k}`;
      if (e && img.current && clipRect.current && painted !== key) {
        painted = key;
        // The cell is drawn in the caller's local space with the feet on the
        // origin, at EXACTLY the sprite factor every prop uses. There is no second
        // rule for people: this used to take a `height` from its caller and divide
        // it by 40, so a figure was drawn 40 units tall, 0.56 m, while the desk
        // beside it was drawn from the other factor entirely. One rule, one atlas,
        // one metre. See Sprite.tsx.
        const x0 = -e.ax * k;
        const y0 = -e.ay * k;
        // The sheet slides under a window the size of the cell: an <image> has no
        // idea what a cell is.
        clipRect.current.setAttribute('x', x0.toFixed(2));
        clipRect.current.setAttribute('y', y0.toFixed(2));
        clipRect.current.setAttribute('width', (e.w * k).toFixed(2));
        clipRect.current.setAttribute('height', (e.h * k).toFixed(2));
        img.current.setAttribute('x', (x0 - e.x * k).toFixed(2));
        img.current.setAttribute('y', (y0 - e.y * k).toFixed(2));
        img.current.setAttribute('width', (ATLAS.width * k).toFixed(2));
        img.current.setAttribute('height', (ATLAS.height * k).toFixed(2));
      }

      const facing = mov.facing < 0 ? -1 : 1;
      if (mirror.current && mirrored !== facing) {
        mirrored = facing;
        // Mirror about the figure's own centre, the local origin. Mirroring the
        // caller's group would flip the name tag and the bubble with it.
        mirror.current.setAttribute('transform', `scale(${mov.facing < 0 ? -1 : 1} 1)`);
      }

    };

    return animateFrames(tick);
  }, [name, activity, atDesk, motion]);

  return (
    <g ref={mirror} opacity={faded ? 0.55 : 1}>
      <clipPath id={clipId}>
        <rect ref={clipRect} x={-12} y={-39} width={24} height={40} />
      </clipPath>
      <image
        ref={img}
        href={atlasUrl}
        preserveAspectRatio="none"
        clipPath={`url(#${clipId})`}
        style={{ imageRendering: 'pixelated' }}
      />
    </g>
  );
}
