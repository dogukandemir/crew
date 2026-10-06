import { cn } from '../../lib/cn';

export type DotState = 'ok' | 'busy' | 'warning' | 'danger' | 'idle' | 'offline';

const DOTS: Record<DotState, string> = {
  ok: 'bg-emerald-400',
  busy: 'bg-sky-400',
  warning: 'bg-amber-400',
  danger: 'bg-rose-500',
  idle: 'bg-slate-500',
  offline: 'bg-slate-600',
};

const LABELS: Record<DotState, string> = {
  ok: 'ok',
  busy: 'busy',
  warning: 'needs attention',
  danger: 'failing',
  idle: 'idle',
  offline: 'offline',
};

export function StatusDot({
  state = 'idle',
  pulse = false,
  label,
  className,
}: {
  state?: DotState;
  pulse?: boolean;
  label?: string;
  className?: string;
}) {
  return (
    <span
      className={cn('inline-flex items-center gap-1.5', className)}
      title={label ?? LABELS[state]}
      aria-label={label ?? LABELS[state]}
    >
      <span className="relative flex h-2 w-2">
        {pulse && (
          <span
            className={cn(
              'absolute inline-flex h-full w-full rounded-full opacity-60 motion-safe:animate-ping',
              DOTS[state],
            )}
          />
        )}
        <span className={cn('relative inline-flex h-2 w-2 rounded-full', DOTS[state])} />
      </span>
    </span>
  );
}

/** Map a domain state string onto a dot colour. */
export function dotForState(state: string | undefined): DotState {
  switch (state) {
    case 'idle':
      return 'idle';
    case 'busy':
    case 'running':
    case 'assigned':
      return 'busy';
    case 'probation':
    case 'blocked':
    case 'escalated':
    case 'verifying':
      return 'warning';
    case 'failed':
    case 'aborted':
    case 'suspended':
      return 'danger';
    case 'completed':
    case 'done':
    case 'active':
      return 'ok';
    case 'archived':
      return 'offline';
    default:
      return 'idle';
  }
}
