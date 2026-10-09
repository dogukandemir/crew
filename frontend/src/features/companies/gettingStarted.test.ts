import { describe, expect, it } from 'vitest';
import { allDone, gettingStartedSteps } from './gettingStarted';

describe('gettingStartedSteps', () => {
  it('reads the record honestly when everything is empty', () => {
    const steps = gettingStartedSteps({ providerReady: false, companies: 0, projects: 0, runs: 0 });
    expect(steps.map((s) => s.key)).toEqual(['provider', 'company', 'project', 'run']);
    expect(steps.every((s) => !s.done)).toBe(true);
  });

  it('marks steps done from counts and provider state — never from dismissal', () => {
    const steps = gettingStartedSteps({ providerReady: true, companies: 1, projects: 2, runs: 0 });
    expect(steps.find((s) => s.key === 'provider')?.done).toBe(true);
    expect(steps.find((s) => s.key === 'company')?.done).toBe(true);
    expect(steps.find((s) => s.key === 'project')?.done).toBe(true);
    expect(steps.find((s) => s.key === 'run')?.done).toBe(false);
  });

  it('allDone only when everything is', () => {
    expect(allDone(gettingStartedSteps({ providerReady: true, companies: 1, projects: 1, runs: 3 }))).toBe(true);
    expect(allDone(gettingStartedSteps({ providerReady: true, companies: 1, projects: 1, runs: 0 }))).toBe(false);
  });
});
