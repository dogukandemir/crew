/**
 * How big the sprites are drawn.
 *
 * `SPRITE_UNIT` already puts a sprite at the size the world says it is — the atlas
 * measures a metre with one number for floor and height alike, so a desk is 1.4 m
 * against a 1.45 m bay without anybody adjusting anything. This is therefore not a
 * correction; it is a preference, and it says so:
 *
 *   compact ×0.75  For a wide floor on a small screen: the layout stays legible
 *                  when everything is small.
 *   to scale ×1.00 The atlas's own metre, and the default. A 1.7 m person is
 *                  1.7 m next to the desk, the chair and the door.
 *   large  ×1.5    For looking at the art.
 *
 * The earlier version's default was 0.68, which was not a preference at all: it
 * was the factor that made the figures stop towering over their own desks, and it
 * paid for that by shrinking every prop to two thirds of the bay the simulation
 * had given it. With the atlas measuring itself in one metre, 1.00 is the honest
 * one, and it is the default.
 */
import { useEffect, useState } from 'react';

export type SpriteScaleName = 'compact' | 'scale' | 'large';

export const SPRITE_SCALES: { name: SpriteScaleName; factor: number; label: string; hint: string }[] = [
  {
    name: 'compact',
    factor: 0.75,
    label: 'Sprite · compact',
    hint: 'Everything smaller, for a wide floor on a small screen.',
  },
  {
    name: 'scale',
    factor: 1,
    label: 'Sprite · to scale',
    hint: 'The atlas’s own metre: a 1.7 m person is 1.7 m against the furniture.',
  },
  { name: 'large', factor: 1.5, label: 'Sprite · large', hint: 'Same geometry, bigger, for reading the art.' },
];

/** A new key, because the old one stored a factor that meant something else. */
const KEY = 'crew.spriteScale.v3';
const FALLBACK: SpriteScaleName = 'scale';

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
