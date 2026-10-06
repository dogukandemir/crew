import { describe, expect, it } from 'vitest';
import { frameScale, lookFor } from './characters';

/** A spread of ids that look like real agent ids. */
const IDS = Array.from({ length: 240 }, (_, i) => `01J${i.toString(36).padStart(4, '0')}-agent`);

const isHex = (v: string) => /^#[0-9a-f]{6}$/i.test(v);

describe('character generation', () => {
  it('is deterministic — the same agent always looks the same', () => {
    const a = lookFor('agent-7', 'Backend Engineer', 3);
    const b = lookFor('agent-7', 'Backend Engineer', 3);
    expect(a).toEqual(b);
  });

  it('gives different agents different faces', () => {
    const look = lookFor('agent-1', 'Engineer');
    const other = lookFor('agent-2', 'Engineer');
    expect(JSON.stringify(look)).not.toBe(JSON.stringify(other));
  });

  it('produces a visibly varied floor, not a crowd of clones', () => {
    const looks = IDS.map((id) => lookFor(id, 'Analyst', 2));

    const skins = new Set(looks.map((l) => l.skin));
    const styles = new Set(looks.map((l) => l.hair.style));
    const colours = new Set(looks.map((l) => l.hair.color));
    const tops = new Set(looks.map((l) => l.top.color));
    const bottoms = new Set(looks.map((l) => l.bottom.color));
    const frames = new Set(looks.map((l) => l.frame));
    const heights = looks.map((l) => l.height);

    expect(skins.size).toBeGreaterThanOrEqual(6);
    expect(styles.size).toBeGreaterThanOrEqual(6);
    expect(colours.size).toBeGreaterThanOrEqual(8);
    expect(tops.size).toBeGreaterThanOrEqual(10);
    expect(bottoms.size).toBeGreaterThanOrEqual(5);
    expect(frames.size).toBe(3);
    expect(Math.max(...heights) - Math.min(...heights)).toBeGreaterThan(0.1);

    // Most people are not bald, and most people wear a badge.
    expect(looks.filter((l) => l.hair.style === 'bald').length / looks.length).toBeLessThan(0.15);
    expect(looks.filter((l) => l.badge !== null).length / looks.length).toBeGreaterThan(0.85);

    // Skirts and dresses appear, but are not the norm.
    const skirts = looks.filter((l) => l.bottom.kind !== 'trousers').length / looks.length;
    expect(skirts).toBeGreaterThan(0.1);
    expect(skirts).toBeLessThan(0.45);
  });

  it('dresses the job: QA in a lab coat, facilities in hi-vis, support with a headset', () => {
    for (const id of IDS.slice(0, 40)) {
      expect(lookFor(id, 'QA Verifier', 3).top.kind).toBe('labcoat');
      expect(lookFor(id, 'Facilities Ops', 2).top.kind).toBe('hivis');
      const support = lookFor(id, 'Customer Support', 2);
      expect(support.top.kind).toBe('tee');
      expect(support.headset).toBe(true);
    }
  });

  it('applies a uniform rather than a personal colour to issued clothing', () => {
    for (const id of IDS.slice(0, 40)) {
      expect(lookFor(id, 'QA Verifier', 3).top.color).toBe('#eef1f5');
      expect(lookFor(id, 'Security Guard', 2).top.color).toBe('#e8a33d');
    }
  });

  it('never puts an engineer in a hoodie when they are dressed up', () => {
    const eng = IDS.map((id) => lookFor(id, 'Backend Engineer', 2).top.kind);
    expect(eng.every((k) => k === 'hoodie' || k === 'tee' || k === 'blazer' || k === 'shirt' || k === 'blouse')).toBe(true);
    // But seniority really does change the dress code.
    const junior = eng.filter((k) => k === 'hoodie').length;
    expect(junior).toBeGreaterThan(0);
  });

  it('steps the dress code up with seniority', () => {
    const rate = (grade: number) =>
      IDS.map((id) => lookFor(id, 'Analyst', grade).top.kind === 'blazer').filter(Boolean).length / IDS.length;
    expect(rate(5)).toBeGreaterThan(rate(1));
    expect(rate(5)).toBeGreaterThan(0.5);
  });

  it('always emits usable colours', () => {
    for (const id of IDS.slice(0, 60)) {
      const l = lookFor(id, 'Designer', 3);
      expect(isHex(l.skin)).toBe(true);
      expect(isHex(l.hair.color)).toBe(true);
      expect(isHex(l.top.color)).toBe(true);
      expect(isHex(l.bottom.color)).toBe(true);
      expect(isHex(l.shoes)).toBe(true);
      if (l.badge) expect(isHex(l.badge)).toBe(true);
      expect(l.height).toBeGreaterThan(0.9);
      expect(l.height).toBeLessThan(1.1);
    }
  });

  it('scales limbs by frame', () => {
    expect(frameScale('slim')).toBeLessThan(frameScale('average'));
    expect(frameScale('broad')).toBeGreaterThan(frameScale('average'));
  });
});
