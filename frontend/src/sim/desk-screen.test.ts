import { describe, expect, it } from 'vitest';
import { deskInUse, type Target } from './targets';
import type { Activity } from './activity';

/**
 * The flows the user reported, as assertions: a computer that looks busy with
 * nobody at it, and a computer that looks idle under somebody who is working.
 * Both were the same mistake — a screen lit from `activity`, which answers "what
 * is this person doing" and not "is anybody at this desk".
 */
const act = (kind: Activity['kind']): Activity => ({ kind, note: '', where: 'desk' });
const at = (roomId: string, seated?: boolean): Target => ({
  agentId: 'a1',
  roomId,
  point: { x: 0, y: 0 },
  reason: '',
  seated,
});

describe('deskInUse — the machine at a desk and the person at it', () => {
  it('is on while its owner sits here working', () => {
    expect(deskInUse(at('d1', true), act('typing'), 'd1')).toBe(true);
    expect(deskInUse(at('d1', true), act('tool'), 'd1')).toBe(true);
  });

  it('is off while the owner works somewhere else: lab bench, squad mate, another department', () => {
    // At the lab bench: standing, in the lab, not seated at home.
    expect(deskInUse(at('lab', undefined), act('typing'), 'd1')).toBe(false);
    // Paired with a squad mate: beside their desk, on their feet.
    expect(deskInUse(at('d1', undefined), act('typing'), 'd1')).toBe(false);
    // Working on another department's task: standing in that department.
    expect(deskInUse(at('d2', undefined), act('tool'), 'd1')).toBe(false);
    // Seated somewhere that is not home — a break-corner chair.
    expect(deskInUse(at('__break', true), act('typing'), 'd1')).toBe(false);
  });

  it('is off while the owner sits here but is not working', () => {
    expect(deskInUse(at('d1', true), act('thinking'), 'd1')).toBe(false);
    expect(deskInUse(at('d1', true), act('talking'), 'd1')).toBe(false);
    expect(deskInUse(at('d1', true), act('idle'), 'd1')).toBe(false);
    expect(deskInUse(at('d1', true), act('idle'), 'd1')).toBe(false);
  });

  it('is off while its owner is still walking to the seat — a long re-grid walk included', () => {
    // After the floor re-grids, "seated" is true the moment somebody is on their
    // way. The screen must wait for the body, or the chair sits empty under a
    // burning monitor for the whole walk.
    expect(deskInUse(at('d1', true), act('typing'), 'd1', true)).toBe(false);
    expect(deskInUse(at('d1', true), act('tool'), 'd1', true)).toBe(false);
    expect(deskInUse(at('d1', true), act('typing'), 'd1', false)).toBe(true);
  });

  it('is off when there is nobody to work at it', () => {
    expect(deskInUse(undefined, act('typing'), 'd1')).toBe(false);
    expect(deskInUse(at('d1', true), undefined, 'd1')).toBe(false);
    expect(deskInUse(at('d1', true), act('typing'), undefined)).toBe(false);
  });
});
