/**
 * A character, drawn as a sprite from the atlas on the office floor.
 *
 * This is the sprite-drawing half of the pair with `SvgCharacter`: the same
 * activity, the same motion ref, the same local space (the feet at the origin, the
 * figure growing upward in negative y). What changes is that the figure is one
 * atlas cell instead of an articulated rig.
 *
 * Identity is by name-hash into the atlas's 64 looks. The vector `lookFor` can
 * express far more combinations than a fixed atlas can carry; the trade is that the
 * atlas cannot be arbitrary, so a look is a *member of a cast* rather than a
 * formula. It is still deterministic per agent — the same person every session.
 *
 * The rAF loop writes the cell's x/y/width/height attributes directly, the same way
 * the SVG rig wrote limb rotations: React does not re-render for animation, and a
 * two-frame walk cycle is what four hand-drawn poses buy.
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
}

export interface SpriteMotionRef {
  current: SpriteMotion;
}

/** Seconds per frame of the two-frame walk. */
const STRIDE = 0.22;

export function SpriteCharacter({
  name,
  activity,
  atDesk,
  motion,
  /** Drawn height in local pixels — the figure's feet land on the local origin. */
  height,
  faded,
}: {
  name: string;
  activity: ActivityKind;
  atDesk: boolean;
  motion: SpriteMotionRef;
  height: number;
  faded?: boolean;
}) {
  const img = useRef<SVGImageElement>(null);
  const clipRect = useRef<SVGRectElement>(null);
  const mirror = useRef<SVGGElement>(null);
  const clipId = `char-${useId().replace(/:/g, '')}`;

  useEffect(() => {
    const atlas = new Map<string, AtlasEntry>(ATLAS.entries.map((e) => [e.name, e]));
    const look = lookIndex(name);
    const cell = (facing: string, pose: string): AtlasEntry | undefined =>
      atlas.get(`char.${look}.${facing}.${pose}`);

    let raf = 0;
    let last = performance.now();
    let phase = 0;

    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      const mov = motion.current;
      phase += dt;

      // `walking` is a destination as much as a movement: an agent sent to the
      // review table keeps that activity after it arrives. Only real movement
      // plays the walk cycle, exactly as the rig did.
      //
      // The walking figure is the FRONT view, mirrored for direction — the way the
      // vector rig walked. The atlas's profile view carries the hair across two
      // thirds of the head, and at this size that reads as a face with something
      // over it, which is what it looked like on the floor.
      let pose: 'stand' | 'walkA' | 'walkB' | 'sit' = 'stand';
      if (atDesk) pose = 'sit';
      else if (mov.moving) pose = Math.floor(phase / STRIDE) % 2 === 0 ? 'walkA' : 'walkB';

      // A sitter faces their desk, so from the room you see their BACK. The atlas
      // has carried char.N.back.sit all along and nothing asked for it, which is
      // why every seated figure looked like it was sitting facing the camera with
      // its chair behind it.
      const e = cell(atDesk ? 'back' : 'front', pose) ?? cell('front', 'stand');
      if (e && img.current && clipRect.current) {
        // The cell is drawn in the caller's local space with the feet on the
        // origin. `height` is how tall the figure should be there, and the same
        // factor scales across: two would shear the sprite. See Sprite.tsx.
        const k = (height / 40) * spriteScaleFactor();
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

      if (mirror.current) {
        // Mirror about the figure's own centre — the local origin. Mirroring the
        // caller's group would flip the name tag and the bubble with it.
        mirror.current.setAttribute('transform', `scale(${mov.facing < 0 ? -1 : 1} 1)`);
      }

      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [name, activity, atDesk, motion, height]);

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
