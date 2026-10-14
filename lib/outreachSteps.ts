// One step of the outreach email sequence, shared by every entry point:
//
//   POST /api/projects/:projectId/experts/:expertId/bookmark
//        — session-authed, Matchy's 'intro' step (the new template)
//   POST /api/projects/:projectId/experts/:expertId/outreach/approve
//        — session-authed, the review-first "send the intro" button
//
// (The QStash-signed /api/email-sequence/trigger was the third entry point; it
// and the 'email1' step it drained were removed 2026-09-09 (W4-1) once the
// pre-Matchy queue had drained.)
//
// Both of them call runSequenceStep() so there is exactly one implementation of
// "send this step and advance the status": one place that resolves the reply
// token, claims the send with a compare-and-set status write, sends through
// Resend and indexes the token in Redis for inbound lookup. The routes own
// authentication and the pre-send policy checks; this module owns the send
// itself, and the send-once rule that stops a stranger being cold-emailed
// twice.
//
// The intro has one more gate than the legacy step: the rubric's personal line
// (docs/OUTREACH_EMAIL_RUBRIC.md). When neither the evidence nor one model call
// yields a line Matchy trusts, the intro is HELD at 'outreach_drafted' with
// `introNeedsWhyThem` set — even when draftOnly is false — and a person writes
// it through the approve route. Matchy never sends a generic first line.
//
// Never logs: expert name, expert email, project name, token, email content.

import type { Project, ProjectExpert } from '../types';
import { getProject, updateExpertStatus, type UpdateExpertInput } from './projectStore';
import { sendSequenceEmail, type SendOutcome } from './emailSequence';
import {
  buildIntroEmail,
  clientDenyTermsFor,
  deriveTopic,
  introArmFor,
  IntroRubricError,
  type MatchyEmail,
} from './matchyTemplates';
import { generateWhyThem, introDomainFor, whyThemFromEvidence } from './introPersonalization';
import type { FirmTypeValue, FirmSizeValue } from './supabase/database.types';
import { generateOutreachToken } from './outreachToken';
import { getUpstashClient, type UpstashRedis } from './upstashRedis';
import { normalizeEmail } from './outreachSuppressions';

const REPLY_TOKEN_TTL_S = 90 * 24 * 60 * 60;

/**
 * How long one in-flight intro holds its send lock. Long enough to cover a
 * slow Resend call and the status write around it, short enough that a process
 * killed mid-send does not block the client's retry for long. The durable
 * guard is the row itself (introAlreadySent); this only closes the window
 * where two callers have both read the row and neither has written it yet.
 */
const INTRO_LOCK_TTL_S = 120;

/**
 * What this module can actually execute.
 *
 * Matchy's 'intro' is the only step. The legacy cadence's 'email1' / 'email2' /
 * 'email3' were removed 2026-09-09 (W4-1) along with the QStash trigger route
 * that drained them. `ProjectExpert.outreachStep` still STORES the string
 * 'email1' — that is the persisted send-claim marker (see introAlreadySent),
 * not a step this module can be asked to run.
 */
export type OutreachStep = 'intro';

export interface SequenceStepInput {
  projectId: string;
  expertId:  string;
  step:      OutreachStep;
  token:     string;   // may be empty — one is generated
  /**
   * 'intro' only. How Matchy names the client to the expert, from
   * organizations.firm_type / firm_size. Absent falls back to
   * "an investment firm".
   */
  firmType?: FirmTypeValue | null;
  firmSize?: FirmSizeValue | null;
  /**
   * The client organization's name. NEVER written into the email — it is a
   * deny term for deriveTopic, so a brief that names the client's own firm
   * cannot carry it to the expert.
   */
  firmName?: string | null;
  /**
   * 'intro' only. The project's "review first" switch, OR walkthrough mode
   * (lib/walkthrough.ts) — callers OR the two together. When true nothing is
   * sent: the intro is written to outreachSubject/outreachDraft and the status
   * becomes 'outreach_drafted' for the client to approve.
   */
  draftOnly?: boolean;
}

export type SequenceStepError =
  | 'project_not_found'
  | 'expert_not_found'
  | 'no_contact_email'
  // The intro quotes the expert-side rate, so a row with no rate is refused
  // rather than mailed with a number nobody chose (docs/OUTREACH_EMAIL_RUBRIC.md).
  | 'expert_rate_not_set'
  | 'step_failed';

