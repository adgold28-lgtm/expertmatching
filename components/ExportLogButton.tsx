'use client';

// "Export log" and "Export all": a plain download of the conversation log for
// a client's compliance officer. No modal, no options page.
//
// The file is fetched rather than linked so the button can show that it is
// working and say plainly when it did not: an <a download> pointed at a route
// that answers 429 would save the error body as the log. The server decides
// the filename (Content-Disposition); it names neither the client's firm nor
// the expert.

import { useState } from 'react';

export type ExportFormat = 'csv' | 'txt';

interface Props {
  /** The export route WITHOUT the query string. */
  href:           string;
  label:          string;
  /** The first is the main button; any others render as a quiet second button. */
  formats?:       readonly ExportFormat[];
  disabled?:      boolean;
  /** Why it is disabled, for the tooltip ("Nothing to export yet."). */
  disabledTitle?: string;
  /** Used only if the response carries no filename. */
  fallbackName:   string;
}

const FORMAT_WORD: Record<ExportFormat, string> = { csv: 'Spreadsheet', txt: 'Text' };

function filenameFrom(disposition: string | null): string | null {
  const match = disposition?.match(/filename="([^"]+)"/);
  return match ? match[1] : null;
}

export default function ExportLogButton({
  href,
  label,
  formats = ['csv'],
  disabled = false,
  disabledTitle,
  fallbackName,
}: Props) {
  const [busy,  setBusy]  = useState<ExportFormat | null>(null);
  const [error, setError] = useState('');

  async function download(format: ExportFormat) {
    if (busy || disabled) return;
    setBusy(format);
    setError('');
    try {
      const res = await fetch(`${href}?format=${format}`, { cache: 'no-store' });
      if (!res.ok) {
        setError(res.status === 429
          ? 'Too many exports in a short time. Try again in a few minutes.'
          : 'The export did not download. Try again.');
        return;
      }
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href     = url;
      link.download = filenameFrom(res.headers.get('Content-Disposition')) ?? `${fallbackName}.${format}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch {
      setError("Couldn't reach the server. Try again.");
    } finally {
      setBusy(null);
    }
  }

  const [main, ...others] = formats;

  return (
    <span className="inline-flex flex-col items-end gap-1 max-w-full">
      <span className="inline-flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => { void download(main); }}
          disabled={disabled || busy !== null}
          title={disabled ? disabledTitle : undefined}
          className="min-h-[32px] sm:min-h-0 inline-flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-navy border border-navy/30 hover:border-navy px-2.5 py-1 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          style={{ letterSpacing: '0.1em' }}
        >
          {busy === main && (
            <span aria-hidden className="inline-block w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" />
          )}
          {busy === main ? 'Preparing…' : label}
        </button>
        {others.map(format => (
          <button
            key={format}
            type="button"
            onClick={() => { void download(format); }}
            disabled={disabled || busy !== null}
            title={disabled ? disabledTitle : undefined}
            aria-label={`${label} as ${FORMAT_WORD[format].toLowerCase()}`}
            className="min-h-[32px] sm:min-h-0 text-[10px] uppercase tracking-widest text-muted hover:text-navy px-1 py-1 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            style={{ letterSpacing: '0.1em' }}
          >
            {busy === format ? 'Preparing…' : FORMAT_WORD[format]}
          </button>
        ))}
      </span>
      {error && (
        <span role="alert" className="text-[10px] text-red-600 text-right max-w-[18rem]">{error}</span>
      )}
    </span>
  );
}
