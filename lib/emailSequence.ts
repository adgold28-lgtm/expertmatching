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
 * a clock ran out. So this is a NO-OP. It is kept, rather than deleted, because
 * app/api/inbound-email still calls it, and a function that does nothing is a
 * smaller change than a half-migrated call site.
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
 * switched live (lib/walkthrough.ts), 'disabled' when DISABLE_EMAILS is set.
 * Callers that ignore the return value still compile — but every caller in this
 * repo reads it, so the UI can show a held state rather than pretending
 * something was sent.
 */
export type SendOutcome =
  | { sent: true }
  | { sent: false; held: HeldReason };

/**
 * THE CHOKEPOINT. Every outbound expert email in the product goes through here,
 * which is why the walkthrough gate lives here and not only at the call sites:
 * no route, present or future, can leak an email past it.
 *
 * The project is resolved from the reply token (the one thing every caller
 * already has). It FAILS CLOSED: an unverifiable token or a missing project
 * throws rather than sending, because a message we cannot attribute to a
 * project is a message we cannot prove is allowed to go.
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
  if (process.env.DISABLE_EMAILS === 'true') {
    console.warn('[emailSequence] suppressed (DISABLE_EMAILS=true)', JSON.stringify({ step: fromName }));
    return { sent: false, held: 'disabled' };
  }

  // Resolve the project before Resend is ever touched. The token is the only
  // handle a caller is guaranteed to have, and it is project+expert scoped.
  const verified = verifyOutreachToken(replyToken);
  const project  = verified.ok ? await getProject(verified.data.projectId) : null;
  if (!project) {
    throw new Error('[emailSequence] send refused: unresolvable project');
  }

  if (isWalkthrough(project)) {
    console.warn('[emailSequence] held (walkthrough)', JSON.stringify({ step: fromName }));
    return { sent: false, held: 'walkthrough' };
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
