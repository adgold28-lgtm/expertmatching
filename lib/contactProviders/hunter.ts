// Hunter.io Email Finder provider — one of the two links in the discovery
// chain (lib/contactDiscovery.ts), plus the domain-search fallback that runs
// when the local heuristic cannot derive a company domain.
//
// Costs: findProfessionalEmail spends one email-finder credit per call;
// hunterDomainSearch does not.
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

// ─── Request plumbing ─────────────────────────────────────────────────────────

/**
 * Aborts on whichever comes first: this provider's own timeout or the caller's
 * deadline (lib/contactDiscovery.ts passes one so a single provider can never
 * eat the whole job's wall clock). Returns the controller plus a cleanup.
 */
function boundedController(timeoutMs: number, external?: AbortSignal): {
  controller: AbortController;
  cleanup:    () => void;
} {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort    = () => controller.abort();

  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', onAbort, { once: true });
  }

  return {
    controller,
    cleanup: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', onAbort);
    },
  };
}

/**
 * One Hunter GET. The key rides in the Authorization header on the first
 * attempt, so in the normal case it cannot land in a proxy or access log.
 * Hunter's older documented scheme is the `api_key` query parameter, so a 401
 * (and ONLY a 401) retries once that way rather than failing the whole lookup
 * on an auth-scheme difference — meaning on that retry path the key IS in the
 * URL and can reach an intermediary's logs. The key is never logged by us.
 */
async function hunterGet(
  path:   string,
  params: URLSearchParams,
  apiKey: string,
  signal: AbortSignal,
): Promise<Response> {
  const url = `https://api.hunter.io/v2/${path}?${params.toString()}`;
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${apiKey}` },
    signal,
  });
  if (res.status !== 401) return res;

  const withKey = new URLSearchParams(params);
  withKey.set('api_key', apiKey);
  return fetch(`https://api.hunter.io/v2/${path}?${withKey.toString()}`, { signal });
}

/**
 * Best-effort company → domain lookup, used only when the local heuristic in
 * lib/contactDiscovery.ts cannot derive a domain from the expert's source
 * links. Costs no email-finder credit. Returns null on anything but a clean
 * answer — never throws, so it can be a fallback step in a bounded chain.
 */
export async function hunterDomainSearch(
  company: string,
  external?: AbortSignal,
  timeoutMs = 8_000,
): Promise<string | null> {
  const apiKey = process.env.HUNTER_API_KEY;
  const name   = company.trim();
  if (!apiKey || !name) return null;

  const { controller, cleanup } = boundedController(timeoutMs, external);

  try {
    const params = new URLSearchParams({ company: name, limit: '1' });
    const res    = await hunterGet('domain-search', params, apiKey, controller.signal);
    if (!res.ok) return null;

    const body = await res.json() as Record<string, unknown>;
    const data = body.data as Record<string, unknown> | null | undefined;
    const domain = data && typeof data.domain === 'string' ? data.domain.trim().toLowerCase() : '';
    return domain && domain.includes('.') ? domain : null;
  } catch {
    return null;
  } finally {
    cleanup();
  }
}

// ─── Provider implementation ──────────────────────────────────────────────────

export const hunterProvider: ContactProvider = {
  name: 'hunter',

  isConfigured(): boolean {
    return Boolean(process.env.HUNTER_API_KEY);
  },

  async findProfessionalEmail({ firstName, lastName, domain, signal }: ContactLookupInput): Promise<ProviderEmailResult[]> {
    // THIS IS WHERE A HUNTER CREDIT MAY BE SPENT
    const apiKey = process.env.HUNTER_API_KEY;
    if (!apiKey) throw new Error('HUNTER_API_KEY not set');

    const { controller, cleanup } = boundedController(10_000, signal);

    try {
      const params = new URLSearchParams({ domain, first_name: firstName, last_name: lastName });
      // Key rides in the Authorization header. NOTE: hunterGet falls back to an
      // `api_key=` query parameter if (and only if) that first call 401s, so the
      // key is not unconditionally kept out of the URL — see hunterGet above.
      const res = await hunterGet('email-finder', params, apiKey, controller.signal);

      if (res.status === 429) {
        throw Object.assign(new Error('Hunter upstream rate limit'), { code: 'provider_rate_limited' });
      }

      if (res.status === 402) {
        throw Object.assign(new Error('Insufficient Hunter credits'), { code: 'not_enough_credits' });
      }

      // A 401 here means the header AND the query-parameter scheme both failed:
      // the key is wrong, not the auth style. Throwing (rather than returning [])
      // keeps a bad key out of the negative cache — discoverContact only caches
      // 'not_found' when a provider actually answered not_found.
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
      cleanup();
    }
  },

  estimateCreditsPerLookup(_input: ContactLookupInput): number {
    return 1;
  },
};
