// Outreach email sending.
//
// The 3-email cadence is GONE. Matchy answers a reply on the thread instead of
// firing a follow-up on a timer, so email 2 (conflicts + rate) and email 3
// (scheduling link) no longer exist: their generators are deleted and
// scheduleNextEmail() publishes nothing. What is left is
//
//   generateEmail1   — the legacy interest check, still reachable through a
//                      queued QStash retry of a send that was already accepted
//   sendSequenceEmail — the single Resend sender, shared with Matchy's own
//                      templates (lib/matchyTemplates.ts) and the thread relay
//
// Emails go out via Resend with Reply-To: reply+[token]@expertmatch.fit.
//
// Required env vars:
//   RESEND_API_KEY, OUTREACH_FROM_EMAIL
//   QSTASH_TOKEN
//   NEXT_PUBLIC_BASE_URL (defaults to https://expertmatch.fit)
// Optional:
//   OUTREACH_POSTAL_ADDRESS — physical address rendered in the CAN-SPAM footer.
//                             Unset omits the address line; the opt-out link is
//                             always present. See lib/outreachFooter.ts.

import { Resend } from 'resend';
import type { Expert } from '../types';
import { openai } from './openai';
import { buildOutreachFooter } from './outreachFooter';
import { getFromAddress } from './mailFrom';
import { verifyOutreachToken } from './outreachToken';
import { getProject } from './projectStore';
import { isWalkthrough, type HeldReason } from './walkthrough';
import { getEntitlementsForProject, recordRestrictedAttempt } from './entitlements';
import { isSuppressed, type SuppressionCheck } from './outreachSuppressions';

/**
 * The step field on a QStash job. 'email2' and 'email3' are retired and nothing
 * publishes them any more, but they stay in the union because it describes the
 * WIRE FORMAT: /api/email-sequence/trigger must still be able to recognise a
 * job that QStash accepted before the cadence was removed, acknowledge it, and
 * send nothing. lib/outreachSteps.OutreachStep is the narrower type of what can
 * actually be executed.
 */
export type EmailStep = 'email1' | 'email2' | 'email3';

export interface SequenceJob {
  projectId: string;
  expertId:  string;
  step:      EmailStep;
  token:     string;  // HMAC-signed outreach reply token
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _resend: Resend | null = null;

function getResend(): Resend {
  if (_resend) return _resend;
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('[emailSequence] RESEND_API_KEY not configured');
  _resend = new Resend(key);
  return _resend;
}


// ─── QStash scheduling ────────────────────────────────────────────────────────

/**
 * RETIRED — Matchy Phase 1 (docs/MATCHY_SPEC.md, "Phasing"). This used to
 * publish a delayed QStash job that fired email2 (conflict + rate) and email3
 * (scheduling link) at the expert on a timer.
 *
 * Matchy replaces the cadence: a reply is read, summarized and answered on the
 * thread, and the follow-up goes out because the expert said yes, not because
 * a clock ran out. So this is a NO-OP.
 *
 * It NO LONGER HAS ANY CALLER — inbound-email used to call it and does not any
 * more (grep: nothing in app/, lib/ or scripts/ references it). It is therefore
 * dead code kept only as a landing pad in case a half-migrated call site turns
 * up; deleting it is safe once that is confirmed.
 *
 * Nothing is published, nothing throws, and one line says so.
 */
export async function scheduleNextEmail(job: SequenceJob): Promise<void> {
  console.log('[emailSequence] cadence retired — not scheduling',
    JSON.stringify({ step: job.step }));
}

// ─── Email generation ─────────────────────────────────────────────────────────

const SYSTEM_PROMPT_BASE = `You write cold outreach emails for a research firm.
RULES — non-negotiable:
- No em dashes anywhere. Use commas or periods instead.
- No "I wanted to reach out", "hope this finds you well", "touch base", "pick your brain"
- No exclamation marks
- No corporate filler, no padding
- Plain text only — no markdown, no links (unless explicitly instructed to include one)
- Sound like a sharp 30-year-old analyst, not a recruiter
- Short sentences
- Never reveal the client firm name unless explicitly told to`;

export async function generateEmail1(
  expert: Expert,
  query: string,
  rate: number,
): Promise<{ subject: string; body: string }> {
  const firstName = expert.name.split(' ')[0] ?? expert.name;

  const userPrompt = `Write Email 1 in a 3-part outreach sequence to ${expert.name}, ${expert.title} at ${expert.company}.

Research topic: "${query}"
Compensation: $${rate}/hr, billed per minute.

Requirements:
- Subject line, then the email body
- Greet by first name (${firstName})
- Ask if they would be open to a paid consulting call ($${rate}/hr, billed per minute) about ${query}
- One sentence connecting their role at ${expert.company} to the topic
- Use only the facts provided above. Do not invent details about this person's background, work, or publications; if you lack a specific detail, keep the sentence general.
- Soft close — no pressure
- No firm name. No links. Plain text only.
- Max 100 words in the body.

Format:
Subject: [subject line]

[body]`;

  const response = await openai.chat.completions.create({
    model:       'gpt-4o-mini',
    max_tokens:  400,
    temperature: 0.6,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT_BASE },
      { role: 'user',   content: userPrompt },
    ],
  });

  return parseEmailResponse(response.choices[0].message.content ?? '');
}

