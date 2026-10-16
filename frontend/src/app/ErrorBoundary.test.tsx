// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ErrorBoundary } from './ErrorBoundary';

/**
 * The boundary is exercised, not assumed. A white screen is the failure this class exists
 * to prevent, so the test has to render a child that genuinely throws during render, in a
 * real DOM, react-dom/server propagates the error instead of rendering the fallback, so
 * this is the only way to prove the catch path.
 */
function Boom(): ReactNode {
  throw new Error('kaboom');
}

describe('ErrorBoundary', () => {
  it('renders its children when nothing is wrong', () => {
    render(
      <ErrorBoundary>
        <span>the office</span>
      </ErrorBoundary>,
    );
    expect(screen.getByText('the office')).toBeTruthy();
  });

  it('shows a recoverable screen, not a blank one, when a child throws', () => {
    // React logs the caught error itself; that noise is expected, not a failure.
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText('This screen hit an error')).toBeTruthy();
    expect(screen.getByText(/kaboom/)).toBeTruthy();
    expect(screen.getByText('Reload')).toBeTruthy();
    expect(screen.getByText('Try again without reloading')).toBeTruthy();
    quiet.mockRestore();
  });
});
