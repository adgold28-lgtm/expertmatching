'use client';

// app/global-error.tsx — the page a visitor sees when React itself fails to
// render, which is the one error the route-level boundaries cannot catch.
// It replaces the root layout, so it carries its own <html> and <body> and
// cannot use the global stylesheet or the fonts; the styles are inline on
// purpose. Every error that lands here is reported to Sentry (lib/sentry.ts
// scrubs it) before the page offers a retry.

import { useEffect } from 'react';
import * as Sentry from '@sentry/nextjs';
import { SUPPORT_EMAIL } from '../lib/contactInfo';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body style={{ margin: 0, background: '#f7f6f3', color: '#1b1b1b', fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif' }}>
        <main style={{ maxWidth: 480, margin: '0 auto', padding: '96px 16px 64px', lineHeight: 1.5 }}>
          <p style={{ margin: '0 0 8px', fontSize: 13, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#6b6b6b' }}>
            ExpertMatch
          </p>
          <h1 style={{ margin: '0 0 12px', fontSize: 26, fontWeight: 600 }}>Something went wrong</h1>
          <p style={{ margin: '0 0 24px', color: '#3d3d3d' }}>
            The error has been reported. Try again, and if it keeps happening, write to{' '}
            <a href={`mailto:${SUPPORT_EMAIL}`} style={{ color: '#1b1b1b' }}>{SUPPORT_EMAIL}</a>.
          </p>
          <button
            type="button"
            onClick={() => reset()}
            style={{
              display: 'inline-block', padding: '10px 18px', border: '1px solid #1b1b1b', borderRadius: 6,
              background: '#1b1b1b', color: '#ffffff', fontSize: 15, cursor: 'pointer',
            }}
          >
            Try again
          </button>
          {error.digest ? (
            <p style={{ margin: '24px 0 0', fontSize: 12, color: '#8a8a8a' }}>Reference {error.digest}</p>
          ) : null}
        </main>
      </body>
    </html>
  );
}
