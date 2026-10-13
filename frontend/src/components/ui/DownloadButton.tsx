import { useState, type ReactNode } from 'react';
import { downloadFile } from '../../api/client';

export function DownloadButton({ path, filename, title, className, children }: {
  path: string;
  filename: string;
  title: string;
  className?: string;
  children: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <span className="inline-flex flex-col items-start">
      <button
        type="button"
        title={title}
        aria-label={busy ? 'Downloading…' : title}
        aria-busy={busy}
        disabled={busy}
        className={className}
        onKeyDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          setBusy(true);
          setError('');
          void downloadFile(path, filename)
            .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Download failed. Please try again.'))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? 'Downloading…' : children}
      </button>
      {error && <span role="alert" className="max-w-64 text-xs text-amber-300">{error}</span>}
    </span>
  );
}
