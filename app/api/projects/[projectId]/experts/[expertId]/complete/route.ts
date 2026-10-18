// POST — protected by routeAuthGuard()
// Marks an expert engagement complete, creates a Stripe payment link, and
// emails an invoice to the client.
//
// WHO MAY: the project owner or a platform admin. This is the call that charges
// the saved card, so a collaborator — who is read-only by product decision
// (docs/MATCHY_SPEC.md, founder answer 5) — must not be able to reach it. The
// owner check runs AFTER getProjectForUser so an inaccessible project still
// 404s rather than confirming it exists.
//
// Billing identity: a call is billed once per CALL, not once per engagement
// (lib/createAndSendInvoice.ts). The call is identified by the booking's ICS
// uid, else the Zoom meeting id; a manually completed call has neither, so this
// route mints `manual:<projectId>:<expertId>:<ms>` once, persists it on the row
// and passes it down. Re-completing the same call reuses the persisted id and
// is therefore a no-op for billing; a genuine second call mints a new one.
//
// A call the client flagged under the ten-minute mismatch guarantee is never
// charged here: it is marked completed and settled at zero, and the expert is
// paid 15 minutes (lib/lateCancelBilling.settleMismatchFlag). The response
// carries `waived: true` and no payment link. A flagged call entered as longer
// than ten minutes voids the flag and is billed as usual.
//
// NEVER log: expert names, client names, emails, or card details.
// Amounts are safe to log.

import { NextRequest, NextResponse } from 'next/server';
import { callChargeDollars, MAX_BILLABLE_MINUTES } from '../../../../../../../lib/pricing';
import { routeAuthGuard, getSessionUser } from '../../../../../../../lib/auth';
import { requireProjectOwner } from '../../../../../../../lib/projectsGuard';
import { getProjectForUser, updateExpertStatus, mutateExpert } from '../../../../../../../lib/projectStore';
import type { UpdateExpertInput } from '../../../../../../../lib/projectStore';
import { createAndSendInvoice, completionReplay } from '../../../../../../../lib/createAndSendInvoice';
import { chargeIsForFlaggedCall, flagVoidedByDuration } from '../../../../../../../lib/mismatchGuarantee';
import { settleMismatchFlag } from '../../../../../../../lib/lateCancelBilling';
import { getEntitlementsForProject, activationRequired } from '../../../../../../../lib/entitlements';
import { getAuthUserIdByEmail } from '../../../../../../../lib/supabase/admin';
import { errorMessage } from '../../../../../../../lib/log';

const ID_RE        = /^[a-f0-9]{24}$/;
const EXPERT_ID_RE = /^[a-zA-Z0-9\-_]+$/;