/**
 * Everything runSequenceStep reaches outside itself. Production never passes
 * it; scripts/test-send-chokepoint.ts and scripts/test-delivery-events.ts run
 * the real claim / send / release sequence against an in-memory row and a
 * stub sender, so the ORDER of the writes can be asserted with no database,
 * no Redis and no Resend. Method syntax so a stub may narrow a parameter type.
 */
export interface SequenceStepDeps {
  getProject(projectId: string): Promise<Project | null>;
  updateExpertStatus(projectId: string, expertId: string, input: UpdateExpertInput): Promise<Project>;
  sendSequenceEmail: typeof sendSequenceEmail;
  /** The send lock and the reply-token index. Null means no Redis. */
  redis(): Pick<UpstashRedis, 'set' | 'del'> | null;
  now(): number;
}

function defaultSequenceStepDeps(): SequenceStepDeps {
  return {
    getProject,
    updateExpertStatus,
    sendSequenceEmail,
    redis: getUpstashClient,
    now:   Date.now,
  };
}

export type SequenceStepResult =
  /**
   * `alreadySent` marks the send-once refusal: the intro was already delivered
   * to this expert, so nothing was sent this time and nothing was written. A
   * caller that emits an `intro_sent` event should skip it when this is set.
   */
  | { ok: true;  project: Project; alreadySent?: true }
  | { ok: false; error: SequenceStepError; status: number };

/** The send-once facts introAlreadySent reads. The bounce fields are optional. */
export type IntroClaimFacts =
  Pick<ProjectExpert, 'email1SentAt' | 'outreachStep'>
  & Partial<Pick<ProjectExpert, 'contactEmail' | 'bouncedEmails' | 'contactBouncedAt'>>;

/**
 * Has the intro already gone to this expert?
 *
 * Either marker is enough. `email1SentAt` is written when the send is claimed
 * (see runSequenceStep) and `outreachStep === 'email1'` is the same claim seen
 * from the pipeline's side; a row that carries one without the other is a
 * half-written claim, which still means "an intro may be in flight".
 *
 * ONE EXCEPTION, AND IT IS NARROW: an intro that HARD-BOUNCED never reached
 * anyone (lib/deliveryEvents.ts). When the standing claim predates the last
 * bounce and the address on file now is a different one, that address has not
 * had an intro, so one may go to it. See claimPredatesBounce. A second intro to
 * the SAME address is still refused: a bounced address is in `bouncedEmails`,
 * which this rule never lets through, and the new address's own claim postdates
 * the bounce the moment it is written.
 *
 * Pure — tested by scripts/test-send-chokepoint.ts and
 * scripts/test-delivery-events.ts.
 */
export function introAlreadySent(pe: IntroClaimFacts): boolean {
  const claimed = (typeof pe.email1SentAt === 'number' && pe.email1SentAt > 0)
    || pe.outreachStep === 'email1';
  if (!claimed) return false;
  return !claimPredatesBounce(pe);
}

/**
 * True only when the intro claim on this row was made for an address that has
 * since hard-bounced, and the address on file now is a different one:
 *
 *   - an address is on file and is NOT one of the bounced addresses
 *   - `email1SentAt` is a real instant at or before `contactBouncedAt`
 *
 * Anything less certain (no address, a half-written claim with no instant, no
 * bounce recorded) is false, which keeps the claim standing. Pure.
 */
export function claimPredatesBounce(pe: IntroClaimFacts): boolean {
  const address = normalizeEmail(pe.contactEmail ?? '');
  if (!address) return false;

  const bounced = (pe.bouncedEmails ?? [])
    .filter((e): e is string => typeof e === 'string')
    .map(normalizeEmail);
  if (bounced.length === 0 || bounced.includes(address)) return false;

  const claimedAt = typeof pe.email1SentAt === 'number' ? pe.email1SentAt : 0;
  const bouncedAt = typeof pe.contactBouncedAt === 'number' ? pe.contactBouncedAt : 0;
  return claimedAt > 0 && bouncedAt > 0 && claimedAt <= bouncedAt;
}

