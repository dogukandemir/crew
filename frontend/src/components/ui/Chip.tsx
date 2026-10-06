import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import type { Tone } from './Badge';

const CHIP_TONES: Record<Tone, string> = {
  neutral: 'border-slate-600/70 text-slate-200 bg-slate-800/60',
  muted: 'border-slate-700/60 text-slate-400 bg-slate-800/40',
  info: 'border-sky-700/60 text-sky-300 bg-sky-950/50',
  accent: 'border-violet-700/60 text-violet-300 bg-violet-950/50',
  success: 'border-emerald-700/60 text-emerald-300 bg-emerald-950/50',
  warning: 'border-amber-700/60 text-amber-300 bg-amber-950/50',
  danger: 'border-rose-700/60 text-rose-300 bg-rose-950/50',
};

export function Chip({
  tone = 'neutral',
  children,
  selected,
  onClick,
  title,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  selected?: boolean;
  onClick?: () => void;
  title?: string;
  className?: string;
}) {
  const base =
    'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap';
  if (!onClick) {
    return (
      <span title={title} className={cn(base, CHIP_TONES[tone], className)}>
        {children}
      </span>
    );
  }
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        base,
        'transition-colors hover:border-slate-400/70',
        CHIP_TONES[tone],
        selected && 'ring-1 ring-emerald-400/70',
        className,
      )}
    >
      {children}
    </button>
  );
}
