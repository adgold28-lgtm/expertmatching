import { snovProvider }   from './snov';
import { hunterProvider } from './hunter';
import type { ContactProvider, ActiveProviderName } from './types';

export { snovProvider, hunterProvider };

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
    } else if (process.env.NODE_ENV === 'production') {
      throw new Error(
        `Contact provider "${name}" is listed in EMAIL_PROVIDER_ORDER but its API key is not configured. ` +
        `Set the required key or remove "${name}" from EMAIL_PROVIDER_ORDER.`,
      );
    } else {
      console.warn(`[contactProviders] Skipping unconfigured provider: ${name}`);
    }
  }

  return waterfall;
}

const ACTIVE_PROVIDERS: Record<ActiveProviderName, ContactProvider> = {
  snov:   snovProvider,
  hunter: hunterProvider,
};

// Returns a provider by name. Throws if the name is not a recognized active provider.
export function getContactProvider(name: string): ContactProvider {
  const provider = ACTIVE_PROVIDERS[name as ActiveProviderName];
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
