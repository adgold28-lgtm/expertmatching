// lib/contactDiscovery.ts — Matchy finds the one address it will write to.
//
// docs/MATCHY_SPEC.md, workflow step 2: a bookmark starts contact discovery as
// a server job. "Silent, bounded attempts, one send." This module is the
// bounded part; app/api/jobs/contact-discovery/route.ts is the job around it.
//
// THE CHAIN, in order, at most one attempt each, no retries inside a job:
//   1. cache        — lib/contactCache.ts (a previous answer for this
//                     name+domain, including a previous "not found")
//   2. snov         — lib/contactProviders/snov.ts
//   3. hunter       — lib/contactProviders/hunter.ts (email-finder)
//   nothing else. When there is no company domain to look up, the local
//   heuristic runs first and Hunter's domain-search is its only fallback.
//
// BUDGETS: each provider gets an 8 s deadline (passed down as an AbortSignal,
// so an abandoned lookup stops making requests rather than running on), and the
// whole chain gets TOTAL_BUDGET_MS — under the 25 s the caller allows. A step
// that would start past the budget is skipped and recorded as 'skipped_budget'.
// Separately, MONEY: each provider call first takes one credit from the global
// daily ceiling (ENRICHMENT_DAILY_BUDGET, lib/rateLimiter.ts). A refusal skips
// that provider ('skipped_spend_budget'); all providers refused gives outcome
// 'unavailable' with reason 'budget'. The ceiling fails OPEN when Redis is down.
//
// GATES: CONTACT_ENRICHMENT_ENABLED must be exactly 'true' or the outcome is
// 'unavailable' and nothing is called. Every candidate must pass syntax
// validation and must not be a role address (info@, sales@, noreply@…) — we
// write to a person, never to a shared inbox.
//
// NEVER LOG: the email, the expert's name, the company, the domain. Counts,
// outcomes and durations only.

import type { ContactEnrichment, ContactStatus } from '../types';
import {
  createCacheStore,
  makeCacheKey,
  ttlForStatus,
  type CacheStore,
} from './contactCache';
import { snovProvider, hunterProvider } from './contactProviders';
import { hunterDomainSearch } from './contactProviders/hunter';
import type {
  ActiveProviderName,
  ContactProvider,
  ProviderEmailResult,
} from './contactProviders/types';
import { normalizeDomain, isDisallowedDomain } from './domainSuggestions';
import {
  checkAndIncrementGlobalBudget,
  createRateLimiterStore,
  type RateLimiterStore,
} from './rateLimiter';
import { getProject, updateExpertStatus } from './projectStore';
import { isWalkthrough } from './walkthrough';
import { getEntitlementsForProject, recordRestrictedAttempt } from './entitlements';
import { runSequenceStep } from './outreachSteps';
import { isSuppressed } from './outreachSuppressions';
import { emitEngagementEvent } from './engagementEvents';
import { getFirm } from './firmStore';

// ─── Result shape ─────────────────────────────────────────────────────────────

export interface DiscoveryAttempt {
  /** 'cache' | 'domain_heuristic' | 'hunter_domain_search' | 'snov' | 'hunter' */
  provider: string;
  /** 'hit' | 'miss' | 'found' | 'not_found' | 'timeout' | 'error' | 'skipped_*' */
  outcome:  string;
  ms:       number;
}

export interface DiscoveryResult {
  outcome:     'found' | 'not_found' | 'unavailable';
  /**
   * Why nothing was looked up, when `outcome` is 'unavailable'. 'budget' means
   * the day's provider spend ceiling refused every provider — we could not look,
   * as opposed to looking and finding nobody — so the caller can retry the
   * expert tomorrow rather than treating them as unreachable.
   */
  reason?:     'budget';
  email?:      string;
  provider?:   string;
  /** 0–100 when the provider supplies one. */
  confidence?: number;
  /** How deliverable the address looked — 'verified' or 'catchall' only. */
  verificationStatus?: ContactStatus;
  attempts:    DiscoveryAttempt[];
}

export interface DiscoverContactInput {
  projectId:    string;
  expertId:     string;
  name:         string;
  company:      string;
  title?:       string;
  sourceUrl?:   string;
  sourceLinks?: string[];
}

// ─── Budgets ──────────────────────────────────────────────────────────────────

/** Per-provider deadline. One attempt each — a job never retries a provider. */
export const PROVIDER_TIMEOUT_MS = 8_000;

/** Whole-chain deadline. The caller's contract is "under 25 s". */
export const TOTAL_BUDGET_MS = 24_000;

/** A "no address exists" answer is only worth caching for a week. */
const NOT_FOUND_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ─── Address validation ───────────────────────────────────────────────────────

