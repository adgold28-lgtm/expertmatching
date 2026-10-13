// lib/screeningPublic.ts — everything an EXPERT is allowed to receive, and the
// link and the email that carry it (docs/SCREENING_FLOW_PLAN.md, build step 4).
//
// THIS IS THE ANONYMITY BOUNDARY IN THE OTHER DIRECTION. lib/screeningView.ts
// decides what a CLIENT may see of an expert; this file decides what an EXPERT
// may see of a client, and the answer is deliberately tiny:
//
//   the topic, an EXPERT-SIDE rate, a call length, "a mid-size PE firm",
//   a deadline, the questions themselves, and whether they already answered.
//
// Nothing else exists in `ScreeningPayload`, and it is built FIELD BY FIELD for
// the same reason lib/screeningView builds its views that way: a spread is how
// `client_rate`, `owner_email` or `targeting` reaches an expert the day someone
// widens a store function. Adding a field here has to be something a person
// typed, and scripts/test-screening-form.ts asserts the whole key set.
//
// THE RATE RULE (docs/MATCHY_SPEC.md) holds here too. The request stores a
// CLIENT-side number; an expert is only ever shown `expertRateFor(clientRate)`,
// and the two never share a message. The email below quotes the expert-side
// number and nothing else.
//
// PURE — no I/O, no database, no clock, no model, no environment beyond
// lib/senderIdentity's OUTREACH_SIGNATURE (read through that module, which owns
// it). That is what lets scripts/test-screening-form.ts import this file with
// no Supabase variables set at all.
//
// NEVER LOGS ANYTHING: every argument here is confidential — the topic, the
// questions, an expert's first name, and a link that IS a credential.

import type {
  ScreeningCandidate,
  ScreeningObjective,
  ScreeningRequest,
} from '../types';
import type { FirmSizeValue, FirmTypeValue } from './supabase/database.types';
import type { VerifiedScreeningToken } from './screeningToken';
import { expertRateFor } from './pricing';
import { firmPhrase, firstNameOf } from './matchyTemplates';
import { senderSignature, signOff } from './senderIdentity';

// ─── The link ─────────────────────────────────────────────────────────────────

/**
 * The public screening URL for a raw token.
 *
 * `base` is whatever the caller's `baseUrl()` resolved to, trailing slashes and
 * all, so this normalises rather than trusting it. The token is percent-encoded
 * because it is base64url plus a '.' separator — safe today, but the encoding
 * is what keeps it safe if the token format ever changes.
 */
export function screeningLinkUrl(base: string, token: string): string {
  return `${base.replace(/\/+$/, '')}/s/${encodeURIComponent(token)}`;
}

// ─── The payload ──────────────────────────────────────────────────────────────

/** One question as the expert reads it. The objective's own text never travels. */
export interface ScreeningPayloadItem {
  /** The objective id — the handle the submission posts answers against. */
  id:          string;
  /** The first-person yes/no question. */
  stem:        string;
  /** What to write behind a yes: role and timeframe. */
  proofPrompt: string;
}

/**
 * The WHOLE of what GET /api/s/[token] returns. Read the list twice: what is
 * here is all an expert learns, and what is absent is absent on purpose —
 * no request id, no organization id, no owner email, no client rate, no
 * targeting, no expert name, address or id, and no token id.
 */
export interface ScreeningPayload {
  /** The client's topic statement, screened at approval. */
  topic:         string;
  /** EXPERT-side whole dollars per hour. Never the client's number. */
  expertRate:    number;
  callLengthMin: 30 | 45 | 60;
  /** "a mid-size PE firm" — the firm's shape, never its name. */
  firmPhrase:    string;
  /** ISO. The form renders it; the expert sees a date, not a timestamp. */
  deadline:      string;
  items:         ScreeningPayloadItem[];
  /** 'submitted' once this link has been used — the form shows a terminal page. */
  state:         'open' | 'submitted';
}

