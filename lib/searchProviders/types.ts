// Provider abstraction for expert candidate web search.
// Add new providers here; route and cache layers are provider-agnostic.

export type SearchProviderName = 'tavily' | 'scrapingbee';

export interface ExpertSearchInput {
  query: string;
  maxResults?: number;
}

export interface SearchResult {
  title:    string;
  url:      string;
  snippet?: string;
  source?:  string; // display label, e.g. "linkedin.com"
  provider: SearchProviderName;
}

export interface SearchProvider {
  readonly name: SearchProviderName;
  // Returns true when required env vars are present.
  isConfigured(): boolean;
  // Returns normalized results. Returns [] on not-found or soft errors.
  // Throws { code: 'provider_rate_limited' } or hard errors on API failure.
  search(input: ExpertSearchInput): Promise<SearchResult[]>;
}
