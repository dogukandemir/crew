// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SettingsPanel } from './SettingsPanel';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const PROJECT = {
  id: 'p1',
  name: 'Launch operations',
  slug: 'launch-operations',
  goal: 'Ship the launch',
  status: 'active',
  kind: 'project',
  budget_cap_micros: 2_500_000,
  spend_micros: 0,
  settings: {
    autonomous_intake: true,
    yolo: true,
    require_goal_confirmation: false,
    require_human_verification: false,
    max_agents: 24,
    max_departments: 6,
    max_senior_ratio: 0.4,
    auto_hire: true,
    layoff_idle_days: 14,
    cadence_enabled: false,
    cadence_max_runs: 3,
    egress_allow: [],
    model_tiers: {},
  },
};

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown) => {
      const u = String(url);
      let body: unknown = { items: [] };
      if (/\/api\/projects\/p1$/.test(u)) body = PROJECT;
      else if (/\/org$/.test(u)) body = { root: { kind: 'org', id: 'root', name: 'Org', children: [] } };
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
}

function renderPanel(qc: QueryClient) {
  return render(
    <QueryClientProvider client={qc}>
      <SettingsPanel projectId="p1" />
    </QueryClientProvider>,
  );
}

const yolo = () => screen.getByRole('switch', { name: 'Full autonomy (YOLO)' });

it('opens the YOLO switch on when the stored settings say yolo true', async () => {
  stubFetch();
  renderPanel(new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  await waitFor(() => expect(yolo().getAttribute('aria-checked')).toBe('true'));
});

it('keeps a user change when the project record is refetched', async () => {
  stubFetch();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  renderPanel(qc);
  await waitFor(() => expect(yolo().getAttribute('aria-checked')).toBe('true'));

  fireEvent.click(yolo());
  expect(yolo().getAttribute('aria-checked')).toBe('false');

  // The record still says yolo true, the owner just turned it off.
  await qc.invalidateQueries({ queryKey: ['project', 'p1'] });
  await waitFor(() => expect(yolo().getAttribute('aria-checked')).toBe('false'));
});
