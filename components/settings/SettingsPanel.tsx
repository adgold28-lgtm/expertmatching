'use client';

// The frame every /settings panel sits in. One card, one title, one optional
// one-line description, and a body. Kept here so the three panels cannot drift
// apart visually.
//
// Mobile-first: the panel is full-bleed inside the page's padding and never
// sets a width of its own — /settings owns the stacking and the breakpoint.

import type { ReactNode } from 'react';

interface SettingsPanelProps {
  title:        string;
  description?: string;
  /** Rendered top-right — a status pill, a role note. */
  aside?:       ReactNode;
  children:     ReactNode;
}

export default function SettingsPanel({
  title, description, aside, children,
}: SettingsPanelProps) {
  return (
    <section className="border border-frame bg-white">
      <header className="px-5 sm:px-6 py-4 border-b border-frame flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2
            className="text-[11px] uppercase font-medium text-navy"
            style={{ letterSpacing: '0.16em' }}
          >
            {title}
          </h2>
          {description && (
            <p className="mt-1.5 text-xs leading-relaxed text-muted">{description}</p>
          )}
        </div>
        {aside && <div className="shrink-0">{aside}</div>}
      </header>
      <div className="px-5 sm:px-6 py-5">{children}</div>
    </section>
  );
}

/** A single-line skeleton used while a panel loads. */
export function PanelSkeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="space-y-2.5" aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <div
          key={i}
          className="h-3 bg-frame/60"
          style={{ width: `${100 - i * 18}%` }}
        />
      ))}
    </div>
  );
}

/** An honest error line with a retry, used by every panel. */
export function PanelError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="text-xs leading-relaxed">
      <p className="text-red-600">{message}</p>
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
