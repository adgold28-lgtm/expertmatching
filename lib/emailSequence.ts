// Automated 3-email outreach sequence via QStash.
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

import { Resend } from 'resend';
import type { Expert } from '../types';
import { openai } from './openai';

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

function getFromAddress(): string {
  const from = process.env.OUTREACH_FROM_EMAIL;
  if (!from) throw new Error('[emailSequence] OUTREACH_FROM_EMAIL not configured');
  return from;
}

// ─── QStash scheduling ────────────────────────────────────────────────────────

export async function scheduleNextEmail(job: SequenceJob): Promise<void> {
  const token = process.env.QSTASH_TOKEN;
  if (!token) throw new Error('[emailSequence] QSTASH_TOKEN not configured');

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? 'https://expertmatch.fit';
  const endpoint = `${baseUrl}/api/email-sequence/trigger`;

  // Random 5-12 minute delay
  const delaySeconds = Math.floor(Math.random() * 8 + 5) * 60;

  const res = await fetch('https://qstash.upstash.io/v2/publish/' + encodeURIComponent(endpoint), {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
      'Upstash-Delay': `${delaySeconds}s`,
    },
    body: JSON.stringify(job),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`[emailSequence] QStash publish failed: ${res.status} ${text.slice(0, 200)}`);
  }

  console.log('[emailSequence] scheduled next step', { step: job.step, delaySeconds });
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
- One specific sentence connecting their background at ${expert.company} to the topic
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

Context: They replied with interest to Email 1 about "${query}". Rate is $${rate}/hr, billed per minute.

Requirements:
- Subject line, then the email body
- Greet by first name (${firstName})
- Thank them briefly for their reply
- Ask three numbered questions:
  1. Do you have any conflict of interest or NDA that would prevent discussing ${query}?
  2. Are you aware of any restrictions from your current employer?
  3. Confirm: you are available at $${rate}/hr billed per minute.
- State the rate as confirmed fact, not a question
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

export async function sendSequenceEmail(
  to:         string,
  subject:    string,
  body:       string,
  replyToken: string,
  fromName:   string,
): Promise<void> {
  if (process.env.DISABLE_EMAILS === 'true') {
    console.log('[emailSequence] suppressed (DISABLE_EMAILS=true)');
    return;
  }

  const from    = getFromAddress();
  const replyTo = `reply+${replyToken}@expertmatch.fit`;
  const resend  = getResend();

  const { error } = await resend.emails.send({
    from,
    to,
    replyTo,
    subject,
    text: body,
  });

  if (error) {
    throw new Error(`[emailSequence] Resend error: ${error.message}`);
  }

  console.log('[emailSequence] sent', { step: fromName, status: 'ok' });
}
