/**
 * The atlas contract, as the floor renderer depends on it.
 *
 * The renderer names sprites by string, so a typo or a stale atlas is a silently
 * empty office — the worst kind of failure, because everything is "fine". These
 * tests fail loudly instead.
 */
import { describe, expect, it } from 'vitest';
import { ATLAS } from './atlas.gen';
import { SPRITE_UNIT, characterSprite, entry, hasSprite, lookIndex } from './sprites';
import { UNITS_PER_METRE } from '../office/iso';

/** Every prop the floor renderer draws, as it names them. */
const USED = [
  'prop.chair',
  'prop.plant',
  'prop.whiteboard',
  'prop.coffee',
  'prop.vending',
  'prop.foosball',
  'prop.desk',
  'prop.desk.busy',
  'prop.cabinet',
  'prop.roundtable',
];

describe('the sprite atlas', () => {
  it('has every prop the renderer asks for', () => {
    const missing = USED.filter((n) => !hasSprite(n));
    expect(missing).toEqual([]);
  });

  it('has every character cell the renderer can ask for', () => {
    const missing: string[] = [];
    for (let look = 0; look < ATLAS.looks; look += 1) {
      for (const facing of ATLAS.facings) {
        for (const pose of ATLAS.poses) {
          if (!entry(`char.${look}.${facing}.${pose}`)) missing.push(`${look}.${facing}.${pose}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('keeps cells inside the image', () => {
    for (const e of ATLAS.entries) {
      expect(e.x + e.w, e.name).toBeLessThanOrEqual(ATLAS.width);
      expect(e.y + e.h, e.name).toBeLessThanOrEqual(ATLAS.height);
      // The anchor has to be a pixel of the cell, or nothing can be placed at all.
      expect(e.ax, e.name).toBeGreaterThanOrEqual(0);
      expect(e.ax, e.name).toBeLessThan(e.w);
      expect(e.ay, e.name).toBeGreaterThanOrEqual(0);
      expect(e.ay, e.name).toBeLessThan(e.h);
    }
  });

  it('gives an agent the same look every time', () => {
    for (const name of ['ada', 'bo', 'agent-7f3a', 'Nils', '']) {
      expect(lookIndex(name)).toBe(lookIndex(name));
      expect(lookIndex(name)).toBeGreaterThanOrEqual(0);
      expect(lookIndex(name)).toBeLessThan(ATLAS.looks);
    }
    expect(characterSprite('ada', 'front', 'stand')).toMatch(/^char\.\d+\.front\.stand$/);
  });

  it('spreads names over the whole cast', () => {
    const names = Array.from({ length: 64 }, (_, i) => `agent-${i}`);
    const used = new Set(names.map(lookIndex));
    // Not a uniform distribution test — just proof that a handful of names does
    // not all land on the same person.
    expect(used.size).toBeGreaterThan(20);
  });

  it('derives the world scale from the atlas, not from a guess', () => {
    // A 2×1 sprite is 48 pixels wide and 2 metres of floor, so a sprite pixel is
    // this many world units. Getting it wrong puts every prop off its tile.
    expect(SPRITE_UNIT).toBeCloseTo(UNITS_PER_METRE / (ATLAS.world.tilePixels / 2), 6);
    expect(SPRITE_UNIT).toBeGreaterThan(0);
  });
});
