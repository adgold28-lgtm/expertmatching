// Contact path resolver — finds official domains and public contact emails
// for experts at small, obscure, or non-obvious companies.
//
// This module uses the configured search provider (Tavily / ScrapingBee) to
// supplement local heuristics. It does NOT call Snov or Hunter — no email
// provider credits are spent here.
//
// Caching: results stored in Upstash Redis for 30 days. Cache key is a
// HMAC hash of expertName|company|title — raw strings never stored in key names.
//
// NEVER logged: expert names, company names, raw emails, raw search results.

import { createHmac } from 'crypto';
import type { ContactPathSuggestion, PublicContactEmail, SuggestedDomain, Expert } from '../types';
import { suggestDomainsForExpert, normalizeDomain, isDisallowedDomain } from './domainSuggestions';
import { searchWithFallback } from './searchProviders';
import { getUpstashClient } from './upstashRedis';

// ─── Cache ─────────────────────────────────────────────────────────────────────
// 30 days — official domains are very stable; public emails may change but
// 30-day caching is acceptable given the fallback nature of this data.

const CACHE_TTL_SEC = 30 * 24 * 60 * 60;

function cacheKey(expertName: string, company: string, title: string): string {
  const raw    = [expertName, company, title].map(s => s.toLowerCase().trim()).join('|');
  const secret = process.env.LOG_HASH_SECRET ?? 'dev-insecure-fallback';
  return createHmac('sha256', secret).update(raw).digest('hex').slice(0, 32);
}

async function getCached(key: string): Promise<ContactPathSuggestion | null> {
  const redis = getUpstashClient();
  if (!redis) return null;
  try {
    const raw = await redis.get(`cpath:${key}`);
    if (!raw) return null;
    return JSON.parse(raw) as ContactPathSuggestion;
  } catch {
    return null;
  }
}

async function setCached(key: string, value: ContactPathSuggestion): Promise<void> {
  const redis = getUpstashClient();
  if (!redis) return;
  try {
    await redis.set(`cpath:${key}`, JSON.stringify(value), { ex: CACHE_TTL_SEC });
  } catch {
    // Non-fatal: if cache write fails, the result is still returned to the client
  }
}

// ─── Public email extraction ──────────────────────────────────────────────────
// Extracts role-based public contact emails from search snippet text.
// Only accepts emails on the target domain with a recognized role prefix.
// Personal-looking addresses (first.last@) are rejected.

const EMAIL_RE = /\b([a-zA-Z0-9._%+\-]{1,50}@[a-zA-Z0-9.\-]{1,100}\.[a-zA-Z]{2,10})\b/g;

// Role-based prefixes that indicate a shared/public inbox, not a personal email
const ROLE_PREFIXES = new Set([
  'info', 'contact', 'hello', 'team', 'office', 'staff',
  'media', 'press', 'pr', 'communications',
  'sales', 'biz', 'business', 'partnerships',
  'support', 'help', 'service', 'helpdesk',
  'admissions', 'enrollment', 'registrar',
  'membership', 'volunteer', 'donate',
  'director', 'coordinator', 'admin', 'manager',
  'general', 'inquiries', 'enquiries',
]);

function isRoleEmail(prefix: string): boolean {
  const p = prefix.toLowerCase();
  if (ROLE_PREFIXES.has(p)) return true;
  // Accept "info.soccer@", "contact.us@" etc.
  if (Array.from(ROLE_PREFIXES).some(r => p.startsWith(r + '.') || p.endsWith('.' + r))) return true;
  return false;
}

function looksPersonal(prefix: string): boolean {
  // Reject clear first.last or f.last patterns
  return /^[a-z]{2,20}\.[a-z]{2,20}$/i.test(prefix);
}

function inferContactType(prefix: string): PublicContactEmail['contactType'] {
  const p = prefix.toLowerCase();
  if (['info', 'contact', 'hello', 'office', 'team', 'general', 'inquiries', 'enquiries'].includes(p)) return 'general';
  if (['media', 'press', 'pr', 'communications'].includes(p)) return 'media';
  if (['sales', 'biz', 'business', 'partnerships'].includes(p)) return 'sales';
  if (['support', 'help', 'service', 'helpdesk'].includes(p)) return 'support';
  if (['admissions', 'enrollment', 'registrar', 'membership'].includes(p)) return 'department';
  return 'unknown';
}