/** Position order, then id, so two objectives sharing a position still settle. */
function byPosition(a: ScreeningObjective, b: ScreeningObjective): number {
  if (a.position !== b.position) return a.position - b.position;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The payload for one candidate on one request.
 *
 * `firm` is the client's organization, or null — in development there is no
 * `organizations` row to read, and in production `getFirmById` returns null for
 * an organization that has gone. Either way the phrase falls back to
 * lib/matchyTemplates.DEFAULT_FIRM_PHRASE rather than naming anyone.
 *
 * `stem` and `proofPrompt` are non-null on every approved request — the
 * approval gate refuses an objective missing either (422 incomplete_items) —
 * but they are typed nullable on the row, so they fall back to '' here rather
 * than putting "null" in front of an expert.
 */
export function buildScreeningPayload(
  request:   ScreeningRequest,
  candidate: ScreeningCandidate,
  firm:      { firmType: FirmTypeValue | null; firmSize: FirmSizeValue | null } | null,
): ScreeningPayload {
  return {
    topic:         request.topicStatement,
    expertRate:    expertRateFor(request.clientRate),
    callLengthMin: request.callLengthMin,
    firmPhrase:    firmPhrase(firm?.firmType ?? null, firm?.firmSize ?? null),
    deadline:      request.deadline,
    items:         [...request.objectives].sort(byPosition).map(objective => ({
      id:          objective.id,
      stem:        objective.stem ?? '',
      proofPrompt: objective.proofPrompt ?? '',
    })),
    state:         candidate.submittedAt !== null ? 'submitted' : 'open',
  };
}

// ─── The token cross-check ────────────────────────────────────────────────────

/**
 * Does this row match the token that was presented?
 *
 * A good signature says the bytes are ours and nothing more. The row is found
 * by hash, so this is belt and braces — but it is the check that refuses a
 * token minted for one request and replayed against a row that has since moved
 * (or, if two hashes ever collided, a row that was never this token's). Both
 * ids are compared, because either one being wrong means the link is not
 * addressing what it claims to.
 *
 * Expiry, revocation and single use are NOT checked here: they live on the row
 * and the public route reads them there.
 */
export function matchesToken(
  candidate: { id: string; requestId: string },
  verified:  VerifiedScreeningToken,
): boolean {
  return candidate.id === verified.tokenId && candidate.requestId === verified.requestId;
}

// ─── The email ────────────────────────────────────────────────────────────────

const SUBJECT_TOPIC_CHARS = 60;

/**
 * Local, because lib/sendAvailabilityRequest keeps its copy private and this
 * module must stay importable with no environment at all.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#39;');
}

/** "Sep 28, 2026" — a date an expert can act on, never a timestamp. */
export function formatDeadline(deadline: string): string {
  const ms = Date.parse(deadline);
  if (!Number.isFinite(ms)) return deadline;
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric',
  }).format(new Date(ms));
}

/** "a mid-size PE firm" opening a sentence. Only the first letter moves. */
function capitalise(phrase: string): string {
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

const NUMBER_WORDS = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six'] as const;

/**
 * "Six" for a request with six objectives, "A few" when the caller did not say.
 * A request carries three to six of them (lib/screeningValidation.LIMITS), so a
 * fixed "six" would be wrong on most of them — and the first thing an expert
 * reads should not be a number they can disprove by opening the link.
 */
function countPhrase(itemCount?: number): string {
  if (typeof itemCount !== 'number' || !Number.isInteger(itemCount)) return 'A few';
  return NUMBER_WORDS[itemCount] ?? 'A few';
}

export interface ScreeningLinkEmailInput {
  /** The full screening URL. It IS the credential — never logged, never reused. */
  link:            string;
  topic:           string;
  /** "a mid-size PE firm". Never the client's name. */
  firmPhrase:      string;
  /** EXPERT-side whole dollars per hour. */
  expertRate:      number;
  callLengthMin:   number;
  /** ISO; formatted to a date in the body. */
  deadline:        string;
  expertFirstName: string;
  /** How many questions the form holds. Spelled out when given. */
  itemCount?:      number;
}

export interface ScreeningLinkEmail {
  subject: string;
  text:    string;
  html:    string;
}

/**
 * The one email an expert gets before they have agreed to anything.
 *
 * WHAT IT MAY SAY: the topic, the expert-side rate, the call length, the shape
 * of the firm, the deadline, and the link. WHAT IT MAY NOT: the client's firm
 * name, a client's name, the client-side rate, or anything about the other
 * candidates. The compliance screen at approval already refused a topic that
 * names the firm; this builder simply never has the other fields to leak.
 *
 * The CAN-SPAM footer is NOT added here — lib/screeningEmail appends
 * buildOutreachFooter, because the footer is keyed on the recipient's address
 * and this builder deliberately never sees one.
 */
export function buildScreeningLinkEmail(input: ScreeningLinkEmailInput): ScreeningLinkEmail {
  const topic = input.topic.trim();
  const clippedTopic = topic.length > SUBJECT_TOPIC_CHARS
    ? `${topic.slice(0, SUBJECT_TOPIC_CHARS - 1).trimEnd()}…`
    : topic;

  const subject = `A paid expert call on ${clippedTopic}: does it fit?`;

  const blocks: string[] = [
    `Dear ${firstNameOf(input.expertFirstName)},`,
    `${capitalise(input.firmPhrase)} is looking for an expert on ${topic} and would pay `
      + `$${input.expertRate}/hr for a ${input.callLengthMin}-minute call.`,
    `Before anyone books time, ${countPhrase(input.itemCount).toLowerCase()} quick yes/no questions tell them `
      + 'exactly what you can speak to — it takes about a minute:',
    input.link,
    `The link works until ${formatDeadline(input.deadline)} and is yours alone.`,
  ];

  const text = signOff(blocks.join('\n\n'));

  // The HTML mirrors the text block for block, sign-off included: both read the
  // signature through lib/senderIdentity, so neither can drift from the other.
  const signature = senderSignature();
  const paragraphs = [
    ...blocks.map(block => (block === input.link
      ? `<a href="${escapeHtml(block)}" style="color:#0B1F3B;">${escapeHtml(block)}</a>`
      : escapeHtml(block))),
    ...(signature ? [escapeHtml(signature).replace(/\n/g, '<br />')] : []),
  ];

  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.65;color:#0B1F3B;max-width:560px;">
${paragraphs.map(p => `  <p style="margin:0 0 16px;">${p}</p>`).join('\n')}
</div>`;

  return { subject, text, html };
}
