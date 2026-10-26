// Next.js instrumentation hook — runs once at server startup, once per runtime.
// Enabled via next.config.js `experimental.instrumentationHook`.

// -----------------------------------------------------------------------------
// register()
// 1. Error monitoring: loads this runtime's Sentry init (sentry.server.config.ts
//    for Node, sentry.edge.config.ts for the Edge runtime that middleware.ts
//    uses). Both are one line that defers to lib/sentry.ts, and both do nothing
//    without NEXT_PUBLIC_SENTRY_DSN. The browser's init is instrumentation-client.ts.
// 2. Boot-time gate (Node only): fails production startup fast if a required
//    secret/env var (Stripe, Zoom, Google, Resend, QStash, Supabase, etc. — see
//    lib/validateEnv.ts REQUIRED_VARS) is missing, instead of failing later on
//    first use deep in a request. Guarded to the Node runtime because the Edge
//    runtime must not run Node-only env checks.
// -----------------------------------------------------------------------------
import * as Sentry from '@sentry/nextjs';

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');
    const { validateEnv } = await import('./lib/validateEnv');
    validateEnv();
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}

// Errors from server components, middleware and proxies. Next calls this from
// 15.0 on; Next 14 ignores the export, and the route-handler and component
// wrappers the build plugin installs cover the same ground there.
export const onRequestError = Sentry.captureRequestError;
