import { expect, it } from 'vitest';
import type { Task } from '../api/types';
import { currentWork, latestRunTasks } from './currentWork';

const history = [
  { id: 'old', project_id: 'p', run_id: 'old-run', title: 'Old failure', state: 'failed' },
  { id: 'current', project_id: 'p', run_id: 'new-run', title: 'Fresh work', state: 'running' },
  { id: 'manual', project_id: 'p', run_id: null, title: 'Manual work', state: 'pending' },
] as Task[];

it('old failures cannot override a newer run on the office floor', () => {
  expect(currentWork(history, { latest_run_id: 'new-run', active_run: true }).map(task => task.id)).toEqual(['current', 'manual']);
});
it('a completed run cannot keep characters looking blocked or busy', () => {
  expect(currentWork(history, { latest_run_id: 'new-run', active_run: false }).map(task => task.id)).toEqual(['manual']);
});
it('latest-run progress does not mix completed and failed attempts from history', () => {
  expect(latestRunTasks(history, { latest_run_id: 'new-run' }).map(task => task.id)).toEqual(['current']);
});
it('legacy scenario data remains visible without pretending it has a run identity', () => {
  expect(currentWork(history)).toBe(history);
});
