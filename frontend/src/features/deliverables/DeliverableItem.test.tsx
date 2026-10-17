// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { DeliverableRow } from '../../api/types';
import { DeliverableItem } from './DeliverablesPanel';

afterEach(cleanup);

const ROW: DeliverableRow = {
  id: 'a1',
  name: 'support_playbook.md',
  path: 'artifacts/a1/support_playbook.md',
  mime: 'text/plain',
  kind: 'file',
  bytes: 4200,
  sha256: 'f'.repeat(64),
  created_at: '2026-10-17T02:03:00+00:00',
  agent_id: 'ag1',
  agent_name: 'Meera Bose',
  department_id: null,
  department_name: null,
  task_id: null,
  task_title: null,
  project_id: 'p1',
  project_name: null,
};

it('keeps the existing behaviour for a row that does not carry the field', () => {
  const onOpen = vi.fn();
  render(<DeliverableItem row={ROW} isCompany={false} onOpen={onOpen} />);
  const open = screen.getByRole('button', { name: /support_playbook\.md/ }) as HTMLButtonElement;
  expect(open.disabled).toBe(false);
  fireEvent.click(open);
  expect(onOpen).toHaveBeenCalledTimes(1);
  expect(screen.queryByText('no longer stored')).toBeNull();
});

it('renders a superseded copy disabled, with a note, and never opens it', () => {
  const onOpen = vi.fn();
  render(
    <DeliverableItem row={{ ...ROW, available: false }} isCompany={false} onOpen={onOpen} />,
  );
  const open = screen.getByRole('button', { name: /support_playbook\.md/ }) as HTMLButtonElement;
  expect(open.disabled).toBe(true);
  fireEvent.click(open);
  expect(onOpen).not.toHaveBeenCalled();
  expect(screen.getByText('no longer stored')).toBeTruthy();
  // A file that is gone must not offer a download either.
  expect(screen.queryByTitle('Download this file')).toBeNull();
});

it('prints the age against the clock it is given', () => {
  // Written 02:03 UTC, looked at 02:25 UTC, the row must read 22m, not the age
  // it happened to be painted with the first time the list rendered.
  const now = Date.parse('2026-10-17T02:25:00Z');
  render(<DeliverableItem row={ROW} isCompany={false} now={now} onOpen={() => {}} />);
  expect(screen.getByText('22m ago')).toBeTruthy();
});