// ─── Parse GPT response ───────────────────────────────────────────────────────

function parseEmailResponse(text: string): { subject: string; body: string } {
  const trimmed = text.trim();
  const subjectMatch = trimmed.match(/^Subject:\s*(.+?)(?:\n|$)/im);
  const subject = subjectMatch?.[1]?.trim() ?? 'Following up';

  // Everything after the subject line and first blank line is the body
  const bodyStart = trimmed.indexOf('\n');
  let body = bodyStart !== -1 ? trimmed.slice(bodyStart).trim() : trimmed;

  // Remove a leading blank line if present
  if (body.startsWith('\n')) body = body.slice(1).trim();

  return { subject, body };
}

// ─── Send via Resend ──────────────────────────────────────────────────────────

export interface SendSequenceEmailOptions {
  /**
   * Set when `body` ALREADY ends with the CAN-SPAM footer, so this function
   * does not append a second one. lib/matchyTemplates.ts builds complete
   * messages, footer included; the legacy generateEmailN prompts return a bare
   * body and rely on the append below.
   */
  footerIncluded?: boolean;
  /**
   * HTML alternative. When given, the message goes out multipart. The legacy
   * cadence is deliberately plain text and passes nothing.
   */
  html?: string;
}

/**
 * Whether the message actually went out.
 *
 * `held` is why it did not: 'walkthrough' when the project has not been
 * switched live (lib/walkthrough.ts), 'trial' when the organization has no card
 * on file (lib/entitlements.ts), 'disabled' when DISABLE_EMAILS is set,
 * 'suppressed' when the address is on the global do-not-contact list, or the
 * list could not be read (lib/outreachSuppressions.ts, fail-closed).
 *
 * EVERY CALLER READS THIS. lib/outreachSteps.ts, lib/matchyScheduling.ts,
 * app/api/jobs/send-nudge and app/api/inbound-email fall back to a drafted or
 * held record; the client reply in .../experts/[expertId]/messages/route.ts,
 * the approved follow-up in .../messages/[messageId]/send/route.ts and
 * .../rate-decision/route.ts run the outcome through `dispositionOf` below,
 * which is what stops a held message from advancing the engagement.
 */
export type SendOutcome =
  | { sent: true }
  | { sent: false; held: HeldReason };

/**
 * Everything the chokepoint is allowed to decide on, gathered by
 * `sendSequenceEmail` in the order below. A `null` means "not evaluated,
 * because an earlier gate already held the send" — and, because every gate here
 * fails closed, an unevaluated fact can only ever hold, never release.
 */
export interface SendGateFacts {
  /** DISABLE_EMAILS=true, the environment-wide kill switch. */
  disableEmails: boolean;
  /** The project has not been switched live (lib/walkthrough.ts). */
  walkthrough:   boolean;
  /** lib/entitlements.getEntitlementsForProject().canOutreachExperts. */
  canOutreach:   boolean | null;
  /** lib/outreachSuppressions.isSuppressed() on the recipient address. */
  suppression:   SuppressionCheck | null;
}

export type SendGateDecision =
  | { send: true }
  | { send: false; held: HeldReason };

/**
 * THE GATE, as a pure function: the four rules that decide whether an email may
 * leave the building, in the order the chokepoint applies them.
 *
 * Fails closed on every unknown: a missing entitlement answer and an
 * unreadable suppression list both hold. Tested by
 * scripts/test-send-chokepoint.ts.
 */
export function resolveSendGate(facts: SendGateFacts): SendGateDecision {
  if (facts.disableEmails)        return { send: false, held: 'disabled' };
  if (facts.walkthrough)          return { send: false, held: 'walkthrough' };
  if (facts.canOutreach !== true) return { send: false, held: 'trial' };
  if (facts.suppression === null || !facts.suppression.ok || facts.suppression.suppressed) {
    return { send: false, held: 'suppressed' };
  }
  return { send: true };
}

/** What a caller may do with the engagement after one send attempt. */
export type SendAttempt =
  /** The route refused before the chokepoint: nothing was offered to Resend. */
  | { kind: 'walkthrough' }
  /** There is nobody to write to yet (no address, or no reply token). */
  | { kind: 'no_recipient' }
  /** The chokepoint answered. */
  | { kind: 'outcome'; outcome: SendOutcome };

export interface SendDisposition {
  /** The hold to store on the thread copy, or null when nothing was held. */
  held:      HeldReason | null;
  /**
   * May the engagement move? Status, money, engagement_events. False ONLY for a
   * chokepoint hold: the expert did not receive the message and no amount of
   * bookkeeping can pretend otherwise. Walkthrough deliberately still advances
   * — practising a decision has to leave the engagement where it really would
   * be — and so does a decision recorded with no address on file.
   */
  advance:   boolean;
  /** True only when Resend accepted the message. */
  delivered: boolean;
}