/**
 * The Redis key of the atomic intro lock for one (project, expert).
 *
 * `generation` is how many addresses have hard-bounced on the engagement. The
 * first intro uses the bare key it always has; the intro to a replacement
 * address uses its own, so a lock left by the bounced send (it holds for
 * INTRO_LOCK_TTL_S, and bounces often arrive within seconds) cannot swallow the
 * one retry. Two concurrent callers after the same bounce still share a key.
 * Carries no address. Pure.
 */
export function introLockKey(projectId: string, expertId: string, generation = 0): string {
  const base = `intro-lock:${projectId}:${expertId}`;
  return generation > 0 ? `${base}:${Math.floor(generation)}` : base;
}

/** How many distinct addresses have hard-bounced on this engagement. Pure. */
function bounceGeneration(pe: Pick<ProjectExpert, 'bouncedEmails'>): number {
  const seen = new Set<string>();
  for (const e of pe.bouncedEmails ?? []) {
    if (typeof e === 'string' && e.trim()) seen.add(normalizeEmail(e));
  }
  return seen.size;
}

/**
 * Send one step of the sequence and persist the resulting status.
 *
 * Fails closed on a missing rate: there is no default. A cleared rate used to
 * fall back to $500/hr, which meant a queued email could quote a number nobody
 * chose.
 *
 * SEND-ONCE, AND THE ORDER THAT MAKES IT TRUE (H-2). An intro that has already
 * gone out is refused outright (`alreadySent`). For a fresh one the status
 * write comes BEFORE the send, not after: it is a compare-and-set, so it is the
 * only thing in this function that can make two concurrent callers disagree
 * about who is sending. Losing that write means not sending at all. Winning it
 * and then failing to send means releasing it again (releaseClaim), which
 * leaves the row exactly where it started. The Redis reply-token index moved
 * after the send and is now best-effort: it can no longer turn a delivered
 * email into a `step_failed` that invites a retry.
 */
