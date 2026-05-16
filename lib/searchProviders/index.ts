import { tavilyProvider }      from './tavily';
import { scrapingbeeProvider } from './scrapingbee';
import { exaProvider }         from './exa';
import type { SearchProvider, ExpertSearchInput, SearchResult } from './types';

export { tavilyProvider, scrapingbeeProvider, exaProvider };

// Returns the configured primary search provider.
// SEARCH_PROVIDER=exa (recommended) | tavily | scrapingbee
// When unset, checks configured providers in order: Exa → Tavily → ScrapingBee.
// Throws if no provider is configured — caller must handle at route level.
export function getSearchProvider(): SearchProvider {
  const configured = process.env.SEARCH_PROVIDER;

  if (configured === 'exa') {
    if (!exaProvider.isConfigured()) throw new Error('SEARCH_PROVIDER=exa but EXA_API_KEY is not set');
    return exaProvider;
  }

  if (configured === 'scrapingbee') {
    if (!scrapingbeeProvider.isConfigured()) throw new Error('SEARCH_PROVIDER=scrapingbee but SCRAPINGBEE_KEY is not set');
    return scrapingbeeProvider;
  }

  if (configured === 'tavily') {
    if (!tavilyProvider.isConfigured()) throw new Error('SEARCH_PROVIDER=tavily but TAVILY_API_KEY is not set');
    return tavilyProvider;
  }

  // Auto-select: prefer Exa (neural search) → Tavily → ScrapingBee
  if (exaProvider.isConfigured()) return exaProvider;
  if (tavilyProvider.isConfigured()) return tavilyProvider;
  if (scrapingbeeProvider.isConfigured()) return scrapingbeeProvider;

  throw new Error('No search provider configured. Set EXA_API_KEY, TAVILY_API_KEY, or SCRAPINGBEE_KEY.');
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