function extractRoleEmails(
  texts: string[],
  targetDomain: string,
  sourceUrl: string,
): PublicContactEmail[] {
  const found: PublicContactEmail[] = [];
  const seen  = new Set<string>();

  for (const text of texts) {
    const matches = Array.from(text.matchAll(EMAIL_RE));
    for (const match of matches) {
      const raw    = match[1].toLowerCase();
      const [prefix, emailDomain] = raw.split('@');
      if (!prefix || !emailDomain) continue;
      // Only accept emails on the exact target domain
      if (emailDomain !== targetDomain) continue;
      if (seen.has(raw)) continue;
      if (!isRoleEmail(prefix)) continue;
      if (looksPersonal(prefix)) continue;
      seen.add(raw);
      found.push({
        email:       raw,
        label:       raw,
        sourceUrl,
        confidence:  'medium',
        contactType: inferContactType(prefix),
        reason:      `Public role-based contact email found at ${targetDomain}`,
      });
    }
  }
  return found;
}

// ─── Domain scoring ───────────────────────────────────────────────────────────
// Scores how well a search result URL's domain matches the company name.
// Returns null if there is no meaningful match.

function scoreDomainMatch(domain: string, company: string): SuggestedDomain['confidence'] | null {
  const domainBase  = domain.split('.')[0].toLowerCase();
  if (!domainBase || domainBase.length < 2) return null;

  // Normalize company: strip common suffixes / sports terms / punctuation
  const companyClean = company.toLowerCase()
    .replace(/\b(llc|inc|corp|company|co|ltd|limited|group|holdings|association|federation|alliance|foundation|club|fc|sc|ac|united|sports?|youth|athletics?)\b/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, '')
    .trim();

  if (!companyClean || companyClean.length < 2) return null;

  // High: domain base exactly equals normalized company name
  if (domainBase === companyClean) return 'high';
  // High: .gov / .edu and domain contains company name (government/university match)
  if (/\.(gov|edu)$/.test(domain)) {
    if (domainBase.includes(companyClean) || companyClean.includes(domainBase)) return 'high';
  }
  // Medium: strong substring match
  if (domainBase.includes(companyClean) || companyClean.includes(domainBase)) return 'medium';
  // Medium: significant word overlap (≥2 company words in domain)
  const words = company.toLowerCase().split(/\W+/).filter(w => w.length > 2);
  const hits  = words.filter(w => domainBase.includes(w)).length;
  if (hits >= 2) return 'medium';
  // Low: single meaningful word match
  if (hits === 1 && domainBase.length <= companyClean.length + 8) return 'low';

  return null;
}

// ─── Search queries ───────────────────────────────────────────────────────────

function buildSearchQueries(company: string, name: string): string[] {
  const base = company.trim();
  const queries = [`"${base}" official website`, `"${base}" contact email`];
  // For smaller orgs, add queries that surface contact pages and staff info
  if (base.length < 50) {
    queries.push(`"${base}" staff contact`);
    queries.push(`"${base}" "mailto"`);
  }
  return queries;
}

// ─── Core resolver ────────────────────────────────────────────────────────────

export interface ResolverInput {
  expert:        Expert;
  forceRefresh?: boolean;
}