/**
 * Shared inboxes. Matchy's intro is addressed to a person and asks them to
 * take a paid call; sending it to sales@ is spam, and a reply from a shared
 * inbox cannot be matched to the expert on the thread.
 */
const ROLE_LOCAL_PARTS = new Set([
  'info', 'information', 'contact', 'contactus', 'hello', 'hi', 'enquiries', 'enquiry',
  'inquiries', 'inquiry', 'general', 'main', 'office', 'reception', 'team', 'staff',
  'sales', 'presales', 'business', 'biz', 'partners', 'partnerships', 'bd',
  'support', 'help', 'helpdesk', 'service', 'services', 'customerservice', 'care',
  'admin', 'administrator', 'webmaster', 'postmaster', 'hostmaster', 'root',
  'noreply', 'no-reply', 'donotreply', 'do-not-reply', 'notifications', 'notification',
  'mailer-daemon', 'bounces', 'bounce', 'abuse', 'security', 'privacy', 'legal',
  'press', 'media', 'pr', 'communications', 'marketing', 'newsletter', 'news',
  'jobs', 'careers', 'recruiting', 'recruitment', 'hr', 'people', 'talent',
  'billing', 'invoices', 'invoice', 'accounts', 'accounting', 'finance', 'ap', 'ar',
  'orders', 'order', 'shop', 'store', 'booking', 'bookings', 'reservations',
  'feedback', 'subscribe', 'unsubscribe', 'mail', 'email', 'test',
]);

/**
 * True when the local part is a shared inbox rather than a person.
 * Matches the bare word and any separated form of it ("info.uk", "sales-team",
 * "no_reply"), which is how these addresses are written in practice.
 */
export function isRoleAddress(email: string): boolean {
  const local = email.toLowerCase().split('@')[0] ?? '';
  if (!local) return true;

  const bare = local.replace(/[._-]/g, '');
  if (ROLE_LOCAL_PARTS.has(local) || ROLE_LOCAL_PARTS.has(bare)) return true;

  // Any separated segment being a role word is enough: "info.emea", "hr-team".
  const segments = local.split(/[._-]+/).filter(Boolean);
  if (segments.length > 1 && segments.some(s => ROLE_LOCAL_PARTS.has(s))) return true;

  return false;
}

/**
 * Syntactic validation only — deliverability is the provider's job. Deliberately
 * stricter than RFC 5322: one @, a dotted domain, no leading/trailing/double
 * dots, and sane lengths. Anything odd is rejected rather than sent to.
 */
