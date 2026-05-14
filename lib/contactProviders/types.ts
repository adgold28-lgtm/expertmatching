// Provider abstraction for professional email lookup.
// Add new providers here; the route and cache layers are provider-agnostic.

// 'none' is only used in ContactEnrichment.provider to mean "no provider found anything".
// Real provider implementations use ActiveProviderName.
export type ContactProviderName = 'snov' | 'hunter' | 'none';
export type ActiveProviderName  = Exclude<ContactProviderName, 'none'>; // 'snov' | 'hunter'

export interface ContactLookupInput {
  firstName: string;
  lastName: string;
  domain: string;
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
  // Route checks this before building the waterfall — unconfigured providers are skipped.
  isConfigured(): boolean;
  // Returns filtered, classified email candidates (no webmail, no raw API response).
  // Returns an empty array when no professional email is found (not_found).
  // Throws with { code: 'not_enough_credits' } or { code: 'provider_rate_limited' }
  // on provider-level quota/rate errors so the route can return the right HTTP status.
  findProfessionalEmail(input: ContactLookupInput): Promise<ProviderEmailResult[]>;
  // Returns the expected credit cost for one lookup (used in audit logs).
  estimateCreditsPerLookup(input: ContactLookupInput): number;
}

// Shared webmail/personal domain blocklist — used by providers to filter results
// and by the route to reject webmail company domains at input validation time.
export const WEBMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com',
  'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'icloud.com', 'mac.com', 'me.com', 'aol.com',
  'proton.me', 'protonmail.com', 'proton.ch',
  'zoho.com', 'zohomail.com', 'mail.com',
  'fastmail.com', 'fastmail.fm', 'hey.com',
  'tutanota.com', 'tutanota.de',
]);
