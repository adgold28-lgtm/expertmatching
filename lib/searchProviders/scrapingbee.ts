// ScrapingBee SERP provider (Google search results via ScrapingBee store).
// API key is server-side only — the key appears in the request URL because
// ScrapingBee's API design requires it; it is never exposed to the client.

import type { SearchProvider, ExpertSearchInput, SearchResult } from './types';

export const scrapingbeeProvider: SearchProvider = {
  name: 'scrapingbee',

  isConfigured(): boolean {
    return Boolean(process.env.SCRAPINGBEE_KEY);
  },

  async search({ query, maxResults = 10 }: ExpertSearchInput): Promise<SearchResult[]> {
    const apiKey = process.env.SCRAPINGBEE_KEY;
    if (!apiKey) throw new Error('SCRAPINGBEE_KEY not set');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);

    try {
      const nb = Math.min(maxResults, 20);
      // ScrapingBee requires the API key as a query parameter (provider API design).
      const url = `https://app.scrapingbee.com/api/v1/store/google?api_key=${apiKey}&search=${encodeURIComponent(query)}&nb_results=${nb}`;

      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        console.error(`[scrapingbee] HTTP ${res.status}`);
        return [];
      }

      const data = await res.json() as Record<string, unknown>;
      const organic = Array.isArray(data.organic_results) ? data.organic_results as Record<string, unknown>[] : [];

      // Debug audit: count only — no query text or raw response logged
      console.log('[scrapingbee] result-counts', JSON.stringify({ returned: organic.length }));

      return organic.map(r => ({
        title:   typeof r.title          === 'string' ? r.title          : '',
        url:     typeof r.url            === 'string' ? r.url
               : typeof r.link          === 'string' ? r.link           : '',
        snippet: typeof r.description   === 'string' ? r.description
               : typeof r.snippet      === 'string' ? r.snippet        : '',
        source:  typeof r.displayed_url  === 'string' ? r.displayed_url
               : typeof r.displayed_link === 'string' ? r.displayed_link : '',
        provider: 'scrapingbee' as const,
      }));
    } finally {
      clearTimeout(timer);
    }
  },
};
