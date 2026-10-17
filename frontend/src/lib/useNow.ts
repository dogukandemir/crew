import { useEffect, useState } from 'react';

/**
 * A clock that re-renders its caller on a fixed interval.
 *
 * Relative labels ("6m ago") are computed from `Date.now()` at render time, so a
 * panel that never re-renders keeps the age it was first painted with: a file
 * written twenty minutes ago still reads "6m ago" an hour later. A surface that
 * prints an age reads this instead of calling `Date.now()` in render, and the
 * label moves with real elapsed time.
 */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
