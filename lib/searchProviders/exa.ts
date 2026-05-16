// Exa neural search provider for expert candidate discovery.
// Uses Exa's people-oriented search to surface LinkedIn profiles and
// professional bios with higher signal quality than keyword-based SERP.
//
// Stage 1: Exa neural search (this file)
// Stage 2: ScrapingBee email enrichment for records without emails (existing contactProviders)
//
// Required env var: EXA_API_KEY — obtain from dashboard.exa.ai

import Exa from 'exa-js';
import type { SearchProvider, ExpertSearchInput, SearchResult } from './types';

let _client: Exa | null = null;

function getClient(): Exa {
  const key = process.env.EXA_API_KEY;
  if (!key) throw new Error('EXA_API_KEY not set');
  if (!_client) _client = new Exa(key);
  return _client;
}

export const exaProvider: SearchProvider = {
  name: 'exa',

  isConfigured(): boolean {
    return Boolean(process.env.EXA_API_KEY);
  },

  async search({ query, maxResults = 10 }: ExpertSearchInput): Promise<SearchResult[]> {
    const exa = getClient();
    const n   = Math.min(maxResults, 25);

    const result = await exa.searchAndContents(query, {
      numResults:   n,
      type:         'neural',
      // 'company' category returns LinkedIn, professional bios, and org pages
      // which is exactly the source type needed for expert identification
      category:     'company',
      text:         { maxCharacters: 400 },
      highlights:   { numSentences: 2, highlightsPerUrl: 1 },
    });

    return (result.results ?? []).map(r => {
      const snippet = r.highlights?.[0] ?? r.text?.slice(0, 300) ?? '';
      const source  = r.url ? (() => {
        try { return new URL(r.url).hostname.replace(/^www\./, ''); } catch { return ''; }
      })() : '';

      return {
        title:    r.title   ?? '',
        url:      r.url     ?? '',
        snippet,
        source,
        provider: 'exa' as const,
      };
    });
  },
};
