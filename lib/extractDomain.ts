import type { Expert } from '../types';

// Extract the expert's company domain for use in Snov.io email lookups.
//
// STRICT RULE: only use a source_links entry explicitly typed as 'Company Website'.
// Directories, articles, LinkedIn profiles, and generic source_url values are
// intentionally rejected — they belong to the directory/publication, not the
// expert's employer, and would produce wrong Snov lookup domains.
//
// Returns null if no Company Website link is present; the UI will ask the user
// to enter the domain manually before any credits are spent.
export function extractDomain(expert: Expert): string | null {
  const companyWebsite = expert.source_links?.find(l => l.type === 'Company Website');
  if (!companyWebsite?.url) return null;

  try {
    const hostname = new URL(companyWebsite.url).hostname;
    return hostname.replace(/^www\./i, '').toLowerCase() || null;
  } catch {
    return null;
  }
}
