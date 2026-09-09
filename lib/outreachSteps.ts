// One step of the outreach email sequence, shared by every entry point:
//
//   POST /api/projects/:projectId/experts/:expertId/bookmark
//        — session-authed, Matchy's 'intro' step (the new template)
//   POST /api/projects/:projectId/experts/:expertId/outreach/approve
//        — session-authed, the review-first "send the intro" button
//   POST /api/email-sequence/trigger
//        — QStash-signed; the cadence is retired, so this only drains a queued
//          email1 retry (it acknowledges email2/email3 without calling here)
//
// All of them call runSequenceStep() so there is exactly one implementation of
// "send this step and advance the status": one place that resolves the reply
// token, indexes it in Redis for inbound lookup, sends through Resend and
// writes the resulting status. The routes own authentication and the pre-send
// policy checks; this module owns the send itself.
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
import { generateEmail1, sendSequenceEmail } from './emailSequence';
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
import { getUpstashClient } from './upstashRedis';

const REPLY_TOKEN_TTL_S = 90 * 24 * 60 * 60;

/**
 * What this module can actually execute.
 *
 * Matchy's 'intro' replaces the legacy `email1` for anything that starts from a
 * bookmark. 'email1' survives only for a queued QStash retry. The cadence's
 * 'email2' / 'email3' are gone — they are still valid values on the QStash wire
 * (lib/emailSequence.EmailStep) but the trigger route acknowledges them and
 * never reaches here.
 */
export type OutreachStep = 'intro' | 'email1';

export interface SequenceStepInput {
  projectId: string;
  expertId:  string;
  step:      OutreachStep;
  token:     string;   // may be empty for email1/intro — one is generated
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
  | 'expert_rate_not_set'
  | 'unknown_step'
  | 'step_failed';

export type SequenceStepResult =
  | { ok: true;  project: Project }
  | { ok: false; error: SequenceStepError; status: number };

/**
 * Send one step of the sequence and persist the resulting status.
 *
 * Fails closed on a missing rate: there is no default. A cleared rate used to
 * fall back to $500/hr, which meant a queued email could quote a number nobody
 * chose.
 */
export async function runSequenceStep(input: SequenceStepInput): Promise<SequenceStepResult> {
  const { projectId, expertId, step, token } = input;

  const project = await getProject(projectId);
  if (!project) return { ok: false, error: 'project_not_found', status: 404 };

  const pe = project.experts.find(e => e.expert.id === expertId);
  if (!pe) return { ok: false, error: 'expert_not_found', status: 404 };

  const expertEmail = pe.contactEmail;
  if (!expertEmail) return { ok: false, error: 'no_contact_email', status: 422 };

  // Both steps quote a number, so both fail closed on a missing rate. There is
  // no default: a cleared rate used to fall back to $500/hr, which meant a
  // queued email could quote a number nobody chose. The bookmark route seeds
  // the intro's rate from the tier before calling.
  const rate = pe.expertRate ?? 0;
  if (rate <= 0) {
    return { ok: false, error: 'expert_rate_not_set', status: 422 };
  }

  const query = project.researchQuestion;

  try {
    // ── Matchy's intro (docs/OUTREACH_EMAIL_RUBRIC.md) ──────────────────────
    // Anonymized client, the expert-side offer, one personal line — see
    // lib/matchyTemplates.ts. It reuses the same token, Redis index and status
    // write as email1, so an expert reply lands on the thread exactly the way
    // it always has.
    if (step === 'intro') {
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
      // write it, whatever `draftOnly` says. Nothing leaves the building.
      if (!whyThem) {
        return { ok: true, project: await hold(projectId, expertId, activeToken, { introArm: arm, introDomain: domain }) };
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
        return { ok: true, project: await hold(projectId, expertId, activeToken, introFields) };
      }

      // Review-first (or walkthrough): write the draft and stop. Nothing
      // leaves the building.
      if (input.draftOnly) {
        return { ok: true, project: await draft(projectId, expertId, activeToken, email.subject, email.text, introFields) };
      }

      // buildIntroEmail returns a complete message, CAN-SPAM footer included,
      // so the sender must not append a second one.
      const introOutcome = await sendSequenceEmail(expertEmail, email.subject, email.text, activeToken, 'intro', {
        footerIncluded: true,
        html:           email.html,
      });

      // The chokepoint held it (walkthrough mode, or DISABLE_EMAILS). Land on
      // exactly the same state the draftOnly branch does rather than writing
      // 'contacted' for a message nobody received.
      if (!introOutcome.sent) {
        return { ok: true, project: await draft(projectId, expertId, activeToken, email.subject, email.text, introFields) };
      }

      // ORDER OF WRITES AFTER A SUCCESSFUL SEND. The email is already gone, so
      // everything from here is bookkeeping that must not be retried blindly:
      // if the Redis index write or the status write throws, the catch below
      // answers `step_failed` (500) while the expert has the intro in hand, and
      // a caller that retries sends a second cold email. The index is
      // best-effort by design — inbound-email falls back to the HMAC token
      // payload when the key is missing — but the status write is not.
      const redis = getUpstashClient();
      if (redis) {
        await redis.set(
          `reply-token:${activeToken}`,
          JSON.stringify({ projectId, expertId }),
          { ex: REPLY_TOKEN_TTL_S },
        );
      }

      const updated = await updateExpertStatus(projectId, expertId, {
        ...introFields,
        status:          'contacted',
        outreachStep:    'email1',
        outreachSubject: email.subject,
        outreachDraft:   email.text,
        email1SentAt:    Date.now(),
        contactedAt:     pe.contactedAt ?? Date.now(),
        outreachToken:   activeToken,
      });
      return { ok: true, project: updated };
    }

    if (step === 'email1') {
      // Generate a fresh outreach reply token when the caller has none yet.
      const activeToken = token || generateOutreachToken(projectId, expertId).token;

      const { subject, body } = await generateEmail1(pe.expert, query, rate);
      const outcome = await sendSequenceEmail(expertEmail, subject, body, activeToken, 'email1');

      // Same safety net on the legacy retry path: a held send is a draft, never
      // a 'contacted'.
      if (!outcome.sent) {
        return { ok: true, project: await draft(projectId, expertId, activeToken, subject, body) };
      }

      // Store reply-token index in Redis for inbound-email lookup
      const redis = getUpstashClient();
      if (redis) {
        await redis.set(
          `reply-token:${activeToken}`,
          JSON.stringify({ projectId, expertId }),
          { ex: REPLY_TOKEN_TTL_S },
        );
      }

      const updated = await updateExpertStatus(projectId, expertId, {
        status:        'contacted',
        outreachStep:  'email1',
        email1SentAt:  Date.now(),
        contactedAt:   pe.contactedAt ?? Date.now(),
        outreachToken: activeToken,
      });
      return { ok: true, project: updated };
    }

    return { ok: false, error: 'unknown_step', status: 400 };
  } catch (err) {
    console.error('[outreachSteps] step failed:',
      err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return { ok: false, error: 'step_failed', status: 500 };
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
  projectId: string,
  expertId:  string,
  token:     string,
  subject:   string,
  text:      string,
  extra:     UpdateExpertInput = {},
): Promise<Project> {
  return updateExpertStatus(projectId, expertId, {
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
  projectId: string,
  expertId:  string,
  token:     string,
  extra:     UpdateExpertInput,
): Promise<Project> {
  return updateExpertStatus(projectId, expertId, {
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
