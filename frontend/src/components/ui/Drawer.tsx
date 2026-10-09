import { useEffect, useRef, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

export function Drawer({
  open,
  title,
  subtitle,
  onClose,
  children,
  footer,
  width = '28rem',
}: {
  open: boolean;
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    panelRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true">
      <div
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
        aria-hidden
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        style={{ width }}
        className="relative z-10 flex h-full max-w-[92vw] flex-col border-l border-slate-700/70 bg-slate-950/95 shadow-2xl outline-none"
      >
        <header className="flex items-start justify-between gap-3 border-b border-slate-700/60 px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold text-slate-100">{title}</h2>
            {subtitle && <div className="mt-0.5 text-xs text-slate-400">{subtitle}</div>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close drawer"
            className="rounded p-1 text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-100"
          >
            ✕
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>
        {footer && (
          <footer className="border-t border-slate-700/60 px-4 py-2.5">{footer}</footer>
        )}
      </div>
    </div>
  );
}

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  className,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} aria-hidden />
      {/* The scroller is a sibling ABOVE the backdrop: a dialog taller than the window
          can always be scrolled (the panel caps its height and scrolls its body, so
          header/footer stay pinned even in a very short window). */}
      <div className="relative z-10 h-full overflow-y-auto overscroll-contain">
        <div
          className="flex min-h-full items-start justify-center p-4 pt-[8vh]"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) onClose();
          }}
        >
          <div
            className={cn(
              'relative flex max-h-[calc(100dvh-5rem)] w-full max-w-lg flex-col rounded-lg border border-slate-700/70 bg-slate-950 shadow-2xl',
              className,
            )}
          >
            <header className="flex shrink-0 items-center justify-between border-b border-slate-700/60 px-4 py-3">
              <h2 className="text-base font-semibold text-slate-100">{title}</h2>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close dialog"
                className="rounded p-1 text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-100"
              >
                ✕
              </button>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>
            {footer && (
              <footer className="flex shrink-0 justify-end gap-2 border-t border-slate-700/60 px-4 py-2.5">
                {footer}
              </footer>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
