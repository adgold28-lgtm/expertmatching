// Matchy's outbound templates — the intro, the follow-up, and the two one-line
// replies that settle a rate.
//
// These are TEMPLATES, not prompts. Matchy never free-writes to an expert
// (docs/MATCHY_SPEC.md, "Decisions taken"), so both emails are assembled from
// pure string parts here with no LLM in the path. That is also what makes them
// testable: scripts/test-matchy-templates.ts asserts the rules below hold for
// every combination of inputs.
//
// THE RULES, straight from the spec:
//
//   Intro
//     - never mentions money, in any form
//     - never names the client
//     - describes the client as one size word plus one type word — "a mid-size
//       PE firm", "a boutique consulting firm", "a large law firm", "a family
//       office" — falling back to "an investment firm" when we do not know
//     - generalizes the research question to one clause with no company names
//     - asks one question and stops
//
//   Follow-up (sent only after a yes)
//     - the conflict / NDA questions, then the rate, ASKED not asserted
//     - quotes the EXPERT-side number, because it is going to the expert. The
//       client-side number never appears in the same message (lib/pricing.ts
//       is the only place the two convert).
//
//   Rate accepted / rate counter (sent when the client presses a button)
//     - same rule: EXPERT-side number only, one line, then it stops
//
// The two email builders return { subject, text, html }; the two rate lines
// return a bare body, because they go out as a reply on an existing thread and
// the sender supplies the subject and the footer.
//
// Both bodies stay under 120 words and both carry the CAN-SPAM footer from
// lib/outreachFooter.ts.
//
// Two style notes. Neither body signs off with a person's name: nobody named
// is actually writing these, and the footer already says who sent it. And no
// em dashes in either body (the house rule for outbound mail) — the one em
// dash in the subject line is the spec's own wording, quoted verbatim.
//
// Never logs anything — these functions are pure and do no I/O.

import type { Project } from '../types';
import type { FirmTypeValue, FirmSizeValue } from './supabase/database.types';
import { buildOutreachFooter } from './outreachFooter';

export interface MatchyEmail {
  subject: string;
  text:    string;
  html:    string;
}

// ─── Firm phrase ──────────────────────────────────────────────────────────────

/**
 * The type word Matchy uses for each firm type. "family office" carries its
 * own size implicitly, so it takes no size word (see FIRM_TYPES_WITHOUT_SIZE).
 */
const FIRM_TYPE_WORD: Record<FirmTypeValue, string> = {
  pe_firm:         'PE firm',
  family_office:   'family office',
  consulting_firm: 'consulting firm',
  law_firm:        'law firm',
  hedge_fund:      'hedge fund',
  corporate:       'corporate strategy team',
  other:           'investment firm',
};

const FIRM_SIZE_WORD: Record<FirmSizeValue, string> = {
  boutique: 'boutique',
  mid_size: 'mid-size',
  large:    'large',
};

/**
 * "a family office" reads right; "a mid-size family office" does not — a family
 * office is understood to be small. Same for the generic fallback.
 */
const FIRM_TYPES_WITHOUT_SIZE: ReadonlySet<FirmTypeValue> = new Set<FirmTypeValue>([
  'family_office',
  'other',
]);

/** What Matchy says when we have captured nothing about the firm. */
export const DEFAULT_FIRM_PHRASE = 'an investment firm';

function articleFor(word: string): 'a' | 'an' {
  return /^[aeiou]/i.test(word) ? 'an' : 'a';
}

/**
 * One size word plus one type word, with the right article:
 *   ('pe_firm', 'mid_size')        → "a mid-size PE firm"
 *   ('consulting_firm','boutique') → "a boutique consulting firm"
 *   ('law_firm', 'large')          → "a large law firm"
 *   ('family_office', anything)    → "a family office"
 *   (unknown, anything)            → "an investment firm"
 */
export function firmPhrase(
  firmType?: FirmTypeValue | null,
  firmSize?: FirmSizeValue | null,
): string {
  if (!firmType || !(firmType in FIRM_TYPE_WORD)) return DEFAULT_FIRM_PHRASE;

  const typeWord = FIRM_TYPE_WORD[firmType];
  const sizeWord = !FIRM_TYPES_WITHOUT_SIZE.has(firmType) && firmSize
    ? FIRM_SIZE_WORD[firmSize]
    : '';

  const phrase = sizeWord ? `${sizeWord} ${typeWord}` : typeWord;
  return `${articleFor(phrase)} ${phrase}`;
}