export function isValidEmailSyntax(email: string): boolean {
  const value = email.trim();
  if (value.length < 6 || value.length > 254) return false;
  if (/\s/.test(value)) return false;

  const parts = value.split('@');
  if (parts.length !== 2) return false;

  const [local, domain] = parts;
  if (!local || local.length > 64) return false;
  if (!/^[a-zA-Z0-9!#$%&'*+/=?^_`{|}~.\-]+$/.test(local)) return false;
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;

  if (domain.length > 253) return false;
  if (!/^[a-zA-Z0-9.-]+$/.test(domain)) return false;
  if (domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) return false;
  if (domain.startsWith('-') || domain.endsWith('-')) return false;

  const labels = domain.split('.');
  if (labels.length < 2) return false;
  if (labels.some(l => l.length === 0 || l.length > 63)) return false;

  const tld = labels[labels.length - 1];
  return /^[a-zA-Z]{2,24}$/.test(tld);
}

/** An address we are willing to write to: valid, and a person, not an inbox. */
export function isUsableAddress(email: string): boolean {
  return isValidEmailSyntax(email) && !isRoleAddress(email);
}

// ─── Name ─────────────────────────────────────────────────────────────────────

/**
 * First and last name for the providers. Middle names, initials and suffixes
 * ("Jr.", "III", "PhD") are dropped — providers match on first + last.
 */
export function splitName(name: string): { first: string; last: string } | null {
  const SUFFIXES = new Set(['jr', 'jr.', 'sr', 'sr.', 'ii', 'iii', 'iv', 'phd', 'ph.d.', 'md', 'mba', 'cfa', 'esq']);
  const parts = name
    .replace(/[,]/g, ' ')
    .split(/\s+/)
    .map(p => p.trim())
    .filter(Boolean)
    .filter(p => !SUFFIXES.has(p.toLowerCase()));

  if (parts.length < 2) return null;

  const first = parts[0];
  const last  = parts[parts.length - 1];
  // A single-letter "last name" is an initial, not a surname to look up.
  if (first.length < 2 || last.replace(/\./g, '').length < 2) return null;

  return { first, last };
}

// ─── Company domain heuristic ─────────────────────────────────────────────────

/** Legal-form words that are never part of a company's domain. */
const LEGAL_SUFFIXES = new Set([
  'inc', 'incorporated', 'llc', 'llp', 'lp', 'ltd', 'limited', 'plc', 'co',
  'corp', 'corporation', 'company', 'gmbh', 'ag', 'sa', 'bv', 'nv', 'ab',
  'as', 'oy', 'srl', 'spa', 'pty', 'pte', 'kk', 'group', 'holdings', 'holding',
]);

/** Words too generic to prove a domain belongs to this company. */
const WEAK_TOKENS = new Set([
  'the', 'and', 'of', 'for', 'at', 'a', 'an', 'global', 'international',
  'national', 'american', 'services', 'service', 'solutions', 'systems',
  'technologies', 'technology', 'industries', 'industrial', 'partners',
  'associates', 'consulting', 'consultants', 'management', 'ventures',
  'capital', 'university', 'college', 'institute', 'center', 'centre',
]);

/** Significant lowercase words of a company name, legal forms removed. */
export function companyTokens(company: string): string[] {
  return company
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter(t => !LEGAL_SUFFIXES.has(t))
    .filter(t => t.length >= 3);
}

/** "Acme Coatings Inc" → "acmecoatings". Empty when nothing is left. */
export function companySlug(company: string): string {
  return companyTokens(company).join('');
}

export interface DomainDerivation {
  domain: string | null;
  /** 'source_link_exact' | 'source_link_partial' | 'source_link_token' | 'none' */
  reason: string;
}

/**
 * Derives the company's mail domain from the links we already hold, scored
 * against the company name. LinkedIn, news, directory and webmail hosts are
 * excluded by lib/domainSuggestions.isDisallowedDomain, so a profile URL never
 * becomes a domain.
 *
 * A link only wins if the company name is visible in the host — a random
 * article host would otherwise send providers (and credits) at the wrong
 * company. When nothing matches, the caller falls back to Hunter's
 * domain-search; guessing "<slug>.com" is not done here because a wrong guess
 * costs a credit and can produce a plausible address at the wrong company.
 *
 * Pure — no network, no env.
 */
export function deriveCompanyDomain(input: {
  company?:     string;
  sourceUrl?:   string;
  sourceLinks?: string[];
}): DomainDerivation {
  const urls = [...(input.sourceLinks ?? []), ...(input.sourceUrl ? [input.sourceUrl] : [])];

  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const url of urls) {
    if (typeof url !== 'string' || !url.trim()) continue;
    const domain = normalizeDomain(url);
    if (!domain || !domain.includes('.')) continue;
    if (isDisallowedDomain(domain)) continue;   // LinkedIn et al. never get here
    if (seen.has(domain)) continue;
    seen.add(domain);
    candidates.push(domain);
  }

  if (candidates.length === 0) return { domain: null, reason: 'none' };

  const slug     = companySlug(input.company ?? '');
  const tokens   = companyTokens(input.company ?? '').filter(t => !WEAK_TOKENS.has(t));
  const scoreOf  = (domain: string): { score: number; reason: string } => {
    // Compare against the whole host with dots and hyphens removed, so
    // "acme-coatings.co.uk" still matches "acmecoatings".
    const flat  = domain.replace(/[.\-]/g, '');
    const label = domain.split('.')[0].replace(/-/g, '');

    if (slug && (label === slug || flat.startsWith(slug))) return { score: 100, reason: 'source_link_exact' };
    if (slug.length >= 5 && (flat.includes(slug) || slug.includes(label) && label.length >= 5)) {
      return { score: 70, reason: 'source_link_partial' };
    }
    const hits = tokens.filter(t => t.length >= 4 && flat.includes(t)).length;
    if (hits > 0) return { score: 30 + hits * 10, reason: 'source_link_token' };
    return { score: 0, reason: 'none' };
  };

  let best: { domain: string; score: number; reason: string } | null = null;
  for (const domain of candidates) {
    const { score, reason } = scoreOf(domain);
    if (score > 0 && (!best || score > best.score)) best = { domain, score, reason };
  }

  return best ? { domain: best.domain, reason: best.reason } : { domain: null, reason: 'none' };
}

// ─── Candidate ranking ────────────────────────────────────────────────────────

/**
 * Verified beats catch-all; nothing else is sendable. 'risky' is an unverified
 * guess and 'invalid' is a known-bad address — writing to either burns the
 * sending domain's reputation, which is the one asset outreach cannot rebuild.
 */
const STATUS_RANK: Record<string, number> = { verified: 2, catchall: 1 };

/** Below this, a provider's own confidence score is not worth a send. */
export const MIN_CONFIDENCE = 50;

/**
 * Best sendable address out of one provider's results, or null.
 * Pure — exported so scripts/test-contact-discovery.ts can pin the ordering.
 */
export function pickBestCandidate(results: ProviderEmailResult[]): ProviderEmailResult | null {
  const usable = results.filter(r =>
    typeof r.email === 'string' &&
    isUsableAddress(r.email) &&
    !r.isWebmail &&
    !r.isDisposable &&
    r.isValidFormat !== false &&
    r.isGibberish !== true &&
    STATUS_RANK[r.normalizedStatus] !== undefined &&
    (r.confidence === undefined || r.confidence >= MIN_CONFIDENCE),
  );

  if (usable.length === 0) return null;

  return usable.reduce((best, current) => {
    const bestRank    = STATUS_RANK[best.normalizedStatus]    ?? 0;
    const currentRank = STATUS_RANK[current.normalizedStatus] ?? 0;
    if (currentRank !== bestRank) return currentRank > bestRank ? current : best;
    return (current.confidence ?? 0) > (best.confidence ?? 0) ? current : best;
  });
}

// ─── Cache plumbing ───────────────────────────────────────────────────────────

function cacheStoreOrNull(): CacheStore | null {
  try {
    return createCacheStore();
  } catch {
    // No Redis configured — discovery still runs, it just cannot remember.
    return null;
  }
}

function providerSignature(providers: ContactProvider[]): string {
  return providers.length > 0 ? providers.map(p => p.name).join('+') : 'none';
}

function cacheVersion(): string {
  return process.env.CONTACT_CACHE_VERSION ?? 'v2';
}

// ─── The chain ────────────────────────────────────────────────────────────────

/** True only when enrichment is explicitly switched on. */
export function isDiscoveryEnabled(): boolean {
  return process.env.CONTACT_ENRICHMENT_ENABLED === 'true';
}

/**
 * Finds at most one address for one expert. Never throws: every failure is an
 * attempt row plus a terminal outcome, because the job around this has to write
 * something the client's status line can render.
 */
export async function discoverContact(input: DiscoverContactInput): Promise<DiscoveryResult> {
  const attempts: DiscoveryAttempt[] = [];
  const startedAt = Date.now();
  const remaining = (): number => TOTAL_BUDGET_MS - (Date.now() - startedAt);

  const record = (provider: string, outcome: string, since: number): void => {
    attempts.push({ provider, outcome, ms: Date.now() - since });
  };

  if (!isDiscoveryEnabled()) {
    return { outcome: 'unavailable', attempts };
  }

  const name = splitName(input.name ?? '');
  if (!name) {
    record('name', 'unparseable', startedAt);
    return { outcome: 'not_found', attempts };
  }

  // ── Domain: local heuristic, then Hunter's domain-search ──────────────────
  const heuristicAt = Date.now();
  const derived     = deriveCompanyDomain({
    company:     input.company,
    sourceUrl:   input.sourceUrl,
    sourceLinks: input.sourceLinks,
  });
  record('domain_heuristic', derived.domain ? derived.reason : 'none', heuristicAt);

  let domain = derived.domain;

  if (!domain && (input.company ?? '').trim() && hunterProvider.isConfigured()) {
    const searchAt = Date.now();
    const budget   = Math.min(PROVIDER_TIMEOUT_MS, remaining());
    if (budget <= 0) {
      record('hunter_domain_search', 'skipped_budget', searchAt);
    } else {
      const found = await hunterDomainSearch(input.company, undefined, budget);
      if (found && !isDisallowedDomain(found)) {
        domain = normalizeDomain(found);
        record('hunter_domain_search', 'found', searchAt);
      } else {
        record('hunter_domain_search', 'not_found', searchAt);
      }
    }
  }

  if (!domain) {
    logCounts(input.projectId, 'not_found', attempts);
    return { outcome: 'not_found', attempts };
  }

  // ── Provider chain ────────────────────────────────────────────────────────
  // Order is hardcoded here, NOT read from EMAIL_PROVIDER_ORDER — the
  // lib/contactProviders/index.buildProviderWaterfall() that honours that env
  // var has no callers. The provider names also feed the cache key, so adding a
  // provider changes the key and old not_found entries stop suppressing the
  // fuller chain (see lib/contactCache.makeCacheKey).
  //
  // SPEND GUARD: lib/rateLimiter.checkAndIncrementGlobalBudget runs once per
  // provider inside the loop below, so a Snov + Hunter waterfall spends two of
  // ENRICHMENT_DAILY_BUDGET's credits, not one — which is what the counter was
  // written for and what H-13 found nothing calling. A refusal skips that
  // provider (recorded as 'skipped_spend_budget') and moves on; if every one of
  // them is refused the outcome is 'unavailable' with reason 'budget', never
  // 'not_found', so nothing negative is cached and a retry tomorrow is free to
  // ask again.
  const providers = [snovProvider, hunterProvider].filter(p => p.isConfigured());

  const store    = cacheStoreOrNull();
  const cacheKey = makeCacheKey(name.first, name.last, domain, providerSignature(providers), cacheVersion());

  // 1. Cache. A stored 'not_found' is an answer too — it is what stops a
  //    re-bookmark spending credits on the same person twice in a week.
  if (store) {
    const cacheAt = Date.now();
    try {
      const hit = await store.get(cacheKey);
      if (hit && hit.lookup_status === 'found' && hit.best_email && isUsableAddress(hit.best_email.email)) {
        record('cache', 'hit_found', cacheAt);
        logCounts(input.projectId, 'found', attempts);
        return {
          outcome:            'found',
          email:              hit.best_email.email,
          provider:           hit.best_email.provider,
          verificationStatus: hit.best_email.status,
          attempts,
        };
      }
      if (hit && hit.lookup_status === 'not_found') {
        record('cache', 'hit_not_found', cacheAt);
        logCounts(input.projectId, 'not_found', attempts);
        return { outcome: 'not_found', attempts };
      }
      record('cache', 'miss', cacheAt);
    } catch {
      record('cache', 'error', cacheAt);
    }
  }

  if (providers.length === 0) {
    // Nothing configured to ask. Not the same as "this person has no address",
    // so it is never cached as not_found.
    record('providers', 'none_configured', startedAt);
    logCounts(input.projectId, 'unavailable', attempts);
    return { outcome: 'unavailable', attempts };
  }

  // 2 + 3. One attempt per provider, in order, each on its own deadline and
  //        each costing one credit from the global daily budget.
  let budgetRefusals = 0;

  for (const provider of providers) {
    const providerAt = Date.now();
    const budget     = Math.min(PROVIDER_TIMEOUT_MS, remaining());
    if (budget <= 0) {
      // 'skipped_budget' has meant the TIME budget here since this loop was
      // written (and still does at the domain-search step above), so the daily
      // SPEND refusal below gets its own name rather than overloading it.
      record(provider.name, 'skipped_budget', providerAt);
      continue;
    }

    // The daily spend ceiling. FAILS OPEN by design: a Redis outage must not
    // stop outreach, and the providers' own credit balances are the backstop.
    // Only an answer of "over budget" refuses (Session 7 rule: paid credential
    // paths fail closed, expert-facing work fails open — this is the latter).
    if (!(await withinGlobalBudget())) {
      budgetRefusals++;
      record(provider.name, 'skipped_spend_budget', providerAt);
      continue;
    }

    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), budget);

    try {
      const results = await provider.findProfessionalEmail({
        firstName: name.first,
        lastName:  name.last,
        domain,
        signal:    controller.signal,
      });

      const best = pickBestCandidate(results);
      if (best) {
        record(provider.name, 'found', providerAt);
        await writeCache(store, cacheKey, domain, name, best);
        logCounts(input.projectId, 'found', attempts);
        return {
          outcome:            'found',
          email:              best.email,
          provider:           best.provider,
          verificationStatus: best.normalizedStatus as ContactStatus,
          ...(best.confidence !== undefined && { confidence: best.confidence }),
          attempts,
        };
      }
      record(provider.name, 'not_found', providerAt);
    } catch (err) {
      const aborted = controller.signal.aborted ||
        (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError'));
      const code = (err as { code?: string } | null)?.code;
      record(
        provider.name,
        aborted ? 'timeout' : (code === 'not_enough_credits' || code === 'provider_rate_limited' ? code : 'error'),
        providerAt,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  // Nobody was asked, because the day's budget is spent. That is "we could not
  // look", not "nobody is there": no cache write, and an outcome the job maps to
  // contact_discovery_unavailable so the expert can be retried tomorrow.
  if (budgetRefusals > 0 && budgetRefusals === providers.length) {
    logCounts(input.projectId, 'unavailable', attempts);
    return { outcome: 'unavailable', reason: 'budget', attempts };
  }

  // Every configured provider answered "nobody by that name at that domain".
  // Only then is the negative worth remembering.
  const providersAnswered = attempts.some(a =>
    (a.provider === 'snov' || a.provider === 'hunter') && a.outcome === 'not_found');
  if (providersAnswered) await writeCache(store, cacheKey, domain, name, null);

  logCounts(input.projectId, 'not_found', attempts);
  return { outcome: 'not_found', attempts };
}

/**
 * One credit's worth of the global daily budget (ENRICHMENT_DAILY_BUDGET,
 * default 500), counted per PROVIDER call — which is what
 * lib/rateLimiter.checkAndIncrementGlobalBudget was written for and what H-13
 * found nothing calling.
 *
 * FAILS OPEN: no Redis, no store, or a store that throws all answer "allowed".
 * The ceiling exists to stop a loop burning a month of Snov and Hunter credits
 * in minutes, not to be a hard gate on outreach, and the providers' own balances
 * are the real backstop.
 */
async function withinGlobalBudget(): Promise<boolean> {
  try {
    const store = rateLimiterStoreOrNull();
    if (!store) return true;
    const { allowed } = await checkAndIncrementGlobalBudget(store);
    if (!allowed) console.warn('[contactDiscovery] daily provider budget reached');
    return allowed;
  } catch {
    return true;
  }
}

/** One rate-limiter store per process; null when one cannot be built. */
let _rlStore: RateLimiterStore | null | undefined;
function rateLimiterStoreOrNull(): RateLimiterStore | null {
  if (_rlStore === undefined) {
    try { _rlStore = createRateLimiterStore(); } catch { _rlStore = null; }
  }
  return _rlStore;
}

/** Stores the answer. Cache failures are never fatal — this swallows them. */
async function writeCache(
  store:  CacheStore | null,
  key:    string,
  domain: string,
  name:   { first: string; last: string },
  best:   ProviderEmailResult | null,
): Promise<void> {
  if (!store) return;

  const now    = Date.now();
  const status = (best?.normalizedStatus ?? 'not_found') as ContactStatus;
  const ttlMs  = best ? ttlForStatus(status) : NOT_FOUND_TTL_MS;

  const value: ContactEnrichment = {
    best_email: best
      ? {
          email:           best.email,
          status,
          is_valid_format: best.isValidFormat !== false,
          is_disposable:   best.isDisposable === true,
          is_webmail:      best.isWebmail === true,
          is_gibberish:    best.isGibberish === true,
          provider:        best.provider as ActiveProviderName,
        }
      : null,
    domain_used:   domain,
    name_used:     { first: name.first, last: name.last },
    looked_up_at:  now,
    expires_at:    now + ttlMs,
    lookup_status: best ? 'found' : 'not_found',
    provider:      best ? best.provider : 'none',
  };

  try {
    await store.set(key, value, ttlMs);
  } catch {
    // A cache that will not write is a slower next run, nothing more.
  }
}

/**
 * A search that found nobody is the one an operator has to be able to explain
 * — a missing key, an exhausted quota and a genuinely unlisted expert all look
 * identical from the outside, and the attempt sequence is what separates them.
 * A successful search logs nothing at all.
 *
 * Counts, outcomes and durations only — never the email, the name, the company
 * or the domain.
 */
function logCounts(projectId: string, outcome: string, attempts: DiscoveryAttempt[]): void {
  if (outcome === 'found') return;
  console.warn('[contactDiscovery] no address', JSON.stringify({
    projectId,
    outcome,
    steps:    attempts.length,
    totalMs:  attempts.reduce((sum, a) => sum + a.ms, 0),
    sequence: attempts.map(a => `${a.provider}:${a.outcome}`).join(','),
  }));
}

// ─── QStash scheduling ────────────────────────────────────────────────────────
//
// Mirrors lib/sourcingJob.publishSourcingJob exactly: the account is
// region-pinned (QSTASH_URL, fallback us-east-1) and the destination goes into
// the path verbatim — QStash rejects a percent-encoded URL.

export interface ContactDiscoveryJob {
  projectId: string;
  expertId:  string;
  /** 1 for the bookmark that started it. One attempt per job; no retries. */
  attempt:   number;
}

/** True when a job can be handed to QStash (production path). */
export function isQStashConfigured(): boolean {
  return Boolean(process.env.QSTASH_TOKEN);
}

/**
 * Publishes one discovery job for immediate delivery.
 * `Upstash-Retries: 0` — a redelivery would be a second cold-email attempt on
 * the same expert, so a failed job stays failed and the client re-bookmarks.
 */
export async function publishContactDiscoveryJob(job: ContactDiscoveryJob): Promise<void> {
  const token = process.env.QSTASH_TOKEN;
  if (!token) throw new Error('[contactDiscovery] QSTASH_TOKEN not configured');

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL
    ?? process.env.NEXT_PUBLIC_APP_URL
    ?? 'https://expertmatch.fit';
  const endpoint = `${baseUrl}/api/jobs/contact-discovery`;

  const qstashHost = (process.env.QSTASH_URL ?? 'https://qstash-us-east-1.upstash.io').replace(/\/+$/, '');

  const res = await fetch(`${qstashHost}/v2/publish/${endpoint}`, {
    method:  'POST',
    headers: {
      'Authorization':   `Bearer ${token}`,
      'Content-Type':    'application/json',
      'Upstash-Retries': '0',
    },
    body: JSON.stringify(job),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`[contactDiscovery] QStash publish failed: ${res.status} ${text.slice(0, 200)}`);
  }
}

// ─── The job ──────────────────────────────────────────────────────────────────
//
// Lives here rather than in app/api/jobs/contact-discovery/route.ts for one
// reason: a Next 14 route module may only export route handlers, and the
// bookmark route has to call this same function directly when QStash is not
// configured (local dev). The route is the QStash-signed door onto it.

/** What the job did. Written onto the expert as `contactStatus`. */
export type DiscoveryJobOutcome =
  | 'intro_sent'
  | 'intro_drafted'
  | 'intro_failed'
  | 'contact_not_found'
  | 'contact_suppressed'
  | 'contact_check_unavailable'
  | 'contact_discovery_unavailable'
  | 'expert_not_found';

/**
 * One discovery attempt for one bookmarked expert, start to finish:
 * find the address → store it → check the do-not-contact list → send Matchy's
 * intro (or draft it on review-first) → emit the events.
 *
 * Never throws and always writes a terminal `contactStatus` onto the expert, so
 * the engagement can never be left mid-flight with nothing to render.
 *
 * Never logs: the address, the expert's name, the company, the project name.
 */
export async function runContactDiscoveryJob(job: ContactDiscoveryJob): Promise<DiscoveryJobOutcome> {
  const { projectId, expertId } = job;
  const attempt = Number.isFinite(job.attempt) && job.attempt > 0 ? Math.floor(job.attempt) : 1;

  try {
    const project = await getProject(projectId);
    if (!project) {
      console.warn('[contactDiscovery] project not found', JSON.stringify({ projectId }));
      return 'expert_not_found';
    }

    const pe = project.experts.find(e => e.expert.id === expertId);
    if (!pe) {
      console.warn('[contactDiscovery] expert not found on project', JSON.stringify({ projectId }));
      return 'expert_not_found';
    }

    const firm  = await getFirm(project.firmDomain).catch(() => null);
    const orgId = firm?.id ?? null;
    const tier  = pe.expert.seniorityTier ?? 'senior';

    let contactEmail = pe.contactEmail;

    // Already have an address (the bookmark raced us, or a human filled it in):
    // skip discovery entirely and go straight to the intro. No credit spent.
    //
    // NOTE the race this opens: nothing here checks whether an intro has already
    // gone out. Two jobs for the same expert (the client bookmarks again while
    // the first job is still running, since status is still 'bookmarked' and the
    // bookmark route lets that through) can both reach runSequenceStep('intro')
    // and send two cold emails. runSequenceStep has no send-once guard either.
    // The single-attempt QStash publish prevents redelivery, not re-bookmarking.
    if (!contactEmail) {
      const result = await discoverContact({
        projectId,
        expertId,
        name:        pe.expert.name,
        company:     pe.expert.company,
        title:       pe.expert.title,
        sourceUrl:   pe.expert.source_url,
        sourceLinks: (pe.expert.source_links ?? []).map(link => link.url),
      });

      if (result.outcome === 'unavailable') {
        await writeOutcome(projectId, expertId, 'contact_discovery_unavailable');
        // `contact_not_found` is the closest allowed event kind — the payload
        // is what distinguishes "we could not look" from "nobody is there".
        // `reason: 'budget'` narrows it further: the day's provider ceiling
        // refused every provider, so this expert is worth retrying tomorrow
        // rather than being treated as unreachable (H-13).
        await emitEngagementEvent({
          projectId, expertId, orgId,
          type:    'contact_not_found',
          payload: {
            stage:  'discovery',
            reason: result.reason ?? 'unavailable',
            attempt, tier, steps: result.attempts.length,
          },
        });
        return 'contact_discovery_unavailable';
      }

      if (result.outcome === 'not_found' || !result.email) {
        await writeOutcome(projectId, expertId, 'contact_not_found');
        await emitEngagementEvent({
          projectId, expertId, orgId,
          type:    'contact_not_found',
          payload: {
            stage:   'discovery',
            reason:  'not_found',
            attempt,
            tier,
            steps:   result.attempts.length,
            totalMs: result.attempts.reduce((sum, a) => sum + a.ms, 0),
          },
        });
        return 'contact_not_found';
      }

      contactEmail = result.email;

      const provider = result.provider === 'snov' || result.provider === 'hunter'
        ? result.provider
        : 'none';

      await updateExpertStatus(projectId, expertId, {
        contactEmail,
        emailProvider:           provider,
        emailVerificationStatus: result.verificationStatus ?? 'risky',
        emailCheckedAt:          Date.now(),
        contactStatus:           'contact_found',
      });

      await emitEngagementEvent({
        projectId, expertId, orgId,
        type:    'contact_found',
        payload: {
          stage:      'discovery',
          attempt,
          tier,
          provider,
          steps:      result.attempts.length,
          ...(result.confidence !== undefined && { confidence: result.confidence }),
        },
      });
    }

    // Global do-not-contact list. Fails CLOSED — the same rule the bookmark
    // route applies before any send.
    const suppression = await isSuppressed(contactEmail);
    if (!suppression.ok || suppression.suppressed) {
      const outcome: DiscoveryJobOutcome = suppression.ok ? 'contact_suppressed' : 'contact_check_unavailable';
      await writeOutcome(projectId, expertId, outcome);
      await emitEngagementEvent({
        projectId, expertId, orgId,
        type:    'contact_not_found',
        payload: { stage: 'suppression', attempt, tier, suppressed: suppression.ok && suppression.suppressed },
      });
      return outcome;
    }

    // The intro — the same call the bookmark route makes when it already has an
    // address, so an expert reply lands on the thread the usual way.
    //
    // Walkthrough mode drafts rather than sends. This is defence in depth: the
    // bookmark route never enqueues this job on a walkthrough project (it will
    // not spend a provider credit either), and lib/emailSequence holds the send
    // regardless. Honoring it here as well means the STATUS is right too.
    // The account boundary (lib/entitlements.ts) is honored the same way: an
    // organization with no card on file gets the intro DRAFTED, never sent.
    const entitlements = await getEntitlementsForProject(projectId);
    if (!entitlements.canOutreachExperts) {
      await recordRestrictedAttempt(entitlements, { action: 'contact_discovery', projectId, expertId });
    }
    const draftOnly = project.reviewFirst === true || isWalkthrough(project) || !entitlements.canOutreachExperts;

    const sendResult = await runSequenceStep({
      projectId,
      expertId,
      step:      'intro',
      token:     pe.outreachToken ?? '',
      firmType:  firm?.firmType ?? null,
      firmSize:  firm?.firmSize ?? null,
      firmName:  firm?.name ?? null,
      draftOnly,
    });

    if (!sendResult.ok) {
      console.warn('[contactDiscovery] intro not sent', JSON.stringify({ projectId, reason: sendResult.error }));
      await writeOutcome(projectId, expertId, 'intro_failed');
      return 'intro_failed';
    }

    // Send-once guard refused: the intro already went out on an earlier call
    // (the race noted above, at the "already have an address" branch — two
    // discovery jobs for the same expert both reaching runSequenceStep). This
    // call sent nothing, so it does not emit a second `intro_sent` event and
    // does not re-write `contactStatus` — the earlier, actually-sending call
    // already wrote it. Mirrors the bookmark route's handling of the same
    // signal (see app/api/.../bookmark/route.ts).
    if (sendResult.alreadySent) {
      return draftOnly ? 'intro_drafted' : 'intro_sent';
    }

    // Whether it went is on the status the step wrote, not on `draftOnly`: the
    // step also holds an intro it has no personal line for (introNeedsWhyThem,
    // lib/outreachSteps.ts), and the send chokepoint can refuse.
    const sentPe = sendResult.project.experts.find(e => e.expert.id === expertId);
    const sent   = sentPe?.status === 'contacted';

    if (sent) {
      await emitEngagementEvent({
        projectId, expertId, orgId,
        type:    'intro_sent',
        payload: {
          hasAddress: true,
          stage:      'discovery',
          attempt,
          tier,
          expertRate: pe.expertRate ?? 0,
          clientRate: pe.clientRate ?? 0,
          introArm:   sentPe?.introArm ?? null,
        },
      });
    }

    // runSequenceStep owns `status`; contactStatus records how it ended so the
    // Matchy line can say it even after a page reload.
    await writeOutcome(projectId, expertId, sent ? 'intro_sent' : 'intro_drafted');
    return sent ? 'intro_sent' : 'intro_drafted';
  } catch (err) {
    console.error('[contactDiscovery] job failed', JSON.stringify({
      projectId,
      reason: err instanceof Error ? err.message.slice(0, 120) : 'unknown',
    }));
    await writeOutcome(projectId, expertId, 'contact_not_found');
    return 'contact_not_found';
  }
}

/** Writes the terminal outcome. Swallows write errors — nothing left to retry. */
async function writeOutcome(
  projectId: string,
  expertId:  string,
  outcome:   DiscoveryJobOutcome,
): Promise<void> {
  try {
    await updateExpertStatus(projectId, expertId, {
      contactStatus:  outcome,
      emailCheckedAt: Date.now(),
    });
  } catch (err) {
    console.error('[contactDiscovery] could not write terminal outcome', JSON.stringify({
      projectId,
      reason: err instanceof Error ? err.message.slice(0, 120) : 'unknown',
    }));
  }
}

/**
 * Local-dev fallback: run the job in-process without blocking the response.
 * Next 14 has no `after()` helper, so this is a deliberate floating promise —
 * runContactDiscoveryJob never throws, so a terminal outcome is always written.
 */
export function runContactDiscoveryJobDetached(job: ContactDiscoveryJob): void {
  void runContactDiscoveryJob(job).catch(() => {
    // runContactDiscoveryJob handles its own errors; this is belt-and-braces.
  });
}
