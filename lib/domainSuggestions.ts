import type { Expert, SuggestedDomain } from '../types';

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

// ─── Known company → domain map ───────────────────────────────────────────────
// High-value, frequently-searched companies for which domain guessing is unreliable.
// These are returned with confidence 'medium' (source is known alias, not verified official).
// Each entry lists all commonly used domains; seen-set deduplicates across multiple matches.

interface CompanyEntry {
  pattern: RegExp;
  domains: string[];
  label:   string;
}

const KNOWN_COMPANY_DOMAINS: CompanyEntry[] = [
  // ── Poultry / meat processing integrators ──────────────────────────────────
  { pattern: /perdue\s*farms?/i,
    domains: ['perduefarms.com', 'perdue.com'],          label: 'Perdue Farms' },
  { pattern: /\bperdue\b/i,
    domains: ['perduefarms.com', 'perdue.com'],          label: 'Perdue Farms' },
  { pattern: /tyson\s*foods?/i,
    domains: ['tysonfoods.com', 'tyson.com'],            label: 'Tyson Foods' },
  { pattern: /\btyson\b/i,
    domains: ['tysonfoods.com', 'tyson.com'],            label: 'Tyson Foods' },
  { pattern: /pilgrim'?s?\s*pride/i,
    domains: ['pilgrims.com'],                           label: "Pilgrim's Pride" },
  { pattern: /pilgrim'?s?/i,
    domains: ['pilgrims.com'],                           label: "Pilgrim's" },
  { pattern: /wayne[-\s]sanderson\s*farms?|wayne[-\s]sanderson/i,
    domains: ['waynesandersonfarms.com', 'waynefarms.com', 'sandersonfarms.com'],
    label: 'Wayne-Sanderson Farms' },
  { pattern: /wayne\s*farms?/i,
    domains: ['waynefarms.com', 'waynesandersonfarms.com'], label: 'Wayne Farms' },
  { pattern: /sanderson\s*farms?/i,
    domains: ['sandersonfarms.com', 'waynesandersonfarms.com'], label: 'Sanderson Farms' },
  { pattern: /\bjbs\s*usa\b/i,
    domains: ['jbsusa.com', 'jbs.com'],                  label: 'JBS USA' },
  { pattern: /\bjbs\b/i,
    domains: ['jbs.com', 'jbsusa.com'],                  label: 'JBS' },
  { pattern: /\bcargill\b/i,
    domains: ['cargill.com'],                            label: 'Cargill' },
  // ── Processing equipment / technology vendors ──────────────────────────────
  { pattern: /\bmarel\b/i,   domains: ['marel.com'],    label: 'Marel' },
  { pattern: /\bbaader\b/i,  domains: ['baader.com'],   label: 'BAADER' },
  { pattern: /john\s*bean\s*technologies?/i,
    domains: ['jbtc.com'],                               label: 'JBT Corporation' },
  { pattern: /\bjbt\b/i,     domains: ['jbtc.com'],     label: 'JBT Corporation' },
  { pattern: /\btomra\b/i,   domains: ['tomra.com'],    label: 'TOMRA' },
  // ── Trade media ────────────────────────────────────────────────────────────
  { pattern: /watt\s*global\s*media/i,
    domains: ['wattglobalmedia.com', 'wattagnet.com'],   label: 'WATT Global Media' },
  { pattern: /wattagnet/i,
    domains: ['wattagnet.com', 'wattglobalmedia.com'],   label: 'WATTAgNet' },
  // ── Government / regulatory ────────────────────────────────────────────────
  { pattern: /agricultural\s*research\s*service|usda\s*ars/i,
    domains: ['ars.usda.gov', 'usda.gov'],               label: 'USDA ARS' },
  { pattern: /\busda\b/i,
    domains: ['usda.gov', 'ars.usda.gov'],               label: 'USDA' },
  { pattern: /\bfsis\b/i,
    domains: ['fsis.usda.gov', 'usda.gov'],              label: 'FSIS (USDA)' },
  { pattern: /\bfda\b/i,    domains: ['fda.gov'],       label: 'FDA' },
  // ── Sports / Major League Soccer ─────────────────────────────────────────
  { pattern: /\bmls\b/i,    domains: ['mlssoccer.com'], label: 'MLS' },
  { pattern: /\bmls\s*next\b/i, domains: ['mlsnext.com', 'mlssoccer.com'], label: 'MLS NEXT' },
  { pattern: /\busl\b/i,    domains: ['uslsoccer.com'], label: 'USL' },
];