// ─── Topic derivation ─────────────────────────────────────────────────────────

/**
 * Phrases a research question routinely opens with. Stripping them turns
 * "How are multi-site veterinary groups handling staffing costs?" into
 * "multi-site veterinary groups handling staffing costs" — one clause, which
 * is what the sentence "…evaluating {topic}" needs.
 */
const QUESTION_OPENERS = [
  /^(how|what|why|when|where|which|who)\s+(do|does|did|are|is|was|were|will|would|can|could|should|has|have|had)\s+/i,
  /^(how|what|why|when|where|which|who)\s+/i,
  /^(we\s+(are|'re)\s+)?(looking\s+to|trying\s+to|seeking\s+to|hoping\s+to)\s+/i,
  /^(we\s+(are|'re)\s+)?(evaluating|assessing|researching|exploring|investigating|understanding)\s+/i,
  /^(i|we)\s+(want|need|would\s+like)\s+to\s+(understand|know|learn)\s+(about\s+)?/i,
  /^(please\s+)?(help\s+(me|us)\s+)?(understand|assess|evaluate)\s+/i,
  /^(the\s+)?(question|topic|brief)\s+is[:,]?\s+/i,
];

/** Trailing clauses that only make sense to the client, not to an expert. */
const TRAILING_NOISE = [
  /\s*[—–-]\s*(for|on\s+behalf\s+of)\b.*$/i,
  /\s*\bfor\s+(a|our|an)\s+(potential\s+)?(portfolio\s+company|client|deal|acquisition|investment|diligence)\b.*$/i,
  /\s*\b(as\s+part\s+of|in\s+support\s+of)\b.*$/i,
];

const MAX_TOPIC_WORDS = 22;

/**
 * Words that mark a token as a real word rather than a company name, so a
 * Capitalised token here is not treated as a proper noun.
 */
const COMMON_CAPITALIZED = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'for', 'in', 'on', 'at', 'to', 'of',
  'us', 'uk', 'eu', 'apac', 'emea', 'latam', 'north', 'south', 'east', 'west',
  'european', 'american', 'asian', 'african', 'global', 'national', 'federal',
  'i', 'we', 'they',
]);

/** Strips punctuation so a token can be inspected as a bare word. */
function bareToken(token: string): string {
  return token.replace(/[^A-Za-z0-9&.'-]/g, '');
}

/** A Capitalised word that is not one of the ordinary ones. */
function looksProper(token: string): boolean {
  const bare = bareToken(token);
  return /^[A-Z][a-z]+/.test(bare) && !COMMON_CAPITALIZED.has(bare.toLowerCase());
}

/**
 * True for a token that looks like a specific company or product name: a
 * Capitalised word, an ALLCAPS ticker, or anything carrying Inc/LLC/Corp/Ltd/
 * Group/Holdings/Partners/Capital. Deliberately blunt — a topic that loses one
 * word is fine; a topic that names the target is not.
 *
 * `sentenceStart` exempts a leading capital that is only a capital because a
 * sentence starts there. The caller grants it only when the token really is
 * the start of the question (nothing was stripped off the front) AND the next
 * word is not itself Capitalised — "Margins in specialty pharma" keeps its
 * first word, "Bayview Veterinary Partners pricing" does not.
 */
function looksLikeCompanyName(token: string, sentenceStart: boolean): boolean {
  const bare = bareToken(token);
  if (!bare) return false;

  if (/^(inc|llc|corp|ltd|plc|gmbh|s\.a\.|co)\.?$/i.test(bare)) return true;
  if (/^(group|holdings|partners|capital|ventures|labs|technologies|systems)$/i.test(bare)) return true;

  // ALLCAPS of 2+ letters that is not a known region word — reads as a ticker
  // or a brand, e.g. "NVDA", "IBM".
  if (/^[A-Z]{2,}$/.test(bare) && !COMMON_CAPITALIZED.has(bare.toLowerCase())) return true;

  if (!sentenceStart && looksProper(bare)) return true;

  return false;
}

/** Collapses whitespace and strips a trailing question mark or period. */
function tidy(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(/[?.!,;:]+$/, '').trim();
}

/**
 * Generalizes a project's research question into the one clause the intro
 * drops into "…evaluating {topic}". Deterministic, no LLM call:
 *
 *   1. prefer the brief's structured `industry` + `function` when both exist —
 *      they are already generalized by construction
 *   2. otherwise take the research question, strip the interrogative opener and
 *      any client-only trailing clause, drop anything that looks like a company
 *      name, and cap the length
 *   3. fall back to the industry alone, then to "this market"
 *
 * Never returns an empty string.
 */
export function deriveTopic(project: Pick<Project, 'researchQuestion' | 'industry' | 'function' | 'expertType'>): string {
  const industry = tidy(project.industry ?? '');
  const func     = tidy(project.function ?? '');

  if (industry && func) return `${func.toLowerCase()} in ${industry.toLowerCase()}`;

  let topic = tidy(project.researchQuestion ?? '');

  for (const pattern of TRAILING_NOISE) topic = topic.replace(pattern, '');

  // Once an interrogative opener comes off, the word now in front is no longer
  // a sentence start, so its capital is not explained away.
  let openerStripped = false;
  for (const opener of QUESTION_OPENERS) {
    const stripped = topic.replace(opener, '');
    if (stripped !== topic) { topic = stripped; openerStripped = true; break; }
  }
  topic = tidy(topic);

  if (topic) {
    const tokens = topic.split(/\s+/);
    const firstIsSentenceStart = !openerStripped && !looksProper(tokens[1] ?? '');
    const kept = tokens
      .filter((token, i) => !looksLikeCompanyName(token, i === 0 && firstIsSentenceStart))
      .slice(0, MAX_TOPIC_WORDS);
    topic = tidy(kept.join(' '));
  }

  // Lower-case a leading capital so the clause reads mid-sentence, unless the
  // first word is an acronym we deliberately kept.
  if (topic && /^[A-Z][a-z]/.test(topic)) topic = topic[0].toLowerCase() + topic.slice(1);

  if (topic.split(/\s+/).length >= 2) return topic;
  if (industry) return industry.toLowerCase();
  if (topic) return topic;
  return 'this market';
}

/**
 * The "given your background in {…}" fragment, taken from the expert's
 * anonymized descriptor (lib/anonymizeExpert.ts writes it, never naming the
 * person or their employer). The descriptor is rendered as
 * "Executive · Operator · Veterinary services"; the intro wants the most
 * specific part, so the last segment wins, and the whole thing is lower-cased
 * to sit inside a sentence.
 */
export function descriptorFragmentFrom(anonymizedDescriptor: string | undefined | null): string {
  const raw = tidy(anonymizedDescriptor ?? '');
  if (!raw) return '';
  const segments = raw.split('·').map(s => tidy(s)).filter(Boolean);
  const chosen = segments.length > 1 ? segments[segments.length - 1] : raw;
  return chosen.toLowerCase();
}

// ─── HTML ─────────────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Wraps a plain-text body in the same restrained shell both emails use. */
function toHtml(bodyText: string, footerHtml: string): string {
  const paragraphs = bodyText
    .split(/\n{2,}/)
    .map(p => `<p style="margin:0 0 14px;">${escapeHtml(p).replace(/\n/g, '<br />')}</p>`)
    .join('\n  ');

  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.65;color:#0B1F3B;max-width:560px;">
  ${paragraphs}
${footerHtml}
</div>`;
}

/** First name only, for the greeting. Falls back to the whole string. */
export function firstNameOf(fullName: string | undefined | null): string {
  const trimmed = (fullName ?? '').trim();
  if (!trimmed) return 'there';
  return trimmed.split(/\s+/)[0];
}

// ─── Intro ────────────────────────────────────────────────────────────────────

export interface IntroEmailInput {
  firmType?:           FirmTypeValue | null;
  firmSize?:           FirmSizeValue | null;
  /** One generalized clause — deriveTopic(project). */
  topic:               string;
  /** One lower-case fragment — descriptorFragmentFrom(expert.anonymizedDescriptor). */
  descriptorFragment?: string;
  expertFirstName:     string;
  /** Recipient address — the CAN-SPAM footer's opt-out link is per-recipient. */
  recipientEmail:      string;
}

/**
 * The first thing an expert ever hears from us. No money, no client name, no
 * links beyond the mandatory opt-out. One question, then it stops.
 */
export function buildIntroEmail(input: IntroEmailInput): MatchyEmail {
  const firm     = firmPhrase(input.firmType, input.firmSize);
  const topic    = tidy(input.topic) || 'this market';
  const fragment = tidy(input.descriptorFragment ?? '');
  const name     = firstNameOf(input.expertFirstName);

  const background = fragment
    ? `Given your background in ${fragment}, they would value a 45 to 60 minute paid consultation.`
    : 'They would value a 45 to 60 minute paid consultation.';

  const body = [
    `Hi ${name},`,
    `I am reaching out on behalf of ${firm} looking at ${topic}. ${background}`,
    'Would you be open to it? If so, I will send the details.',
  ].join('\n\n');

  const footer = buildOutreachFooter(input.recipientEmail);

  return {
    subject: `Paid expert call — ${topic}`,
    text:    `${body}${footer.text}`,
    html:    toHtml(body, footer.html),
  };
}

// ─── Follow-up ────────────────────────────────────────────────────────────────

export interface FollowUpEmailInput {
  /** The same generalized clause the intro used. */
  topic:           string;
  /** EXPERT-side hourly rate in whole dollars. Never the client number. */
  expertRate:      number;
  expertFirstName: string;
  recipientEmail:  string;
}

/**
 * Sent after a yes. Three questions: NDAs, current involvements, and the rate.
 * The rate is ASKED — "does that work for you?" — never asserted, because the
 * expert's answer is the input to the negotiation, not a formality.
 */
export function buildFollowUpEmail(input: FollowUpEmailInput): MatchyEmail {
  const topic = tidy(input.topic) || 'this market';
  const name  = firstNameOf(input.expertFirstName);
  const rate  = Math.max(0, Math.round(input.expertRate));

  const body = [
    `Hi ${name},`,
    'Glad to hear it. Three quick things before we schedule.',
    [
      `1. Any NDAs or employer restrictions that would limit discussing ${topic}?`,
      '2. Any current involvement with companies in this space we should know about?',
      `3. We compensate experts at $${rate}/hr, billed per minute. Does that work for you?`,
    ].join('\n'),
    'Answer those three and I will propose a couple of times.',
  ].join('\n\n');

  const footer = buildOutreachFooter(input.recipientEmail);

  return {
    subject: `Re: Paid expert call — ${topic}`,
    text:    `${body}${footer.text}`,
    html:    toHtml(body, footer.html),
  };
}

// ─── Rate decision ────────────────────────────────────────────────────────────

export interface RateDecisionInput {
  /** The expert's first name, for the greeting. */
  firstName:  string;
  /** EXPERT-side hourly rate in whole dollars. NEVER the client number. */
  expertRate: number;
}

/**
 * The two lines Matchy sends an expert once the client has decided on a rate.
 *
 * THE RULE THESE EXIST TO ENFORCE (docs/MATCHY_SPEC.md, "Pricing rule"): the
 * client's number and the expert's number never share a message. The client
 * presses Accept or Offer on a card showing CLIENT-side dollars; what leaves
 * the platform is one of these templates, carrying only `expertRate`. Nothing
 * the client typed is relayed, so there is no path for the client-side figure
 * to reach an expert's inbox.
 *
 * Bodies only — POST .../rate-decision builds the subject from the thread and
 * lib/emailSequence appends the CAN-SPAM footer. No em dashes (house rule for
 * outbound mail), no contractions, one dry line and then it stops.
 */
export function rateAcceptedTemplate(input: RateDecisionInput): string {
  const name = firstNameOf(input.firstName);
  const rate = Math.max(0, Math.round(input.expertRate));
  return `Thanks, ${name}. $${rate}/hr works. Next I will find a time that suits you both.`;
}

/** The counter: the client is holding at their standing rate. Asked, not told. */
export function rateCounterTemplate(input: RateDecisionInput): string {
  const name = firstNameOf(input.firstName);
  const rate = Math.max(0, Math.round(input.expertRate));
  return `Thanks, ${name}. Could you do $${rate}/hr? If so I will get a time on the calendar.`;
}
