// lib/sentry.ts — the one Sentry configuration, shared by the three init files
// Next loads per runtime: instrumentation-client.ts (browser),
// sentry.server.config.ts (Node) and sentry.edge.config.ts (Edge, where
// middleware.ts runs). Those files are one line each; everything is here.
//
// WHAT SENTRY GETS: uncaught exceptions from route handlers, server components
// and middleware (the @sentry/nextjs build plugin in next.config.js wraps
// them), browser errors, React render crashes (app/global-error.tsx), and
// every log.error line (lib/log.ts hands them to the sink installed below).
// Every event passes lib/sentryScrub.ts first.
//
// WHAT IT DOES NOT GET: performance traces (tracesSampleRate 0), session
// replays (never installed), user identity, cookies, headers, bodies, query
// strings or local variables (dataCollection below), and anything the scrub
// removes. Nothing is initialised without NEXT_PUBLIC_SENTRY_DSN, which is
// every local checkout and CI. A DSN is a public ingest address, not a
// secret, which is why it may be NEXT_PUBLIC_ and reach the browser.

import * as Sentry from '@sentry/nextjs';
import { scrubSentryEvent } from './sentryScrub';
import { setErrorSink } from './log';

export type SentryRuntime = 'client' | 'server' | 'edge';

/** The DSN, or undefined when monitoring is off. */
export function sentryDsn(): string | undefined {
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN?.trim();
  return dsn ? dsn : undefined;
}

/** production | preview | development on Vercel; NODE_ENV elsewhere. */
export function sentryEnvironment(): string {
  return process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'development';
}

/** Sentry.init for one runtime, then the log.error sink. A no-op without a DSN. */
export function initSentry(runtime: SentryRuntime): void {
  const dsn = sentryDsn();
  if (!dsn) return;

  Sentry.init({
    dsn,
    environment:      sentryEnvironment(),
    tracesSampleRate: 0,
    maxBreadcrumbs:   20,
    initialScope:     { tags: { runtime } },
    beforeSend:       event => scrubSentryEvent(event),
    dataCollection: {
      userInfo:            false,
      cookies:             false,
      httpHeaders:         false,
      httpBodies:          [],
      urlQueryParams:      false,
      graphQL:             { document: false, variables: false },
      genAI:               { inputs: false, outputs: false },
      mcp:                 { inputs: false, outputs: false },
      databaseQueryData:   false,
      stackFrameVariables: false,
    },
  });

  setErrorSink((scope, message, fields) => {
    Sentry.captureMessage(`${scope} ${message}`, { level: 'error', extra: fields });
  });
}
