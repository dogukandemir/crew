import { useQueryClient } from '@tanstack/react-query';
import { API_BASE, ApiError, isBackendUnreachable } from '../api/client';
import { Button } from '../components/ui/Button';
import { EmptyState } from '../components/ui/EmptyState';
import { useUi } from '../stores/ui';

/**
 * "Never lie" (docs/09 §3): a dead backend yields a banner with a retry, never
 * an empty screen or fabricated data.
 */
export function BackendBanner() {
  const backendDown = useUi((s) => s.backendDown);
  const detail = useUi((s) => s.backendDetail);
  const qc = useQueryClient();

  if (!backendDown) return null;

  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-3 border-b border-amber-700/60 bg-amber-950/50 px-3 py-1.5 text-xs text-amber-200"
    >
        <span className="min-w-0 truncate">
          <strong className="font-semibold">Backend unreachable.</strong>{' '}
          {detail ?? `No response from ${API_BASE}`}
        </span>
      <Button size="xs" variant="secondary" onClick={() => void qc.invalidateQueries()}>
        Retry
      </Button>
    </div>
  );
}

/** Consistent error rendering for any query failure. */
export function PanelError({
  error,
  onRetry,
  label = 'This panel',
}: {
  error: unknown;
  onRetry?: () => void;
  label?: string;
}) {
  const unreachable = isBackendUnreachable(error);
  const message =
    error instanceof ApiError
      ? error.problem?.detail ?? error.message
      : error instanceof Error
        ? error.message
        : String(error);

  if (unreachable) {
    return (
      <EmptyState
        title="Backend unreachable"
        description={
          <>
            {label} needs the Crew backend at <code className="font-mono">{API_BASE}</code>. Start it
            with <code className="font-mono">uvicorn</code> and retry.
          </>
        }
        action={
          onRetry ? (
            <Button size="sm" variant="secondary" onClick={onRetry}>
              Retry
            </Button>
          ) : undefined
        }
      />
    );
  }

  return (
    <div className="rounded-lg border border-rose-800/60 bg-rose-950/40 px-3 py-2 text-xs text-rose-200">
      <div className="font-medium">
        {error instanceof ApiError && error.problem?.title ? error.problem.title : 'Request failed'}
      </div>
      <div className="mt-0.5 break-words text-rose-300/80">{message}</div>
      {error instanceof ApiError && error.problem?.trace_id && (
        <div className="mt-0.5 font-mono text-[10px] text-rose-400/70">
          trace {error.problem.trace_id}
        </div>
      )}
      {onRetry && (
        <Button size="xs" variant="ghost" className="mt-1" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}
