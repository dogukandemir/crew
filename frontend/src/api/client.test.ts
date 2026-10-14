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


// Review 2026-10-14: approval and control bodies once shipped inside a {"payload": …}
// envelope; every extra="forbid" model rejected them (live 422 on approve). Pin the
// flat shapes so the client can't drift back behind the mock's back.
const ok = (body: unknown = {}) =>
  // fresh Response per call: a consumed body can't be read twice
  vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify(body), { status: 200 })));
/* eslint-disable @typescript-eslint/no-explicit-any */
const sent = (fetcher: any, i = 0) =>
  JSON.parse(String((fetcher.mock.calls[i][1] as RequestInit).body));

it('approval grant/deny send flat ApprovalDecision bodies', async () => {
  const fetcher = ok({ approval_id: 'a1', state: 'granted' });
  vi.stubGlobal('fetch', fetcher);
  await api.grantApproval('a1', 'looks fine', { always: true });
  expect(sent(fetcher)).toEqual({ reason: 'looks fine', always: true });
  await api.denyApproval('a1');
  expect(sent(fetcher, 1)).toEqual({});
});

it('revoking a command allow sends a flat reason body', async () => {
  const fetcher = ok({ allow_id: 'a1', state: 'revoked' });
  vi.stubGlobal('fetch', fetcher);
  await api.revokeCommandAllow('a1', 'no longer needed');
  expect(sent(fetcher)).toEqual({ reason: 'no longer needed' });
});

it('task reassign uses the backend key agent_id', async () => {
  const fetcher = ok();
  vi.stubGlobal('fetch', fetcher);
  await api.reassignTask('t1', 'agent-9');
  expect(sent(fetcher)).toEqual({ agent_id: 'agent-9' });
});

it('run answer/steer send AnswerBody/SteerBody shapes', async () => {
  const fetcher = ok();
  vi.stubGlobal('fetch', fetcher);
  await api.answerRun('r1', ['Yes']);
  expect(sent(fetcher)).toEqual({ answers: ['Yes'], confirm: true });
  await api.steerRun('r1', 'keep going');
  expect(sent(fetcher, 1)).toEqual({ text: 'keep going' });
});

it('brain supersede/promote send flat model fields (promote has no rationale)', async () => {
  const fetcher = ok();
  vi.stubGlobal('fetch', fetcher);
  await api.supersedeEntry('e1', 'e2', 'newer wins');
  expect(sent(fetcher)).toEqual({ new_entry_id: 'e2', reason: 'newer wins' });
  await api.promoteEntry('e1', 'brain-2', 'worthy');
  expect(sent(fetcher, 1)).toEqual({ to_brain_id: 'brain-2' });
});
