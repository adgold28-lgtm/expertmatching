import { NextRequest } from 'next/server';
import { timingSafeEqual } from 'crypto';
import {
  createCacheStore,
  makeCacheKey,
  pseudonymize,
  ttlForStatus,
  type CacheStore,
} from '../../../lib/contactCache';
import {
  createRateLimiterStore,
  checkRequestThrottle,
  checkCreditLimits,
  checkAndIncrementGlobalBudget,
  incrementProviderDailyCount,
  type RateLimiterStore,
} from '../../../lib/rateLimiter';
import {
  buildProviderWaterfall,
  type ContactProvider,
  type ContactProviderName,
  type ActiveProviderName,
} from '../../../lib/contactProviders';
import type { ContactEnrichment, ContactStatus, EnrichedEmail } from '../../../types';
import { WEBMAIL_DOMAINS } from '../../../lib/contactProviders/types';
import type { ProviderEmailResult } from '../../../lib/contactProviders/types';

// ─── Module-level singletons ──────────────────────────────────────────────────
// Lazily initialized on first request so env vars are available.

let _cacheStore:       CacheStore       | null = null;
let _rateLimiterStore: RateLimiterStore | null = null;

function getCacheStore():       CacheStore       { return (_cacheStore       ??= createCacheStore()); }
function getRateLimiterStore(): RateLimiterStore { return (_rateLimiterStore ??= createRateLimiterStore()); }

// Local in-flight deduplication (within one process).
// Multi-instance deduplication is handled by the distributed lock in CacheStore.
const inFlightLookups = new Map<string, Promise<ContactEnrichment>>();

// ─── Constants ────────────────────────────────────────────────────────────────

