// The legacy 3-email outreach sequence.
//
// RETIRED IN PART, Matchy Phase 1: SCHEDULING is gone. scheduleNextEmail() is
// a no-op and /api/email-sequence/trigger acknowledges email2/email3 without
// sending them, so no expert receives a timed follow-up any more. The senders
// below are kept because the trigger route still needs to compile and because
// email1 is still reachable from the legacy "Send Email 1" button; the
// bookmark path uses lib/matchyTemplates.ts instead. A later part of Phase 1
// removes what is left.
//
// Email 1 — interest check, plain text, no firm name, max 100 words.
// Email 2 — conflict check + rate confirmation, no firm name, max 120 words.
// Email 3 — scheduling link + firm name revealed, max 80 words.
//
// Emails sent via Resend with Reply-To: reply+[token]@expertmatch.fit
// QStash schedules next step with a random 5-12 min delay.
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
 * a clock ran out. So this is now a NO-OP. It is kept, rather than deleted,
 * because callers exist that a later part of Phase 1 will rewrite
 * (app/api/inbound-email), and a function that quietly does nothing is a
 * smaller change than a half-migrated call site.
 *
 * Nothing is published, nothing throws, and one line says so. The QStash
 * trigger route stays live to drain jobs that were already queued before this
 * shipped.
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

export async function generateEmail2(
  expert: Expert,
  query: string,
  rate: number,
): Promise<{ subject: string; body: string }> {
  const firstName = expert.name.split(' ')[0] ?? expert.name;

  const userPrompt = `Write Email 2 in a 3-part outreach sequence to ${expert.name}, ${expert.title} at ${expert.company}.

Context: They replied with interest to Email 1 about "${query}". The proposed rate is $${rate}/hr, billed per minute — it is not yet agreed.

Requirements:
- Subject line, then the email body
- Greet by first name (${firstName})
- Thank them briefly for their reply
- Ask three numbered questions:
  1. Do you have any conflict of interest or NDA that would prevent discussing ${query}?
  2. Are you aware of any restrictions from your current employer?
  3. Would $${rate}/hr, billed per minute, work for you?
- Use only the facts provided above. Do not invent details about this person's background, work, or publications.
- No firm name. Plain text only.
- Max 120 words in the body.

Format:
Subject: [subject line]

[body]`;

  const response = await openai.chat.completions.create({
    model:       'gpt-4o-mini',
    max_tokens:  450,
    temperature: 0.5,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT_BASE },
      { role: 'user',   content: userPrompt },
    ],
  });

  return parseEmailResponse(response.choices[0].message.content ?? '');
}

export async function generateEmail3(
  expert: Expert,
  firmName: string,
  schedulingUrl: string,
): Promise<{ subject: string; body: string }> {
  const firstName = expert.name.split(' ')[0] ?? expert.name;

  const userPrompt = `Write Email 3 in a 3-part outreach sequence to ${expert.name}, ${expert.title} at ${expert.company}.

Context: They confirmed no conflicts and agreed to the rate. Now reveal the client firm and send the scheduling link.

Firm name: ${firmName}
Scheduling link: ${schedulingUrl}

Requirements:
- Subject line, then the email body
- Greet by first name (${firstName})
- Reveal the client firm is ${firmName}
- Include ONLY the scheduling link — no other links
- End with: "Please keep this engagement confidential."
- Plain text only.
- Max 80 words in the body.

Format:
Subject: [subject line]

[body]`;

  const response = await openai.chat.completions.create({
    model:       'gpt-4o-mini',
    max_tokens:  300,
    temperature: 0.5,
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

export async function sendSequenceEmail(
  to:         string,
  subject:    string,
  body:       string,
  replyToken: string,
  fromName:   string,
  options:    SendSequenceEmailOptions = {},
): Promise<void> {
  if (process.env.DISABLE_EMAILS === 'true') {
    console.log('[emailSequence] suppressed (DISABLE_EMAILS=true)');
    return;
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

  console.log('[emailSequence] sent', { step: fromName, status: 'ok' });
}
