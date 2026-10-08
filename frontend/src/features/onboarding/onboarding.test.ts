import { describe, expect, it } from 'vitest';
import {
  describeKeyError,
  keyConsoleUrl,
  keyLooksSane,
  providerLabel,
  shouldShowOnboarding,
} from './onboarding';
import type { OnboardingState } from '../../api/types';

const BASE: OnboardingState = {
  needed: true,
  provider: 'deepseek',
  model: 'deepseek/deepseek-flash',
  offline_llm: false,
  vault: 'configured',
};

describe('shouldShowOnboarding', () => {
  it('shows when a key is missing and the user has not skipped', () => {
    expect(shouldShowOnboarding(BASE, false)).toBe(true);
  });
  it('never shows while the state is unknown', () => {
    expect(shouldShowOnboarding(undefined, false)).toBe(false);
  });
  it('never shows when a key is present or the runner is offline', () => {
    expect(shouldShowOnboarding({ ...BASE, needed: false }, false)).toBe(false);
  });
  it('never shows for a provider this card cannot accept', () => {
    expect(shouldShowOnboarding({ ...BASE, provider: null }, false)).toBe(false);
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
  });
});

describe('the console link and label', () => {
  it('maps known providers and stays honest about unknown ones', () => {
    expect(keyConsoleUrl('deepseek')).toContain('platform.deepseek.com');
    expect(keyConsoleUrl('mystery')).toBeNull();
    expect(providerLabel('deepseek')).toBe('DeepSeek');
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
