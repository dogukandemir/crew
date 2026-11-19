// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RunGate } from './RunGate';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  CALLS.length = 0;
});

const CALLS: Array<{ url: string; init?: RequestInit }> = [];

function stubFetch(runs: unknown[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      CALLS.push({ url: u, init });
      let body: unknown = { items: runs };
      if (/\/api\/runs\/r1\/answer$/.test(u)) body = { run_id: 'r1', status: 'running' };
      if (/\/api\/runs\/r1\/cancel$/.test(u)) body = { run_id: 'r1', status: 'aborted' };
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
}

function renderGate() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RunGate projectId="p1" />
    </QueryClientProvider>,
  );
}

const confirmation = {
  id: 'r1',
  project_id: 'p1',
  goal: 'Ship the first release',
  status: 'pending_confirmation',
  stage: 'INTAKE',
  mode: 'autonomous',
  goal_brief: {
    interpretation: 'Ship the first public release',
    success_criteria: ['A verifiable artifact'],
    assumptions: ['The goal text is the requirement'],
  },
  pending_questions: [],
};

it('shows a pending confirmation and answers it once', async () => {
  stubFetch([confirmation]);
  renderGate();

  expect(await screen.findByText('Goal confirmation needed')).toBeTruthy();
  expect(screen.getByText('Ship the first public release')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Approve & continue' }));

  await waitFor(() =>
    expect(CALLS.some((call) => /\/api\/runs\/r1\/answer$/.test(call.url))).toBe(true),
  );
  const call = CALLS.find((entry) => /\/api\/runs\/r1\/answer$/.test(entry.url));
  expect(call?.init?.method).toBe('POST');
  expect(String(call?.init?.body)).toContain('Approved from the control room');
});

it('keeps the gate hidden when no run is waiting', async () => {
  stubFetch([{ ...confirmation, status: 'completed', goal_brief: {} }]);
  renderGate();
  await waitFor(() => expect(CALLS.some((call) => /\/runs$/.test(call.url))).toBe(true));
  expect(screen.queryByText('Goal confirmation needed')).toBeNull();
});