export async function runSequenceStep(
  input: SequenceStepInput,
  deps:  Partial<SequenceStepDeps> = {},
): Promise<SequenceStepResult> {
  const d = { ...defaultSequenceStepDeps(), ...deps };
  const { projectId, expertId, step, token } = input;

  const project = await d.getProject(projectId);
  if (!project) return { ok: false, error: 'project_not_found', status: 404 };

  const pe = project.experts.find(e => e.expert.id === expertId);
  if (!pe) return { ok: false, error: 'expert_not_found', status: 404 };

  const expertEmail = pe.contactEmail;
  if (!expertEmail) return { ok: false, error: 'no_contact_email', status: 422 };

  // The intro quotes the expert-side number (docs/OUTREACH_EMAIL_RUBRIC.md:
  // the offer is part of the message), so it fails closed on a missing rate.
  // There is no default: a cleared rate used to fall back to $500/hr, which
  // meant an email could quote a number nobody chose. The bookmark route seeds
  // the intro's rate from the tier before calling.
  const rate = pe.expertRate ?? 0;
  if (rate <= 0) {
    return { ok: false, error: 'expert_rate_not_set', status: 422 };
  }

  try {
    // ── Matchy's intro (docs/OUTREACH_EMAIL_RUBRIC.md) ──────────────────────
    // Anonymized client, the expert-side offer, one personal line — see
    // lib/matchyTemplates.ts. It reuses the same token, Redis index and status
    // write the retired cadence used, so an expert reply lands on the thread
    // the way it always has.
    //
    // SEND ONCE (H-2). One cold email per stranger is the product rule
    // (docs/MATCHY_SPEC.md), and this is the only place that can enforce it:
    // two bookmarks, a re-queued discovery job and a double-clicked approve
    // all arrive here. Checked before the draft branch too — re-drafting an
    // intro that already went out would drag the row back to
    // 'outreach_drafted' and offer the client a button that sends a second.
    // The one intro to a REPLACEMENT address after a hard bounce is let
    // through by introAlreadySent itself (claimPredatesBounce); a bounced
    // address never is.
    if (introAlreadySent(pe)) {
      console.info('[outreachSteps] intro already sent — nothing sent', JSON.stringify({ step }));
      return { ok: true, project, alreadySent: true };
    }

    const activeToken = token || generateOutreachToken(projectId, expertId).token;
    const arm         = pe.introArm ?? introArmFor(expertId);
    const denyTerms   = clientDenyTermsFor(project, input.firmName);
    const topic       = deriveTopic(project, { denyTerms: input.firmName ? [input.firmName] : [] });

    // The personal line and the subject's domain. Whatever is already on
    // the expert wins (staff may have written the line, or an earlier draft
    // computed it); otherwise the deterministic pass, then one model call.
    // Nothing here ever fabricates a sentence — see lib/introPersonalization.
    const resolved = await resolveWhyThem(pe, { industry: project.industry, denyTerms });
    const whyThem  = resolved.whyThem;
    const domain   = resolved.domain ?? topic;

    // Personalization is a rubric hard rule, not a nicety. With no line
    // Matchy trusts, the intro waits at 'outreach_drafted' for a person to
    // write it, whatever `draftOnly` says. Nothing leaves the building, so
    // no claim is taken either.
    if (!whyThem) {
      return { ok: true, project: await hold(d, projectId, expertId, activeToken, { introArm: arm, introDomain: domain }) };
    }

    const introFields: UpdateExpertInput = {
      introArm:          arm,
      whyThem,
      introDomain:       domain,
      introNeedsWhyThem: false,
    };

    let email: MatchyEmail;
    try {
      email = buildIntroEmail({
        arm,
        domain,
        whyThem,
        firmType:        input.firmType ?? null,
        firmSize:        input.firmSize ?? null,
        topic,
        expertRate:      rate,
        expertFirstName: pe.expert.name,
        recipientEmail:  expertEmail,
      });
    } catch (err) {
      // The assembled message broke a hard rule (an em dash or a banned
      // phrase in the line, or a body over 90 words). Same answer as no
      // line at all: hold it for a person, never send it.
      if (!(err instanceof IntroRubricError)) throw err;
      console.warn('[outreachSteps] intro held: rubric', JSON.stringify({ rule: err.rule }));
      return { ok: true, project: await hold(d, projectId, expertId, activeToken, introFields) };
    }

    // Review-first (or walkthrough): write the draft and stop. Nothing
    // leaves the building.
    if (input.draftOnly) {
      return { ok: true, project: await draft(d, projectId, expertId, activeToken, email.subject, email.text, introFields) };
    }

    // TWO CLAIMS, AND THEY DO DIFFERENT JOBS.
    //
    // The Redis SET NX below is the ATOMIC one: it is what makes two callers
    // that both read an unclaimed row disagree about who is sending. Exactly
    // one gets the key; the other returns `alreadySent` having sent nothing.
    // `updateExpertStatus`, a compare-and-set on the row's updated_at, is not
    // enough on its own — lib/projectStore.mutateExpert RE-READS and retries
    // on a lost CAS, so the loser's second attempt would write over the
    // winner's claim and go on to send. Redis being unavailable falls back to
    // the row check alone (the local store has no Redis at all), which is the
    // pre-existing behaviour rather than a new opening.
    //
    // The status write is the DURABLE one: it is what stops the second email
    // an hour later, after the lock has expired, and it is written BEFORE the
    // send so that a claim we could not record means not sending at all.
    // Both are released again (releaseClaim) when the send is held or throws,
    // so a genuine failure leaves the expert exactly where they were.
    const lockKey = introLockKey(projectId, expertId, bounceGeneration(pe));
    const lock    = await claimIntroLock(d, lockKey);
    if (lock === 'held_by_other') {
      console.info('[outreachSteps] intro already in flight — nothing sent', JSON.stringify({ step }));
      return { ok: true, project, alreadySent: true };
    }

    let claimed: Project;
    try {
      claimed = await d.updateExpertStatus(projectId, expertId, {
        // The rubric fields ride on the claim, so the arm, the line and the
        // domain that produced THIS email are recorded in the same write that
        // says it went (docs/OUTREACH_EMAIL_RUBRIC.md).
        ...introFields,
        status:          'contacted',
        outreachStep:    'email1',
        outreachSubject: email.subject,
        outreachDraft:   email.text,
        // A FRESH instant on every claim, the replacement intro after a hard
        // bounce included: it is what makes this send postdate
        // `contactBouncedAt`, so the row stops reading as bounced
        // (lib/outreachStats.ts) and introAlreadySent refuses a second one.
        email1SentAt:    d.now(),
        contactedAt:     pe.contactedAt ?? d.now(),
        outreachToken:   activeToken,
      });
    } catch (err) {
      await releaseIntroLock(d, lockKey);
      console.error('[outreachSteps] intro claim failed — nothing sent:',
        err instanceof Error ? err.message.slice(0, 120) : 'unknown');
      return { ok: false, error: 'step_failed', status: 500 };
    }

    // buildIntroEmail returns a complete message, CAN-SPAM footer included,
    // so the sender must not append a second one.
    let introOutcome: SendOutcome;
    try {
      introOutcome = await d.sendSequenceEmail(expertEmail, email.subject, email.text, activeToken, 'intro', {
        footerIncluded: true,
        html:           email.html,
      });
    } catch (err) {
      // Resend refused. Release both claims so the client can try again, then
      // report the failure the way this function always has.
      await releaseClaim(d, projectId, expertId, pe);
      await releaseIntroLock(d, lockKey);
      console.error('[outreachSteps] intro send failed:',
        err instanceof Error ? err.message.slice(0, 120) : 'unknown');
      return { ok: false, error: 'step_failed', status: 500 };
    }

    // The chokepoint held it (walkthrough, DISABLE_EMAILS, no card on file,
    // or the do-not-contact list). Nothing left the building, so the claim is
    // released and the row lands on exactly the state the draftOnly branch
    // writes rather than claiming 'contacted'.
    if (!introOutcome.sent) {
      await releaseClaim(d, projectId, expertId, pe);
      await releaseIntroLock(d, lockKey);
      return { ok: true, project: await draft(d, projectId, expertId, activeToken, email.subject, email.text, introFields) };
    }

    // The email is gone and the claim that records it is already durable. The
    // Redis reply-token index is best-effort by design — inbound-email falls
    // back to the HMAC token payload when the key is missing — so a failure
    // here must not undo a delivered email or answer `step_failed`.
    try {
      const redis = d.redis();
      if (redis) {
        await redis.set(
          `reply-token:${activeToken}`,
          JSON.stringify({ projectId, expertId }),
          { ex: REPLY_TOKEN_TTL_S },
        );
      }
    } catch (err) {
      console.warn('[outreachSteps] reply-token index not written',
        JSON.stringify({ reason: err instanceof Error ? err.message.slice(0, 80) : 'unknown' }));
    }

    return { ok: true, project: claimed };
  } catch (err) {
    console.error('[outreachSteps] step failed:',
      err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return { ok: false, error: 'step_failed', status: 500 };
  }
}

/**
 * Take the atomic send lock for one (project, expert) intro.
 *
 * `SET NX` is the only primitive in this system that two concurrent requests
 * cannot both win. 'no_lock' means Redis is not configured or did not answer:
 * the caller proceeds on the row check alone, which is what this function has
 * always effectively done, rather than refusing every intro whenever Redis is
 * down.
 *
 * Never logs the key's contents; the key itself carries no address
 * (introLockKey).
 */
async function claimIntroLock(
  d:       SequenceStepDeps,
  lockKey: string,
): Promise<'claimed' | 'held_by_other' | 'no_lock'> {
  const redis = d.redis();
  if (!redis) return 'no_lock';
  try {
    const result = await redis.set(lockKey, '1', {
      ex: INTRO_LOCK_TTL_S,
      nx: true,
    });
    return result ? 'claimed' : 'held_by_other';
  } catch (err) {
    console.warn('[outreachSteps] intro lock unavailable',
      JSON.stringify({ reason: err instanceof Error ? err.message.slice(0, 80) : 'unknown' }));
    return 'no_lock';
  }
}

/**
 * Give the lock back after a send that did not happen, so the client's retry
 * is not stuck behind the TTL. A failure here costs at most INTRO_LOCK_TTL_S of
 * waiting and can never cause a second email, so it is swallowed.
 */
async function releaseIntroLock(d: SequenceStepDeps, lockKey: string): Promise<void> {
  const redis = d.redis();
  if (!redis) return;
  try {
    await redis.del(lockKey);
  } catch {
    // The TTL cleans up.
  }
}

/**
 * Undo the pre-send claim: the intro did not go, so nothing may say it did.
 *
 * `email1SentAt: 0`, not null: `UpdateExpertInput.email1SentAt` now accepts
 * `number | null`, but 0 is what introAlreadySent() reads as falsy, so the
 * next attempt is allowed through either way — 0 is kept for consistency
 * with the rest of this file's claim/release pairing.
 *
 * AN INTRO TO A REPLACEMENT ADDRESS (lib/deliveryEvents.ts) restores the
 * instant of the BOUNCED intro instead of 0: the row then reads exactly as it
 * did before this attempt (claim predates the bounce, so the retry is still
 * allowed), and the bounced intro stays on the record. A first intro had no
 * instant, so it still gets 0.
 *
 * Best effort: a failure here leaves the row claimed, which refuses the next
 * send rather than duplicating one. That is the right way to fail.
 */
async function releaseClaim(
  d:         SequenceStepDeps,
  projectId: string,
  expertId:  string,
  previous:  ProjectExpert,
): Promise<void> {
  try {
    await d.updateExpertStatus(projectId, expertId, {
      status:       previous.status,
      email1SentAt: typeof previous.email1SentAt === 'number' && previous.email1SentAt > 0
        ? previous.email1SentAt
        : 0,
      // EXACTLY what was there, nothing included. Written unconditionally: the
      // claim set 'email1', and a row that had no step before must not keep
      // it, or introAlreadySent reads the held intro as sent and the next
      // approve answers "sent" having sent nothing. (A key present with
      // `undefined` is removed by lib/projectStore's merge.)
      outreachStep: previous.outreachStep,
    });
  } catch (err) {
    console.error('[outreachSteps] claim not released:',
      err instanceof Error ? err.message.slice(0, 120) : 'unknown');
  }
}

/**
 * The "written but not sent" state, in one place.
 *
 * Three paths land here: the review-first switch, walkthrough mode, and the
 * chokepoint refusing a send (lib/emailSequence.SendOutcome). All three mean the
 * same thing to the client — the intro exists and is waiting on them — so they
 * must write the same record. `extra` carries the intro's rubric fields (arm,
 * line, domain) so a later approve reuses them instead of recomputing.
 */
async function draft(
  d:         SequenceStepDeps,
  projectId: string,
  expertId:  string,
  token:     string,
  subject:   string,
  text:      string,
  extra:     UpdateExpertInput = {},
): Promise<Project> {
  return d.updateExpertStatus(projectId, expertId, {
    ...extra,
    status:          'outreach_drafted',
    outreachSubject: subject,
    outreachDraft:   text,
    outreachToken:   token,
  });
}

/**
 * The "waiting on a person" state: drafted, but Matchy could not write a
 * why-them line it trusts (or the one it had breaks the rubric). No body is
 * stored — there is no body without the line — and `introNeedsWhyThem` is
 * what the thread renders as "Matchy is finishing the intro" and what the
 * approve route refuses to send past without a line.
 */
async function hold(
  d:         SequenceStepDeps,
  projectId: string,
  expertId:  string,
  token:     string,
  extra:     UpdateExpertInput,
): Promise<Project> {
  return d.updateExpertStatus(projectId, expertId, {
    ...extra,
    status:            'outreach_drafted',
    outreachToken:     token,
    introNeedsWhyThem: true,
  });
}

/**
 * The why-them line and the domain for one expert, in the order the rubric
 * note in docs/OUTREACH_EMAIL_RUBRIC.md describes: what is already recorded,
 * then the deterministic evidence pass, then one model call. Either field may
 * come back null; the caller decides what a missing one means.
 */
async function resolveWhyThem(
  pe: ProjectExpert,
  options: { industry: string | null | undefined; denyTerms: readonly string[] },
): Promise<{ whyThem: string | null; domain: string | null }> {
  const stored = {
    whyThem: pe.whyThem?.trim() || null,
    domain:  pe.introDomain?.trim() || null,
  };
  if (stored.whyThem && stored.domain) return stored;

  // Staff wrote the line but nothing named the domain yet: derive it without
  // touching the line.
  if (stored.whyThem) {
    return { whyThem: stored.whyThem, domain: introDomainFor(pe.expert, options) };
  }

  const generated = whyThemFromEvidence(pe.expert, options) ?? await generateWhyThem(pe.expert, options);
  if (!generated) return { whyThem: null, domain: stored.domain ?? introDomainFor(pe.expert, options) };
  return { whyThem: generated.whyThem, domain: stored.domain ?? generated.domain };
}
