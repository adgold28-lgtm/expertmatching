// POST — public, called by QStash only.
// Verifies the QStash signature before processing (same block as
// app/api/jobs/source-experts).
//
// One contact-discovery attempt for one bookmarked expert:
// find the address → check the do-not-contact list → send Matchy's intro (or
// draft it when the project is on review-first) → emit the events.
// docs/MATCHY_SPEC.md workflow step 2, "silent, bounded attempts, one send".
//
// No auth guard — QStash must get through; middleware.ts already lists
// '/api/jobs/' in PUBLIC_PREFIXES.
// No rate limit — the job is published with `Upstash-Retries: 0`, so QStash
// delivers each job exactly once and never redelivers. A failed attempt is
// retried by the client bookmarking again, never by us: a redelivery would be
// a second cold email to the same person.
//
// Job body: { projectId, expertId, attempt }
// The job writes its own terminal outcome onto the expert (`contactStatus`), so
// a 200 here only means "the job ran".
//
// NEVER log: expert names, email addresses, company names, project names.

import { NextRequest, NextResponse } from 'next/server';
import { Receiver } from '@upstash/qstash';
import {
  runContactDiscoveryJob,
  type ContactDiscoveryJob,
} from '../../../../lib/contactDiscovery';

// The provider chain is capped at 24 s (lib/contactDiscovery.TOTAL_BUDGET_MS)
// and the intro send follows it, so the job needs more than a 10 s default.
export const maxDuration = 60;

const ID_RE        = /^[a-f0-9]{24}$/;
const EXPERT_ID_RE = /^[a-zA-Z0-9\-_]+$/;

function getReceiver(): Receiver {
  const currentKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextKey    = process.env.QSTASH_NEXT_SIGNING_KEY;
  if (!currentKey || !nextKey) {
    throw new Error('[jobs/contact-discovery] QSTASH_CURRENT_SIGNING_KEY / QSTASH_NEXT_SIGNING_KEY missing');
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
        console.warn('[jobs/contact-discovery] invalid QStash signature');
        return NextResponse.json({ error: 'invalid_signature' }, { status: 400 });
      }
    } catch (err) {
      console.error('[jobs/contact-discovery] signature verify error:',
        err instanceof Error ? err.message.slice(0, 120) : 'unknown');
      return NextResponse.json({ error: 'invalid_signature' }, { status: 400 });
    }
  }

  // ── 3. Parse job ─────────────────────────────────────────────────────────
  let job: ContactDiscoveryJob;
  try {
    job = JSON.parse(body) as ContactDiscoveryJob;
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  if (typeof job.projectId !== 'string' || !ID_RE.test(job.projectId)) {
    return NextResponse.json({ error: 'missing_fields' }, { status: 400 });
  }
  if (typeof job.expertId !== 'string' || !EXPERT_ID_RE.test(job.expertId)) {
    return NextResponse.json({ error: 'missing_fields' }, { status: 400 });
  }

  // ── 4. Run it. runContactDiscoveryJob owns its own error handling and
  //      always leaves a terminal outcome on the expert, so there is nothing
  //      for a caller to retry. One attempt per job — a bounce retry is a
  //      separate job, not a redelivery of this one.
  const outcome = await runContactDiscoveryJob({
    projectId: job.projectId,
    expertId:  job.expertId,
    attempt:   typeof job.attempt === 'number' ? job.attempt : 1,
  });

  return NextResponse.json({ ok: true, outcome });
}
