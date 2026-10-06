import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export function TabBar<T extends string>({
  tabs,
  value,
  onChange,
  counts,
  className,
}: {
  tabs: Array<{ id: T; label: string }>;
  value: T;
  onChange: (id: T) => void;
  counts?: Partial<Record<T, number>>;
  className?: string;
}) {
  return (
    <div role="tablist" className={cn('flex items-center gap-0.5 overflow-x-auto', className)}>
      {tabs.map((t) => {
        const active = t.id === value;
        const count = counts?.[t.id];
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={active}
            type="button"
            onClick={() => onChange(t.id)}
            className={cn(
              'relative flex items-center gap-1.5 rounded-t-md border-b-2 px-3 py-1.5 text-xs font-medium transition-colors',
              active
                ? 'border-emerald-400 text-slate-100'
                : 'border-transparent text-slate-400 hover:text-slate-200',
            )}
          >
            {t.label}
            {typeof count === 'number' && count > 0 && (
              <span className="rounded-full bg-slate-700/80 px-1.5 text-[10px] text-slate-200">{count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function Section({
  title,
  description,
  children,
  actions,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="space-y-2 border-b border-slate-800/70 py-3 last:border-b-0">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-100">{title}</h3>
          {description && <p className="text-xs text-slate-400">{description}</p>}
        </div>
        {actions}
      </div>
      {children}
    </div>
  );
}

export function KeyValue({ pairs, className }: { pairs: Array<[ReactNode, ReactNode]>; className?: string }) {
  return (
    <dl className={cn('grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-3 gap-y-1 text-xs', className)}>
      {pairs.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-slate-500">{k}</dt>
          <dd className="min-w-0 text-slate-200">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
