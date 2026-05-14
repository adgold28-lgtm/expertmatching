// POST — protected by routeAuthGuard()
// Marks an expert engagement complete, creates a Stripe payment link, and
// emails an invoice to the client.
//
// NEVER log: expert names, client names, emails, or card details.
// Amounts are safe to log.

import { NextRequest, NextResponse } from 'next/server';
import { routeAuthGuard } from '../../../../../../../lib/auth';
import { getProject, updateExpertStatus } from '../../../../../../../lib/projectStore';
import { createAndSendInvoice } from '../../../../../../../lib/createAndSendInvoice';

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
    callDurationMin < 1 || callDurationMin > 480
  ) {
    return NextResponse.json({ error: 'invalid_callDurationMin', message: 'callDurationMin must be 1–480' }, { status: 400 });
  }
  if (
    invoiceAmount === null || !Number.isInteger(invoiceAmount) ||
    invoiceAmount < 1 || invoiceAmount > 50000
  ) {
    return NextResponse.json({ error: 'invalid_invoiceAmount', message: 'invoiceAmount must be 1–50000' }, { status: 400 });
  }

  // 3. Load project and find expert
  const project = await getProject(params.projectId);
  if (!project) {
    return NextResponse.json({ error: 'project_not_found' }, { status: 404 });
  }
  const pe = project.experts.find(e => e.expert.id === params.expertId);
  if (!pe) {
    return NextResponse.json({ error: 'expert_not_found' }, { status: 404 });
  }

  // 4. Check expertRate is set
  if (!pe.expertRate) {
    return NextResponse.json({ error: 'expert_rate_not_set', message: 'Set expert rate before completing engagement' }, { status: 422 });
  }

  // 5. Cross-check invoice amount (server-authoritative)
  const serverAmount = Math.round((pe.expertRate * callDurationMin) / 60);
  if (Math.abs(serverAmount - invoiceAmount) > 1) {
    return NextResponse.json({ error: 'invoice_amount_mismatch' }, { status: 400 });
  }

  try {
    // 6. Persist completion status, duration, and invoice amount
    await updateExpertStatus(params.projectId, params.expertId, {
      status:        'completed',
      callDurationMin,
      invoiceAmount: serverAmount,
    });

    // 7. Create Stripe payment link + send invoice email via shared helper
    const result = await createAndSendInvoice(params.projectId, params.expertId, serverAmount, callDurationMin);
    if (!result) {
      return NextResponse.json({ error: 'invoice_failed', message: 'Failed to create invoice' }, { status: 500 });
    }

    return NextResponse.json({ success: true, paymentLinkUrl: result.paymentLinkUrl });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[stripe] complete route error:', msg);
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
