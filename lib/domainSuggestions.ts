// -----------------------------------------------------------------------------
// Company-domain heuristics and the "never use this host" blocklist.
//
// Pure — no network, no env, no secrets — which is why it is safe to import
// from both server and client code.
//
// Live consumers:
//   normalizeDomain / isDisallowedDomain — lib/contactDiscovery.ts, to turn an
//     expert's source links into a mail domain and to reject LinkedIn, news and
//     webmail hosts before a provider credit is spent on them.
//   isLinkedInProfileUrl               — components/ExpertCard.tsx.
//
// Removed 2026-09-09 (W4-1): suggestDomainsForExpert, the known-company domain
// map and the heuristic .com guesser went with lib/contactPathResolver.ts,
// their only consumer.
//
// Must never do: return a webmail or directory host as a company domain. A
// wrong domain here means a real cold email to a real stranger at the wrong
// company, so every path adds through add()/isDisallowedDomain.
// -----------------------------------------------------------------------------

// Re-export SuggestedDomain so existing imports of it from this file keep working.
export type { SuggestedDomain } from '../types';

// ─── Domain normalization ─────────────────────────────────────────────────────

export function normalizeDomain(input: string): string {
  return input
    .replace(/^https?:\/\//i, '')
    .split('/')[0]
    .split('?')[0]
    .replace(/^www\./i, '')
    .toLowerCase()
    .trim();
}

// ─── Disallowed domains ───────────────────────────────────────────────────────
// Social / media / webmail / directory / generic domains — never suggested.

const DISALLOWED = new Set([
  // Social / platforms
  'linkedin.com', 'twitter.com', 'x.com', 'facebook.com', 'instagram.com',
  'youtube.com', 'tiktok.com', 'reddit.com', 'github.com', 'medium.com',
  'substack.com', 'wordpress.com', 'blogspot.com', 'researchgate.net',
  'academia.edu', 'scholar.google.com',
  // Article / news aggregators / directories
  'news.google.com', 'google.com', 'bing.com', 'yahoo.com',
  'bloomberg.com', 'crunchbase.com', 'zoominfo.com', 'dnb.com', 'manta.com',
  'indeed.com', 'glassdoor.com', 'ziprecruiter.com',
  // Webmail
  'gmail.com', 'googlemail.com', 'ymail.com',
  'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'icloud.com', 'mac.com', 'me.com', 'aol.com',
  'proton.me', 'protonmail.com', 'proton.ch',
  'zoho.com', 'zohomail.com', 'mail.com',
  'fastmail.com', 'fastmail.fm', 'hey.com',
  'tutanota.com', 'tutanota.de',
]);

export function isDisallowedDomain(domain: string): boolean {
  const norm = normalizeDomain(domain);
  if (DISALLOWED.has(norm)) return true;
  if (/^localhost$/i.test(norm)) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(norm)) return true;
  if (/\.(local|internal|localhost|test|example|invalid)$/i.test(norm)) return true;
  return false;
}

// ─── LinkedIn profile URL check ───────────────────────────────────────────────
// Only person-profile URLs (linkedin.com/in/ or linkedin.com/pub/).
// Rejects company pages, searches, learning, jobs, etc.

export function isLinkedInProfileUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    if (host !== 'linkedin.com') return false;
    return /^\/(in|pub)\/[^/]+\/?$/.test(u.pathname);
  } catch {
    return false;
  }
}
