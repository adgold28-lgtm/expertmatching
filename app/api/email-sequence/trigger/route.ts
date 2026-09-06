// POST — public, called by QStash only.
// Verifies QStash signature before processing.
// Executes one queued step of the outreach email sequence.
//
// No auth guard — QStash retries must get through.
// No rate limit — QStash delivers at most once per job.
//
// The human-clicked start of the sequence does NOT come through here: the UI
// calls the session-authed
//   POST /api/projects/:projectId/experts/:expertId/outreach/start
// which runs the same lib/outreachSteps.ts implementation. This endpoint stays
// QStash-only so a browser can never drive a scheduled step.
//
// RETIRED, Matchy Phase 1 (docs/MATCHY_SPEC.md, "Phasing"): the timed cadence
// is gone. lib/emailSequence.scheduleNextEmail no longer publishes anything, so
// nothing new arrives here. The route stays live only to DRAIN jobs QStash had
// already accepted before the change: an email2 or email3 delivery is
// acknowledged with 200 and NOTHING IS SENT, which stops QStash retrying it
// while guaranteeing no expert receives a follow-up nobody asked for.
//
// Steps:
//   email2 → acknowledged, not sent (retired)
//   email3 → acknowledged, not sent (retired)
//   email1 is still executed, for a queued retry of a human-clicked send.

import { NextRequest, NextResponse } from 'next/server';
import { Receiver } from '@upstash/qstash';
import type { SequenceJob } from '../../../../lib/emailSequence';
import { runSequenceStep } from '../../../../lib/outreachSteps';

function getReceiver(): Receiver {
  const currentKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextKey    = process.env.QSTASH_NEXT_SIGNING_KEY;
  if (!currentKey || !nextKey) {
    throw new Error('[email-sequence/trigger] QSTASH_CURRENT_SIGNING_KEY / QSTASH_NEXT_SIGNING_KEY missing');
  }
  return new Receiver({ currentSigningKey: currentKey, nextSigningKey: nextKey });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // ── 1. Read raw body for signature verification ──────────────────────────
  const body = await request.text();

  // ── 2. Verify QStash signature ───────────────────────────────────────────
  // Skip verification in dev if signing keys are not configured
  if (process.env.NODE_ENV === 'production' || process.env.QSTASH_CURRENT_SIGNING_KEY) {
    try {
      const receiver  = getReceiver();
      const signature = request.headers.get('upstash-signature') ?? '';
      const valid     = await receiver.verify({ signature, body });
      if (!valid) {
        console.warn('[email-sequence/trigger] invalid QStash signature');
        return NextResponse.json({ error: 'invalid_signature' }, { status: 400 });
      }
    } catch (err) {
      console.error('[email-sequence/trigger] signature verify error:',
        err instanceof Error ? err.message.slice(0, 120) : 'unknown');
      return NextResponse.json({ error: 'invalid_signature' }, { status: 400 });
    }
  }

  // ── 3. Parse job ─────────────────────────────────────────────────────────
  let job: SequenceJob;
  try {
    job = JSON.parse(body) as SequenceJob;
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const { projectId, expertId, step, token } = job;
  if (!projectId || !expertId || !step) {
    return NextResponse.json({ error: 'missing_fields' }, { status: 400 });
  }

  // ── 3a. Retired steps: acknowledge and do nothing ────────────────────────
  // 200 rather than an error so QStash marks the job delivered and stops
  // retrying. Matchy answers replies on the thread instead of on a timer.
  if (step === 'email2' || step === 'email3') {
    console.log('[email-sequence/trigger] cadence retired — acknowledged without sending',
      JSON.stringify({ step }));
    return NextResponse.json({ ok: true, skipped: 'cadence_retired' });
  }

  // ── 4. Execute the step (shared with the session-authed start route) ─────
  const result = await runSequenceStep({ projectId, expertId, step, token: token ?? '' });
  if (!result.ok) {
    console.error('[email-sequence/trigger] step rejected', { step, error: result.error });
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  console.log('[email-sequence/trigger] step completed', { step, projectId });
  return NextResponse.json({ ok: true });
}
