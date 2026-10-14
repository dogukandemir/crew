// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Project } from '../../api/types';
import { RunSummary } from './RunSummary';

afterEach(cleanup);

const base = { id: 'p1', name: 'P', goal: 'g', status: 'active', kind: 'project' } as unknown as Project;

function renderWith(runStatus: string, nav = vi.fn()) {
  render(<RunSummary project={{ ...base, run_status: runStatus } as Project} navigate={nav} />);
  return nav;
}

it('a failed run points at the task results', () => {
  const nav = renderWith('failed');
  fireEvent.click(screen.getByRole('button', { name: 'Review tasks' }));
  expect(nav).toHaveBeenCalledWith('tasks');
});

it('a completed run points at the deliverables', () => {
  const nav = renderWith('completed');
  fireEvent.click(screen.getByRole('button', { name: 'View deliverables' }));
  expect(nav).toHaveBeenCalledWith('deliverables');
});

it('a paused run points at the overview, paused_budget at settings', () => {
  const nav = renderWith('paused');
  fireEvent.click(screen.getByRole('button', { name: 'Review run' }));
  expect(nav).toHaveBeenCalledWith('overview');
  cleanup();
  const nav2 = renderWith('paused_budget');
  fireEvent.click(screen.getByRole('button', { name: 'Review budget' }));
  expect(nav2).toHaveBeenCalledWith('settings');
});

it('a live run renders no summary banner at all', () => {
  const { container } = render(
    <RunSummary project={{ ...base, run_status: 'running' } as Project} navigate={() => {}} />,
  );
  expect(container.firstChild).toBeNull();
});
