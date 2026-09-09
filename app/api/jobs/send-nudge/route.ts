// POST /api/jobs/send-nudge — public, called by QStash only.
//
// One follow-up email to one expert who has not replied. The planner
// (GET /api/jobs/schedule-nudges) decided hours ago that this was plausible;
// this route decides whether it is still TRUE, and it is the only one of the
// two that can send.
//
// THE RE-VALIDATION IS THE FEATURE. Between the planner and this worker the
// expert may have replied, the client may have moved the engagement on, a
// second job may have superseded this one, or the address may have landed on
// the do-not-contact list. Every one of those is checked again here against
// freshly read state, and any of them means no email. A nudge sent to someone
// who already answered is the single worst thing this feature can do.
//
// SIGNATURE-VERIFIED, not session-authenticated: middleware.ts lets /api/jobs/
// through without a session, and the QStash signature is what proves the caller
// is our own planner. Same block as app/api/jobs/contact-discovery.
//
// NO RETRIES. The planner publishes with `Upstash-Retries: 0`, so QStash
// delivers this exactly once and never redelivers — a redelivery would be a
// second email to the same person on the same morning. Anything that goes wrong
// is therefore reported and dropped, not retried: the planner runs again
// tomorrow, and the nudge count was not incremented, so nothing is lost but a
// day.
//
// Job body: { projectId, expertId, day, stage, waitingSince }
//
// NEVER logs: the expert's name, address, the line sent, or the subject.

import { NextRequest, NextResponse } from 'next/server';
import { Receiver } from '@upstash/qstash';
import { getProject } from '../../../../lib/projectStore';
import { appendMessage, listThread } from '../../../../lib/conversations';
import { sendSequenceEmail } from '../../../../lib/emailSequence';
import { isSuppressed } from '../../../../lib/outreachSuppressions';
import { isWalkthrough } from '../../../../lib/walkthrough';
import { getEntitlementsForProject, recordRestrictedAttempt } from '../../../../lib/entitlements';
import { getFirm } from '../../../../lib/firmStore';
import { emitEngagementEvent, recordSystemFailure } from '../../../../lib/engagementEvents';
import {
  MAX_NUDGES,
  buildNudgeBody,
  nudgeStageFor,
  nudgeSubjectFor,
  nudgeSummary,
  pickNudgeLine,
  varyNudgeLine,
  waitingSinceFor,
  writeNudgeState,
} from '../../../../lib/nudges';
import type { NudgeStage, NudgeState } from '../../../../types';

// A project read, a thread read, a suppression check, one Resend call and two
// writes. Well inside 30 s, and a ceiling stops a hung provider holding a slot.
export const maxDuration = 30;

const ID_RE        = /^[a-f0-9]{24}$/;
const EXPERT_ID_RE = /^[a-zA-Z0-9\-_]+$/;
const DAY_RE       = /^\d{4}-\d{2}-\d{2}$/;

const STAGES: readonly NudgeStage[] = ['intro', 'terms', 'times'];

interface NudgeJob {
  projectId:    string;
  expertId:     string;
  day:          string;
  stage:        NudgeStage;
  waitingSince: number;
}

/** Why this delivery sent nothing. Diagnostics only — no PII in any value. */
type SkipReason =
  | 'project_missing'
  | 'walkthrough'
  | 'activation_required'
  | 'expert_missing'
  | 'stage_moved'
  | 'replied'
  | 'superseded'
  | 'capped'
  | 'no_address'
  | 'suppressed'
  | 'suppression_unavailable'
  | 'send_failed'
  | 'held';

function getReceiver(): Receiver {
  const currentKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextKey    = process.env.QSTASH_NEXT_SIGNING_KEY;
  if (!currentKey || !nextKey) {
    throw new Error('[jobs/send-nudge] QSTASH_CURRENT_SIGNING_KEY / QSTASH_NEXT_SIGNING_KEY missing');
  }
  return new Receiver({ currentSigningKey: currentKey, nextSigningKey: nextKey });
}

