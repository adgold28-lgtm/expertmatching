// Tavily search provider.
// API key is server-side only — NEVER exposed to client or logs.
// API docs: https://docs.tavily.com/docs/rest-api/api-reference

import type { SearchProvider, ExpertSearchInput, SearchResult } from './types';

interface TavilyResultItem {
  title?:   string;
  url?:     string;
  content?: string;
  score?:   number;
}

function hostnameOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

export const tavilyProvider: SearchProvider = {
  name: 'tavily',

  isConfigured(): boolean {
    return Boolean(process.env.TAVILY_API_KEY);
  },

  async search({ query, maxResults = 10 }: ExpertSearchInput): Promise<SearchResult[]> {
    // THIS IS WHERE A TAVILY CREDIT IS SPENT
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) throw new Error('TAVILY_API_KEY not set');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);

    try {
      // API key sent in POST body (Tavily's auth mechanism — server-to-server, never client-visible)
      const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key:             apiKey,
          query,
          search_depth:        'basic',
          max_results:         Math.min(maxResults, 20),
          include_answer:      false,
          include_raw_content: false,
        }),
        signal: controller.signal,
      });

      if (res.status === 401) {
        throw new Error('Tavily API key invalid or revoked');
      }
      if (res.status === 429) {
        throw Object.assign(new Error('Tavily upstream rate limit'), { code: 'provider_rate_limited' });
      }
      if (!res.ok) {
        console.error(`[tavily] HTTP ${res.status}`);
        return [];
      }

      const data = await res.json() as Record<string, unknown>;
      const items = Array.isArray(data.results) ? (data.results as TavilyResultItem[]) : [];

      // Debug audit: count only — no query text, API key, or raw response logged
      console.log('[tavily] result-counts', JSON.stringify({ returned: items.length }));

      return items.map(r => ({
        title:    r.title   ?? '',
        url:      r.url     ?? '',
        snippet:  r.content ?? '',
        source:   hostnameOf(r.url ?? ''),
        provider: 'tavily' as const,
      }));
    } finally {
      clearTimeout(timer);
    }
  },
};
