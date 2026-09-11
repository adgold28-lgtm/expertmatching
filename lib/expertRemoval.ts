// Wave 5 contract file — OWNED BY BRIEF B1, called by B2.
//
// What happens when the EXPERT is at fault (docs/CALL_POLICIES_DRAFT.md,
// founder decision 3): no charge to the client, no payout, Matchy emails the
// client an apology on ExpertMatch's behalf saying the expert has been removed
// from the platform, the expert's contactEmail goes on outreach_suppressions
// (reason 'manual', source project id), and the engagement ends
// ('rejected_after_outreach').
//
// Callers: lib/bookCall.cancelCall (expert late cancel) and the Zoom webhook /
// staff attendance confirmation (expert no-show). The apology names no client
// details and is capped like every Matchy line. Idempotent on the engagement
// status; never throws.
//
// THE ORDER, and why. Suppression first: it is the only step that protects a
// person (the expert must not be cold-emailed again from the next project), it
// is idempotent by construction (upsert on the address), and a failure in a
// later step must never leave it undone. The apology second, because it is the
// one step a client sees. The status write last, because it is what makes a
// second call a no-op: a row that is already terminal has already been through
// here, so nothing is sent twice.
//
// IDEMPOTENCE is keyed on the engagement status rather than a new column: the
// only thing that moves an engagement to 'rejected_after_outreach' with a
// booking on it is this module and lib/bookCall.cancelCall, which calls it.
//
// Never logs: the expert's address or name, the client's address, the project
// name. Never throws: every caller is already in the middle of a cancel or a
// webhook and has nothing useful to do with an exception.

import type { Project, ProjectExpert } from '../types';
import { updateExpertStatus } from './projectStore';
import { suppress } from './outreachSuppressions';
import { appendMessage } from './conversations';
import { sendSequenceEmail } from './emailSequence';
import { expertRemovedApologyEmail, threadSubject } from './schedulingTemplates';
import { enforceBrevity } from './matchyBrevity';
import { getUser } from './firmStore';
import { cleanEmailBody } from './emailClean';

export type ExpertFault = 'late_cancel' | 'no_show';

export interface ExpertRemovalResult {
  ok:          boolean;
  /** Fixed labels only. */
  reason?:     'not_implemented' | 'already_removed' | 'no_contact_email';
  suppressed?: boolean;
  apologySent?: boolean;
}

/** The address the apology goes to: the signed-in owner, else the legacy field. */
function clientAddressOf(project: Project): string {
  return (project.ownerEmail?.trim() || project.clientEmail?.trim() || '');
}

/** The client contact's first name, best effort. 'there' when we have none. */
async function clientFirstNameOf(project: Project): Promise<string> {
  const stated = project.clientName?.trim();
  if (stated) return stated;
  if (!project.ownerEmail) return 'there';
  const owner = await getUser(project.ownerEmail).catch(() => null);
  return owner?.firstName?.trim() || 'there';
}

export async function removeExpertForFault(
  project: Project,
  pe:      ProjectExpert,
  fault:   ExpertFault,
): Promise<ExpertRemovalResult> {
  // Already been through here. Not an error: a late cancel that the webhook
  // then also reports as a no-show must cost the expert exactly one removal.
  // Keyed on the removal's own stamp, NOT on the terminal status: cancelCall
  // writes 'rejected_after_outreach' in its compare-and-set and only then
  // calls this with the row it wrote, so the status is already terminal on the
  // very call that has to do the work.
  if (pe.expertRemovedAt) {
    return { ok: true, reason: 'already_removed' };
  }

  const result: ExpertRemovalResult = { ok: true };

  // ── 1. The do-not-contact list ─────────────────────────────────────────
  if (pe.contactEmail) {
    result.suppressed = await suppress(pe.contactEmail, 'manual', project.id).catch(() => false);
  } else {
    result.suppressed = false;
    result.reason     = 'no_contact_email';
  }

  // ── 2. The apology, and the same line on the thread ────────────────────
  const clientEmail = clientAddressOf(project);
  const subject     = threadSubject(pe.outreachSubject);
  const firstName   = await clientFirstNameOf(project).catch(() => 'there');

  const email = expertRemovedApologyEmail({
    clientFirstName: firstName,
    recipientEmail:  clientEmail,
    subject,
  });

  // The house cap on a Matchy line, applied the same way every other outbound
  // body applies it. A body that will not fit is still sent: enforceBrevity
  // reports, it does not rewrite, and this copy is a fixed template rather than
  // model output, so a failure here is a bug in the template and nothing a
  // client should be denied an apology over.
  const brevity = enforceBrevity(email.text);
  if (!brevity.ok) {
    console.warn('[expertRemoval] apology copy exceeds the brevity cap',
      JSON.stringify({ reason: brevity.reason }));
  }

  if (clientEmail && pe.outreachToken) {
    const outcome = await sendSequenceEmail(
      clientEmail, subject, email.text, pe.outreachToken, 'expert_removed',
      { footerIncluded: true, html: email.html },
    ).catch(() => ({ sent: false as const, held: 'disabled' as const }));
    result.apologySent = outcome.sent;

    await appendMessage({
      projectId: project.id,
      expertId:  pe.expert.id,
      direction: 'outbound',
      author:    'matchy',
      bodyClean: cleanEmailBody(email.text),
      summary:   'The expert has been removed. You have not been charged.',
      ...(outcome.sent ? {} : { held: outcome.held }),
    });
  } else {
    result.apologySent = false;
  }

  // ── 3. End the engagement ──────────────────────────────────────────────
  try {
    await updateExpertStatus(project.id, pe.expert.id, {
      status:           'rejected_after_outreach',
      expertRemovedAt:  Date.now(),
      expertRemovedFor: fault,
    });
  } catch (err) {
    console.error('[expertRemoval] status write failed:',
      err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    result.ok = false;
  }

  return result;
}
