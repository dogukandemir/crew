import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, API_BASE, AUTH_EXPIRED_EVENT, setAuthToken } from '../api/client';

const SessionContext = createContext<{ signOut: (() => Promise<void>) | null }>({ signOut: null });
export const useSession = () => useContext(SessionContext);

export function AuthGate({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [tokenMode, setTokenMode] = useState(false);
  const [mode, setMode] = useState<'loading' | 'login' | 'ready' | 'error'>('loading');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`${API_BASE}/api/auth/config`, { signal: controller.signal })
      .then(async r => { if (!r.ok) throw new Error('Cannot reach Crew'); return r.json(); })
      .then(config => { setTokenMode(config.mode !== 'local'); setMode(config.mode === 'local' ? 'ready' : 'login'); })
      .catch(err => { if (!controller.signal.aborted) { setError(String(err)); setMode('error'); } });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    const expired = () => {
      queryClient.clear();
      setPassword('');
      setError('Your session ended. Please sign in again.');
      setMode('login');
    };
    window.addEventListener(AUTH_EXPIRED_EVENT, expired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, expired);
  }, [queryClient]);
  const signOut = async () => {
    await api.logout();
    setAuthToken(undefined);
    queryClient.clear();
    setError('');
    setMode('login');
  };
  if (mode === 'ready') return <SessionContext.Provider value={{ signOut: tokenMode ? signOut : null }}>{children}</SessionContext.Provider>;
  if (mode === 'loading') return <p className="p-8" role="status">Connecting to Crew…</p>;
  if (mode === 'error') return <div className="p-8" role="alert">{error}. Check that the backend is running, then reload.</div>;
  return <main className="mx-auto mt-20 max-w-sm space-y-4 rounded-lg border border-slate-700 p-6">
    <h1 className="text-xl">Sign in to Crew</h1>
    <p className="text-sm text-slate-400">Use the account created by this workspace's operator.</p>
    <form className="space-y-4" onSubmit={async e => {
      e.preventDefault(); setBusy(true); setError('');
      try { const result = await api.login(email, password); setAuthToken(result.access_token); setPassword(''); setMode('ready'); }
      catch (err) { setError(err instanceof Error ? err.message : 'Sign-in failed'); }
      finally { setBusy(false); }
    }}>
      <label className="block">Email<input className="mt-1 block w-full rounded bg-slate-800 p-2" type="email" autoComplete="username" required value={email} onChange={e => setEmail(e.target.value)} /></label>
      <label className="block">Password<input className="mt-1 block w-full rounded bg-slate-800 p-2" type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} /></label>
      {error && <p role="alert">{error}</p>}
      <button className="rounded bg-emerald-700 px-4 py-2" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
    </form>
  </main>;
}
