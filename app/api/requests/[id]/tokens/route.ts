// POST /api/requests/[id]/tokens
//
// Mints ONE screening link for ONE candidate on an approved request
// (docs/SCREENING_FLOW_PLAN.md, build step 4) and optionally emails it.
//
// STAFF ONLY, and that is a product decision rather than caution. A client
// cannot hold an expert's email address — that is the anonymity boundary the
// whole platform rests on — so a client-side "copy this link and send it" is
// unusable by construction. Platform staff add the candidate (name, headline,
// background lines, optional address) and either read the link off the screen
// or have the platform send it. The client sees respondents and acts on them,
// never addresses. `adminGuard` runs FIRST for that reason, and the request
// lookup still 404s for an admin who names a request that does not exist: an
// admin may act on anything, but nothing here confirms an id that is not real.
//
// THE ORDER OF THE MINT IS THE INTERESTING PART:
//   1. `randomUUID()` — the row's id, generated HERE
//   2. `generateScreeningToken(id, requestId, deadline)` — signs that id
//   3. `addCandidate({ id, tokenHash, … })` — inserts the row WITH its hash
// The row and the hash that revokes it are born together. Inserting first and
// hashing second would leave a window in which a live, signed link addressed a
// row nobody could revoke. That is why AddCandidateInput takes an id at all.
//
// THE RAW TOKEN APPEARS IN THIS RESPONSE ONCE AND NEVER AGAIN. It is not
// stored (only `sha256(token)` is), it is not logged, and it is not re-derivable
// — losing it means revoking the row and minting another.
//
// EXPIRY is the request deadline, both in the signature and on the row, so a
// link dies when the client stops needing answers. A deadline already in the
// past is refused here (409) rather than minting a token that can never verify.
//
// Never logs: the raw token, the token hash, the expert's name or address, the
// topic, the questions, or the link. The product event carries three booleans.

import { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';
import {
  getRequestForUser,
  addCandidate,
  listCandidates,
} from '../../../../../lib/requestStore';
import { guardMutatingRequest } from '../../../../../lib/projectsGuard';
import { adminGuard, getSessionUser } from '../../../../../lib/auth';
import {
  validateCandidateInput,
  normalizeExpertId,
  isValid,
} from '../../../../../lib/screeningValidation';
import { generateScreeningToken } from '../../../../../lib/screeningToken';
import { screeningLinkUrl } from '../../../../../lib/screeningPublic';
import { sendScreeningLinkEmail, type ScreeningEmailHeld } from '../../../../../lib/screeningEmail';
import { buildRequestView } from '../../../../../lib/screeningView';
import { firmPhrase, firstNameOf } from '../../../../../lib/matchyTemplates';
import { getFirmById } from '../../../../../lib/firmStore';
import { expertRateFor } from '../../../../../lib/pricing';
import { trackProductEvent } from '../../../../../lib/productEvents';

/** Where this app answers. Same resolution order as lib/qstashPublish. */
function baseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_BASE_URL
    ?? process.env.NEXT_PUBLIC_APP_URL
    ?? 'https://expertmatch.fit'
  ).replace(/\/+$/, '');
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  const adminErr = await adminGuard(request);
  if (adminErr) return adminErr;

  const guard = await guardMutatingRequest(request);
  if ('error' in guard) return guard.error;

  try {
    const { email, role } = await getSessionUser(request);
    const found = await getRequestForUser(params.id, email, role);
    if (!found) return Response.json({ error: 'not_found' }, { status: 404 });

    // ── Status ───────────────────────────────────────────────────────────────
    if (found.status !== 'approved') {
      return Response.json(
        {
          error:   'request_not_approved',
          message: 'Approve the screening set before sending it to anyone.',
        },
        { status: 409 },
      );
    }

    // A link cannot outlive the deadline it is stamped with, so a deadline
    // already gone would mint a token that fails verification on first click.
    if (Date.parse(found.deadline) <= Date.now()) {
      return Response.json(
        {
          error:   'deadline_passed',
          message: 'This request has passed its deadline. Move the deadline before adding candidates.',
        },
        { status: 409 },
      );
    }

    // ── Validation ───────────────────────────────────────────────────────────
    const validated = validateCandidateInput(guard.body);
    if (!isValid(validated)) {
      const first = validated.errors[0];
      return Response.json(
        {
          error:   first.error,
          field:   first.field,
          message: first.message,
          errors:  validated.errors,
        },
        { status: 400 },
      );
    }
    const data = validated.data;

    // ── Mint ─────────────────────────────────────────────────────────────────
    const id       = randomUUID();
    const expertId = normalizeExpertId(data.email);
    const { token, tokenHash } = generateScreeningToken(id, found.id, Date.parse(found.deadline));

    await addCandidate(found.id, {
      id,
      expertId,
      expertEmail: data.email,
      snapshot: {
        name:       data.name,
        headline:   data.headline,
        background: data.background,
      },
      tokenHash,
      expiresAt:      found.deadline,
      createdByEmail: email,
    });

    const link = screeningLinkUrl(baseUrl(), token);

    // ── Send ─────────────────────────────────────────────────────────────────
    // A held or failed send is NOT an error: the link exists, it is in the
    // response, and staff can hand it over another way. The panel says which.
    let sent = false;
    let held: ScreeningEmailHeld | null = null;

    if (data.send && data.email) {
      const firm = await getFirmById(found.organizationId).catch(() => null);
      const outcome = await sendScreeningLinkEmail({
        to:              data.email,
        link,
        topic:           found.topicStatement,
        firmPhrase:      firmPhrase(firm?.firmType ?? null, firm?.firmSize ?? null),
        expertRate:      expertRateFor(found.clientRate),
        callLengthMin:   found.callLengthMin,
        deadline:        found.deadline,
        expertFirstName: firstNameOf(data.name),
        itemCount:       found.objectives.length,
      });
      sent = outcome.sent;
      if (!outcome.sent) held = outcome.held;
    }

    void trackProductEvent({
      type:           'screening_link_minted',
      actorEmail:     email,
      organizationId: found.organizationId,
      payload: {
        sent,
        hasEmail: data.email !== null,
        held:     held ?? null,
      },
    });

    // ── Respond ──────────────────────────────────────────────────────────────
    const candidates = await listCandidates(found.id);
    const view       = buildRequestView(found, candidates, { email, role });
    const respondent = view.respondents.find(r => r.id === id);

    // The row was written a line ago; not reading it back means the store is
    // not answering, and a 201 with no respondent would be a lie.
    if (!respondent) {
      return Response.json(
        { error: 'failed_to_mint', message: 'We could not create that screening link. Try again.' },
        { status: 500 },
      );
    }

    return Response.json(
      {
        respondent,
        link,
        sent,
        ...(held ? { held } : {}),
      },
      { status: 201 },
    );
  } catch (err) {
    console.error('[api/requests/[id]/tokens] error:', err instanceof Error ? err.message : String(err));
    return Response.json(
      { error: 'failed_to_mint', message: 'We could not create that screening link. Try again.' },
      { status: 500 },
    );
  }
}
