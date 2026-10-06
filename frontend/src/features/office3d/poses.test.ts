import { describe, expect, it } from 'vitest';
import { ACTIVITY_ORDER, type ActivityKind } from '../../sim/activity';
import { POSES, blendPose, motionOffset, poseForContext } from './poses';

describe('pose table', () => {
  it('has a pose for every activity an agent can be in', () => {
    for (const kind of ACTIVITY_ORDER) {
      expect(POSES[kind], `no pose for ${kind}`).toBeDefined();
    }
  });

  it('sits at a desk and stands on a floor', () => {
    expect(POSES.typing.seated).toBe(true);
    expect(POSES.thinking.seated).toBe(true);
    expect(POSES.walking.seated).toBe(false);
    expect(POSES.celebrating.seated).toBe(false);
  });

  it('drops the hips and bends the knees when seated', () => {
    expect(POSES.typing.hipY).toBeLessThan(POSES.walking.hipY);
    expect(POSES.typing.kneeL).toBeGreaterThan(0.5);
    // Standing is a straight leg.
    expect(Math.abs(POSES.walking.kneeL)).toBeLessThan(0.3);
  });

  it('reaches forward to the desk when typing', () => {
    // A negative shoulder rotation swings the arm forward, towards the keyboard.
    expect(POSES.typing.armL[0]).toBeLessThan(-0.6);
    expect(POSES.typing.armR[0]).toBeLessThan(-0.6);
    expect(POSES.typing.typing).toBe(1);
  });

  it('raises both arms to celebrate', () => {
    expect(POSES.celebrating.armL[0]).toBeLessThan(-2);
    expect(POSES.celebrating.armR[0]).toBeLessThan(-2);
  });

  it('stands a body up when it is not at its own desk', () => {
    expect(poseForContext('typing', true).seated).toBe(true);
    expect(poseForContext('typing', false).seated).toBe(false);
    // Walking wins even at a desk.
    expect(poseForContext('walking', true).seated).toBe(false);
  });
});

describe('pose blending', () => {
  it('returns the start pose at 0 and the target at 1', () => {
    const from = POSES.idle;
    const to = POSES.celebrating;
    expect(blendPose(from, to, 0)).toEqual(from);
    expect(blendPose(from, to, 1)).toEqual(to);
  });

  it('meets in the middle', () => {
    const from = POSES.idle;
    const to = POSES.celebrating;
    const mid = blendPose(from, to, 0.5);
    expect(mid.hipY).toBeCloseTo((from.hipY + to.hipY) / 2, 6);
    expect(mid.armL[0]).toBeCloseTo((from.armL[0] + to.armL[0]) / 2, 6);
  });

  it('never sits and stands at the same time', () => {
    const sitting = blendPose(POSES.walking, POSES.typing, 0.49);
    const standing = blendPose(POSES.walking, POSES.typing, 0.51);
    expect(sitting.seated).toBe(false);
    expect(standing.seated).toBe(true);
  });

  it('treats out-of-range t as the ends', () => {
    expect(blendPose(POSES.idle, POSES.celebrating, -4)).toEqual(POSES.idle);
    expect(blendPose(POSES.idle, POSES.celebrating, 9)).toEqual(POSES.celebrating);
  });
});

describe('motion offsets', () => {
  const phases = Array.from({ length: 24 }, (_, i) => i * 0.26);

  it('swings the legs in antiphase while walking', () => {
    const at = motionOffset(POSES.walking, 0.9);
    expect(Math.sign(at.hipL) * Math.sign(at.hipR)).toBeLessThanOrEqual(0);
  });

  it('only ever bends knees backwards, never forwards', () => {
    for (const phase of phases) {
      const off = motionOffset(POSES.walking, phase);
      expect(off.kneeL, `kneeL at ${phase}`).toBeGreaterThanOrEqual(0);
      expect(off.kneeR, `kneeR at ${phase}`).toBeGreaterThanOrEqual(0);
    }
  });

  it('keeps a walking body within human-looking limits', () => {
    for (const phase of phases) {
      const off = motionOffset(POSES.walking, phase);
      expect(Math.abs(off.hipL)).toBeLessThan(0.6);
      expect(Math.abs(off.armL[0])).toBeLessThan(0.6);
      expect(Math.abs(off.hipY)).toBeLessThan(0.06);
    }
  });

  it('leaves a seated idle body almost still', () => {
    for (const phase of phases) {
      const off = motionOffset(POSES.idle, phase);
      expect(Math.abs(off.hipL)).toBeLessThan(0.001);
      expect(Math.abs(off.armL[0])).toBeLessThan(0.01);
      expect(Math.abs(off.hipY)).toBeLessThan(0.02);
    }
  });

  it('does not make one arm follow the other while walking', () => {
    const off = motionOffset(POSES.walking, 0.9);
    expect(Math.sign(off.armL[0]) * Math.sign(off.armR[0])).toBeLessThanOrEqual(0);
  });

  it('is defined for every activity', () => {
    for (const kind of ACTIVITY_ORDER as ActivityKind[]) {
      const off = motionOffset(POSES[kind], 1.7);
      expect(Number.isFinite(off.hipY)).toBe(true);
      expect(Number.isFinite(off.armL[0])).toBe(true);
    }
  });
});
