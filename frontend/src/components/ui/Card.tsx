import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export function Card({
  title,
  subtitle,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section
      className={cn(
        'rounded-lg border border-slate-700/60 bg-slate-900/60 shadow-sm backdrop-blur-sm',
        className,
      )}
    >
      {(title || actions) && (
        <header className="flex items-start justify-between gap-3 border-b border-slate-700/50 px-3 py-2">
          <div className="min-w-0">
            {title && <h3 className="truncate text-sm font-semibold text-slate-100">{title}</h3>}
            {subtitle && <p className="truncate text-xs text-slate-400">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
        </header>
      )}
      <div className={cn('px-3 py-2.5', bodyClassName)}>{children}</div>
    </section>
  );
}

/** Mission-control KPI tile (docs/09 §2.1). */
export function StatCard({
  label,
  value,
  hint,
  tone = 'neutral',
  onClick,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info';
  onClick?: () => void;
}) {
  const tones: Record<string, string> = {
    neutral: 'text-slate-100',
    success: 'text-emerald-300',
    warning: 'text-amber-300',
    danger: 'text-rose-300',
    info: 'text-sky-300',
  };
  const Comp = onClick ? 'button' : 'div';
  return (
    <Comp
      onClick={onClick}
      className={cn(
        'min-w-[8.5rem] flex-1 rounded-lg border border-slate-700/60 bg-slate-900/60 px-3 py-2 text-left',
        onClick && 'transition-colors hover:border-slate-500/70 hover:bg-slate-800/60',
      )}
    >
      <div className="text-[11px] uppercase tracking-wide text-slate-400">{label}</div>
      <div className={cn('mt-0.5 text-xl font-semibold tabular-nums', tones[tone])}>{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-slate-500">{hint}</div>}
    </Comp>
  );
}

export function ProgressBar({
  value,
  tone = 'accent',
  className,
  label,
}: {
  value: number;
  tone?: 'accent' | 'success' | 'warning' | 'danger';
  className?: string;
  label?: string;
}) {
  const pct = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)) * 100;
  const tones: Record<string, string> = {
    accent: 'bg-emerald-400',
    success: 'bg-emerald-500',
    warning: 'bg-amber-400',
    danger: 'bg-rose-500',
  };
  return (
    <div
      className={cn('h-1.5 w-full overflow-hidden rounded-full bg-slate-700/70', className)}
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <div className={cn('h-full rounded-full transition-[width]', tones[tone])} style={{ width: `${pct}%` }} />
    </div>
  );
}
