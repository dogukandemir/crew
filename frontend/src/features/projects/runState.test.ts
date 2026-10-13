import { expect, it } from 'vitest';
import type { Project } from '../../api/types';
import { hasActiveRun, needsResume, runLabel } from './runState';
it('a failed terminal run is not treated as still running', () => {
  expect(hasActiveRun({ stage: 'FAILED' })).toBe(false);
  expect(runLabel({ status: 'active', stage: 'FAILED', run_status: 'failed' } as Project)).toBe('Failed');
});
it('explicit runtime status wins over a stale stored stage', () => {
  expect(hasActiveRun({ stage: 'IDLE', active_run: true })).toBe(true);
  expect(runLabel({ status: 'active', stage: 'IDLE', run_status: 'completed' } as Project)).toBe('Completed');
});
it('a budget-paused run can resume even when its project is still active', () => {
  expect(needsResume({ status: 'active', run_status: 'paused_budget' })).toBe(true);
  expect(needsResume({ status: 'active', run_status: 'running' })).toBe(false);
});
