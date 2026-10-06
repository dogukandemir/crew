import { describe, expect, it } from 'vitest';
import { lookFor, type HairStyle, type TopKind } from './look';
import { POSES } from './poses';
import {
  CHIBI,
  HEAD_FRACTION_FLOOR,
  collarKind,
  dropFor,
  figureFor,
  figureHeight,
  hairKind,
  headFraction,
  lift,
  ankleY,
  shade,
  to2d,
  uniformColour,
} from './svg';

const isHex = (v: string) => /^#[0-9a-f]{6}$/i.test(v);
const IDS = Array.from({ length: 120 }, (_, i) => `01J${i.toString(36)}-svg`);

describe('chibi proportions', () => {
  it('keeps the head dominant, because that is what makes it cute', () => {
    for (const id of IDS) {
      const fig = figureFor(lookFor(id, 'Analyst', 2));
      expect(headFraction(fig), `head too small for ${id}`).toBeGreaterThanOrEqual(HEAD_FRACTION_FLOOR);
    }
  });

  it('damps variation so a floor reads as one cast', () => {
    const heights = IDS.map((id) => figureFor(lookFor(id, 'Analyst', 2)).stature);
    expect(Math.min(...heights)).toBeGreaterThanOrEqual(0.93);
    expect(Math.max(...heights)).toBeLessThanOrEqual(1.06);
    // Short people, by design: no chibi is meaningfully taller than another.
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(0.14);
  });

  it('widens a broad frame without distorting the head', () => {
    const slim = figureFor({ ...lookFor('a', 'x', 1), frame: 'slim' });
    const broad = figureFor({ ...lookFor('a', 'x', 1), frame: 'broad' });
    expect(broad.girth).toBeGreaterThan(slim.girth);
    expect(broad.torsoHalfW).toBeGreaterThan(slim.torsoHalfW);
    // The head is not part of girth.
    expect(broad.headR).toBe(slim.headR);
  });

  it('is deterministic', () => {
    const a = figureFor(lookFor('agent-9', 'Engineer', 3));
    const b = figureFor(lookFor('agent-9', 'Engineer', 3));
    expect(a).toEqual(b);
  });

  it('draws inside its own viewBox', () => {
    for (const id of IDS.slice(0, 40)) {
      const fig = figureFor(lookFor(id, 'Designer', 3));
      expect(figureHeight(fig)).toBeLessThanOrEqual(CHIBI.footY * 1.06 + 0.001);
      expect(fig.headCy - fig.headR).toBeGreaterThan(0);
    }
  });
});

describe('colours', () => {
  it('lifts toward white and shades toward black, in hex', () => {
    expect(lift('#000000', 0.5)).toBe('#808080');
    expect(shade('#ffffff', 0.5)).toBe('#808080');
    expect(isHex(lift('#3b4657', 0.12))).toBe(true);
    expect(isHex(shade('#3b4657', 0.55))).toBe(true);
  });

  it('never fully clips a colour', () => {
    expect(lift('#ffffff', 0.9)).toBe('#ffffff');
    expect(shade('#000000', 0.9)).toBe('#000000');
  });

  it('expands short hex', () => {
    expect(lift('#fff', 0)).toBe('#ffffff');
  });
});

describe('style mapping', () => {
  it('has a hair shape for every hairstyle', () => {
    const styles: HairStyle[] = ['buzz', 'short', 'wave', 'bun', 'ponytail', 'long', 'curly', 'bald'];
    for (const s of styles) expect(hairKind(s)).toBeTruthy();
    expect(hairKind('bald')).toBe('none');
    expect(new Set(styles.map(hairKind)).size).toBe(styles.length);
  });

  it('has a collar shape for every kind of top', () => {
    const tops: TopKind[] = ['tee', 'shirt', 'blouse', 'hoodie', 'blazer', 'labcoat', 'hivis'];
    for (const t of tops) expect(collarKind(t)).toBeTruthy();
  });

  it('treats issued clothing as a fixed colour and personal clothing as not', () => {
    expect(uniformColour('hivis')).toBe('#e8a33d');
    expect(uniformColour('labcoat')).toBe('#eef1f5');
    for (const t of ['tee', 'shirt', 'blouse', 'hoodie', 'blazer'] as TopKind[]) {
      expect(uniformColour(t)).toBeNull();
    }
  });
});

describe('2D projection of the shared poses', () => {
  it('leaves a standing figure on the floor', () => {
    const fig = figureFor(lookFor('a', 'x', 1));
    const p = to2d(POSES.walking, fig);
    expect(p.drop).toBe(0);
    expect(p.seated).toBe(false);
  });

  it('keeps a seated figure on the floor — nobody floats or sinks', () => {
    for (const id of IDS.slice(0, 30)) {
      const fig = figureFor(lookFor(id, 'Engineer', 3));
      const p = to2d(POSES.typing, fig);
      const sole = ankleY(fig, p.thighL, p.kneeL) + fig.shoeH + p.drop;
      expect(sole, `sole off the floor for ${id}`).toBeCloseTo(fig.footY, 6);
    }
  });

  it('drops the hips when sitting and not when standing', () => {
    const fig = figureFor(lookFor('a', 'x', 1));
    expect(to2d(POSES.typing, fig).drop).toBeGreaterThan(4);
    expect(to2d(POSES.celebrating, fig).drop).toBe(0);
  });

  it('folds the thigh instead of leaving it flat, which a billboard cannot show', () => {
    const fig = figureFor(lookFor('a', 'x', 1));
    const seated = to2d(POSES.typing, fig);
    expect(seated.thighL).toBeLessThan(0);
    expect(Math.abs(seated.thighL)).toBeLessThan(80);
    expect(seated.kneeL).toBeGreaterThan(0);
  });

  it('converts radians to degrees for the flat figure', () => {
    const fig = figureFor(lookFor('a', 'x', 1));
    const p = to2d(POSES.walking, fig);
    expect(p.thighL).toBeCloseTo((POSES.walking.hipL * 180) / Math.PI, 6);
    expect(p.lean).toBeCloseTo((POSES.walking.hipPitch * 180) / Math.PI, 6);
  });

  it('gives every activity a usable projection', () => {
    const fig = figureFor(lookFor('a', 'x', 1));
    for (const key of Object.keys(POSES) as (keyof typeof POSES)[]) {
      const p = to2d(POSES[key], fig);
      for (const v of [p.drop, p.lean, p.armL, p.armR, p.thighL, p.kneeL]) {
        expect(Number.isFinite(v), `${key} produced ${v}`).toBe(true);
      }
    }
  });

  it('computes a drop that lands the sole for any fold', () => {
    const fig = figureFor(lookFor('a', 'x', 1));
    for (const [thigh, knee] of [
      [-50, 80],
      [-65, 100],
      [-80, 120],
    ]) {
      const drop = dropFor(fig, thigh, knee);
      expect(ankleY(fig, thigh, knee) + fig.shoeH + drop).toBeCloseTo(fig.footY, 6);
    }
  });
});
