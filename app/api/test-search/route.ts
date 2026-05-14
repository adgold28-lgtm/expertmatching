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
    return Response.json({ error: err instanceof Error ? err.message : 'No search provider configured' });
  }

  const query = request.nextUrl.searchParams.get('q') || 'solar interconnection manager Texas site:linkedin.com/in';

  try {
    const results = await searchWithFallback({ query, maxResults: 3 });
    return Response.json({ status: 200, provider: providerName, query, resultCount: results.length, results });
  } catch (err) {
    return Response.json({ error: String(err) });
  }
}
