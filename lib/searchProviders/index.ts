import { tavilyProvider }      from './tavily';
import { scrapingbeeProvider } from './scrapingbee';
import type { SearchProvider, ExpertSearchInput, SearchResult } from './types';

export { tavilyProvider, scrapingbeeProvider };

// Returns the configured primary search provider.
// SEARCH_PROVIDER=tavily (default) or SEARCH_PROVIDER=scrapingbee.
// Throws if neither required env var is set — caller must handle at route level.
export function getSearchProvider(): SearchProvider {
  const configured = process.env.SEARCH_PROVIDER;

  if (configured === 'scrapingbee') {
    if (!scrapingbeeProvider.isConfigured()) throw new Error('SEARCH_PROVIDER=scrapingbee but SCRAPINGBEE_KEY is not set');
    return scrapingbeeProvider;
  }

  // Default: prefer Tavily; fall through to ScrapingBee if Tavily unconfigured.
  if (tavilyProvider.isConfigured()) return tavilyProvider;
  if (scrapingbeeProvider.isConfigured()) return scrapingbeeProvider;

  throw new Error('No search provider configured. Set TAVILY_API_KEY or SCRAPINGBEE_KEY.');
}

// Runs a search with optional ScrapingBee fallback.
// Fallback is only attempted when:
//   - Primary provider throws a non-budget error
//   - SEARCH_FALLBACK_ENABLED=true
//   - ScrapingBee is configured and is not already the primary
export async function searchWithFallback(input: ExpertSearchInput): Promise<SearchResult[]> {
  const primary = getSearchProvider();

  try {
    return await primary.search(input);
  } catch (err) {
    const fallbackEnabled = process.env.SEARCH_FALLBACK_ENABLED === 'true';
    const canFallback     = fallbackEnabled
      && primary.name !== 'scrapingbee'
      && scrapingbeeProvider.isConfigured();

    if (canFallback) {
      console.warn(
        '[search] primary provider failed, falling back to scrapingbee:',
        err instanceof Error ? err.message : String(err),
      );
      return scrapingbeeProvider.search(input);
    }

    throw err;
  }
}

export type {
  SearchProvider,
  SearchProviderName,
  ExpertSearchInput,
  SearchResult,
} from './types';
