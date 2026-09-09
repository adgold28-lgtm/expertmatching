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
// Never logs: expert name, expert email, project name, token, email content.

import type { Project } from '../types';
import { getProject, updateExpertStatus } from './projectStore';
import { generateEmail1, sendSequenceEmail } from './emailSequence';
import { buildIntroEmail, deriveTopic, descriptorFragmentFrom } from './matchyTemplates';
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

  // The legacy cadence quotes a number, so it fails closed on a missing rate.
  // Matchy's intro never mentions money, so it does not need one — but the
  // bookmark route seeds the rate from the tier before calling anyway.
  const rate = pe.expertRate ?? 0;
  if (step !== 'intro' && rate <= 0) {
    return { ok: false, error: 'expert_rate_not_set', status: 422 };
  }

  const query = project.researchQuestion;

  try {
    // ── Matchy's intro (docs/MATCHY_SPEC.md workflow step 3) ────────────────
    // Anonymized, no money, no client name — see lib/matchyTemplates.ts. It
    // reuses the same token, Redis index and status write as email1, so an
    // expert reply lands on the thread exactly the way it always has.
    if (step === 'intro') {
      const activeToken = token || generateOutreachToken(projectId, expertId).token;

      const email = buildIntroEmail({
        firmType:           input.firmType ?? null,
        firmSize:           input.firmSize ?? null,
        topic:              deriveTopic(project, { denyTerms: input.firmName ? [input.firmName] : [] }),
        descriptorFragment: descriptorFragmentFrom(pe.expert.anonymizedDescriptor),
        expertFirstName:    pe.expert.name,
        recipientEmail:     expertEmail,
      });

      // Review-first (or walkthrough): write the draft and stop. Nothing
      // leaves the building.
      if (input.draftOnly) {
        return { ok: true, project: await draft(projectId, expertId, activeToken, email.subject, email.text) };
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
        return { ok: true, project: await draft(projectId, expertId, activeToken, email.subject, email.text) };
      }

      const redis = getUpstashClient();
      if (redis) {
        await redis.set(
          `reply-token:${activeToken}`,
          JSON.stringify({ projectId, expertId }),
          { ex: REPLY_TOKEN_TTL_S },
        );
      }

      const updated = await updateExpertStatus(projectId, expertId, {
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
 * must write the same record.
 */
async function draft(
  projectId: string,
  expertId:  string,
  token:     string,
  subject:   string,
  text:      string,
): Promise<Project> {
  return updateExpertStatus(projectId, expertId, {
    status:          'outreach_drafted',
    outreachSubject: subject,
    outreachDraft:   text,
    outreachToken:   token,
  });
}
