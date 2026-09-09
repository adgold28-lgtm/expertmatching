// Provider abstraction for professional email lookup.
// Add new providers here; the discovery chain and cache layers are
// provider-agnostic.
//
// The only consumer is lib/contactDiscovery.ts (called from the QStash worker
// app/api/jobs/contact-discovery/route.ts). Comments below that say "the route"
// mean that chain — the standalone /api/enrich-contact route they were written
// for no longer exists.

// 'none' is only used in ContactEnrichment.provider to mean "no provider found anything".
// Real provider implementations use ActiveProviderName.
export type ContactProviderName = 'snov' | 'hunter' | 'none';
export type ActiveProviderName  = Exclude<ContactProviderName, 'none'>; // 'snov' | 'hunter'

export interface ContactLookupInput {
  firstName: string;
  lastName: string;
  domain: string;
  /**
   * Caller-owned deadline. Every network call a provider makes aborts when this
   * fires, and a provider that polls stops polling. lib/contactDiscovery.ts
   * passes one so a single provider can never eat the whole job's wall clock;
   * without it each provider keeps its own internal timeouts.
   */
  signal?: AbortSignal;
}

// Normalized status from a provider result. 'not_found' is NOT included here — that is
// the conclusion reached by the route when the provider returns an empty array.
export type NormalizedEmailStatus = 'verified' | 'catchall' | 'risky' | 'invalid';

export interface ProviderEmailResult {
  email: string;
  provider: ActiveProviderName;
  providerStatus: string;           // raw status string from the provider (audit/debug only)
  normalizedStatus: NormalizedEmailStatus;
  confidence?: number;              // 0–100 if provider supplies it
  isWebmail: boolean;
  isDisposable: boolean;
  isValidFormat: boolean;
  isGibberish?: boolean;
  reason?: string | null;
}

export interface ContactProvider {
  readonly name: ActiveProviderName;
  // Returns true when the required env vars for this provider are present.
  // lib/contactDiscovery.discoverContact() filters the chain on this, so an
  // unconfigured provider is skipped rather than throwing mid-lookup.
  isConfigured(): boolean;
  // Returns filtered, classified email candidates (no webmail, no raw API response).
  // Returns an empty array when no professional email is found (not_found).
  // Throws with { code: 'not_enough_credits' } or { code: 'provider_rate_limited' }
  // on provider-level quota/rate errors. discoverContact() catches these and
  // records the code as the attempt outcome, then moves to the next provider —
  // an exhausted quota must not look like "this person has no address", because
  // only a genuine not_found is allowed into the negative cache.
  findProfessionalEmail(input: ContactLookupInput): Promise<ProviderEmailResult[]>;
  // Expected credit cost of one lookup. Nothing calls this today (both
  // providers return 1); it exists for a future cost-aware chain.
  estimateCreditsPerLookup(input: ContactLookupInput): number;
}

// Shared webmail/personal domain blocklist. Each provider filters its own
// results against it, so a webmail address can never reach the caller even if
// the provider fails to flag it. lib/domainSuggestions.ts keeps a second,
// broader list (social/news/directory hosts too) for domain derivation.
export const WEBMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com',
  'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'icloud.com', 'mac.com', 'me.com', 'aol.com',
  'proton.me', 'protonmail.com', 'proton.ch',
  'zoho.com', 'zohomail.com', 'mail.com',
  'fastmail.com', 'fastmail.fm', 'hey.com',
  'tutanota.com', 'tutanota.de',
]);
