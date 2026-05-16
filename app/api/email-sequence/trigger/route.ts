// POST — public, called by QStash only.
// Verifies QStash signature before processing.
// Executes one step of the 3-email outreach sequence.
//
// No auth guard — QStash retries must get through.
// No rate limit — QStash delivers at most once per job.
//
// Steps:
//   email1 → send interest check → status: contacted
//   email2 → send conflict/rate check → status: email2_sent
//   email3 → send scheduling link → status: scheduling_sent

import { NextRequest, NextResponse } from 'next/server';
import { Receiver } from '@upstash/qstash';
import { getProject, updateExpertStatus } from '../../../../lib/projectStore';
import {
  generateEmail1,
  generateEmail2,
  generateEmail3,
  sendSequenceEmail,
  type SequenceJob,
} from '../../../../lib/emailSequence';
import { generateAvailabilityToken } from '../../../../lib/availabilityToken';
import { generateOutreachToken } from '../../../../lib/outreachToken';
import { getUpstashClient } from '../../../../lib/upstashRedis';

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
  if (!projectId || !expertId || !step || !token) {
    return NextResponse.json({ error: 'missing_fields' }, { status: 400 });
  }

  // ── 4. Load project + expert ──────────────────────────────────────────────
  const project = await getProject(projectId);
  if (!project) {
    console.error('[email-sequence/trigger] project not found', { projectId });
    return NextResponse.json({ error: 'project_not_found' }, { status: 404 });
  }

  const pe = project.experts.find(e => e.expert.id === expertId);
  if (!pe) {
    console.error('[email-sequence/trigger] expert not found in project');
    return NextResponse.json({ error: 'expert_not_found' }, { status: 404 });
  }

  const expertEmail = pe.contactEmail;
  if (!expertEmail) {
    console.error('[email-sequence/trigger] expert has no contact email');
    return NextResponse.json({ error: 'no_email' }, { status: 422 });
  }

  const rate = pe.expertRate ?? 500;
  const query = project.researchQuestion;

  // ── 5. Execute step ───────────────────────────────────────────────────────
  try {
    if (step === 'email1') {
      // Generate a fresh outreach token if not provided (direct trigger from UI)
      let activeToken = token;
      if (!activeToken) {
        const generated = generateOutreachToken(projectId, expertId);
        activeToken = generated.token;
      }

      const { subject, body: emailBody } = await generateEmail1(pe.expert, query, rate);
      await sendSequenceEmail(expertEmail, subject, emailBody, activeToken, 'email1');

      // Store reply-token index in Redis for inbound-email lookup
      const redis = getUpstashClient();
      if (redis) {
        await redis.set(`reply-token:${activeToken}`, JSON.stringify({ projectId, expertId }), { ex: 90 * 24 * 60 * 60 });
      }

      await updateExpertStatus(projectId, expertId, {
        status:        'contacted',
        outreachStep:  'email1',
        email1SentAt:  Date.now(),
        outreachToken: activeToken,
      });

    } else if (step === 'email2') {
      // Use the stored outreach token (set during email1)
      const replyToken = pe.outreachToken ?? token;
      const { subject, body: emailBody } = await generateEmail2(pe.expert, query, rate);
      await sendSequenceEmail(expertEmail, subject, emailBody, replyToken, 'email2');
      await updateExpertStatus(projectId, expertId, {
        status:       'email2_sent',
        outreachStep: 'email2',
        email2SentAt: Date.now(),
      });

    } else if (step === 'email3') {
      const replyToken = pe.outreachToken ?? token;
      // Generate scheduling link
      const { token: schedToken } = generateAvailabilityToken(projectId, expertId);
      const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? 'https://expertmatch.fit';
      const schedulingUrl = `${baseUrl}/availability/${schedToken}`;

      const firmName = project.name; // project name serves as firm name context

      const { subject, body: emailBody } = await generateEmail3(pe.expert, firmName, schedulingUrl);
      await sendSequenceEmail(expertEmail, subject, emailBody, replyToken, 'email3');
      await updateExpertStatus(projectId, expertId, {
        status:       'scheduling_sent',
        outreachStep: 'email3',
        email3SentAt: Date.now(),
      });

    } else {
      return NextResponse.json({ error: 'unknown_step' }, { status: 400 });
    }

    console.log('[email-sequence/trigger] step completed', { step, projectId });
    return NextResponse.json({ ok: true });

  } catch (err) {
    console.error('[email-sequence/trigger] step failed:', err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return NextResponse.json({ error: 'step_failed' }, { status: 500 });
  }
}
