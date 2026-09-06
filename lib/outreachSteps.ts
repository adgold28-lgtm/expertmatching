// One step of the outreach email sequence, shared by both entry points:
//
//   POST /api/projects/:projectId/experts/:expertId/outreach/start
//        — session-authed, human-clicked, email1 only
//   POST /api/email-sequence/trigger
//        — QStash-signed, email2 and any future scheduled step
//
// Both call runSequenceStep() so there is exactly one implementation of "send
// this step and advance the status". The routes own authentication and the
// pre-send policy checks; this module owns the send itself.
//
// Never logs: expert name, expert email, project name, token, email content.

import type { Project } from '../types';
import { getProject, updateExpertStatus } from './projectStore';
import {
  generateEmail1,
  generateEmail2,
  generateEmail3,
  sendSequenceEmail,
  type EmailStep,
} from './emailSequence';
import { generateAvailabilityToken } from './availabilityToken';
import { generateOutreachToken } from './outreachToken';
import { getUpstashClient } from './upstashRedis';

const REPLY_TOKEN_TTL_S = 90 * 24 * 60 * 60;

export interface SequenceStepInput {
  projectId: string;
  expertId:  string;
  step:      EmailStep;
  token:     string;   // may be empty for email1 — one is generated
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

  const rate = pe.expertRate;
  if (!rate || rate <= 0) return { ok: false, error: 'expert_rate_not_set', status: 422 };

  const query = project.researchQuestion;

  try {
    if (step === 'email1') {
      // Generate a fresh outreach reply token when the caller has none yet.
      const activeToken = token || generateOutreachToken(projectId, expertId).token;

      const { subject, body } = await generateEmail1(pe.expert, query, rate);
      await sendSequenceEmail(expertEmail, subject, body, activeToken, 'email1');

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

    if (step === 'email2') {
      const replyToken = pe.outreachToken ?? token;
      const { subject, body } = await generateEmail2(pe.expert, query, rate);
      await sendSequenceEmail(expertEmail, subject, body, replyToken, 'email2');

      const updated = await updateExpertStatus(projectId, expertId, {
        status:       'email2_sent',
        outreachStep: 'email2',
        email2SentAt: Date.now(),
      });
      return { ok: true, project: updated };
    }

    if (step === 'email3') {
      const replyToken = pe.outreachToken ?? token;
      const { token: schedToken } = generateAvailabilityToken(projectId, expertId);
      const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
      const schedulingUrl = `${baseUrl}/availability/${schedToken}`;

      const firmName = project.name; // project name serves as firm name context

      const { subject, body } = await generateEmail3(pe.expert, firmName, schedulingUrl);
      await sendSequenceEmail(expertEmail, subject, body, replyToken, 'email3');

      const updated = await updateExpertStatus(projectId, expertId, {
        status:       'scheduling_sent',
        outreachStep: 'email3',
        email3SentAt: Date.now(),
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
