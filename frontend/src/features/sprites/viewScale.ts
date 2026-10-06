/**
 * How big the sprites are drawn, and which of the offered looks is in force.
 *
 * The first cut mapped a sprite's two axes with two different factors, to make its
 * footprint and its height each match this world's metres. It was arithmetically
 * defensible and visually wrong: a sprite's own floor is 2:1, and scaling x and y
 * by different amounts breaks that, so every desk came out sheared. A sprite has to
 * be drawn with ONE factor — its geometry is not negotiable — and the only real
 * choice is how big that factor is.
 *
 * So this is a choice, not a calculation, and it is the user's to make:
 *
 *   tiled  ×1.00  Every prop covers exactly the tile the simulation gave it. People
 *                 stand on their own desks' tiles. Chunky, because spriteforge's
 *                 metre of height is a metre and a half of this world's.
 *   true   ×0.68  Shrunk until a 1.7 m person is 1.7 m in this world's units, so
 *                 the office reads to scale against its rooms. The props no longer
 *                 fill their tiles.
 *   big    ×1.45  For looking at the art: the same geometry, larger.
 *
 * Kept in a module-level value with a listener set rather than a store: two
 * components read it, nothing else needs to know, and it survives a reload.
 */
import { useEffect, useState } from 'react';

export type SpriteScaleName = 'tiled' | 'true' | 'big';

export const SPRITE_SCALES: { name: SpriteScaleName; factor: number; label: string; hint: string }[] = [
  {
    name: 'tiled',
    factor: 1,
    label: 'Sprite · tiled',
    hint: 'Every sprite covers the tile the simulation gave it. The chunky one.',
  },
  {
    name: 'true',
    factor: 0.68,
    label: 'Sprite · to scale',
    hint: 'Shrunk until a person is 1.7 m against the rooms. Props no longer fill their tiles.',
  },
  { name: 'big', factor: 1.45, label: 'Sprite · large', hint: 'Same geometry, bigger, for reading the art.' },
];

const KEY = 'crew.spriteScale.v2';
/**
 * To scale by default.
 *
 * The atlas desk is drawn two metres across and the simulation's desk is 1.45, so
 * at 1:1 the furniture reads bigger than the rooms it stands in — which is what
 * "still crowded" was. The storage key carries a version because a stored choice
 * must not be silently overridden; a new key is a new question, asked once.
 */
const FALLBACK: SpriteScaleName = 'true';

const read = (): SpriteScaleName => {
  try {
    const v = localStorage.getItem(KEY) as SpriteScaleName | null;
    return v && SPRITE_SCALES.some((s) => s.name === v) ? v : FALLBACK;
  } catch {
    return FALLBACK;
  }
};

let current: SpriteScaleName = read();
const listeners = new Set<() => void>();

/** The factor every sprite multiplies its own scale by. One number, both axes. */
export function spriteScaleFactor(): number {
  return SPRITE_SCALES.find((s) => s.name === current)?.factor ?? 1;
}

export function setSpriteScale(name: SpriteScaleName): void {
  current = name;
  try {
    localStorage.setItem(KEY, name);
  } catch {
    /* a private window is not a reason to break the office */
  }
  for (const l of listeners) l();
}

/** The current choice, and a re-render when it changes. */
export function useSpriteScale(): SpriteScaleName {
  const [, bump] = useState(0);
  useEffect(() => {
    const f = () => bump((n) => n + 1);
    listeners.add(f);
    return () => {
      listeners.delete(f);
    };
  }, []);
  return current;
}
