// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { OnboardingState } from '../../api/types';
import { ProviderStatus } from './ProviderStatus';

afterEach(cleanup);
const state: OnboardingState = {
  needed: false, provider: 'deepseek', model: 'deepseek/deepseek-flash', offline_llm: true,
  vault: 'configured', providers: [{ id: 'deepseek', label: 'DeepSeek', configured: true, kind: 'key', placeholder: '', hint: '', console: '' }],
};

it('makes the configured provider visible even while Demo is selected', () => {
  render(<ProviderStatus state={state} />);
  expect(screen.getByText('DeepSeek connected')).toBeTruthy();
  expect(screen.getByTitle(/Demo does not use this provider/)).toBeTruthy();
});

it('does not mistake the Demo needed=false flag for a configured provider', () => {
  render(<ProviderStatus state={{ ...state, providers: [] }} />);
  expect(screen.getByText('DeepSeek not connected')).toBeTruthy();
});

it('distinguishes unavailable status from a missing connection', () => {
  render(<ProviderStatus unavailable />);
  expect(screen.getByText('Provider status unavailable')).toBeTruthy();
});
