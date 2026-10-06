import { describe, expect, it } from 'vitest';
import {
  budgetFraction,
  formatDuration,
  formatMicros,
  formatMoney,
  formatPercent,
  formatRelativeTime,
  formatTokens,
  formatUsd,
  microsToUsd,
  usdToMicros,
} from './format';

describe('money (micro-USD, docs/11 §1)', () => {
  it('converts micros to USD', () => {
    expect(microsToUsd(1_240_000)).toBeCloseTo(1.24, 10);
    expect(microsToUsd(0)).toBe(0);
    expect(microsToUsd(500_000)).toBeCloseTo(0.5, 10);
  });

  it('treats unknown money as zero rather than NaN', () => {
    expect(microsToUsd(null)).toBe(0);
    expect(microsToUsd(undefined)).toBe(0);
    expect(microsToUsd(Number.NaN)).toBe(0);
    expect(formatMicros(null)).toBe('—');
  });

  it('round-trips USD back to micros', () => {
    expect(usdToMicros(1.24)).toBe(1_240_000);
    expect(usdToMicros(10)).toBe(10_000_000);
    expect(usdToMicros(Number.NaN)).toBe(0);
  });

  it('formats micros as currency', () => {
    expect(formatMicros(1_240_000)).toBe('$1.24');
    expect(formatMicros(0)).toBe('$0.00');
    expect(formatMicros(3_800_000)).toBe('$3.80');
    expect(formatMicros(1_234_500_000)).toBe('$1,234.50');
  });

  it('keeps precision on sub-cent amounts', () => {
    expect(formatMicros(1_240)).toBe('$0.0012');
    expect(formatMicros(500_000)).toBe('$0.50');
  });

  it('formats plain USD and keeps an explicit unknown', () => {
    expect(formatUsd(1.24)).toBe('$1.24');
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(null)).toBe('—');
    expect(formatUsd(1.5, { signed: true })).toBe('+$1.50');
    expect(formatMoney(1_240_000)).toBe('$1.24');
  });

  it('computes the budget fraction, clamped to [0,1]', () => {
    expect(budgetFraction(2_000_000, 10_000_000)).toBeCloseTo(0.2, 10);
    expect(budgetFraction(20_000_000, 10_000_000)).toBe(1);
    expect(budgetFraction(1_000_000, 0)).toBe(0);
  });
});

describe('tokens', () => {
  it('formats raw counts below 1000 verbatim', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
  });

  it('compacts thousands, millions and billions', () => {
    expect(formatTokens(1234)).toBe('1.2k');
    expect(formatTokens(2000)).toBe('2k');
    expect(formatTokens(1_234_567)).toBe('1.2M');
    expect(formatTokens(1_500_000_000)).toBe('1.5B');
  });

  it('handles negatives and unknown', () => {
    expect(formatTokens(-1500)).toBe('-1.5k');
    expect(formatTokens(null)).toBe('—');
    expect(formatTokens(undefined)).toBe('—');
  });
});

describe('percent, duration, relative time', () => {
  it('formats fractions as percentages', () => {
    expect(formatPercent(0.812)).toBe('81%');
    expect(formatPercent(0.5, 1)).toBe('50.0%');
    expect(formatPercent(null)).toBe('—');
  });

  it('formats durations with a unit that fits', () => {
    expect(formatDuration(45)).toBe('45ms');
    expect(formatDuration(1500)).toBe('1.5s');
    expect(formatDuration(125_000)).toBe('2m 5s');
    expect(formatDuration(7_200_000)).toBe('2h 0m');
    expect(formatDuration(null)).toBe('—');
  });

  it('formats relative time against an injected clock', () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    const ago = (ms: number) => formatRelativeTime(new Date(now - ms).toISOString(), now);
    expect(ago(2_000)).toBe('just now');
    expect(ago(12_000)).toBe('12s ago');
    expect(ago(180_000)).toBe('3m ago');
    expect(ago(7_200_000)).toBe('2h ago');
    expect(ago(432_000_000)).toBe('5d ago');
    expect(formatRelativeTime(null, now)).toBe('—');
    expect(formatRelativeTime('not-a-date', now)).toBe('—');
  });
});
