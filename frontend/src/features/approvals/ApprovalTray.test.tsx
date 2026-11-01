// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Approval } from '../../api/types';
import { ApprovalRow } from './ApprovalTray';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const EGRESS: Approval = {
  id: 'a1',
  project_id: 'p1',
  task_id: 'task-12345678',
  agent_id: 'agent-87654321',
  capability: 'net.fetch',
  state: 'pending',
  created_at: new Date().toISOString(),
  request: {
    kind: 'egress',
    host: 'example.com',
    url: 'https://example.com/pricing',
  },
};

function stubFetch() {
  const calls: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify({ approval_id: 'a1', state: 'granted' }), { status: 200 });
    }),
  );
  return calls;
}

function renderRow(approval: Approval = EGRESS) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ApprovalRow approval={approval} projectId="p1" />
    </QueryClientProvider>,
  );
}

it('renders an egress request as a host card with allow once, always allow and deny', () => {
  stubFetch();
  renderRow();

  expect(screen.getByText('example.com')).toBeTruthy();
  expect(screen.getByText('https://example.com/pricing')).toBeTruthy();
  expect(screen.getByText(/agent agent-87/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Allow once' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Always allow' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Deny' })).toBeTruthy();
  // Always allow is explained: it writes the host into this project's allowlist.
  expect(screen.getByText(/into this project’s egress allowlist/)).toBeTruthy();
});

it('calls the grant endpoint with always true when Always allow is clicked', async () => {
  const calls = stubFetch();
  renderRow();

  fireEvent.click(screen.getByRole('button', { name: 'Always allow' }));

  await waitFor(() => expect(calls.some((c) => /\/api\/approvals\/a1\/grant$/.test(c.url))).toBe(true));
  const grant = calls.find((c) => /\/api\/approvals\/a1\/grant$/.test(c.url));
  expect(grant?.body).toEqual({ always: true });
});
