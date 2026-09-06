// POST — public, called by QStash only.
// Verifies QStash signature before processing.
// Runs one background expert-sourcing job to completion.
//
// No auth guard — QStash retries must get through.
// No rate limit — QStash delivers at most once per job.
//
// Job body: { projectId, businessProblem?, expertType? }
// The job writes its own outcome onto the project (sourcingStatus
// 'completed' | 'failed'), so a 200 here only means "job ran".
//
// NEVER log: project names, research questions, brief content, or expert names.

import { NextRequest, NextResponse } from 'next/server';
import { Receiver } from '@upstash/qstash';
import { runSourcingJob, type SourcingJob } from '../../../../lib/sourcingJob';

function getReceiver(): Receiver {
  const currentKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextKey    = process.env.QSTASH_NEXT_SIGNING_KEY;
  if (!currentKey || !nextKey) {
    throw new Error('[jobs/source-experts] QSTASH_CURRENT_SIGNING_KEY / QSTASH_NEXT_SIGNING_KEY missing');
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
        console.warn('[jobs/source-experts] invalid QStash signature');
        return NextResponse.json({ error: 'invalid_signature' }, { status: 400 });
      }
    } catch (err) {
      console.error('[jobs/source-experts] signature verify error:',
        err instanceof Error ? err.message.slice(0, 120) : 'unknown');
      return NextResponse.json({ error: 'invalid_signature' }, { status: 400 });
    }
  }

  // ── 3. Parse job ─────────────────────────────────────────────────────────
  let job: SourcingJob;
  try {
    job = JSON.parse(body) as SourcingJob;
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  if (!job.projectId || typeof job.projectId !== 'string') {
    return NextResponse.json({ error: 'missing_fields' }, { status: 400 });
  }

  // ── 4. Run it. runSourcingJob owns its own error handling and always
  //      leaves the project on a terminal status, so QStash never needs to
  //      retry a run that already reported failure to the user.
  await runSourcingJob(job);

  return NextResponse.json({ ok: true });
}
