'use client';

// The frame every /requests page sits in: the in-app header (same shape as
// /settings and /app so moving between them does not feel like leaving the
// product) and a centred main column.
//
// Mobile-first: one column, the page's own padding, no fixed widths. `wide`
// widens the column for the review table, which needs the room on a laptop and
// still stacks on a phone.
//
// Renders nothing about the request itself — the pages own their content and
// their own loading, error and empty states.

import type { ReactNode } from 'react';
import Link from 'next/link';

interface RequestsShellProps {
  /** Page title. Omit to render the header only (the page draws its own). */
  title?:       string;
  description?: string;
  /** Rendered top-right of the title row — a status pill, an action button. */
  aside?:       ReactNode;
  /** Widen the column for tables. */
  wide?:        boolean;
  children:     ReactNode;
}

export default function RequestsShell({
  title, description, aside, wide = false, children,
}: RequestsShellProps) {
  const column = wide ? 'max-w-6xl' : 'max-w-4xl';

  return (
    <div className="min-h-screen flex flex-col" style={{ background: '#F7F9FC' }}>

      {/* ── Header ── */}
      <header className="bg-navy border-b-2 border-gold sticky top-0 z-40">
        <div className={`${column} mx-auto px-6 sm:px-10 py-4 flex items-center justify-between gap-4`}>
          <Link
            href="/app"
            className="font-display text-cream font-semibold shrink-0"
            style={{ letterSpacing: '0.15em', fontSize: '13px' }}
          >
            EXPERTMATCH
          </Link>
          <nav className="flex items-center gap-4 sm:gap-5 flex-wrap justify-end">
            <Link
              href="/requests"
              className="text-[10px] uppercase tracking-widest text-gold/80 hover:text-gold transition-colors"
              style={{ letterSpacing: '0.18em' }}
            >
              Requests
            </Link>
            <Link
              href="/app"
              className="text-[10px] uppercase tracking-widest text-gold/50 hover:text-gold/80 transition-colors"
              style={{ letterSpacing: '0.18em' }}
            >
              Projects
            </Link>
            <Link
              href="/settings"
              className="text-[10px] uppercase tracking-widest text-gold/50 hover:text-gold/80 transition-colors"
              style={{ letterSpacing: '0.18em' }}
            >
              Settings
            </Link>
          </nav>
        </div>
      </header>

      <main className={`flex-1 ${column} w-full mx-auto px-6 sm:px-10 py-8 sm:py-10`}>
        {title && (
          <div className="mb-8 flex items-start justify-between gap-4 flex-wrap">
            <div className="min-w-0">
              <h1
                className="font-display text-navy"
                style={{ fontSize: '1.5rem', fontWeight: 500, letterSpacing: '0.01em' }}
              >
                {title}
              </h1>
              {description && (
                <p className="mt-1.5 text-xs leading-relaxed text-muted" style={{ fontWeight: 300 }}>
                  {description}
                </p>
              )}
            </div>
            {aside && <div className="shrink-0">{aside}</div>}
          </div>
        )}
        {children}
      </main>
    </div>
  );
}

/** Skeleton rows used while a /requests page loads. */
export function ShellSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-3" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton h-14 border border-frame" />
      ))}
    </div>
  );
}

/** An honest error block with a retry, used by every /requests page. */
export function ShellError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="border border-red-200 bg-red-50 px-5 py-4 text-sm leading-relaxed">
      <p className="text-red-700">{message}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 text-[10px] uppercase text-navy underline underline-offset-2 hover:opacity-70 transition-opacity"
          style={{ letterSpacing: '0.14em' }}
        >
          Try again
        </button>
      )}
    </div>
  );
}
