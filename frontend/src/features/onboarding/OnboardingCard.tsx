/**
 * First-run onboarding (ADR 0013): one card, one key.
 *
 * The key is verified by the backend against the provider, stored encrypted in the
 * local vault, and never returned or shown again — so this card asks exactly once.
 * Everything here is deliberately plain: a sentence, an input, a button, a way out.
 */
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { OnboardingState } from '../../api/types';
import { Button } from '../../components/ui/Button';
import { describeKeyError, keyConsoleUrl, keyLooksSane, providerLabel } from './onboarding';

export function OnboardingCard({
  state,
  onDone,
  onSkip,
}: {
  state: OnboardingState;
  onDone: (detail: string) => void;
  onSkip: () => void;
}) {
  const [key, setKey] = useState('');
  const provider = state.provider as string; // the card only renders for a known provider
  const label = providerLabel(provider);
  const consoleUrl = keyConsoleUrl(provider);
  const canSave = keyLooksSane(provider, key);

  const save = useMutation({
    mutationFn: () => api.saveProviderKey(provider, key.trim()),
    onSuccess: (res) => onDone(res.detail),
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/95 p-6"
      role="dialog"
      aria-modal="true"
      aria-label="Set up a model provider"
    >
      <div className="w-full max-w-md rounded-xl border border-slate-700/70 bg-slate-900/80 p-6 shadow-2xl">
        <div className="flex items-center gap-2">
          <span className="text-emerald-400">◈</span>
          <h1 className="text-base font-semibold text-slate-100">Welcome to Crew</h1>
        </div>

        <p className="mt-2 text-sm leading-relaxed text-slate-400">
          The org runs on the model provider <span className="text-slate-200">{label}</span>{' '}
          (<code className="text-[11px] text-slate-300">{state.model}</code>). Paste your API
          key once — it is checked, stored <span className="text-slate-200">encrypted</span> in
          the local vault, and never shown again.
        </p>

        <label className="mt-5 block text-[11px] uppercase tracking-wide text-slate-500">
          {label} API key
        </label>
        <input
          type="password"
          autoFocus
          value={key}
          placeholder="sk-…"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && canSave && !save.isPending) save.mutate();
          }}
          className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-emerald-500/60 focus:outline-none"
        />
        {save.isError && (
          <p className="mt-2 text-xs text-rose-400">{describeKeyError(save.error)}</p>
        )}

        <div className="mt-4 flex items-center justify-between gap-3">
          {consoleUrl ? (
            <a
              href={consoleUrl}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-emerald-300/90 underline decoration-dotted hover:text-emerald-200"
            >
              Get a {label} key →
            </a>
          ) : (
            <span />
          )}
          <Button
            variant="primary"
            size="sm"
            loading={save.isPending}
            disabled={!canSave}
            onClick={() => save.mutate()}
          >
            Save key
          </Button>
        </div>

        <div className="mt-5 border-t border-slate-800 pt-3">
          <p className="text-[11px] leading-relaxed text-slate-500">
            No key yet? You can run everything against a deterministic fake model:{' '}
            <code className="rounded bg-slate-800/80 px-1 text-slate-400">CREW_OFFLINE_LLM=true</code>{' '}
            on the backend, zero spend — or skip and add the key later.
          </p>
          <button
            type="button"
            onClick={onSkip}
            className="mt-2 text-[11px] text-slate-500 underline decoration-dotted hover:text-slate-300"
          >
            Skip for now
          </button>
        </div>
      </div>
    </div>
  );
}
