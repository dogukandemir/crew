/**
 * First-run onboarding (ADR 0013, revision): pick a provider, hand over the key once.
 *
 * A row of brand tiles, DeepSeek, OpenAI, Anthropic, OpenRouter, and LOCAL Ollama,
 * then exactly one input and one button. The key is verified by the backend against
 * the provider, stored encrypted in the local vault, and never returned or shown
 * again. Ollama's tile is deliberately the odd one: it is the machine's own server
 * (no key, zero spend, the slot carries its address), cloud-hosted Ollama models
 * ride through OpenRouter, so there is no separate cloud tile to confuse the local one.
 */
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useDialogFocus } from '../../components/ui/useDialogFocus';
import { useMutation } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { OnboardingProvider, OnboardingState } from '../../api/types';
import { Button } from '../../components/ui/Button';
import { cn } from '../../lib/cn';
import {
  defaultProvider,
  describeKeyError,
  keyConsoleUrl,
  keyLooksSane,
  providerLabel,
} from './onboarding';
import {
  AnthropicLogo,
  DeepSeekLogo,
  OllamaLogo,
  OpenAILogo,
  OpenRouterLogo,
} from './providerLogos';

const LOGOS: Record<string, (p: { className?: string }) => React.ReactElement> = {
  deepseek: DeepSeekLogo,
  openai: OpenAILogo,
  anthropic: AnthropicLogo,
  openrouter: OpenRouterLogo,
  ollama: OllamaLogo,
};

/** Older backends have no roster: degrade to a single tile for the tier's provider. */
function pickerRoster(state: OnboardingState): OnboardingProvider[] {
  if (state.providers && state.providers.length > 0) return state.providers;
  if (!state.provider) return [];
  return [
    {
      id: state.provider,
      label: providerLabel(state.provider),
      kind: 'key',
      placeholder: 'sk-…',
      hint: '',
      console: keyConsoleUrl(state.provider) ?? '',
      configured: false,
    },
  ];
}

export function OnboardingCard({
  state,
  onDone,
  onSkip,
}: {
  state: OnboardingState;
  onDone: (detail: string) => void;
  onSkip: () => void;
}) {
  const dialogRef = useDialogFocus(true, onSkip);
  const roster = pickerRoster(state);
  const [selectedId, setSelectedId] = useState(() => defaultProvider(state));
  const selected = roster.find((p) => p.id === selectedId) ?? roster[0];
  const [values, setValues] = useState<Record<string, string>>({});
  const value = values[selected?.id ?? ''] ?? '';
  const isLocal = selected?.kind === 'local';
  const canSave =
    selected !== undefined && keyLooksSane(selected.id, isLocal && !value.trim() ? '' : value);

  const save = useMutation({
    mutationFn: () => api.saveProviderKey(selected?.id ?? '', value.trim()),
    onSuccess: (res) => onDone(res.detail),
  });

  const consoleUrl = selected ? keyConsoleUrl(selected.id) : null;

  return createPortal(
    <div
      ref={dialogRef}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/95 p-6"
      role="dialog"
      aria-modal="true"
      aria-label="Set up a model provider"
    >
      <div className="my-auto w-full max-w-lg rounded-xl border border-slate-700/70 bg-slate-900/80 p-6 shadow-2xl">
        <div className="flex items-center gap-2">
          <span className="text-emerald-400">◈</span>
          <h1 className="text-base font-semibold text-slate-100">Welcome to Crew</h1>
        </div>

        <p className="mt-2 text-sm leading-relaxed text-slate-400">
          Pick the model provider this org runs on. The key is checked, stored{' '}
          <span className="text-slate-200">encrypted</span> in the local vault, and never shown
          again. The choice points every model tier at that provider.
        </p>

        <div className="mt-4 grid grid-cols-5 gap-1.5" role="group" aria-label="Model provider">
          {roster.map((p) => {
            const Logo = LOGOS[p.id];
            const active = p.id === selected?.id;
            return (
              <button
                key={p.id}
                type="button"
                aria-pressed={active}
                onClick={() => setSelectedId(p.id)}
                className={cn(
                  'relative flex flex-col items-center gap-1.5 rounded-lg border px-1 py-2.5 transition-colors',
                  active
                    ? 'border-emerald-400/70 bg-emerald-950/30'
                    : 'border-slate-700/60 bg-slate-900/40 hover:border-slate-500/70',
                )}
              >
                {Logo ? <Logo className="h-7 w-7" /> : <span className="h-7 w-7" />}
                <span className="w-full truncate text-center text-[10px] text-slate-300">{p.label}</span>
                {p.configured && (
                  <span className="text-[9px] font-medium text-emerald-300">Configured</span>
                )}
              </button>
            );
          })}
        </div>

        {selected && (
          <>
            {selected.hint && <p className="mt-3 text-[11px] text-slate-500">{selected.hint}</p>}
            {selected.configured && <p role="status" className="mt-3 rounded border border-emerald-800 bg-emerald-950/30 p-3 text-xs text-emerald-200">
              {selected.label} is configured{state.provider === selected.id ? ' and selected for your agents' : ''}.
              {isLocal ? ' Reconnect only to change the server address.' : ' Your saved key stays hidden. Enter a new key only to replace it.'}
            </p>}

            <label htmlFor="provider-key" className="mt-3 block text-[11px] uppercase tracking-wide text-slate-500">
              {isLocal ? 'Ollama base URL' : `${selected.label} API key`}
            </label>
            <input
              id="provider-key"
              type={isLocal ? 'text' : 'password'}
              autoFocus
              value={value}
              placeholder={selected.placeholder}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setValues((v) => ({ ...v, [selected.id]: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSave && !save.isPending) save.mutate();
              }}
              className={cn(
                'mt-1 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-emerald-500/60 focus:outline-none',
                isLocal && 'font-mono text-xs',
              )}
            />
            {isLocal && (
              <p className="mt-1.5 text-[11px] text-slate-500">
                Model requests go to your Ollama server. Enabled web tools can still access the internet.
              </p>
            )}
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
                  {isLocal ? 'Install Ollama →' : `Get your ${selected.label} key →`}
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
                {isLocal ? 'Connect' : selected.configured ? 'Replace key' : 'Save key'}
              </Button>
            </div>
          </>
        )}

        <div className="mt-5 border-t border-slate-800 pt-3">
          <p className="text-[11px] leading-relaxed text-slate-500">
            Saving a provider keeps your current execution mode. Use the Demo / Live control on the welcome screen when ready.
          </p>
          <button
            type="button"
            onClick={onSkip}
            className="mt-2 text-[11px] text-slate-500 underline decoration-dotted hover:text-slate-300"
          >
            {roster.some(p => p.id === state.provider && p.configured) ? 'Done' : 'Skip for now'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
