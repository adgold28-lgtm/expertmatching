// Structured abuse event logging with pseudonymized identifiers.
//
// SECURITY: Raw email, IP, name, domain, token, and request body are NEVER logged.
// All user/firm identifiers are replaced with 12-char HMAC-SHA256 truncations
// (same scheme as contactCache.ts pseudonymization) so events can be correlated
// without exposing PII.
//
// Events are emitted as structured JSON to console. The format is intentionally
// machine-parseable for log aggregation (Datadog, CloudWatch, etc.).
//
// Scope note: this is the login-logging-only subset of issue #27. Usage-cap and
// AI-quota event helpers were intentionally omitted (those gates were not applied
// to avoid overlapping with the #29 rate limiter).

import { createHmac } from 'crypto';

// 12-char HMAC-SHA256 truncation — sufficient for log correlation, not reversible.
function pseudonymize(value: string): string {
  const secret = process.env.LOG_HASH_SECRET ?? 'dev-insecure-fallback';
  return createHmac('sha256', secret).update(value).digest('hex').slice(0, 12);
}

// ─── Event shape ──────────────────────────────────────────────────────────────

interface AuthFailureEvent {
  type:      'auth_failure';
  timestamp: number;
  userHash:  string;
  reason:    string;
}

type AbuseEvent = AuthFailureEvent;

function emit(event: AbuseEvent): void {
  console.warn('[abuse-logger]', JSON.stringify(event));
}

// ─── Public helpers ───────────────────────────────────────────────────────────

export function logAuthFailure(
  emailAttempted: string,
  reason:         string,
): void {
  emit({
    type:      'auth_failure',
    timestamp: Date.now(),
    userHash:  pseudonymize(emailAttempted),
    reason,
  });
}
