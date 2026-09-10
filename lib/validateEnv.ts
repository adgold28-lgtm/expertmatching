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
/*
 * Removed 2026-09-09 (W4-1, M-50): GOOGLE_CALENDAR_REFRESH_TOKEN and
 * STRIPE_CONNECT_CLIENT_ID. A repository-wide grep for `process.env.<NAME>`
 * finds no read of either — the app's own Google Calendar writes were retired
 * and Stripe Connect Express needs no client id in this integration shape — yet
 * both sat here and could fail a production boot for a variable nothing uses.
 * SESSION_SECRET and CONTACT_ENRICHMENT_ADMIN_TOKEN were the same story in
 * .env.example and went with them.
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
  // Run a second provider alongside the first and log how the two compare.
  // Diagnostics only; off unless 'true' (lib/generateExperts.ts).
  'SEARCH_COMPARE_PROVIDERS',
  // ── Added 2026-09-09 (W4-1, M-51): read by the running code but invisible to
  // the admin env-status console until now. Two of them are kill switches.
  // Kill switch: 'false' makes every /api/projects route answer 503 (lib/projectsGuard.ts)
  'PROJECTS_ENABLED',
  // Bearer token that lets a non-session caller through the projects guard (lib/projectsGuard.ts)
  'PROJECTS_ADMIN_TOKEN',
  // 'true' turns on session authentication for the app (lib/auth.ts)
  'APP_AUTH_ENABLED',
  // Where new-account and access-request notifications go (lib/firmStore.ts)
  'ADMIN_NOTIFICATION_EMAIL',
  // Kill switch: 'true' suppresses every outbound email, everywhere
  'DISABLE_EMAILS',
  // Absolute origin used to build links inside emails and job callbacks;
  // falls back to NEXT_PUBLIC_APP_URL and then to https://expertmatch.fit
  'NEXT_PUBLIC_BASE_URL',
  // Bumping this string invalidates every cached contact lookup (lib/contactCache.ts)
  'CONTACT_CACHE_VERSION',
  // Comma-separated email-provider order. Read by lib/contactProviders/index.ts,
  // but the live discovery path hardcodes its provider list, so it has no
  // effect today (M-23) — listed so the console does not hide it.
  'EMAIL_PROVIDER_ORDER',
  // Global daily provider-credit budget; defaults to 500 (lib/rateLimiter.ts).
  // Documented in .env.example but absent from both lists until 2026-09-09, so
  // the console could not show it — the same defect M-51 names, two variables
  // its list missed because they were already in .env.example.
  'ENRICHMENT_DAILY_BUDGET',
  // Sent to the browser so the onboarding billing step can mount Stripe
  // Elements. Deliberately NOT in REQUIRED_VARS: unset makes
  // POST /api/onboarding/billing answer 503 billing_unavailable rather than
  // failing the production boot. Listed here for visibility only.
  'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY',
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