/**
 * The branch the three client-facing routes take after a send attempt, in one
 * place so they cannot drift (H-4). Pure; tested by scripts/test-walkthrough.ts.
 */
export function dispositionOf(attempt: SendAttempt): SendDisposition {
  switch (attempt.kind) {
    case 'walkthrough':
      return { held: 'walkthrough', advance: true, delivered: false };
    case 'no_recipient':
      return { held: null, advance: true, delivered: false };
    case 'outcome':
      return attempt.outcome.sent
        ? { held: null, advance: true, delivered: true }
        : { held: attempt.outcome.held, advance: false, delivered: false };
  }
}

/**
 * THE CHOKEPOINT. Every outbound expert email in the product goes through here,
 * which is why all four gates live here and not only at the call sites: no
 * route, present or future, can leak an email past them.
 *
 * The project is resolved from the reply token (the one thing every caller
 * already has). It FAILS CLOSED: an unverifiable token or a missing project
 * throws rather than sending, because a message we cannot attribute to a
 * project is a message we cannot prove is allowed to go.
 *
 * THE GLOBAL DO-NOT-CONTACT LIST IS CHECKED HERE (H-3), last of the four, so an
 * expert who clicks the footer opt-out mid-thread cannot receive a client
 * reply, a rate line, an auto follow-up or a scheduling proposal either. The
 * call-site checks in bookmark, outreach/approve, messages/[id]/send,
 * jobs/send-nudge and lib/contactDiscovery stay as early-exit UX: they answer
 * 409 with a written explanation instead of storing a held message.
 *
 * The gates are ordered cheapest-first and each one short-circuits the lookup
 * the next would need, so a walkthrough project still costs no entitlement read
 * and no suppression read. `resolveSendGate` above is the rule itself.
 *
 * Never logs: the recipient address, the subject, the body, or the token.
 */
export async function sendSequenceEmail(
  to:         string,
  subject:    string,
  body:       string,
  replyToken: string,
  fromName:   string,
  options:    SendSequenceEmailOptions = {},
): Promise<SendOutcome> {
  const disableEmails = process.env.DISABLE_EMAILS === 'true';

  // Resolve the project before Resend is ever touched. The token is the only
  // handle a caller is guaranteed to have, and it is project+expert scoped.
  const project = disableEmails ? null : await resolveSendProject(replyToken);
  const walkthrough = project !== null && isWalkthrough(project);

  // The account boundary (lib/entitlements.ts): a trial, or any organization
  // with no card on file, may never reach an expert — whatever the project's
  // own mode claims. A project cannot normally leave walkthrough without this
  // entitlement, so this is the backstop, not the gate.
  const entitlements = project && !walkthrough
    ? await getEntitlementsForProject(project.id)
    : null;

  // The do-not-contact list, keyed on the address rather than the engagement.
  // isSuppressed fails closed, and resolveSendGate treats that as a hold.
  const suppression = entitlements?.canOutreachExperts
    ? await isSuppressed(to)
    : null;

  const gate = resolveSendGate({
    disableEmails,
    walkthrough,
    canOutreach: entitlements === null ? null : entitlements.canOutreachExperts,
    suppression,
  });

  if (!gate.send) {
    if (gate.held === 'trial' && project && entitlements) {
      await recordRestrictedAttempt(entitlements, { action: 'send_email', projectId: project.id });
    }
    console.warn('[emailSequence] held', JSON.stringify({ step: fromName, reason: gate.held }));
    return { sent: false, held: gate.held };
  }

  const from    = getFromAddress();
  const replyTo = `reply+${replyToken}@expertmatch.fit`;
  const resend  = getResend();

  // CAN-SPAM footer: postal address (when configured) plus a per-recipient
  // opt-out link. Appended here only when the caller has not already built it
  // in — two opt-out links in one email is worse than none.
  const text = options.footerIncluded
    ? body
    : `${body}${buildOutreachFooter(to).text}`;

  const { error } = await resend.emails.send({
    from,
    to,
    replyTo,
    subject,
    text,
    ...(options.html ? { html: options.html } : {}),
  });

  if (error) {
    throw new Error(`[emailSequence] Resend error: ${error.message}`);
  }

  console.info('[emailSequence] sent', JSON.stringify({ step: fromName, status: 'ok' }));
  return { sent: true };
}

/**
 * The project behind a reply token, or a throw. Split out only so the gate
 * facts above can be gathered in one readable pass; the rule is unchanged —
 * a message we cannot attribute to a project is never sent.
 */
async function resolveSendProject(replyToken: string) {
  const verified = verifyOutreachToken(replyToken);
  const project  = verified.ok ? await getProject(verified.data.projectId) : null;
  if (!project) {
    throw new Error('[emailSequence] send refused: unresolvable project');
  }
  return project;
}
