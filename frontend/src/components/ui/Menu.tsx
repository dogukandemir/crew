import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Button } from './Button';

export interface MenuItem {
  key: string;
  label: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  /** Marks the entry the user is already on. */
  current?: boolean;
}

/**
 * A small popover menu: no portal, closes on outside click and Escape. Built for the
 * project switcher, the one navigation affordance the workspace was missing.
 */
export function Menu({
  label,
  title,
  items,
  align = 'right',
}: {
  label: ReactNode;
  title?: string;
  items: MenuItem[];
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const menu = ref.current?.querySelector<HTMLElement>('[role="menu"]');
    const enabled = () => [...(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
    enabled()[0]?.focus();
    const restore = () => ref.current?.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')?.focus();
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); restore(); return; }
      if (!menu?.contains(document.activeElement)) return;
      if (e.key === 'Tab') { setOpen(false); restore(); return; }
      const buttons = enabled();
      if (!buttons.length) return;
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      let next = index;
      if (e.key === 'ArrowDown') next = (index + 1) % buttons.length;
      else if (e.key === 'ArrowUp') next = (index + buttons.length - 1) % buttons.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = buttons.length - 1;
      else return;
      e.preventDefault(); buttons[next]?.focus();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <Button
        size="xs"
        variant="ghost"
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {label}
      </Button>
      {open && (
        <div
          role="menu"
          className={cn(
            'absolute z-40 mt-1 max-h-72 min-w-48 overflow-auto rounded-md border border-slate-700/70 bg-slate-900/95 py-1 shadow-xl',
            align === 'right' ? 'right-0' : 'left-0',
          )}
        >
          {items.map((it) => (
            <button
              key={it.key}
              type="button"
              role="menuitem"
              tabIndex={-1}
              disabled={it.disabled}
              onClick={() => {
                setOpen(false);
                it.onSelect();
              }}
              className={cn(
                'flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-slate-200 hover:bg-slate-800/80 disabled:cursor-not-allowed disabled:opacity-40',
                it.current && 'text-emerald-300',
              )}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
