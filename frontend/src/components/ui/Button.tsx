import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'dangerSolid';
type Size = 'xs' | 'sm' | 'md' | 'icon';

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-emerald-500 text-emerald-950 hover:bg-emerald-400 border border-emerald-400/60 shadow-sm',
  secondary:
    'bg-slate-800/80 text-slate-100 hover:bg-slate-700 border border-slate-600/70',
  ghost: 'bg-transparent text-slate-300 hover:bg-slate-800/70 border border-transparent',
  danger:
    'bg-rose-950/60 text-rose-200 hover:bg-rose-900/60 border border-rose-700/60',
  dangerSolid: 'bg-rose-600 text-white hover:bg-rose-500 border border-rose-400/60',
};

const SIZES: Record<Size, string> = {
  xs: 'h-6 px-2 text-[11px] gap-1',
  sm: 'h-8 px-2.5 text-xs gap-1.5',
  md: 'h-9 px-3.5 text-sm gap-2',
  icon: 'h-8 w-8 p-0 justify-center',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  children?: ReactNode;
}

export function Button({
  variant = 'secondary',
  size = 'sm',
  loading = false,
  className,
  disabled,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center rounded-md font-medium transition-colors',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-emerald-400',
        'disabled:cursor-not-allowed disabled:opacity-45',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
    >
      {loading && (
        <span
          aria-hidden
          className="h-3 w-3 animate-spin rounded-full border border-current border-t-transparent"
        />
      )}
      {children}
    </button>
  );
}
