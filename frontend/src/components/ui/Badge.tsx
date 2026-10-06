import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export type Tone =
  | 'neutral'
  | 'info'
  | 'accent'
  | 'success'
  | 'warning'
  | 'danger'
  | 'muted';

const TONES: Record<Tone, string> = {
  neutral: 'bg-slate-700/60 text-slate-200 border-slate-500/50',
  muted: 'bg-slate-800/60 text-slate-400 border-slate-700/60',
  info: 'bg-sky-950/70 text-sky-300 border-sky-700/60',
  accent: 'bg-violet-950/70 text-violet-300 border-violet-700/60',
  success: 'bg-emerald-950/70 text-emerald-300 border-emerald-700/60',
  warning: 'bg-amber-950/70 text-amber-300 border-amber-700/60',
  danger: 'bg-rose-950/70 text-rose-300 border-rose-700/60',
};

export function Badge({
  tone = 'neutral',
  children,
  className,
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-medium leading-none',
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Severity → tone mapping used by events, verifications and audit rows. */
export function severityTone(severity: string): Tone {
  switch (severity) {
    case 'critical':
    case 'error':
      return 'danger';
    case 'warning':
      return 'warning';
    case 'notice':
      return 'info';
    case 'debug':
      return 'muted';
    default:
      return 'neutral';
  }
}
