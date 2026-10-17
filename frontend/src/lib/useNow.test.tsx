// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { formatRelativeTime } from './format';
import { useNow } from './useNow';

afterEach(() => {
  vi.useRealTimers();
});

it('moves the age label with real elapsed time', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-17T02:09:00Z'));
  const { result } = renderHook(() => useNow(30_000));

  // A file written at 02:03, first read at 02:09.
  const written = '2026-10-17T02:03:00Z';
  expect(formatRelativeTime(written, result.current)).toBe('6m ago');

  // Twenty minutes of wall clock later the label must not still say 6m: the list
  // is only fetched once, so the clock is what has to keep the age honest.
  act(() => {
    vi.advanceTimersByTime(16 * 60_000);
  });
  expect(formatRelativeTime(written, result.current)).toBe('22m ago');
});
