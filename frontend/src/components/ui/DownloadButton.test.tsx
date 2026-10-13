// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AUTH_EXPIRED_EVENT, setAuthToken } from '../../api/client';
import { DownloadButton } from './DownloadButton';

afterEach(() => {
  cleanup();
  setAuthToken(undefined);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function mount() {
  render(<DownloadButton path="/api/artifacts/test/download" filename="result.txt" title="Download this file">↓</DownloadButton>);
  return screen.getByRole('button', { name: 'Download this file' });
}

it('downloads bytes using the session header and releases the temporary URL', async () => {
  setAuthToken('test-download-session');
  const fetcher = vi.fn().mockResolvedValue(new Response('actual file bytes'));
  vi.stubGlobal('fetch', fetcher);
  const create = vi.fn().mockReturnValue('blob:test-download');
  const revoke = vi.fn();
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    expect(this.download).toBe('result.txt');
    expect(this.href).toBe('blob:test-download');
  });
  fireEvent.click(mount());
  await waitFor(() => expect(click).toHaveBeenCalledOnce());
  const [url, options] = fetcher.mock.calls[0];
  expect(url).not.toContain('test-download-session');
  expect(options.headers.Authorization).toBe('Bearer test-download-session');
  expect(await create.mock.calls[0][0].text()).toBe('actual file bytes');
  await waitFor(() => expect(revoke).toHaveBeenCalledWith('blob:test-download'), { timeout: 2000 });
});

it('shows failure and expires a rejected session instead of saving an error document', async () => {
  setAuthToken('expired-download-session');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: 'Session expired' }), { status: 401 })));
  const expired = vi.fn();
  window.addEventListener(AUTH_EXPIRED_EVENT, expired, { once: true });
  fireEvent.click(mount());
  expect((await screen.findByRole('alert')).textContent).toContain('Session expired');
  expect(expired).toHaveBeenCalledOnce();
});

it('blocks repeated clicks while a download is pending', async () => {
  let finish!: (response: Response) => void;
  const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
  vi.stubGlobal('fetch', fetcher);
  const button = mount();
  fireEvent.click(button);
  expect((button as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(button);
  expect(fetcher).toHaveBeenCalledOnce();
  finish(new Response('{}', { status: 410 }));
  await screen.findByRole('alert');
  expect((button as HTMLButtonElement).disabled).toBe(false);
});
