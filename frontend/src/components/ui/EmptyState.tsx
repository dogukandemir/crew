import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

/**
 * Every panel has an empty state that teaches (docs/09 §4) — no blank boxes.
 */
export function EmptyState({
  title,
  description,
  action,
  icon,
  className,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-slate-700/70 px-6 py-10 text-center',
        className,
      )}
    >
      {icon && <div className="text-2xl text-slate-600">{icon}</div>}
      <p className="text-sm font-medium text-slate-200">{title}</p>
      {description && <p className="max-w-md text-xs text-slate-400">{description}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded bg-slate-700/50', className)} />;
}

export function SkeletonRows({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('space-y-2', className)}>
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-7 w-full" />
      ))}
    </div>
  );
}

export function ErrorNotice({
  title,
  detail,
  action,
}: {
  title: string;
  detail?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-rose-800/60 bg-rose-950/40 px-3 py-2 text-sm text-rose-200">
      <div className="font-medium">{title}</div>
      {detail && <div className="mt-0.5 break-words text-xs text-rose-300/80">{detail}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
