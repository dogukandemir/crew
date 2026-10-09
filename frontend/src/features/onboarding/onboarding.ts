/**
 * The first-run card's pure rules (ADR 0013): when it appears, what a key should look
 * like, and where its console is. No React, no network — the card and its tests share
 * these rules.
 */
import type { OnboardingState } from '../../api/types';

const DISMISS_KEY = 'crew.onboarding.dismissed';

export function onboardingDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false; // private mode: the card simply shows again next time
  }
}

export function dismissOnboarding(): void {
  try {
    window.localStorage.setItem(DISMISS_KEY, '1');
  } catch {
    /* private mode — nothing to remember */
  }
}

export function clearOnboardingDismissal(): void {
  try {
    window.localStorage.removeItem(DISMISS_KEY);
  } catch {
    /* private mode */
  }
}

/**
 * Show the card only when it can actually help: the backend is reachable, the runner
 * is live, a provider is missing, the card can offer at least one way to fix that
 * (the picker roster, or the legacy single-provider path), and the user has not
 * skipped it.
 */
export function shouldShowOnboarding(
  state: OnboardingState | undefined,
  dismissed: boolean,
): boolean {
  if (!state) return false;
  if (!state.needed) return false;
  const canAccept = (state.providers?.length ?? 0) > 0 || state.provider !== null;
  if (!canAccept) return false;
  return !dismissed;
}

/** DeepSeek keys start with `sk-`; Ollama's slot carries an address; blanks fail. */
export function keyLooksSane(provider: string, key: string): boolean {
  const k = key.trim();
  if (provider === 'ollama') return k === '' || /^https?:\/\/\S+$/.test(k);
  if (k.length < 8) return false;
  if (provider === 'deepseek' && !k.startsWith('sk-')) return false;
  return true;
}

const CONSOLES: Record<string, string> = {
  deepseek: 'https://platform.deepseek.com/api_keys',
  openai: 'https://platform.openai.com/api-keys',
  anthropic: 'https://console.anthropic.com/settings/keys',
  openrouter: 'https://openrouter.ai/settings/keys',
  ollama: 'https://ollama.com',
};

export function keyConsoleUrl(provider: string): string | null {
  return CONSOLES[provider] ?? null;
}

const LABELS: Record<string, string> = {
  deepseek: 'DeepSeek',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  openrouter: 'OpenRouter',
  ollama: 'Ollama',
};

export function providerLabel(provider: string): string {
  return LABELS[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
}

/** Which tile starts selected: the standard tier's provider, else the first tile. */
export function defaultProvider(state: OnboardingState): string {
  if (state.provider) return state.provider;
  return state.providers?.[0]?.id ?? 'deepseek';
}

/**
 * The save failure a human deserves: the backend's problem `detail` (it says WHY — "the
 * provider rejected this key"), not the transport line ("POST … failed with 400").
 */
export function describeKeyError(err: unknown): string {
  if (err && typeof err === 'object' && 'problem' in err) {
    const p = (err as { problem?: { detail?: string; title?: string } | null }).problem;
    if (p?.detail) return p.detail;
    if (p?.title) return p.title;
  }
  return err instanceof Error ? err.message : String(err);
}