const DOMAIN_REGEX       = /^[a-z0-9]([a-z0-9\-]{0,61}[a-z0-9])?(\.[a-z]{2,})+$/;
const RESERVED_TLD_REGEX = /\.(local|internal|localhost|test|example|invalid)$/i;
const IP_REGEX           = /^\d{1,3}(\.\d{1,3}){3}$/;
const NAME_REGEX         = /^[a-zA-Z\s'\-\.]+$/;

// ─── Audit logging ────────────────────────────────────────────────────────────
// NEVER log: IP, name, domain, email, token, client ID, cache key, raw API response.

interface AuditEvent {
  timestamp: string;
  action: 'cache_hit' | 'cache_miss' | 'lookup_start' | 'lookup_complete'
        | 'rate_limited' | 'validation_error' | 'auth_failed' | 'error';
  keyHash: string;              // HMAC-SHA256(cacheKey), 12 hex chars
  ipHash: string;               // HMAC-SHA256(ip), 12 hex chars
  estimatedCredits: number;
  providerOrderHash?: string;   // HMAC-SHA256(providerSignature), 12 hex chars
  provider?: ContactProviderName;
  resultStatus?: string;
  durationMs?: number;
  // Result-count breakdown — only populated on lookup_complete after a provider call.
  // NEVER contains emails, names, domains, tokens, or raw provider responses.
  totalReturned?:    number;
  displayableCount?: number;
  verifiedCount?:    number;
  catchallCount?:    number;
  riskyCount?:       number;
  invalidCount?:     number;
  webmailCount?:     number;
  disposableCount?:  number;
}

function auditLog(event: AuditEvent): void {
  console.log('[enrich-contact]', JSON.stringify(event));
}

// ─── Input validation ─────────────────────────────────────────────────────────

function normalizeDomain(raw: string): string {
  return raw
    .replace(/^https?:\/\//i, '')
    .split('/')[0]
    .split('?')[0]
    .replace(/^www\./i, '')
    .toLowerCase()
    .trim();
}

type ValidatedInput = { firstName: string; lastName: string; domain: string; forceRefresh: boolean };
type ValidationError = { error: string; field: string };

function validateInput(body: unknown): ValidatedInput | ValidationError {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { error: 'Request body must be a JSON object', field: 'body' };
  }

  const b = body as Record<string, unknown>;

  const firstName    = typeof b.firstName === 'string' ? b.firstName.trim() : '';
  const lastName     = typeof b.lastName  === 'string' ? b.lastName.trim()  : '';
  const rawDomain    = typeof b.domain    === 'string' ? b.domain.trim()    : '';
  const forceRefresh = b.forceRefresh === true;

  if (!firstName)              return { error: 'First name is required', field: 'firstName' };
  if (firstName.length > 50)   return { error: 'First name too long (max 50)', field: 'firstName' };
  if (!NAME_REGEX.test(firstName)) return { error: 'First name contains invalid characters', field: 'firstName' };

  if (!lastName)               return { error: 'Last name is required', field: 'lastName' };
  if (lastName.length > 80)    return { error: 'Last name too long (max 80)', field: 'lastName' };
  if (!NAME_REGEX.test(lastName))  return { error: 'Last name contains invalid characters', field: 'lastName' };

  if (!rawDomain) return { error: 'Domain is required', field: 'domain' };

  const domain = normalizeDomain(rawDomain);
  if (!domain)                          return { error: 'Domain is required', field: 'domain' };
  if (domain.length > 253)              return { error: 'Domain too long', field: 'domain' };
  if (!domain.includes('.'))            return { error: 'Domain must contain at least one dot', field: 'domain' };
  if (!DOMAIN_REGEX.test(domain))       return { error: 'Invalid domain format', field: 'domain' };
  if (RESERVED_TLD_REGEX.test(domain))  return { error: 'Internal/reserved domain not allowed', field: 'domain' };
  if (IP_REGEX.test(domain))            return { error: 'IP addresses are not allowed', field: 'domain' };
  if (WEBMAIL_DOMAINS.has(domain))      return { error: 'Enter a company domain, not a personal email provider', field: 'domain' };

  if (b.expertId !== undefined) {
    if (typeof b.expertId !== 'string')         return { error: 'Invalid expertId', field: 'expertId' };
    if (b.expertId.length > 64)                 return { error: 'expertId too long', field: 'expertId' };
    if (!/^[a-zA-Z0-9\-_]+$/.test(b.expertId)) return { error: 'expertId contains invalid characters', field: 'expertId' };
  }

  return { firstName, lastName, domain, forceRefresh };
}

// ─── Best-email selection ─────────────────────────────────────────────────────

function isDisplayable(r: ProviderEmailResult): boolean {
  if (r.isWebmail)    return false;
  if (r.isDisposable) return false;
  if (r.isGibberish)  return false;
  if (!r.isValidFormat) return false;
  if (r.normalizedStatus === 'invalid' || r.normalizedStatus === 'risky') return false;
  const dom = r.email.split('@')[1]?.toLowerCase() ?? '';
  if (WEBMAIL_DOMAINS.has(dom)) return false;
  return true;
}

function pickBestResult(results: ProviderEmailResult[]): ProviderEmailResult | null {
  const displayable = results.filter(isDisplayable);
  if (displayable.length === 0) return null;
  return displayable.find(r => r.normalizedStatus === 'verified') ?? displayable[0];
}

// Counts only — no email addresses, names, domains, or raw API data.
function resultCounts(results: ProviderEmailResult[]) {
  const domOf = (r: ProviderEmailResult) => r.email.split('@')[1]?.toLowerCase() ?? '';
  return {
    totalReturned:    results.length,
    webmailCount:     results.filter(r => r.isWebmail || WEBMAIL_DOMAINS.has(domOf(r))).length,
    disposableCount:  results.filter(r => r.isDisposable).length,
    verifiedCount:    results.filter(r => r.normalizedStatus === 'verified').length,
    catchallCount:    results.filter(r => r.normalizedStatus === 'catchall').length,
    riskyCount:       results.filter(r => r.normalizedStatus === 'risky').length,
    invalidCount:     results.filter(r => r.normalizedStatus === 'invalid').length,
    displayableCount: results.filter(isDisplayable).length,
  };
}

// ─── Core lookup logic — provider waterfall ───────────────────────────────────
//
// Providers are tried in order. Hunter is only called if Snov returns no displayable
// professional email. Errors thrown by a provider propagate immediately.
//
// The global daily budget is decremented once PER PROVIDER CALL so a full Snov+Hunter
// waterfall costs 2 credits, not 1.

async function performLookup(
  providers: ContactProvider[],
  rateLimiterStore: RateLimiterStore,
  firstName: string,
  lastName: string,
  domain: string,
  cacheKey: string,
  keyHash: string,
  ipHash: string,
  providerOrderHash: string,
): Promise<ContactEnrichment> {
  const startTime        = Date.now();
  const cacheStore       = getCacheStore();
  let   providersCompleted = 0;

  for (const provider of providers) {
    // Check and decrement global budget before each provider call.
    // This ensures each API call (Snov, then Hunter if needed) counts separately.
    const budget = await checkAndIncrementGlobalBudget(rateLimiterStore);
    if (!budget.allowed) {
      throw Object.assign(
        new Error('Global provider budget exceeded'),
        { code: 'global_budget_exceeded', retryAfterMs: budget.retryAfterMs },
      );
    }

    // Informational per-provider counter (no hard limit)
    await incrementProviderDailyCount(rateLimiterStore, provider.name as ActiveProviderName);

    // THIS IS WHERE A CONTACT PROVIDER CREDIT MAY BE SPENT
    auditLog({
      timestamp: new Date().toISOString(),
      action: 'lookup_start', keyHash, ipHash, provider: provider.name,
      estimatedCredits: provider.estimateCreditsPerLookup({ firstName, lastName, domain }),
      providerOrderHash,
    });

    let results: ProviderEmailResult[];
    try {
      results = await provider.findProfessionalEmail({ firstName, lastName, domain });
    } catch (err) {
      // Partial timeout: at least one earlier provider completed successfully (returned
      // no displayable result). Cache a short not_found so the next request doesn't
      // re-trigger a slow waterfall immediately, but allow retrying sooner than normal.
      if (err instanceof Error && err.name === 'AbortError' && providersCompleted > 0) {
        const ttlMs     = 20 * 60 * 1000; // 20 minutes
        const notFound: ContactEnrichment = {
          best_email:    null,
          domain_used:   domain,
          name_used:     { first: firstName, last: lastName },
          looked_up_at:  Date.now(),
          expires_at:    Date.now() + ttlMs,
          lookup_status: 'not_found',
          provider:      'none',
        };
        await cacheStore.set(cacheKey, notFound, ttlMs);
        throw Object.assign(err, { code: 'provider_timeout', timedOutProvider: provider.name });
      }
      throw err;
    }

    providersCompleted++;
    const bestResult = pickBestResult(results);
    const counts     = resultCounts(results);

    if (bestResult) {
      const bestEmail: EnrichedEmail = {
        email:           bestResult.email,
        status:          bestResult.normalizedStatus as ContactStatus,
        is_valid_format: bestResult.isValidFormat,
        is_disposable:   bestResult.isDisposable,
        is_webmail:      bestResult.isWebmail,
        is_gibberish:    bestResult.isGibberish ?? false,
        provider:        bestResult.provider,
      };

      const ttlMs = ttlForStatus(bestEmail.status);

      const enrichment: ContactEnrichment = {
        best_email:    bestEmail,
        domain_used:   domain,
        name_used:     { first: firstName, last: lastName },
        looked_up_at:  Date.now(),
        expires_at:    Date.now() + ttlMs,
        lookup_status: 'found',
        provider:      provider.name,
      };

      await cacheStore.set(cacheKey, enrichment, ttlMs);

      auditLog({
        timestamp: new Date().toISOString(),
        action: 'lookup_complete', keyHash, ipHash, provider: provider.name,
        estimatedCredits: 0, resultStatus: 'found',
        durationMs: Date.now() - startTime,
        providerOrderHash,
        ...counts,
      });

      return enrichment;
    }

    // Provider returned no displayable result — log and fall through to next provider
    auditLog({
      timestamp: new Date().toISOString(),
      action: 'lookup_complete', keyHash, ipHash, provider: provider.name,
      estimatedCredits: 0, resultStatus: 'not_found',
      providerOrderHash,
      ...counts,
    });
  }

  // All providers exhausted — cache and return not_found
  const ttlMs = ttlForStatus('not_found');
  const enrichment: ContactEnrichment = {
    best_email:    null,
    domain_used:   domain,
    name_used:     { first: firstName, last: lastName },
    looked_up_at:  Date.now(),
    expires_at:    Date.now() + ttlMs,
    lookup_status: 'not_found',
    provider:      'none',
  };

  await cacheStore.set(cacheKey, enrichment, ttlMs);

  auditLog({
    timestamp: new Date().toISOString(),
    action: 'lookup_complete', keyHash, ipHash, provider: 'none',
    estimatedCredits: 0, resultStatus: 'not_found',
    durationMs: Date.now() - startTime,
    providerOrderHash,
  });

  return enrichment;
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST(request: NextRequest): Promise<Response> {
  // 1. Kill switch
  if (process.env.CONTACT_ENRICHMENT_ENABLED !== 'true') {
    return Response.json({ error: 'contact_enrichment_unavailable' }, { status: 503 });
  }

  // 2. Provider waterfall — at least one provider must be configured.
  // buildProviderWaterfall() throws in production if a listed provider is missing its API key.
  let providers: ContactProvider[];
  try {
    providers = buildProviderWaterfall();
  } catch (err) {
    console.error('[enrich-contact] Provider configuration error:', err instanceof Error ? err.message : String(err));
    return Response.json({ error: 'contact_enrichment_unavailable' }, { status: 503 });
  }
  if (providers.length === 0) {
    return Response.json({ error: 'contact_enrichment_unavailable' }, { status: 503 });
  }
  // Compute early so providerOrderHash is available for all audit events in this handler.
  const providerSignature = providers.map(p => p.name).join('+');
  const providerOrderHash = pseudonymize(providerSignature);

  // 3. LOG_HASH_SECRET required in production (pseudonymization depends on it)
  if (process.env.NODE_ENV === 'production' && !process.env.LOG_HASH_SECRET) {
    console.error('[enrich-contact] FATAL: LOG_HASH_SECRET not configured in production');
    return Response.json({ error: 'service_unavailable' }, { status: 503 });
  }

  // 4. Production fail-closed: require durable store (both URL and token)
  if (process.env.NODE_ENV === 'production') {
    if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
      console.error('[enrich-contact] FATAL: production requires UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN');
      return Response.json({ error: 'service_unavailable', reason: 'durable_store_required' }, { status: 503 });
    }
  }

  // 5. Admin token gate — constant-time comparison prevents timing attacks.
  // Replace with proper session/JWT auth before public launch.
  //
  // If CONTACT_ENRICHMENT_ADMIN_TOKEN is set: the incoming x-enrichment-token header
  // must match exactly. Missing or wrong → 401.
  // If it is NOT set in production: fail closed with 503 (no unauthenticated production path).
  // In development without the env var: skip this check (allows local testing).
  const adminToken = process.env.CONTACT_ENRICHMENT_ADMIN_TOKEN;
  if (!adminToken) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[enrich-contact] FATAL: CONTACT_ENRICHMENT_ADMIN_TOKEN not set in production');
      return Response.json({ error: 'service_unavailable' }, { status: 503 });
    }
    // dev — no token required
  } else {
    const providedToken = request.headers.get('x-enrichment-token') ?? '';
    const adminBuf    = Buffer.from(adminToken,    'utf8');
    const providedBuf = Buffer.from(providedToken, 'utf8');
    const lengthMatch = adminBuf.length === providedBuf.length;
    // Always run timingSafeEqual even on length mismatch (use adminBuf twice) to avoid
    // leaking the expected token length via early-return timing.
    const valueMatch  = timingSafeEqual(adminBuf, lengthMatch ? providedBuf : adminBuf);
    if (!lengthMatch || !valueMatch) {
      auditLog({
        timestamp: new Date().toISOString(),
        action: 'auth_failed', keyHash: 'n/a', ipHash: 'n/a', estimatedCredits: 0,
        providerOrderHash,
      });
      return Response.json({ error: 'not_authorized' }, { status: 401 });
    }
  }

  // 6. Request hardening
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return Response.json({ error: 'content_type_required' }, { status: 415 });
  }

  const contentLengthHeader = request.headers.get('content-length');
  if (contentLengthHeader && parseInt(contentLengthHeader, 10) > 2048) {
    return Response.json({ error: 'request_too_large' }, { status: 413 });
  }

  // Origin check — required in production. Fail closed if APP_URL is not configured.
  const origin = request.headers.get('origin');
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? process.env.APP_URL;
  if (origin) {
    if (!appUrl) {
      if (process.env.NODE_ENV === 'production') {
        console.error('[enrich-contact] FATAL: NEXT_PUBLIC_APP_URL (or APP_URL) not set in production — cannot validate Origin');
        return Response.json({ error: 'service_unavailable' }, { status: 503 });
      }
      // dev without APP_URL — allow (same-origin requests won't send Origin at all)
    } else if (origin !== appUrl) {
      return Response.json({ error: 'forbidden' }, { status: 403 });
    }
  }

  // 7. Parse + size-check body
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return Response.json({ error: 'invalid_request' }, { status: 400 });
  }

  if (rawBody.length > 2048) {
    return Response.json({ error: 'request_too_large' }, { status: 413 });
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  // 8. Input validation
  const validated = validateInput(parsedBody);
  if ('error' in validated) {
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    auditLog({
      timestamp: new Date().toISOString(),
      action: 'validation_error', keyHash: 'n/a', ipHash: pseudonymize(ip),
      estimatedCredits: 0, resultStatus: validated.field,
      providerOrderHash,
    });
    return Response.json({ error: 'invalid_input', field: validated.field, detail: validated.error }, { status: 400 });
  }

  const { firstName, lastName, domain, forceRefresh } = validated;
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';

  // providerSignature was computed at step 2; reused here for the cache key.
  // Changing EMAIL_PROVIDER_ORDER (e.g. snov+hunter → hunter+snov) changes the signature
  // and therefore the cache key, so old not_found entries never suppress a reordered waterfall.
  const cacheVersion = process.env.CONTACT_CACHE_VERSION ?? 'v1';
  const cacheKey = makeCacheKey(firstName, lastName, domain, providerSignature, cacheVersion);
  const keyHash  = pseudonymize(cacheKey);
  const ipHash   = pseudonymize(ip);

  // 9. Tier-1 rate limit: cheap per-IP throttle (BEFORE cache — prevents request spam)
  const throttleCheck = await checkRequestThrottle(getRateLimiterStore(), ip);
  if (!throttleCheck.allowed) {
    auditLog({ timestamp: new Date().toISOString(), action: 'rate_limited', keyHash, ipHash, estimatedCredits: 0, providerOrderHash });
    return Response.json(
      { error: 'rate_limited', retryAfterMs: throttleCheck.retryAfterMs },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((throttleCheck.retryAfterMs ?? 60_000) / 1000)) } }
    );
  }

  const cacheStore = getCacheStore();

  // 10. Cache read (skip on forceRefresh)
  if (!forceRefresh) {
    const cached = await cacheStore.get(cacheKey);
    if (cached) {
      auditLog({
        timestamp: new Date().toISOString(),
        action: 'cache_hit', keyHash, ipHash, provider: cached.provider,
        estimatedCredits: 0, resultStatus: cached.lookup_status,
        providerOrderHash,
      });
      return Response.json({ enrichment: cached });
    }
    auditLog({ timestamp: new Date().toISOString(), action: 'cache_miss', keyHash, ipHash, estimatedCredits: 0, providerOrderHash });
  }

  // 11. Tier-2 rate limits: per-IP/day and per-key/day (AFTER cache)
  // Global budget is NOT checked here — it is decremented inside performLookup
  // once per provider call so each waterfall step counts accurately.
  const creditCheck = await checkCreditLimits(getRateLimiterStore(), ip, cacheKey);
  if (!creditCheck.allowed) {
    auditLog({ timestamp: new Date().toISOString(), action: 'rate_limited', keyHash, ipHash, estimatedCredits: 0, providerOrderHash });
    return Response.json(
      { error: 'rate_limited', retryAfterMs: creditCheck.retryAfterMs },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((creditCheck.retryAfterMs ?? 60_000) / 1000)) } }
    );
  }

  // 12. Local in-flight deduplication (within one process)
  const existing = inFlightLookups.get(cacheKey);
  if (existing) {
    try   { return Response.json({ enrichment: await existing }); }
    catch { return Response.json({ error: 'lookup_failed' }, { status: 500 }); }
  }

  // 13. Distributed lock (prevents duplicate provider calls across instances)
  let lockId: string | null = null;
  if (cacheStore.acquireLock) {
    lockId = await cacheStore.acquireLock(cacheKey, 30_000);
    if (lockId === null) {
      // Another instance holds the lock — poll until it populates the cache
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 500));
        const populated = await cacheStore.get(cacheKey);
        if (populated) return Response.json({ enrichment: populated });
      }
      return Response.json({ error: 'service_unavailable' }, { status: 503, headers: { 'Retry-After': '5' } });
    }
  }

  // 14. Run provider waterfall
  const lookupPromise = performLookup(
    providers, getRateLimiterStore(),
    firstName, lastName, domain,
    cacheKey, keyHash, ipHash, providerOrderHash,
  );
  inFlightLookups.set(cacheKey, lookupPromise);

  try {
    const result = await lookupPromise;
    return Response.json({ enrichment: result });
  } catch (err) {
    const code = (err as { code?: string }).code;

    if (code === 'not_enough_credits') {
      auditLog({
        timestamp: new Date().toISOString(),
        action: 'error', keyHash, ipHash,
        estimatedCredits: 0, resultStatus: 'not_enough_credits',
        providerOrderHash,
      });
      return Response.json({ error: 'insufficient_provider_credits' }, { status: 402 });
    }

    if (code === 'provider_rate_limited') {
      auditLog({
        timestamp: new Date().toISOString(),
        action: 'rate_limited', keyHash, ipHash,
        estimatedCredits: 0, resultStatus: 'provider_upstream_429',
        providerOrderHash,
      });
      return Response.json({ error: 'rate_limited' }, { status: 429 });
    }

    if (code === 'global_budget_exceeded') {
      const retryAfterMs = (err as { retryAfterMs?: number }).retryAfterMs ?? 60_000;
      auditLog({ timestamp: new Date().toISOString(), action: 'rate_limited', keyHash, ipHash, estimatedCredits: 0, resultStatus: 'global_budget_exceeded', providerOrderHash });
      return Response.json(
        { error: 'rate_limited', retryAfterMs },
        { status: 429, headers: { 'Retry-After': String(Math.ceil(retryAfterMs / 1000)) } }
      );
    }

    if (code === 'provider_timeout') {
      const timedOutProvider = (err as { timedOutProvider?: string }).timedOutProvider;
      auditLog({
        timestamp: new Date().toISOString(),
        action: 'error', keyHash, ipHash,
        estimatedCredits: 0, resultStatus: 'provider_timeout',
        providerOrderHash,
      });
      return Response.json({ error: 'provider_timeout', timedOutProvider }, { status: 504 });
    }

    if (err instanceof Error && err.name === 'AbortError') {
      return Response.json({ error: 'lookup_timeout' }, { status: 504 });
    }

    console.error('[enrich-contact] lookup error:', err instanceof Error ? err.message : String(err));
    auditLog({ timestamp: new Date().toISOString(), action: 'error', keyHash, ipHash, estimatedCredits: 0, providerOrderHash });
    return Response.json({ error: 'lookup_failed' }, { status: 500 });
  } finally {
    inFlightLookups.delete(cacheKey);
    if (cacheStore.releaseLock && lockId) {
      await cacheStore.releaseLock(cacheKey, lockId).catch(() => {});
    }
  }
}
