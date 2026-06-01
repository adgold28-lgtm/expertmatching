// Structured abuse event logging with pseudonymized identifiers.
//
// SECURITY: Raw email, IP, name, domain, token, and request body are NEVER logged.
// All user/firm identifiers are replaced with 12-char HMAC-SHA256 truncations
// (same scheme as contactCache.ts pseudonymization) so events can be correlated
// without exposing PII.
//
// Events are emitted as structured JSON to console. The format is intentionally
// machine-parseable for log aggregation (Datadog, CloudWatch, etc.).

import { createHmac } from 'crypto';
import type { CapOperation } from './usageCaps';

// 12-char HMAC-SHA256 truncation — sufficient for log correlation, not reversible.
function pseudonymize(value: string): string {
  const secret = process.env.LOG_HASH_SECRET ?? 'dev-insecure-fallback';
  return createHmac('sha256', secret).update(value).digest('hex').slice(0, 12);
}

// ─── Event shape ──────────────────────────────────────────────────────────────

interface UsageCapExceededEvent {
  type:         'usage_cap_exceeded';
  timestamp:    number;
  userHash:     string;
  firmHash:     string;
  operation:    CapOperation;
  limitedBy:    'user' | 'firm';
  retryAfterMs: number;
}

interface RateLimitExceededEvent {
  type:       'rate_limit_exceeded';
  timestamp:  number;
  userHash?:  string;
  firmHash?:  string;
  tier:       string;
}

interface AuthFailureEvent {
  type:       'auth_failure';
  timestamp:  number;
  userHash:   string;
  reason:     string;
}

type AbuseEvent = UsageCapExceededEvent | RateLimitExceededEvent | AuthFailureEvent;

function emit(event: AbuseEvent): void {
  console.warn('[abuse-logger]', JSON.stringify(event));
}

// ─── Public helpers ───────────────────────────────────────────────────────────

export function logUsageCapExceeded(
  operation:    CapOperation,
  userEmail:    string,
  firmDomain:   string,
  limitedBy:    'user' | 'firm',
  retryAfterMs: number,
): void {
  emit({
    type:    'usage_cap_exceeded',
    timestamp: Date.now(),
    userHash:  pseudonymize(userEmail),
    firmHash:  pseudonymize(firmDomain),
    operation,
    limitedBy,
    retryAfterMs,
  });
}

export function logRateLimitExceeded(
  tier:        string,
  userEmail?:  string,
  firmDomain?: string,
): void {
  emit({
    type:      'rate_limit_exceeded',
    timestamp: Date.now(),
    userHash:  userEmail   ? pseudonymize(userEmail)   : undefined,
    firmHash:  firmDomain && firmDomain !== '*' ? pseudonymize(firmDomain) : undefined,
    tier,
  });
}

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
