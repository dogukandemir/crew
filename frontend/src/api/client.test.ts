import { afterEach, expect, it, vi } from 'vitest';
import { api } from './client';
afterEach(() => vi.unstubAllGlobals());

it('task filters use the actual REST contract names', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [] }), { status: 200 }));
  vi.stubGlobal('fetch', fetcher);
  await api.listTasks('project', { run: 'current-run', dept: 'team', squad: 'squad', agent: 'worker', state: 'running' });
  const query = new URL(fetcher.mock.calls[0][0]).searchParams;
  expect(Object.fromEntries(query)).toEqual({ run_id: 'current-run', department_id: 'team', squad_id: 'squad', agent_id: 'worker', state: 'running' });
});
it('no filter means no accidental undefined or empty query values', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [] }), { status: 200 }));
  vi.stubGlobal('fetch', fetcher); await api.listTasks('project');
  expect(new URL(fetcher.mock.calls[0][0]).search).toBe('');
});
