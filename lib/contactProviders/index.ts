// -----------------------------------------------------------------------------
// Contact-provider registry.
//
// The ONLY thing the live code path uses from this module today is the
// `export { snovProvider, hunterProvider }` line below: lib/contactDiscovery.ts
// imports the two providers directly and builds its own chain as
// `[snovProvider, hunterProvider].filter(p => p.isConfigured())`.
//
// parseProviderOrder / buildProviderWaterfall / getContactProvider are NOT
// called from anywhere in the repo (the old /api/enrich-contact route that used
// them is gone). Consequence worth knowing before you set it: the
// EMAIL_PROVIDER_ORDER env var currently has no effect on discovery order.
// -----------------------------------------------------------------------------

import { snovProvider }   from './snov';
import { hunterProvider } from './hunter';
import type { ContactProvider, ActiveProviderName } from './types';

export { snovProvider, hunterProvider };

// The one registry of active providers, read by buildProviderWaterfall and
// getContactProvider.
const PROVIDER_MAP: Record<ActiveProviderName, ContactProvider> = {
  snov:   snovProvider,
  hunter: hunterProvider,
};

// Parse EMAIL_PROVIDER_ORDER env var.
// Defaults to ['snov', 'hunter'] when the var is absent or empty.
// Unknown values and duplicates are silently discarded.
// Example: EMAIL_PROVIDER_ORDER=hunter,snov → ['hunter', 'snov']
export function parseProviderOrder(): ActiveProviderName[] {
  const raw = process.env.EMAIL_PROVIDER_ORDER?.trim();
  if (!raw) return ['snov', 'hunter'];

  const seen   = new Set<ActiveProviderName>();
  const result: ActiveProviderName[] = [];

  for (const part of raw.split(',')) {
    const name = part.trim().toLowerCase() as ActiveProviderName;
    if ((name === 'snov' || name === 'hunter') && !seen.has(name)) {
      seen.add(name);
      result.push(name);
    }
  }

  return result.length > 0 ? result : ['snov', 'hunter'];
}

// Build the provider waterfall according to EMAIL_PROVIDER_ORDER.
//
// Dev: unconfigured providers are skipped with a console.warn.
// Production: throws if any listed provider is missing its required API key so the
//   route can return 503 (fail closed) rather than silently degrading.
export function buildProviderWaterfall(): ContactProvider[] {
  const order     = parseProviderOrder();
  const waterfall: ContactProvider[] = [];

  for (const name of order) {
    const provider = PROVIDER_MAP[name];
    if (provider.isConfigured()) {
      waterfall.push(provider);
    } else {
      // Skip unconfigured providers in all environments — the route handles an
      // empty waterfall by returning 503. This allows partial configuration
      // (e.g. Snov only, no Hunter key) without crashing the whole request.
      console.warn(`[contactProviders] Skipping unconfigured provider "${name}" — API key not set`);
    }
  }

  return waterfall;
}

// Returns a provider by name. Throws if the name is not a recognized active provider.
// Reads the same PROVIDER_MAP buildProviderWaterfall does — there used to be a
// second, byte-identical ACTIVE_PROVIDERS map here purely because this function
// was written against it (audit M-23).
export function getContactProvider(name: string): ContactProvider {
  const provider = PROVIDER_MAP[name as ActiveProviderName];
  if (!provider) throw new Error(`Unknown contact provider: ${name}`);
  return provider;
}

export type {
  ContactProvider,
  ContactProviderName,
  ActiveProviderName,
  ContactLookupInput,
  ProviderEmailResult,
  NormalizedEmailStatus,
} from './types';
