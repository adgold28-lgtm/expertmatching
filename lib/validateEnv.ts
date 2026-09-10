// Startup environment variable validation.
// Called once from instrumentation.ts (Node.js runtime only).
//
// In production: throws if any required variable is missing.
// In non-production: logs a warning for each missing variable.
//
// Never reads or logs a variable's VALUE — only presence/absence. Also backs
// GET /api/admin/env-status, which reports the same
// PRESENT/MISSING state to the founder without exposing secrets.

/**
 * Every variable the app refuses to boot without in production.
 *
 * Exported so GET /api/admin/env-status can report PRESENCE (never values)
 * from one list — a second hand-kept copy in the route would drift the moment
 * a variable is added here.
 */
export const REQUIRED_VARS = [
  'AVAILABILITY_TOKEN_SECRET',
  'SIGNUP_TOKEN_SECRET',
  'ENCRYPTION_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'ZOOM_WEBHOOK_SECRET_TOKEN',
  'ZOOM_CLIENT_ID',
  'ZOOM_CLIENT_SECRET',
  'ZOOM_ACCOUNT_ID',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_CALENDAR_REFRESH_TOKEN',
  'RESEND_API_KEY',
  'OUTREACH_FROM_EMAIL',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'LOG_HASH_SECRET',
  'NEXT_PUBLIC_APP_URL',
  'OPENAI_API_KEY',
  // Phase 4 — email sequence + inbound
  'QSTASH_TOKEN',
  'QSTASH_CURRENT_SIGNING_KEY',
  'QSTASH_NEXT_SIGNING_KEY',
  'RESEND_WEBHOOK_SECRET',
  // Phase 6 — Stripe Connect
  'STRIPE_CONNECT_CLIENT_ID',
  // Supabase — auth + source-of-truth Postgres
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  // Anthropic API (expert generation)
  'ANTRHOPICKEYREAL',
] as const;

/**
 * Variables that switch a feature on or tune it, never required to boot. Listed
 * here ONLY so GET /api/admin/env-status can show the founder whether each one
 * is set in the running deployment — the console is the one place that answers
 * "did I already add the Hunter key?" without opening the Vercel dashboard.
 * validateEnv() never checks these.
 */
export const OPTIONAL_VARS = [
  // Background jobs (Vercel Cron sends this on /api/jobs/reconcile and /api/jobs/schedule-nudges)
  'CRON_SECRET',
  // Region-pinned QStash host; the code falls back to us-east-1 when unset
  'QSTASH_URL',
  // Contact discovery on bookmark: off unless the flag is 'true' AND a provider key exists
  'CONTACT_ENRICHMENT_ENABLED',
  'HUNTER_API_KEY',
  'SNOV_CLIENT_ID',
  'SNOV_CLIENT_SECRET',
  // Who signs Matchy's emails (lib/senderIdentity.ts); unset = unsigned
  'OUTREACH_SIGNATURE',
  // CAN-SPAM postal address in the footer
  'OUTREACH_POSTAL_ADDRESS',
  // One-line LLM rephrase of nudges; off unless 'true'
  'NUDGE_LLM_VARIATION',
  // Web search behind expert sourcing. Not required to boot — the app runs
  // fine without it right up until a user starts a run, which then fails with
  // no_search_provider — so validateEnv() warns instead (see below).
  'EXA_API_KEY',
  'TAVILY_API_KEY',
  'SCRAPINGBEE_KEY',
  // Which of the three to try first, and whether to fall through to the others
  'SEARCH_PROVIDER',
  'SEARCH_FALLBACK_ENABLED',
] as const;

/**
 * Sourcing needs at least ONE of these. Any one is enough, which is why none of
 * them can sit in REQUIRED_VARS.
 */
const SEARCH_PROVIDER_KEYS = ['EXA_API_KEY', 'TAVILY_API_KEY', 'SCRAPINGBEE_KEY'] as const;

export function validateEnv(): void {
  const isProd = process.env.NODE_ENV === 'production';
  const missing: string[] = [];

  for (const name of REQUIRED_VARS) {
    if (!process.env[name]) {
      if (isProd) {
        missing.push(name);
      } else {
        console.warn(`[validateEnv] WARNING: running without ${name} — acceptable in dev`);
      }
    }
  }

  // No search key at all means expert sourcing — the product's core feature —
  // fails on the first run with no_search_provider, and nothing else notices
  // (M-19). Any one key is enough, so this WARNS rather than refusing to boot:
  // a deployment that never sources is a legitimate one, and taking the site
  // down for a missing optional key would be the worse failure.
  if (!SEARCH_PROVIDER_KEYS.some(name => process.env[name])) {
    console.warn(
      '[validateEnv] WARNING: no search provider key set '
      + `(${SEARCH_PROVIDER_KEYS.join(', ')}) — expert sourcing will fail with no_search_provider`,
    );
  }

  if (missing.length > 0) {
    throw new Error(
      `[validateEnv] Missing required environment variables in production: ${missing.join(', ')}`,
    );
  }
}
