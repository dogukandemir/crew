// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api, setAuthToken } from '../api/client';
import { AuthGate, useSession } from './AuthGate';

afterEach(() => { cleanup(); setAuthToken(undefined); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function Content() {
  const { signOut } = useSession();
  return <><p>Private workspace</p>{signOut && <button onClick={() => void signOut()}>Sign out</button>}</>;
}

async function signedIn() {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ mode: 'token' })));
  vi.stubGlobal('fetch', fetcher);
  vi.spyOn(api, 'login').mockResolvedValue({ access_token: 'session-test' });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><AuthGate><Content /></AuthGate></QueryClientProvider>);
  fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'owner@example.com' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'test-password' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  await screen.findByText('Private workspace');
  client.setQueryData(['private'], { secret: 'cached data' });
  return { client, fetcher };
}

it('revokes the session and clears cached workspace data on sign-out', async () => {
  const { client } = await signedIn();
  const logout = vi.spyOn(api, 'logout').mockResolvedValue(null);
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
  await screen.findByRole('heading', { name: 'Sign in to Crew' });
  expect(logout).toHaveBeenCalledOnce();
  expect(client.getQueryData(['private'])).toBeUndefined();
  expect(screen.queryByText('Private workspace')).toBeNull();
});

it('an authenticated 401 returns to sign-in and clears cached data', async () => {
  const { client, fetcher } = await signedIn();
  fetcher.mockResolvedValue(new Response(JSON.stringify({ detail: 'session expired' }), { status: 401 }));
  await expect(api.me()).rejects.toMatchObject({ status: 401 });
  await screen.findByRole('heading', { name: 'Sign in to Crew' });
  expect(screen.getByRole('alert').textContent).toContain('Your session ended');
  expect(client.getQueryData(['private'])).toBeUndefined();
});

it('a late 401 from an old session does not end a newer session', async () => {
  const { fetcher } = await signedIn();
  let finish!: (value: Response) => void;
  fetcher.mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; }));
  const pending = api.me();
  setAuthToken('newer-session');
  finish(new Response('{}', { status: 401 }));
  await expect(pending).rejects.toMatchObject({ status: 401 });
  await waitFor(() => expect(screen.getByText('Private workspace')).toBeTruthy());
});
