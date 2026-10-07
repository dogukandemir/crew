import { describe, expect, it } from 'vitest';
import { signLayout } from './OfficeScene';

/**
 * The board has to contain everything it says. What went wrong: the seats and
 * shipped lines were drawn at the plate's bottom edge with no width of their own,
 * so "3 seats · 2 working · 1 stuck" overhung the board on both sides and its top
 * half was inside the plate while its bottom half was not.
 */
const pulse = (over: Partial<Parameters<typeof signLayout>[1] & object> = {}) =>
  ({ seats: 3, working: 2, blocked: 1, producing: 2, shipped: 1, brandNew: false, ...over }) as Parameters<typeof signLayout>[1];

describe('signLayout — the board and everything on it', () => {
  it('measures the plate by its widest row, name included', () => {
    const l = signLayout({ name: 'Engineering', subtitle: 'Ship the launch' }, pulse());
    for (const row of l.rows) {
      expect(row.text.length * 5 + 26).toBeLessThanOrEqual(l.w);
    }
    expect(l.name.length * 7.4 + 32).toBeLessThanOrEqual(l.w);
    expect(l.w).toBeGreaterThanOrEqual(96);
  });

  it('keeps every row inside the plate, with the last baseline clear of the edge', () => {
    const l = signLayout({ name: 'Growth', subtitle: 'grow the thing' }, pulse());
    const lastBaseline = 28 + (l.rows.length - 1) * 11;
    expect(l.rows.length).toBe(3);
    expect(lastBaseline).toBeLessThan(l.h - 4); // descenders stay on the board
  });

  it('clamps a long status line rather than widening the board forever', () => {
    const l = signLayout({ name: 'Engineering' }, pulse({ lastOutput: { title: 'A remarkably long deliverable name that would never fit' } } as never));
    const shipped = l.rows.find((r) => r.text.startsWith('✓'));
    expect(shipped).toBeDefined();
    expect(shipped!.text.length).toBeLessThanOrEqual(32);
    expect(shipped!.text.endsWith('…')).toBe(true);
  });

  it('clamps a mission and a council question the same way', () => {
    const l = signLayout({ name: 'Meeting room', subtitle: 'Ship the launch now, or fold it into the Q3 campaign?' });
    const sub = l.rows[0];
    expect(sub.text.length).toBeLessThanOrEqual(32);
    expect(sub.text.endsWith('…')).toBe(true);
  });

  it('has no rows when there is nothing to report', () => {
    const l = signLayout({ name: 'Lab' });
    expect(l.rows).toEqual([]);
    expect(l.h).toBe(30);
  });
});