export async function resolveContactPaths(input: ResolverInput): Promise<ContactPathSuggestion> {
  const { expert, forceRefresh = false } = input;

  const key = cacheKey(expert.name, expert.company, expert.title);

  if (!forceRefresh) {
    const cached = await getCached(key);
    if (cached) {
      console.log(JSON.stringify({
        action: 'contact_path_resolve', cache: 'hit',
        domainSuggestionsCount: cached.domains.length,
        publicContactEmailCount: cached.publicContactEmails.length,
      }));
      return cached;
    }
  }

  // Step 1: local heuristics — always fast, no API call
  const localSuggestions = suggestDomainsForExpert(expert);

  // Whether we already have a high-confidence domain from a verified source link
  const hasVerifiedSourceLink = localSuggestions.some(
    s => s.confidence === 'high' && s.sourceType === 'source_link',
  );

  const seenDomains       = new Set<string>(localSuggestions.map(s => s.domain));
  const searchedDomains:  SuggestedDomain[]    = [];
  const publicEmails:     PublicContactEmail[] = [];
  const notes:            string[]             = [];
  let   usedSearchProvider                     = false;

  const company = expert.company?.trim() ?? '';
  const noSearchNeeded = !company || /not\s*specified|unknown|n\/a|none/i.test(company);

  if (!noSearchNeeded) {
    const queries = buildSearchQueries(company, expert.name);

    // If we already have a verified source link, only search for public emails on that domain.
    // Otherwise, search for official domain + emails.
    const domainToSearchEmails = hasVerifiedSourceLink
      ? localSuggestions.find(s => s.sourceType === 'source_link')?.domain ?? null
      : null;

    const searchLimit = hasVerifiedSourceLink ? 2 : 3;

    try {
      for (const query of queries.slice(0, searchLimit)) {
        const results = await searchWithFallback({ query, maxResults: 5 });
        usedSearchProvider = true;

        for (const result of results) {
          if (!result.url) continue;
          try {
            const parsed = new URL(result.url);
            const domain = normalizeDomain(parsed.hostname);
            if (!domain || isDisallowedDomain(domain)) continue;

            // Skip this result if it's from a social/article/directory — only accept plausible official sites
            if (isArticleOrDirectoryDomain(domain)) continue;

            // Score domain match
            if (!hasVerifiedSourceLink && !seenDomains.has(domain)) {
              const confidence = scoreDomainMatch(domain, company);
              if (confidence) {
                seenDomains.add(domain);
                searchedDomains.push({
                  domain,
                  label:            result.title || domain,
                  confidence,
                  reason:           `Found via web search`,
                  sourceUrl:        result.url,
                  sourceType:       'search_result',
                  verifiedOfficial: confidence === 'high',
                });
              }
            }

            // Extract public role emails from snippet
            const targetDomain = domainToSearchEmails ?? domain;
            if (result.snippet && (domain === targetDomain || seenDomains.has(targetDomain))) {
              const emails = extractRoleEmails(
                [result.snippet, result.title ?? ''],
                targetDomain,
                result.url,
              );
              publicEmails.push(...emails);
            }
          } catch { /* unparseable URL — skip */ }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notes.push('Search provider unavailable — showing local suggestions only.');
      console.warn('[contactPathResolver] search error:', msg);
    }
  }

  // Deduplicate public emails
  const seenEmails  = new Set<string>();
  const dedupEmails = publicEmails.filter(e => {
    if (seenEmails.has(e.email)) return false;
    seenEmails.add(e.email);
    return true;
  });

  // Merge domains: local first, then search-found
  const allDomains: SuggestedDomain[] = [...localSuggestions, ...searchedDomains];
  const order: Record<SuggestedDomain['confidence'], number> = { high: 0, medium: 1, low: 2 };
  allDomains.sort((a, b) => order[a.confidence] - order[b.confidence]);

  const result: ContactPathSuggestion = {
    domains:             allDomains,
    publicContactEmails: dedupEmails,
    ...(notes.length > 0 && { notes }),
    resolvedAt:          Date.now(),
  };

  await setCached(key, result);

  console.log(JSON.stringify({
    action: 'contact_path_resolve', cache: 'miss',
    domainSuggestionsCount: allDomains.length,
    publicContactEmailCount: dedupEmails.length,
    usedSearchProvider,
  }));

  return result;
}

// ─── Article/directory domain guard ───────────────────────────────────────────
// Prevents adding domains from news sites, directories, or social networks
// as official company domains — even when they appear in search results.

const ARTICLE_DIRECTORY_DOMAINS = new Set([
  'prnewswire.com', 'businesswire.com', 'globenewswire.com', 'newswire.com',
  'accesswire.com', 'prweb.com', 'cision.com',
  'sec.gov', // Skip for domain matching — it's a regulator, not a company
  'bbb.org', 'yelp.com', 'angieslist.com',
  'whitepages.com', 'spokeo.com', 'beenverified.com',
  'dun.com', 'manta.com', 'hoovers.com',
  'pitchbook.com', 'crunchbase.com', 'zoominfo.com',
  'linkedin.com', 'twitter.com', 'facebook.com', 'instagram.com',
  'glassdoor.com', 'indeed.com', 'ziprecruiter.com',
]);

function isArticleOrDirectoryDomain(domain: string): boolean {
  return ARTICLE_DIRECTORY_DOMAINS.has(domain) || isDisallowedDomain(domain);
}
