import { useEffect } from 'react';
import { useUi } from '../stores/ui';
import { cn } from '../lib/cn';

/** Tiny toast (success/error feedback for user commands). */
export function Toaster() {
  const toast = useUi((s) => s.toast);
  const setToast = useUi((s) => s.setToast);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(id);
  }, [toast, setToast]);

  if (!toast) return null;

  return (
    <div
      role="status"
      className={cn(
        'fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-md border px-3 py-1.5 text-xs shadow-lg',
        toast.kind === 'error'
          ? 'border-rose-700/70 bg-rose-950/95 text-rose-100'
          : toast.kind === 'success'
            ? 'border-emerald-700/70 bg-emerald-950/95 text-emerald-100'
            : 'border-slate-600/70 bg-slate-900/95 text-slate-100',
      )}
    >
      {toast.message}
    </div>
  );
}
