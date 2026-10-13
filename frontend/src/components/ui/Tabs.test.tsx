// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TabBar } from './Tabs';
afterEach(cleanup);

it('has one tab stop and supports arrow, Home and End navigation', () => {
  const change = vi.fn();
  render(<TabBar tabs={[{ id: 'office', label: 'Office' }, { id: 'tasks', label: 'Tasks' }, { id: 'files', label: 'Files' }]}
    value="office" onChange={change} />);
  const [office, tasks, files] = screen.getAllByRole('tab');
  expect(office.tabIndex).toBe(0); expect(tasks.tabIndex).toBe(-1);
  fireEvent.keyDown(office, { key: 'ArrowRight' });
  expect(change).toHaveBeenLastCalledWith('tasks'); expect(document.activeElement).toBe(tasks);
  fireEvent.keyDown(tasks, { key: 'End' }); expect(document.activeElement).toBe(files);
  fireEvent.keyDown(files, { key: 'Home' }); expect(document.activeElement).toBe(office);
  fireEvent.keyDown(office, { key: 'ArrowLeft' }); expect(document.activeElement).toBe(files);
});
