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
import atlasUrl from './atlas.png';
import { project } from '../office/iso';
import { SPRITE_UNIT, entry } from './sprites';

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
  const e = entry(name);
  if (!e) return null;

  const p = project(x, y, z);
  const left = p.x - e.ax * SPRITE_UNIT;
  const top = p.y - e.ay * SPRITE_UNIT;
  const w = e.w * SPRITE_UNIT;
  const h = e.h * SPRITE_UNIT;

  const image = (
    <image
      href={atlasUrl}
      x={left}
      y={top}
      width={w}
      height={h}
      opacity={opacity}
      preserveAspectRatio="none"
      className={className}
      style={{ imageRendering: 'pixelated' }}
    />
  );

  if (!flip) return image;
  // Mirror about the sprite's own centre. Mirroring the surrounding group is what
  // turns a name tag and a speech bubble backwards.
  const cx = left + w / 2;
  return <g transform={`translate(${cx} 0) scale(-1 1) translate(${-cx} 0)`}>{image}</g>;
}
