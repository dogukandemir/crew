// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SettingsPanel } from './SettingsPanel';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  CALLS.length = 0;
});

const CALLS: Array<{ url: string; init?: RequestInit }> = [];

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

function stubFetch(project: unknown = PROJECT) {
  CALLS.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      CALLS.push({ url: u, init });
      let body: unknown = { items: [] };
      if (/\/api\/projects\/p1$/.test(u)) body = project;
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
const presetChip = (name: string) => screen.getByRole('button', { name });

/** The catalogue the backend serves with the project payload. */
const PRESET_CATALOGUE = {
  available: {
    docs: ['python.org', 'developer.mozilla.org', 'docs.python.org', 'readthedocs.io'],
    research: ['arxiv.org', 'wikipedia.org', 'nature.com'],
    news: ['reuters.com', 'apnews.com', 'bbc.com', 'techcrunch.com'],
    shopping: ['amazon.com', 'etsy.com', 'aliexpress.com'],
    code: ['github.com', 'raw.githubusercontent.com', 'pypi.org', 'stackoverflow.com'],
  },
  selected: ['docs'],
};

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

it('renders the stored egress preset selected and saves a second one alongside it', async () => {
  stubFetch({
    ...PROJECT,
    settings: { ...PROJECT.settings, egress_presets: ['docs'] },
    egress_presets: PRESET_CATALOGUE,
  });
  renderPanel(new QueryClient({ defaultOptions: { queries: { retry: false } } }));

  const docs = await waitFor(() => presetChip('docs'));
  expect(docs.getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByText(/opens python\.org, developer\.mozilla\.org/)).toBeTruthy();

  const research = presetChip('research');
  expect(research.getAttribute('aria-pressed')).toBe('false');
  fireEvent.click(research);
  expect(research.getAttribute('aria-pressed')).toBe('true');

  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(CALLS.some((c) => c.init?.method === 'PATCH')).toBe(true));

  const patchCall = CALLS.find((c) => c.init?.method === 'PATCH');
  const body = JSON.parse(String(patchCall?.init?.body)) as { settings: { egress_presets: string[] } };
  expect(body.settings.egress_presets).toEqual(['docs', 'research']);
});

it('still renders the presets control when the backend publishes no catalogue', async () => {
  stubFetch();
  renderPanel(new QueryClient({ defaultOptions: { queries: { retry: false } } }));

  const docs = await waitFor(() => presetChip('docs'));
  expect(docs.getAttribute('aria-pressed')).toBe('false');
  // No catalogue means no invented host list, the control says so instead.
  expect(docs.getAttribute('title')).toBe('host list not published by this backend');
  expect(screen.getByText(/granted from the approvals tray/)).toBeTruthy();
});
