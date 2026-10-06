import { useState } from 'react';
import { cn } from '../../lib/cn';

/**
 * Payload viewer for event rows (docs/09 §2.8 "Row → JSON payload").
 * Collapsed by default; expands into a scrollable pretty-printed body.
 */
export function JsonView({
  value,
  maxHeight = '22rem',
  defaultOpen = true,
  className,
}: {
  value: unknown;
  maxHeight?: string;
  defaultOpen?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);

  if (value === undefined || value === null) {
    return <p className="text-xs text-slate-500">No payload on this event.</p>;
  }

  const text = safeStringify(value);
  const preview = text.split('\n')[0] ?? '';

  return (
    <div className={cn('rounded-md border border-slate-700/60 bg-slate-950/70', className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-2 py-1 text-left text-[11px] text-slate-400 hover:text-slate-200"
      >
        <span aria-hidden>{open ? '▾' : '▸'}</span>
        <span className="font-mono">payload</span>
        {!open && <span className="truncate font-mono text-slate-500">{preview}</span>}
      </button>
      {open && (
        <pre
          style={{ maxHeight }}
          className="overflow-auto border-t border-slate-800/80 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-slate-300"
        >
          {text}
        </pre>
      )}
    </div>
  );
}

function safeStringify(value: unknown): string {
  try {
    // Truncation notice from the backend (docs/11 §3) is preserved verbatim.
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
