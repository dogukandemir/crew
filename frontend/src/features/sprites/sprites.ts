/**
 * The sprite atlas, as the floor renderer uses it.
 *
 * The atlas is generated in the spriteforge repo (`npx tsx src/atlas.ts`) and
 * copied in as `atlas.png` + `atlas.gen.ts`. It replaces the vector props and the
 * SVG cast with pixel art, and it is deliberately a *fixed cast*: a renderer maps
 * an agent's name onto one of the 64 looks by hash, so the same name is the same
 * person in every session, the way `lookFor` was for the vector figures.
 *
 * ## The one number that matters
 *
 * `SPRITE_UNIT` converts a sprite pixel into world units. It is derived, not
 * chosen: a sprite's footprint of `a × b` tiles is `(a + b) * tilePixels / 2`
 * pixels wide, and the same footprint in this world is `(a + b) * UNITS_PER_METRE`
 * wide — so one sprite pixel is `UNITS_PER_METRE / (tilePixels / 2)`. Get this
 * wrong and every prop lands off its own tile however good the art is.
 *
 * One honest note: spriteforge draws a metre of height as 24 pixels while its
 * floor is 2:1, so a sprite is 1.5× taller relative to this world's own geometry
 * (where a metre up is a metre across). Placing sprites on their exact footprints
 * is worth more than that stretch costs, and everything drawn as a sprite stays
 * consistent with everything else drawn as a sprite.
 */
import { ATLAS, type AtlasEntry } from './atlas.gen';
import { UNITS_PER_METRE } from '../office/iso';

/**
 * World units per sprite pixel. ONE number for both axes, and it has to stay that
 * way: spriteforge draws a metre of floor as 16 px across (the 2:1 tile) and a
 * metre of height as 24 px up, so a sprite's two axes are different world scales.
 * Mapping them with two different factors makes each of them match this world's
 * metres and shears every sprite's own 2:1 floor — which is what "the desks look
 * crooked" was. A sprite's geometry is not negotiable; only its size is, and that
 * is the user's choice in `viewScale.ts`.
 */
export const SPRITE_UNIT = UNITS_PER_METRE / (ATLAS.world.tilePixels / 2);

const BY_NAME = new Map<string, AtlasEntry>(ATLAS.entries.map((e) => [e.name, e]));

/** The atlas cell for a name, or undefined — never a silent substitute. */
export function entry(name: string): AtlasEntry | undefined {
  return BY_NAME.get(name);
}

export function hasSprite(name: string): boolean {
  return BY_NAME.has(name);
}

export type SpriteFacing = (typeof ATLAS.facings)[number];
export type SpritePose = (typeof ATLAS.poses)[number];

/**
 * A stable look index for an agent, 0..looks-1.
 *
 * FNV-1a over the name: deterministic, spreads well over short strings, and needs
 * no state. The same agent keeps the same face across reloads and machines.
 */
export function lookIndex(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i += 1) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % ATLAS.looks;
}

/** The atlas name of a character cell. */
export function characterSprite(name: string, facing: SpriteFacing, pose: SpritePose): string {
  return `char.${lookIndex(name)}.${facing}.${pose}`;
}
