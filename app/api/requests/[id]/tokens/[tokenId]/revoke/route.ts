// POST /api/requests/[id]/tokens/[tokenId]/revoke
//
// Kills one screening link (docs/SCREENING_FLOW_PLAN.md, build step 4). The
// wrong person was added, the address was wrong, the candidate turns out to
// have a conflict — the link stops working on the next request.
//
// STAFF ONLY, for the same reason minting is: a client never holds a link or an
// address, so revoking one is not a client action. `adminGuard` runs first and
// the request lookup still 404s for a request that does not exist.
//
// REVOCATION IS A ROW, NOT A SIGNATURE. The token stays perfectly valid as
// bytes; what changes is `revoked_at` on the row its hash points at, and
// GET/POST /api/s/[token] refuse the moment that column is set — with the same
// "this link has expired" page every other dead reason gets, so a holder cannot
// tell revocation from expiry.
//
// IDEMPOTENT. lib/requestStore.revokeCandidate never un-revokes and never moves
// an existing stamp, so a double press is the same answer twice. A tokenId that
// is not on this request comes back null → 404, which is also what an id from
// another request gets: nothing here confirms a link exists elsewhere.
//
// Never logs: the token id, the expert's name or address, or anything the
// expert wrote.

import { NextRequest } from 'next/server';
import {
  getRequestForUser,
  listCandidates,
  revokeCandidate,
} from '../../../../../../../lib/requestStore';
import { guardMutatingRequest } from '../../../../../../../lib/projectsGuard';
import { adminGuard, getSessionUser } from '../../../../../../../lib/auth';
import { buildRequestView } from '../../../../../../../lib/screeningView';

const NOT_FOUND = { error: 'not_found' } as const;

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string; tokenId: string } },
) {
  const adminErr = await adminGuard(request);
  if (adminErr) return adminErr;

  const guard = await guardMutatingRequest(request);
  if ('error' in guard) return guard.error;

  try {
    const { email, role } = await getSessionUser(request);
    const found = await getRequestForUser(params.id, email, role);
    if (!found) return Response.json(NOT_FOUND, { status: 404 });

    const revoked = await revokeCandidate(found.id, params.tokenId);
    if (!revoked) return Response.json(NOT_FOUND, { status: 404 });

    const candidates = await listCandidates(found.id);
    const view       = buildRequestView(found, candidates, { email, role });
    const respondent = view.respondents.find(r => r.id === revoked.id);
    if (!respondent) return Response.json(NOT_FOUND, { status: 404 });

    return Response.json({ respondent });
  } catch (err) {
    console.error('[api/requests/[id]/tokens/[tokenId]/revoke] error:',
      err instanceof Error ? err.message : String(err));
    return Response.json(
      { error: 'failed_to_revoke', message: 'We could not revoke that link. Try again.' },
      { status: 500 },
    );
  }
}
