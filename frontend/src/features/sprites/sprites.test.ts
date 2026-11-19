/**
 * The atlas contract, as the floor renderer depends on it.
 *
 * The renderer names sprites by string, so a typo or a stale atlas is a silently
 * empty office, the worst kind of failure, because everything is "fine". These
 * tests fail loudly instead.
 */
import { describe, expect, it } from 'vitest';
import { ATLAS } from './atlas.gen';
import {
  SPRITE_UNIT,
  categoryCensus,
  categoryOf,
  characterSprite,
  entry,
  hasSprite,
  lookIndex,
  scaleForWidth,
  spriteTiles,
  spriteCentreOffset,
  spriteFootprint,
  spriteWidth,
} from './sprites';
import { SPRITE_SCALES } from './viewScale';
import { UNITS_PER_METRE } from '../office/iso';
import { DESK_TOP_D_M, DESK_TOP_W_M } from '../../sim/floorplan';

/** Every prop the floor renderer draws, as it names them. */
const USED = [
  'prop.chair',
  'prop.chair.turned',
  'prop.plant',
  'prop.whiteboard',
  'prop.coffee',
  'prop.vending',
  'prop.foosball',
  'prop.desk',
  'prop.desk.busy',
  'prop.cabinet',
  'prop.roundtable',
  'prop.table.3',
  'prop.partition.1',
  'prop.labbench',
  'prop.fumehood',
  'prop.microscope',
  'prop.centrifuge',
  'prop.stool',
  'prop.bottleshelf',
  // The room dressing the office and the HQ floor both draw: without these in the
  // list, a regenerated atlas could drop a sofa or a lamp and every renderer would
  // silently draw nothing there.
  'prop.bookshelf',
  'prop.floorlamp',
  'prop.fridge',
  'prop.server',
  'prop.sofa',
  'prop.coffeetable',
  'prop.plant.tall',
  'prop.rug.warm',
  'prop.rug.cool',
  'prop.rug.round',
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
    // Not a uniform distribution test, just proof that a handful of names does
    // not all land on the same person.
    expect(used.size).toBeGreaterThan(20);
  });

  it('measures a metre the same way up as across', () => {
    // THE number this whole layer rests on. A 1 m tile is `tilePixels` px wide and a
    // 1 m height is `heightPixelsPerMetre` px tall; for one uniform pixels→units
    // factor to place floor and height alike, the tile must be exactly twice the
    // height-metre, a tile costs two world metres of screen width, a height-metre
    // costs one.
    //
    // These disagreed (32 against 24) for as long as the atlas existed. The renderer
    // worked around it with a hand-chosen view factor, which is how every prop ended
    // up two thirds the size of the bay it stood in.
    expect(ATLAS.world.tilePixels / 2).toBe(ATLAS.world.heightPixelsPerMetre);
    expect(ATLAS.world.pixelsPerMetre).toBe(ATLAS.world.heightPixelsPerMetre);
    expect(SPRITE_UNIT).toBeCloseTo(UNITS_PER_METRE / ATLAS.world.pixelsPerMetre, 9);
  });

  it('draws a sprite with ONE factor, so its own floor stays 2:1', () => {
    // Two factors, one per axis, is the bug that made every desk look sheared:
    // each axis matched this world's metres, and the sprite's own 2:1 floor did not.
    expect(SPRITE_UNIT).toBeGreaterThan(0);
    const e = entry('prop.desk')!;
    expect(spriteWidth('prop.desk')).toBeCloseTo(e.w * SPRITE_UNIT, 9);
  });

  it('offers the sizes it claims to', () => {
    const names = SPRITE_SCALES.map((s) => s.name);
    expect(names).toEqual(['compact', 'scale', 'large']);
    for (const s of SPRITE_SCALES) {
      expect(s.factor).toBeGreaterThan(0);
      // Nothing offered may shear: one factor per option, applied to both axes.
      expect(Number.isFinite(s.factor)).toBe(true);
    }
    // "To scale" is the atlas's own metre, and the default: the only option at which
    // a person is the height the art says they are.
    expect(SPRITE_SCALES.find((s) => s.name === 'scale')?.factor).toBe(1);
  });

  it('has a sprite family for every category the floor is built from', () => {
    // StarNet's build tools name the parts of a station: room, hallway, surface,
    // prop, belt. This is the census that says which of them the atlas can draw,
    // the question that found the lab benches still being boxes.
    const census = categoryCensus();
    expect(census.character).toBeGreaterThan(0);
    expect(census.shell).toBeGreaterThan(0);
    expect(census.surface).toBeGreaterThan(0);
    expect(census.prop).toBeGreaterThan(0);
    // Belt is the documented gap: the conveyor is drawn as rails and ties in the
    // scene, not as a sprite. If that changes, this is where it gets recorded.
    expect(census.belt).toBe(0);
    expect(Object.values(census).reduce((a, b) => a + b, 0)).toBe(ATLAS.entries.length);
  });

  it('classifies the things the renderer actually uses', () => {
    expect(categoryOf('char.3.front.walkA')).toBe('character');
    expect(categoryOf('prop.partition.1')).toBe('shell');
    expect(categoryOf('prop.desk.busy')).toBe('surface');
    expect(categoryOf('prop.labbench')).toBe('surface');
    expect(categoryOf('prop.table.3')).toBe('surface');
    expect(categoryOf('prop.vending')).toBe('prop');
    expect(categoryOf('nonsense')).toBe('prop');
  });

  it('reports a caller a width to divide by, and a centre to step back from', () => {
    // Scaling a thing by its own width: the caller asks for 100 units and gets them.
    const s = scaleForWidth('prop.whiteboard', 100);
    expect((spriteWidth('prop.whiteboard') ?? 0) * s).toBeCloseTo(100, 6);
    // A caller who knows where the MIDDLE of something is must step back by half a
    // footprint; for a 0.6 m chair that is 0.3 m along each axis. Derived from the
    // cell, whose footprint diamond is rounded to whole pixels, so this is within a
    // few centimetres rather than exact, which is the point: derived, not typed.
    const c = spriteCentreOffset('prop.chair');
    const halfChair = UNITS_PER_METRE * 0.3;
    expect(Math.abs(c.x - halfChair) / halfChair).toBeLessThan(0.05);
    expect(c.y).toBeCloseTo(c.x, 9);
    // An unknown name is not a crash and not a substitution.
    expect(scaleForWidth('prop.nonexistent', 100)).toBe(1);
    expect(spriteCentreOffset('prop.nonexistent')).toEqual({ x: 0, y: 0 });
  });

  it('tiles a prop that has to be longer than its own art, instead of stretching it', () => {
    // The lab bench is 2 m of art. Stretched to 4 m it is 1.7 m TALL, the pale slab
    // the laboratory turned into; tiled it stays a bench at any room width.
    const tile = spriteWidth('prop.labbench')!;
    const run = spriteTiles('prop.labbench', tile * 2.3);
    expect(run.count).toBe(3);
    expect(run.tile).toBeCloseTo(tile, 6);
    expect(run.span).toBeCloseTo(tile * 3, 6);
    // Centred on the run it was asked for, so the overhang is symmetric.
    expect(run.start).toBeCloseTo((tile * 2.3 - tile * 3) / 2, 6);
    // A prop that fits is one tile and is NOT scaled by this path at all.
    expect(spriteTiles('prop.labbench', tile).count).toBe(1);
    expect(spriteTiles('prop.labbench', tile * 0.4).count).toBe(1);
  });
});

