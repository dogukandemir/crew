import { describe, expect, it } from 'vitest';
import {
  defaultProvider,
  describeKeyError,
  keyConsoleUrl,
  keyLooksSane,
  providerLabel,
  shouldShowOnboarding,
} from './onboarding';
import type { OnboardingProvider, OnboardingState } from '../../api/types';

const ROSTER: OnboardingProvider[] = [
  { id: 'deepseek', label: 'DeepSeek', kind: 'key', placeholder: 'sk-…', hint: '', console: '', configured: false },
  { id: 'openai', label: 'OpenAI', kind: 'key', placeholder: 'sk-…', hint: '', console: '', configured: false },
  { id: 'anthropic', label: 'Anthropic', kind: 'key', placeholder: 'sk-ant-…', hint: '', console: '', configured: false },
  { id: 'openrouter', label: 'OpenRouter', kind: 'key', placeholder: 'sk-or-…', hint: '', console: '', configured: false },
  { id: 'ollama', label: 'Ollama', kind: 'local', placeholder: 'http://localhost:11434', hint: '', console: '', configured: false },
];

const BASE: OnboardingState = {
  needed: true,
  provider: 'deepseek',
  model: 'deepseek/deepseek-flash',
  offline_llm: false,
  vault: 'configured',
  providers: ROSTER,
};

describe('shouldShowOnboarding', () => {
  it('shows when a provider is missing and the user has not skipped', () => {
    expect(shouldShowOnboarding(BASE, false)).toBe(true);
  });
  it('never shows while the state is unknown', () => {
    expect(shouldShowOnboarding(undefined, false)).toBe(false);
  });
  it('never shows when a provider is present or the runner is offline', () => {
    expect(shouldShowOnboarding({ ...BASE, needed: false }, false)).toBe(false);
  });
  it('shows for the picker even when the standard tier points at a strange provider', () => {
    expect(shouldShowOnboarding({ ...BASE, provider: null }, false)).toBe(true);
  });
  it('never shows when there is nothing the card could accept', () => {
    expect(shouldShowOnboarding({ ...BASE, provider: null, providers: [] }, false)).toBe(false);
    expect(shouldShowOnboarding({ ...BASE, provider: null, providers: undefined }, false)).toBe(false);
  });
  it('respects the skip', () => {
    expect(shouldShowOnboarding(BASE, true)).toBe(false);
  });
});

describe('keyLooksSane', () => {
  it('wants a DeepSeek key to start with sk-', () => {
    expect(keyLooksSane('deepseek', 'sk-abc12345')).toBe(true);
    expect(keyLooksSane('deepseek', 'abc12345')).toBe(false);
    expect(keyLooksSane('deepseek', 'sk-')).toBe(false);
  });
  it('accepts any non-trivial key for other providers', () => {
    expect(keyLooksSane('openai', 'anything-long-enough')).toBe(true);
    expect(keyLooksSane('openrouter', 'sk-or-abc123')).toBe(true);
  });
  it('treats the Ollama slot as an address, with the default allowed', () => {
    expect(keyLooksSane('ollama', '')).toBe(true); // the backend defaults it
    expect(keyLooksSane('ollama', 'http://localhost:11434')).toBe(true);
    expect(keyLooksSane('ollama', 'https://box.local:11434')).toBe(true);
    expect(keyLooksSane('ollama', 'localhost:11434')).toBe(false); // needs a scheme
  });
});

describe('the console link and label', () => {
  it('maps known providers and stays honest about unknown ones', () => {
    expect(keyConsoleUrl('deepseek')).toContain('platform.deepseek.com');
    expect(keyConsoleUrl('openrouter')).toContain('openrouter.ai');
    expect(keyConsoleUrl('mystery')).toBeNull();
    expect(providerLabel('deepseek')).toBe('DeepSeek');
    expect(providerLabel('ollama')).toBe('Ollama');
  });
});

describe('defaultProvider', () => {
  it('starts on the standard tier\'s provider', () => {
    expect(defaultProvider(BASE)).toBe('deepseek');
    expect(defaultProvider({ ...BASE, provider: 'openrouter' })).toBe('openrouter');
  });
  it('falls back to the first tile, then to deepseek', () => {
    expect(defaultProvider({ ...BASE, provider: null })).toBe('deepseek');
    expect(defaultProvider({ ...BASE, provider: null, providers: [] })).toBe('deepseek');
  });
});

describe('describeKeyError', () => {
  it('prefers the problem detail over the transport line', () => {
    expect(describeKeyError({ problem: { detail: 'the provider rejected this key' } }))
      .toBe('the provider rejected this key');
  });
  it('falls back to the error message, then to the raw value', () => {
    expect(describeKeyError(new Error('boom'))).toBe('boom');
    expect(describeKeyError('weird')).toBe('weird');
  });
});