export async function POST(
  request: NextRequest,
  { params }: { params: { projectId: string; expertId: string } },
) {
  // 1. Auth
  const authErr = await routeAuthGuard(request);
  if (authErr) return authErr;

  // 2. Validate IDs
  if (!ID_RE.test(params.projectId)) {
    return NextResponse.json({ error: 'invalid_project_id' }, { status: 400 });
  }
  if (!EXPERT_ID_RE.test(params.expertId)) {
    return NextResponse.json({ error: 'invalid_expert_id' }, { status: 400 });
  }

  // Parse body
  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const callDurationMin = typeof body.callDurationMin === 'number' ? body.callDurationMin : null;
  const invoiceAmount   = typeof body.invoiceAmount   === 'number' ? body.invoiceAmount   : null;

  if (
    callDurationMin === null || !Number.isInteger(callDurationMin) ||
    callDurationMin < 1 || callDurationMin > MAX_BILLABLE_MINUTES
  ) {
    return NextResponse.json({ error: 'invalid_callDurationMin', message: `callDurationMin must be 1–${MAX_BILLABLE_MINUTES}` }, { status: 400 });
  }
  if (
    invoiceAmount === null || !Number.isInteger(invoiceAmount) ||
    invoiceAmount < 1 || invoiceAmount > 50000
  ) {
    return NextResponse.json({ error: 'invalid_invoiceAmount', message: 'invoiceAmount must be 1–50000' }, { status: 400 });
  }

  // 3. Load project (ownership / collaborator / admin scoped) and find expert.
  //    404 on inaccessible/nonexistent so we do not leak project existence.
  const { email, role } = await getSessionUser(request);
  const project = await getProjectForUser(params.projectId, email, role);
  if (!project) {
    return NextResponse.json({ error: 'project_not_found' }, { status: 404 });
  }
  const pe = project.experts.find(e => e.expert.id === params.expertId);
  if (!pe) {
    return NextResponse.json({ error: 'expert_not_found' }, { status: 404 });
  }

  // 3b. Only the owner (or staff) may bill a call. Collaborators read.
  const ownerErr = requireProjectOwner(project, { email, role });
  if (ownerErr) return ownerErr as NextResponse;

  // 3c. The account boundary (lib/entitlements.ts): no card on file, no charge.
  //     createAndSendInvoice refuses too; refusing here keeps the status honest.
  const entitlements = await getEntitlementsForProject(params.projectId);
  if (!entitlements.canCharge) {
    const actorId = await getAuthUserIdByEmail(email).catch(() => null);
    return (await activationRequired(entitlements, {
      action: 'charge_card', actorId, projectId: params.projectId, expertId: params.expertId,
    })) as NextResponse;
  }

  // 4. Check expertRate is set
  if (!pe.expertRate) {
    return NextResponse.json({ error: 'expert_rate_not_set', message: 'Set expert rate before completing engagement' }, { status: 422 });
  }

  // 5. Cross-check invoice amount (server-authoritative)
  //    The client is charged the CLIENT rate (expert offer / EXPERT_SHARE, rounded
  //    up to $50) over the billable minutes (15-minute minimum) — lib/pricing.ts.
  const serverAmount = callChargeDollars(pe.expertRate, callDurationMin);
  if (Math.abs(serverAmount - invoiceAmount) > 1) {
    return NextResponse.json({ error: 'invoice_amount_mismatch' }, { status: 400 });
  }

  // 5b. The identity of the call being billed. A booked call already has one;
  //     a manual completion of a call that was never booked through the
  //     platform mints one and keeps it, so a re-completion bills nothing.
  const existingCallId = pe.booking?.icsUid ?? pe.zoomMeetingId ?? pe.callId ?? null;
  const callId = existingCallId
    ?? `manual:${params.projectId}:${params.expertId}:${Date.now()}`;

  // 5c'. The ten-minute mismatch guarantee (lib/mismatchGuarantee.ts). The
  //      client flagged this call inside its first ten minutes, so completing
  //      it charges nothing: the call is recorded as completed and the waiver
  //      settles it, paying the expert 15 minutes. Checked before the replay
  //      guard below because a waived call is never billed, with any numbers.
  let flaggedForThisCall = chargeIsForFlaggedCall(pe, callId);
  if (flaggedForThisCall && flagVoidedByDuration(callDurationMin)) {
    // Past ten minutes the guarantee no longer applies (founder, 2026-10-17):
    // the flag is voided and the call is billed below like any other.
    await mutateExpert(params.projectId, params.expertId, current => ({
      ...current, mismatchCallId: null, mismatchVoidedAt: Date.now(), updatedAt: Date.now(),
    }));
    pe.mismatchCallId = null;
    flaggedForThisCall = false;
  }
  if (flaggedForThisCall) {
    try {
      const flaggedPatch: UpdateExpertInput = { status: 'completed', callDurationMin };
      await updateExpertStatus(params.projectId, params.expertId, flaggedPatch);
      await settleMismatchFlag(params.projectId, params.expertId);
      return NextResponse.json({ success: true, charged: false, paymentLinkUrl: null, waived: true });
    } catch (err) {
      console.error('[stripe] complete route (waived) error:',
        err instanceof Error ? err.message.slice(0, 120) : 'unknown');
      return NextResponse.json({ error: 'internal_error' }, { status: 500 });
    }
  }

  // 5c. A re-completion of a call that is already billed never rewrites its
  //     ledger. Step 6 persists the duration and amount before billing skips
  //     the already-billed call, so a second click with different numbers would
  //     leave the stored amount disagreeing with the charge (and the expert
  //     payout reads callDurationMin when Zoom recorded no actualDurationMin).
  if (completionReplay(pe, callId, serverAmount, callDurationMin) === 'conflict') {
    return NextResponse.json({
      error:   'already_billed',
      message: 'This call has already been billed with a different duration or amount.',
    }, { status: 409 });
  }

  try {
    // 6. Persist completion status, duration, and invoice amount — plus the
    //    minted call id, so the next completion of this same call resolves to
    //    it instead of minting a second one.
    const completionPatch: UpdateExpertInput = {
      status:        'completed',
      callDurationMin,
      invoiceAmount: serverAmount,
      ...(existingCallId ? {} : { callId }),
    };
    await updateExpertStatus(params.projectId, params.expertId, completionPatch);

    // 7. Bill the call via the shared helper — charges the client's saved card
    //    off-session when one exists, otherwise creates a payment link and
    //    emails a pay-now invoice.
    const result = await createAndSendInvoice(params.projectId, params.expertId, serverAmount, callDurationMin, callId);
    if (!result) {
      return NextResponse.json({ error: 'invoice_failed', message: 'Failed to create invoice' }, { status: 500 });
    }

    return NextResponse.json({
      success:        true,
      charged:        result.charged,
      paymentLinkUrl: result.paymentLinkUrl,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[stripe] complete route error:', errorMessage(msg));
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
