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
 * is live, a key is missing, the missing key is one this card can take, and the user
 * has not skipped it.
 */
export function shouldShowOnboarding(
  state: OnboardingState | undefined,
  dismissed: boolean,
): boolean {
  if (!state) return false;
  if (!state.needed) return false;
  if (state.provider === null) return false;
  return !dismissed;
}

/** DeepSeek keys start with `sk-`; anything blank is a mistake we can stop early. */
export function keyLooksSane(provider: string, key: string): boolean {
  const k = key.trim();
  if (k.length < 8) return false;
  if (provider === 'deepseek' && !k.startsWith('sk-')) return false;
  return true;
}

const CONSOLES: Record<string, string> = {
  deepseek: 'https://platform.deepseek.com/api_keys',
  openai: 'https://platform.openai.com/api-keys',
  anthropic: 'https://console.anthropic.com/settings/keys',
};

export function keyConsoleUrl(provider: string): string | null {
  return CONSOLES[provider] ?? null;
}

const LABELS: Record<string, string> = {
  deepseek: 'DeepSeek',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
};

export function providerLabel(provider: string): string {
  return LABELS[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
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
