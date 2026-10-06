/**
 * One atlas cell, drawn into the SVG scene at a world position.
 *
 * The anchor is what makes this work: a sprite knows the pixel that touches the
 * floor, so the image is offset by `-anchor * scale` rather than by its own
 * bounding box. That is what lets a desk and a person occupy the same isometric
 * space and sort against each other.
 *
 * `image-rendering: pixelated` is not decoration — a browser smoothing a 24×40
 * sprite into a 30-pixel box is what turns pixel art into a blur.
 */
import { useId } from 'react';
import atlasUrl from './atlas.png';
import { project } from '../office/iso';
import { ATLAS } from './atlas.gen';
import { SPRITE_UNIT, entry } from './sprites';
import { spriteScaleFactor } from './viewScale';

export function Sprite({
  name,
  x,
  y,
  z = 0,
  flip = false,
  opacity = 1,
  className,
}: {
  /** Atlas key. An unknown key draws nothing, on purpose. */
  name: string;
  /** World position, in units. */
  x: number;
  y: number;
  /** Height the sprite's anchor sits at, in units. */
  z?: number;
  flip?: boolean;
  opacity?: number;
  className?: string;
}) {
  // Hooks first: an early return after a hook would change the hook order.
  const rawId = useId();
  const e = entry(name);
  if (!e) return null;

  const p = project(x, y, z);
  // One factor for both axes: a sprite's floor is 2:1 and scaling x and y by
  // different amounts shears it. The size is the user's choice, not a calculation.
  const u = SPRITE_UNIT * spriteScaleFactor();
  const left = p.x - e.ax * u;
  const top = p.y - e.ay * u;
  const w = e.w * u;
  const h = e.h * u;

  // The SHEET, not the cell. An SVG <image> draws the whole file it is pointed at,
  // so a cell is selected by scaling the sheet up to the atlas's own pixel size and
  // sliding it so the wanted cell lands under a clip window the size of that cell.
  // Sizing the <image> to the cell — which is what this did first — squashes all
  // 793 sprites into every one of them, and the office turns into static.
  const clipId = `sprite-${rawId.replace(/:/g, '')}`;
  const sprite = (
    <>
      <clipPath id={clipId}>
        <rect x={left} y={top} width={w} height={h} />
      </clipPath>
      <image
        href={atlasUrl}
        x={left - e.x * u}
        y={top - e.y * u}
        width={ATLAS.width * u}
        height={ATLAS.height * u}
        opacity={opacity}
        preserveAspectRatio="none"
        clipPath={`url(#${clipId})`}
        className={className}
        style={{ imageRendering: 'pixelated' }}
      />
    </>
  );

  if (!flip) return sprite;
  // Mirror about the sprite's own centre. Mirroring the surrounding group is what
  // turns a name tag and a speech bubble backwards.
  const cx = left + w / 2;
  return <g transform={`translate(${cx} 0) scale(-1 1) translate(${-cx} 0)`}>{sprite}</g>;
}
