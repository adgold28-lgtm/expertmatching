// GET /api/admin/attention — everything that needs a human, in one list.
//
// Platform admins only (adminGuard; middleware.ts also 404s /api/admin/* for
// non-admins, so this is defence in depth).
//
// Response: 200 { items: AttentionItem[] }
//
// The list merges recorded system failures (lib/engagementEvents
// .recordSystemFailure → public.system_events), sourcing runs stuck for more
// than 15 minutes, and organizations whose Stripe subscription is past_due or
// unpaid. See lib/attention.ts for what each source means and why each one
// fails soft rather than failing the request.
//
// Query: ?limit=<1-200> (default 50).
//
// NEVER returns: emails, names, Stripe ids, or research content.

import { NextRequest } from 'next/server';
import { adminGuard } from '../../../../lib/auth';
import { listAttentionItems } from '../../../../lib/attention';

const DEFAULT_LIMIT = 50;

export async function GET(request: NextRequest): Promise<Response> {
  const authError = await adminGuard(request);
  if (authError) return authError;

  const raw    = request.nextUrl.searchParams.get('limit');
  const parsed = raw ? Number.parseInt(raw, 10) : DEFAULT_LIMIT;
  const limit  = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LIMIT;

  try {
    const items = await listAttentionItems(limit);
    return Response.json({ items });
  } catch (err) {
    // listAttentionItems is written not to throw; this is the last line.
    console.error('[api/admin/attention] error:',
      err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }
}
