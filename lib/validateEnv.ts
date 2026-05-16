// Startup environment variable validation.
// Called once from instrumentation.ts (Node.js runtime only).
//
// In production: throws if any required variable is missing.
// In non-production: logs a warning for each missing variable.

const REQUIRED_VARS = [
  'AVAILABILITY_TOKEN_SECRET',
  'SIGNUP_TOKEN_SECRET',
  'ENCRYPTION_KEY',
  'SESSION_SECRET',
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
] as const;

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

  if (missing.length > 0) {
    throw new Error(
      `[validateEnv] Missing required environment variables in production: ${missing.join(', ')}`,
    );
  }
}
