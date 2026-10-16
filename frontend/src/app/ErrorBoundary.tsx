import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * The last line of defence for the whole app.
 *
 * There was none: any render error anywhere took the entire screen to white, including
 * the controls somebody would need to get out of it. A boundary cannot stop the bug, but
 * it turns "the app is gone" into "this screen broke, here is what it said".
 *
 * It catches render, constructor and lifecycle errors in the tree below it. It does NOT
 * catch work that happens later, promises, event handlers, the office's animation loop,
 * which each need their own handling; the API client already classifies its own failures.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null; info: ErrorInfo | null }> {
  override state: { error: Error | null; info: ErrorInfo | null } = { error: null, info: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Leave the evidence where a bug report can find it. Guarded because this must not be
    // the thing that throws when the app is already broken (or under a renderer, as in
    // the test that exercises this class).
    if (typeof window !== 'undefined') {
      (window as unknown as { __crewError?: unknown }).__crewError = {
        message: String(error?.message ?? error),
        stack: String(error?.stack ?? ''),
        componentStack: info.componentStack ?? '',
        at: new Date().toISOString(),
      };
    }
    console.error('Crew: a component threw', error, info);
  }

  override render(): ReactNode {
    const { error, info } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 p-8 text-slate-200">
        <div className="w-full max-w-xl space-y-4 rounded-lg border border-slate-700/60 bg-slate-900/60 p-6">
          <h1 className="text-lg font-semibold text-slate-100">This screen hit an error</h1>
          <p className="text-sm text-slate-400">
            The rest of the app is still running. Reload to get the screen back; if it keeps
            happening, the detail below plus the browser console is what a bug report needs.
          </p>
          <pre className="max-h-64 overflow-auto rounded bg-slate-950/80 p-3 text-xs whitespace-pre-wrap text-rose-300">
            {String(error.message ?? error)}
            {info?.componentStack ? `\n${info.componentStack.split('\n').slice(0, 6).join('\n')}` : ''}
          </pre>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded bg-slate-700 px-3 py-1.5 text-sm text-slate-100 hover:bg-slate-600"
              onClick={() => window.location.reload()}
            >
              Reload
            </button>
            <button
              type="button"
              className="rounded px-3 py-1.5 text-sm text-slate-400 hover:text-slate-200"
              onClick={() => this.setState({ error: null, info: null })}
            >
              Try again without reloading
            </button>
          </div>
        </div>
      </div>
    );
  }
}