describe('the art against the floor plan', () => {
  const ppm = ATLAS.world.pixelsPerMetre;
  /** A sprite cell's width is its footprint's diamond: `(a + b)` tiles, in px. */
  const footprintMetres = (name: string): number => {
    const e = entry(name);
    expect(e, name).toBeDefined();
    return e!.w / ppm;
  };

  it('declares the footprint of its furniture, and the desk fits its bay', () => {
    // The footprint is the art's own claim about itself, and it is what lets the
    // renderer put a chair against the desk's near edge. Read here, it is also the
    // place where the art and the floor plan are held to each other: a desk drawn
    // 2 × 1 in a 1.45 m bay overhangs its neighbours however the plan is tuned.
    const desk = entry('prop.desk')!;
    expect(desk.a).toBeCloseTo(DESK_TOP_W_M, 6);
    expect(desk.b).toBeCloseTo(DESK_TOP_D_M, 6);
    expect(spriteFootprint('prop.desk')).toEqual({
      a: DESK_TOP_W_M * UNITS_PER_METRE,
      b: DESK_TOP_D_M * UNITS_PER_METRE,
    });
    // And it fits: the desk's depth plus its legroom is inside the bay's own depth.
    expect(DESK_TOP_D_M).toBeLessThan(92 / (104 / 1.45));

    const chair = entry('prop.chair')!;
    expect(chair.a).toBeCloseTo(0.6, 6);
    expect(chair.b).toBeCloseTo(0.6, 6);

    // A desk's centre is half its footprint from its anchor, exactly, not nearly.
    expect(spriteCentreOffset('prop.desk').x).toBeCloseTo((DESK_TOP_W_M * UNITS_PER_METRE) / 2, 9);
    expect(spriteCentreOffset('prop.desk').y).toBeCloseTo((DESK_TOP_D_M * UNITS_PER_METRE) / 2, 9);
  });

  it('draws a chair a chair could sit on, and a person taller than it', () => {
    expect(footprintMetres('prop.chair')).toBeCloseTo(1.2, 1);
    const figure = entry('char.0.front.stand')!;
    const metres = figure.h / ppm;
    expect(metres).toBeGreaterThan(1.5);
    expect(metres).toBeLessThan(1.9);
  });

  it('draws the lab bench and the long table at the sizes the rooms ask for', () => {
    expect(footprintMetres('prop.labbench')).toBeCloseTo(2 + 0.7, 1);
    expect(footprintMetres('prop.table.3')).toBeCloseTo(3 + 1, 1);
  });
});