/** Narrows the parsed body, or explains nothing about why beyond "no". */
function parseJob(raw: string): NudgeJob | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const job = parsed as Record<string, unknown>;
  if (typeof job.projectId !== 'string' || !ID_RE.test(job.projectId)) return null;
  if (typeof job.expertId  !== 'string' || !EXPERT_ID_RE.test(job.expertId)) return null;
  if (typeof job.day       !== 'string' || !DAY_RE.test(job.day)) return null;
  if (typeof job.stage     !== 'string' || !STAGES.includes(job.stage as NudgeStage)) return null;
  if (typeof job.waitingSince !== 'number' || !Number.isFinite(job.waitingSince)) return null;

  return {
    projectId:    job.projectId,
    expertId:     job.expertId,
    day:          job.day,
    stage:        job.stage as NudgeStage,
    waitingSince: job.waitingSince,
  };
}

function skipped(reason: SkipReason): NextResponse {
  return NextResponse.json({ ok: true, sent: false, skipped: reason });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // ── 1. Raw body, for the signature ─────────────────────────────────────────
  const raw = await request.text();

  // ── 2. Verify the QStash signature ─────────────────────────────────────────
  // Skipped in development when no signing keys are configured, exactly like
  // app/api/jobs/contact-discovery. In production the keys are always present,
  // so this always runs.
  if (process.env.NODE_ENV === 'production' || process.env.QSTASH_CURRENT_SIGNING_KEY) {
    try {
      const receiver  = getReceiver();
      const signature = request.headers.get('upstash-signature') ?? '';
      const valid     = await receiver.verify({ signature, body: raw });
      if (!valid) {
        console.warn('[jobs/send-nudge] invalid QStash signature');
        return NextResponse.json({ error: 'invalid_signature' }, { status: 400 });
      }
    } catch (err) {
      console.error('[jobs/send-nudge] signature verify error:',
        err instanceof Error ? err.message.slice(0, 120) : 'unknown');
      return NextResponse.json({ error: 'invalid_signature' }, { status: 400 });
    }
  }

  // ── 3. Parse ───────────────────────────────────────────────────────────────
  const job = parseJob(raw);
  if (!job) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });

  const { projectId, expertId } = job;

  // ── 4. Re-read everything ──────────────────────────────────────────────────
  const project = await getProject(projectId).catch(() => null);
  if (!project) return skipped('project_missing');

  // The chokepoint would hold the send anyway; refusing here means we do not
  // burn a line or a count on a project that cannot send.
  if (isWalkthrough(project)) return skipped('walkthrough');

  // Account boundary (lib/entitlements.ts): no card on file, no nudge.
  const entitlements = await getEntitlementsForProject(projectId);
  if (!entitlements.canOutreachExperts) {
    await recordRestrictedAttempt(entitlements, { action: 'send_nudge', projectId, expertId });
    return skipped('activation_required');
  }

  const pe = project.experts.find(e => e.expert.id === expertId);
  if (!pe) return skipped('expert_missing');

  // The status moved: they replied and the client acted, or the engagement
  // advanced. A nudge written for the old stage is the wrong email now.
  if (nudgeStageFor(pe.status) !== job.stage) return skipped('stage_moved');

  const thread = await listThread(projectId, expertId);
  // Anything newer than the outbound we were waiting on — their reply, or
  // another message of ours — invalidates this job.
  if (waitingSinceFor(thread) !== job.waitingSince) return skipped('replied');

  const state: NudgeState | null = pe.nudges ?? null;
  // A second planner run superseded this job, or the state was cleared.
  if (!state || !state.scheduledFor || state.scheduledDay !== job.day) return skipped('superseded');
  if (state.stage !== job.stage || state.waitingSince !== job.waitingSince) return skipped('superseded');
  if (state.count >= MAX_NUDGES) return skipped('capped');

  if (!pe.contactEmail || !pe.outreachToken) return skipped('no_address');

  // The opt-out list can have gained this address since the planner ran.
  // FAILS CLOSED: an unreadable list means no send.
  const suppression = await isSuppressed(pe.contactEmail);
  if (!suppression.ok) {
    // Transient. Forget the slot so tomorrow's planner queues a fresh job.
    await clearQueueSlot(projectId, expertId, state);
    return skipped('suppression_unavailable');
  }
  if (suppression.suppressed) {
    // Permanent for this stage. Retiring the budget stops the planner queueing
    // a job every morning for an address that can never be written to.
    await writeNudgeState(projectId, expertId, {
      ...state,
      count:        MAX_NUDGES,
      scheduledFor: null,
      scheduledDay: null,
    });
    return skipped('suppressed');
  }

  // ── 5. The line ────────────────────────────────────────────────────────────
  const linesUsed = Array.isArray(state.linesUsed) ? state.linesUsed : [];
  const poolLine  = pickNudgeLine(job.stage, linesUsed);
  // Off unless NUDGE_LLM_VARIATION=true; falls back to poolLine on any doubt.
  const line      = await varyNudgeLine(poolLine, linesUsed);

  const body    = buildNudgeBody(pe.expert.name, line);
  const subject = nudgeSubjectFor(pe);
  const now     = Date.now();

  // ── 6. Send ────────────────────────────────────────────────────────────────
  let outcome: { sent: boolean };
  try {
    outcome = await sendSequenceEmail(pe.contactEmail, subject, body, pe.outreachToken, 'nudge');
  } catch (err) {
    // Resend was unreachable or refused. Clear the queue slot so tomorrow's
    // planner tries again; the count is untouched, so nothing was spent.
    await clearQueueSlot(projectId, expertId, state);
    await recordSystemFailure({ area: 'nudge', reason: err, projectId, expertId });
    return skipped('send_failed');
  }

  if (!outcome.sent) {
    // Held by the environment kill switch (walkthrough was already ruled out).
    // Nothing went, so nothing is counted.
    await clearQueueSlot(projectId, expertId, state);
    return skipped('held');
  }

  // ── 7. Record it ───────────────────────────────────────────────────────────
  const count = state.count + 1;

  // The thread stores the LINE, not the greeting or the signature: that is the
  // message, and it is what the client reads on the conversation.
  await appendMessage({
    projectId,
    expertId,
    direction: 'outbound',
    author:    'matchy',
    bodyClean: line,
    summary:   nudgeSummary(pe.expert.name, count),
  });

  await writeNudgeState(projectId, expertId, {
    stage:        state.stage,
    waitingSince: state.waitingSince,
    count,
    lastSentAt:   now,
    scheduledFor: null,
    scheduledDay: null,
    // The line that actually went, so variation output is never repeated either.
    linesUsed:    [...linesUsed, line],
  });

  const firm = await getFirm(project.firmDomain).catch(() => null);
  await emitEngagementEvent({
    projectId,
    expertId,
    orgId:   firm?.id ?? null,
    type:    'nudge_sent',
    payload: {
      stage:        job.stage,
      count,
      hoursWaiting: Math.max(0, Math.round((now - job.waitingSince) / 3_600_000)),
    },
  });

  console.info('[jobs/send-nudge] sent', JSON.stringify({ stage: job.stage, count }));

  return NextResponse.json({ ok: true, sent: true, count });
}

/**
 * Forget the queued job without touching the count or the line history, so the
 * planner can queue a fresh one tomorrow. Used on every no-send that is our
 * fault rather than the expert's.
 */
async function clearQueueSlot(
  projectId: string,
  expertId:  string,
  state:     NudgeState,
): Promise<void> {
  await writeNudgeState(projectId, expertId, {
    ...state,
    scheduledFor: null,
    scheduledDay: null,
  });
}
