// POST — protected by routeAuthGuard()
// Synchronous expert generation. Generates and returns candidates; persists
// nothing. Kept for callers that want results in-hand (the Source panel's
// adjacent-perspective flow historically used it).
//
// The generation itself lives in lib/generateExperts.ts so the background
// sourcing worker (POST /api/jobs/source-experts) runs the exact same logic.
//
// SECURITY: never log briefContext fields — they may contain client-sensitive content.

import { NextRequest } from 'next/server';
import { routeAuthGuard } from '../../../lib/auth';
import {
  generateExperts,
  GenerateExpertsError,
  type BriefContext,
} from '../../../lib/generateExperts';

export async function POST(request: NextRequest) {
  // Route-level auth guard (defense in depth — supplements middleware).
  const authErr = await routeAuthGuard(request);
  if (authErr) return authErr;

  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  try {
    const result = await generateExperts({
      query:     typeof body.query     === 'string' ? body.query     : '',
      geography: typeof body.geography === 'string' ? body.geography : undefined,
      seniority: typeof body.seniority === 'string' ? body.seniority : undefined,
      briefContext: (body.briefContext && typeof body.briefContext === 'object')
        ? body.briefContext as BriefContext
        : undefined,
      supplementarySearch: body.supplementarySearch === true,
      excludeNames: Array.isArray(body.excludeNames)
        ? (body.excludeNames as unknown[]).filter((n): n is string => typeof n === 'string')
        : undefined,
      additionalContext: typeof body.additionalContext === 'string' ? body.additionalContext : undefined,
    });
    return Response.json(result);
  } catch (err) {
    if (err instanceof GenerateExpertsError) {
      return Response.json({ error: err.code, message: err.message }, { status: err.status });
    }
    // Safe error log: message only, no prompt content, no keys
    console.error('[generate-experts] unhandled error', err instanceof Error ? err.message : String(err));
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }
}
