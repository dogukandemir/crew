// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TaskDrawer } from './TaskDrawer';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const TASK = {
  id: 't1',
  run_id: 'r1',
  project_id: 'p1',
  title: 'Review actual product capabilities',
  state: 'running',
  assignee_agent_id: null,
  attempts: 1,
  effort: 'M',
  cost_micros: 120000,
  tokens_in: 100,
  tokens_out: 200,
  acceptance_criteria: ['Lists at least signup and punch flow.'],
  depends_on: [],
  // The real backend ships weighted skill refs (docs/03 §1), an object here once
  // crashed the whole screen ("Objects are not valid as a React child").
  required_skills: [{ skill: 'critical-review', weight: 0.5 }, { skill: 'technical-writing' }],
};

function stubFetch(task: unknown = TASK) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown) => {
      const u = String(url);
      let body: unknown = task;
      if (/\/artifacts$/.test(u)) body = { items: [] };
      else if (/\/org$/.test(u)) body = { root: { kind: 'org', id: 'root', name: 'Org', children: [] } };
      else if (/\/projects\/p1\/tasks$/.test(u)) body = { items: [] };
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
}

function renderDrawer() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TaskDrawer taskId="t1" projectId="p1" onClose={() => {}} />
    </QueryClientProvider>,
  );
}

it('renders weighted skill refs instead of crashing the screen', async () => {
  stubFetch();
  renderDrawer();
  expect(await screen.findByText('critical-review ×0.5')).toBeTruthy();
  expect(screen.getByText('technical-writing')).toBeTruthy();
  expect(screen.getByText('Lists at least signup and punch flow.')).toBeTruthy();
});

it('still renders legacy plain-string skills', async () => {
  stubFetch({ ...TASK, required_skills: ['analytics'] });
  renderDrawer();
  expect(await screen.findByText('analytics')).toBeTruthy();
});

it('renders reward rows even when a payload omits the id, no key warning', async () => {
  // The live console showed "Each child in a list should have a unique key prop"
  // because reward rows shipped {agent_id, role, reward} without their id.
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  stubFetch({
    ...TASK,
    rewards: [
      { agent_id: 'a1', role_in_task: 'producer', reward: -0.261, components: { quality: 0.1 } },
      { agent_id: 'a2', role_in_task: 'verifier', reward: -0.056 },
    ],
  });
  renderDrawer();
  expect(await screen.findByText('producer')).toBeTruthy();
  expect(screen.getByText('verifier')).toBeTruthy();
  const keyWarnings = spy.mock.calls.filter((c) => String(c[0]).includes('unique "key" prop'));
  expect(keyWarnings.length).toBe(0);
});
