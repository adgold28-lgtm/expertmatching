// GET /api/admin/held-intros — every intro waiting on a person to write its
// "why them" line, across every project, newest first.
//
// Platform admins only (adminGuard; middleware.ts also 404s /api/admin/* for
// non-admins, so this is defence in depth).
//
// Response: 200 { items: HeldIntro[] } (lib/heldIntros.ts). Each item names the
// expert in full (name, title, company, evidence), because staff write the
// line from the expert's real background; there is no client viewer on this
// route. No contact address, rate or token is returned.
//
// The line itself is sent through the EXISTING approve route,
// POST /api/projects/:id/experts/:expertId/outreach/approve { whyThem }, which
// screens it, lints it against the rubric and sends the intro. This route only
// reads.
//
// Query: ?limit=<1-200> (default 100).
//
// Never logs: names, titles, companies, evidence.

import { NextRequest } from 'next/server';
import { adminGuard } from '../../../../lib/auth';
import { clampHeldIntroLimit, listHeldIntros } from '../../../../lib/heldIntros';

export async function GET(request: NextRequest): Promise<Response> {
  const authError = await adminGuard(request);
  if (authError) return authError;

  const limit = clampHeldIntroLimit(request.nextUrl.searchParams.get('limit'));

  try {
    const items = await listHeldIntros(limit);
    return Response.json({ items }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    console.error('[api/admin/held-intros] error:',
      err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return Response.json(
      { error: 'internal_error', message: 'Could not load the held intros.' },
      { status: 500 },
    );
  }
}
