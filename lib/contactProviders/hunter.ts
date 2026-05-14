// Hunter.io Email Finder provider.
// API key is server-side only — NEVER exposed to client or logs.
// API docs: https://hunter.io/api-documentation/v2#email-finder

import type { ContactProvider, ContactLookupInput, ProviderEmailResult, NormalizedEmailStatus } from './types';
import { WEBMAIL_DOMAINS } from './types';

// ─── Status normalization ─────────────────────────────────────────────────────

// Hunter verification status values (from response data.verification.status).
type HunterVerificationStatus =
  | 'valid'       // confirmed deliverable
  | 'invalid'     // confirmed undeliverable
  | 'accept_all'  // catch-all domain
  | 'webmail'     // personal/webmail domain
  | 'disposable'  // disposable address
  | 'unknown';    // could not verify

function normalizeStatus(
  verificationStatus: string | null,
  score: number,
): NormalizedEmailStatus {
  // Explicit invalidity beats score
  if (verificationStatus === 'invalid' || verificationStatus === 'disposable') return 'invalid';

  // Explicit validity
  if (verificationStatus === 'valid') return 'verified';

  // Catch-all: domain accepts everything, can't confirm individual delivery
  if (verificationStatus === 'accept_all') return 'catchall';

  // Score-based fallback (Hunter score: 0–100)
  if (score >= 80) return 'verified';
  if (score >= 60) return 'catchall';
  return 'risky';
}

// ─── Provider implementation ──────────────────────────────────────────────────

export const hunterProvider: ContactProvider = {
  name: 'hunter',

  isConfigured(): boolean {
    return Boolean(process.env.HUNTER_API_KEY);
  },

  async findProfessionalEmail({ firstName, lastName, domain }: ContactLookupInput): Promise<ProviderEmailResult[]> {
    // THIS IS WHERE A HUNTER CREDIT MAY BE SPENT
    const apiKey = process.env.HUNTER_API_KEY;
    if (!apiKey) throw new Error('HUNTER_API_KEY not set');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);

    try {
      const params = new URLSearchParams({ domain, first_name: firstName, last_name: lastName });
      // API key sent as Authorization header — NEVER in the query string
      const res = await fetch(`https://api.hunter.io/v2/email-finder?${params}`, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
        signal: controller.signal,
      });

      if (res.status === 429) {
        throw Object.assign(new Error('Hunter upstream rate limit'), { code: 'provider_rate_limited' });
      }

      if (res.status === 402) {
        throw Object.assign(new Error('Insufficient Hunter credits'), { code: 'not_enough_credits' });
      }

      if (res.status === 401) {
        throw new Error('Hunter API key invalid or revoked');
      }

      if (res.status === 451) {
        // Privacy/GDPR claimed email — treat as not_found, no error thrown, nothing logged.
        return [];
      }

      if (!res.ok) {
        throw new Error(`Hunter HTTP ${res.status}`);
      }

      const body = await res.json() as Record<string, unknown>;

      // Hunter may return application-level errors in the errors array
      const errors = body.errors;
      if (Array.isArray(errors) && errors.length > 0) {
        // Errors like "missing_domain", "no_result" — treat as not_found, not a throw
        return [];
      }

      const data = body.data as Record<string, unknown> | null | undefined;
      if (!data) return [];

      const email = typeof data.email === 'string' ? data.email.trim() : '';
      if (!email) return [];

      const score              = typeof data.score  === 'number' ? data.score : 0;
      const verification       = (data.verification ?? {}) as Record<string, unknown>;
      const verificationStatus = typeof verification.status === 'string'
        ? verification.status as HunterVerificationStatus
        : null;

      const emailDomain = email.split('@')[1]?.toLowerCase() ?? '';

      // Filter webmail — security invariant enforced at provider level
      const isWebmail =
        verificationStatus === 'webmail' ||
        WEBMAIL_DOMAINS.has(emailDomain);
      if (isWebmail) return [];

      const isDisposable = verificationStatus === 'disposable';
      const isInvalid    = verificationStatus === 'invalid';

      // Hunter returns only valid-format emails, but be defensive
      const isValidFormat = email.includes('@') && emailDomain.includes('.');

      const normalizedStatus = isInvalid
        ? 'invalid'
        : normalizeStatus(verificationStatus, score);

      // Debug audit: counts only — no email, domain, API key, or raw response logged
      console.log('[hunter] result-counts', JSON.stringify({
        returned:          1,
        verificationStatus: verificationStatus ?? 'unknown',
        score,
        normalizedStatus,
        isWebmail,
        isDisposable,
      }));

      return [{
        email,
        provider:         'hunter',
        providerStatus:   verificationStatus ?? 'unknown',
        normalizedStatus,
        confidence:       score,
        isWebmail,
        isDisposable,
        isValidFormat,
        isGibberish:      false, // Hunter does not surface a gibberish flag
        reason:           verificationStatus ?? null,
      }];
    } finally {
      clearTimeout(timer);
    }
  },

  estimateCreditsPerLookup(_input: ContactLookupInput): number {
    return 1;
  },
};
