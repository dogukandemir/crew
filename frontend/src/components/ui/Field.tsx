import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

const CONTROL =
  'rounded-md border border-slate-600/70 bg-slate-900/80 px-2.5 py-1.5 text-sm text-slate-100 ' +
  'placeholder:text-slate-500 focus:border-emerald-400/70 focus:outline-none focus:ring-1 focus:ring-emerald-400/40 ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

function controlClass(className?: string) {
  // Explicit widths must not compete with w-full in the utility cascade.
  const width = className?.split(/\s+/).some(token => token.startsWith('w-'));
  return cn(CONTROL, !width && 'w-full', className);
}

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn('block', className)}>
      <span className="mb-1 block text-xs font-medium text-slate-300">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-slate-500">{hint}</span>}
    </label>
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={controlClass(className)} />;
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...rest} className={cn(controlClass(className), 'min-h-[72px] resize-y')} />;
}

export function Select({
  className,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { children: ReactNode }) {
  return (
    <select {...rest} className={cn(controlClass(className), 'pr-7')}>
      {children}
    </select>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5">
      <div className="min-w-0">
        <div className="text-sm text-slate-200">{label}</div>
        {hint && <div className="text-[11px] text-slate-500">{hint}</div>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={typeof label === 'string' ? label : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative mt-0.5 h-5 w-9 shrink-0 rounded-full border transition-colors disabled:opacity-50',
          checked ? 'border-emerald-400/70 bg-emerald-500/80' : 'border-slate-600 bg-slate-700/70',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white transition-all',
            checked ? 'left-[1.15rem]' : 'left-0.5',
          )}
        />
      </button>
    </div>
  );
}

/** The "never lie" affordance: an explicit unknown. */
export function Unknown({ title = 'not reported by the backend' }: { title?: string }) {
  return (
    <span className="text-slate-600" title={title}>
    ,
    </span>
  );
}
