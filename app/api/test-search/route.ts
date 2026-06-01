import { NextRequest } from 'next/server';
import { getSearchProvider, searchWithFallback } from '../../../lib/searchProviders';
import { routeAuthGuard } from '../../../lib/auth';

export async function GET(request: NextRequest) {
  // Debug-only endpoint — not available in production.
  if (process.env.NODE_ENV === 'production') {
    return Response.json({ error: 'not_found' }, { status: 404 });
  }

  // Route-level auth guard (defense in depth — supplements middleware).
  const authErr = await routeAuthGuard(request);
  if (authErr) return authErr;

  // Verify at least one provider is configured
  let providerName: string;
  try {
    providerName = getSearchProvider().name;
  } catch (err) {
    console.error('[test-search] provider error:', err instanceof Error ? err.message.slice(0, 120) : String(err));
    return Response.json({ error: 'no_search_provider' }, { status: 503 });
  }

  const query = request.nextUrl.searchParams.get('q') || 'solar interconnection manager Texas site:linkedin.com/in';

  try {
    const results = await searchWithFallback({ query, maxResults: 3 });
    return Response.json({ status: 200, provider: providerName, query, resultCount: results.length, results });
  } catch (err) {
    console.error('[test-search] search failed:', err instanceof Error ? err.message.slice(0, 120) : String(err));
    return Response.json({ error: 'search_failed' }, { status: 500 });
  }
}