// ─── Conservative heuristic ───────────────────────────────────────────────────
// Generates a .com guess ONLY when the company name is clean and unambiguous.
// This is a last resort — only runs when no known-map entry and no source links.
// Returns null when any of the following apply:
//   - Company is "Not specified" / blank
//   - Name has parentheses (often "formerly X" or "via Y")
//   - Name contains quotes or article-title markers
//   - Name has 4+ meaningful words (too complex to guess reliably)
//   - Name references a publication, magazine, journal, news outlet
//   - Normalized slug is very long (> 30 chars) or very short (< 3 chars)
//
// Low-confidence output: NEVER auto-prefilled; user must explicitly select.

function heuristicDomain(company: string): string | null {
  if (!company) return null;
  const raw = company.trim();

  // Never guess for "Not specified" or similar blanks
  if (/not\s*specified|unknown|n\/a|none/i.test(raw)) return null;

  // Never guess if parentheses present (signals "formerly", "via", "as of" qualifiers)
  if (/[()]/.test(raw)) return null;

  // Never guess if name has quotes (signals article titles or aliases)
  if (/["']/.test(raw)) return null;

  // Never guess for publication-like names
  if (/\b(magazine|journal|review|times|news|post|herald|tribune|media|press|weekly|monthly|daily|newsletter)\b/i.test(raw)) return null;

  // Never guess for names that are clearly not company names
  if (/\b(university|college|school|institute|academy)\b/i.test(raw)) {
    // Universities often have clear .edu domains but guessing them is unreliable
    // (e.g. "University of Arkansas" → uark.edu, not universityofarkansas.edu)
    return null;
  }

  // Remove legal suffixes
  let name = raw.toLowerCase();
  name = name.replace(
    /\b(llc|inc\.?|corp\.?|corporation|company|co\.?|ltd\.?|limited|group|holdings?|associates?|international|intl|services?|solutions?|consulting|technologies?|tech|foundation|association|federation|alliance)\b/g,
    ' ',
  );

  // Remove sport-specific suffixes (generates bad guesses like "ozarkunitedfc.com" which
  // the resolver should find via search instead)
  name = name.replace(/\b(fc|sc|ac|cf|united|sports?|youth|club|athletics?)\b/g, ' ');

  // Strip non-alphanumeric
  name = name.replace(/[^a-z0-9\s]/g, ' ');
  const words = name.split(/\s+/).filter(w => w.length > 0);

  // Too many words → unreliable guess
  if (words.length > 3) return null;

  const slug = words.join('');

  // Slug too short or too long
  if (slug.length < 3) return null;
  if (slug.length > 30) return null;

  return `${slug}.com`;
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function suggestDomainsForExpert(expert: Expert): SuggestedDomain[] {
  const suggestions: SuggestedDomain[] = [];
  const seen = new Set<string>();

  function add(s: SuggestedDomain) {
    const norm = normalizeDomain(s.domain);
    if (!norm || !norm.includes('.')) return;
    if (isDisallowedDomain(norm))     return;
    if (seen.has(norm))               return;
    seen.add(norm);
    suggestions.push({ ...s, domain: norm });
  }

  // (1) Company Website source links → high confidence, verified official
  for (const link of expert.source_links ?? []) {
    if (link.type === 'Company Website') {
      const dom = normalizeDomain(link.url);
      if (dom) {
        add({
          domain:           dom,
          label:            dom,
          confidence:       'high',
          reason:           'Listed as Company Website in sources',
          sourceUrl:        link.url,
          sourceType:       'source_link',
          verifiedOfficial: true,
        });
      }
    }
  }

  // (2) Known company map → medium confidence (trusted alias, not user-verified)
  const companyText = [expert.company, expert.title].filter(Boolean).join(' ');
  let knownMapMatched = false;
  for (const entry of KNOWN_COMPANY_DOMAINS) {
    if (entry.pattern.test(companyText)) {
      knownMapMatched = true;
      for (const domain of entry.domains) {
        add({
          domain,
          label:      entry.label,
          confidence: 'medium',
          reason:     `Known company alias: ${entry.label}`,
          sourceType: 'known_alias',
        });
      }
    }
  }

  // (3) Conservative heuristic → low confidence
  // Only runs when no known-map match and no source links, so it never
  // competes with a verified alias. Low-confidence items are NEVER auto-prefilled
  // (the caller must only prefill from the first high-confidence suggestion).
  if (!knownMapMatched && suggestions.length === 0 && expert.company) {
    const guess = heuristicDomain(expert.company);
    if (guess) {
      add({
        domain:     guess,
        label:      guess,
        confidence: 'low',
        reason:     `Generated from company name "${expert.company}" — verify before use`,
        sourceType: 'heuristic',
      });
    }
  }

  const order: Record<SuggestedDomain['confidence'], number> = { high: 0, medium: 1, low: 2 };
  suggestions.sort((a, b) => order[a.confidence] - order[b.confidence]);

  return suggestions;
}
