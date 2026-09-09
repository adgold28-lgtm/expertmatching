// Next.js instrumentation hook — runs once at server startup.
// Only runs in the Node.js runtime (not Edge); safe to import Node-only modules here.
// Enabled via next.config.js `experimental.instrumentationHook`.

// -----------------------------------------------------------------------------
// register()
// Boot-time gate: fails production startup fast if a required secret/env var
// (Stripe, Zoom, Google, Resend, QStash, Supabase, etc. — see
// lib/validateEnv.ts REQUIRED_VARS) is missing, instead of failing later on
// first use deep in a request. Guarded to the Node runtime because the Edge
// runtime (middleware.ts) also loads this file's config but must not run
// Node-only env checks there.
// -----------------------------------------------------------------------------
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { validateEnv } = await import('./lib/validateEnv');
    validateEnv();
  }
}
