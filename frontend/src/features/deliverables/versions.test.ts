import { expect, it } from 'vitest';
import type { DeliverableRow } from '../../api/types';
import { latestFiles } from './versions';
const row = (id: string, project: string, time: string) => ({ id, project_id: project, kind: 'file', name: 'README.md', created_at: time }) as DeliverableRow;

it('chooses the newest publication even if incoming rows are not sorted', () => {
  expect(latestFiles([row('old', 'p', '2026-10-10'), row('new', 'p', '2026-10-13')]).map(file => file.id)).toEqual(['new']);
});
it('keeps distinct projects and kinds separate when filenames match', () => {
  const rows = [row('one', 'p1', '2026-10-13'), row('two', 'p2', '2026-10-13'), { ...row('report', 'p1', '2026-10-13'), kind: 'report' }];
  expect(latestFiles(rows)).toHaveLength(3);
});
