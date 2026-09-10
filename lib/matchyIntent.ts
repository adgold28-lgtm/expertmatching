// lib/matchyIntent.ts — the pure router behind "Ask Matchy" (Matchy 2.0).
//
// The composer at the foot of a thread has two exits. "Send to {first}" is
// today's relay and never comes here. "Ask Matchy" brings the text here, and
// this module decides, with regex and the record already in the browser, ONE
// of these outcomes:
//
//   • a factual line from the record (status, money in client dollars, nudges,
//     the booking), sometimes with Matchy's stored summary of a reply quoted;
//   • a proposal for a verb the thread already has (set a rate, propose times,
//     move the call, send the intro, pass), ending in that verb's button;
//   • a request for a draft, which the thread turns into ONE call to
//     POST …/messages/draft (the only network call Ask can trigger);
//   • a refusal, in one quiet line.
//
// RULES (docs/MATCHY_SPEC.md principles 1–4, amended for 2.0):
//   • Nothing here sends, stores or moves a status. Every button on a card
//     calls the handler the thread already owns.
//   • No model writes a client-facing answer. Every line is a template over the
//     viewer-redacted payload; a content question quotes Matchy's SUMMARY of a
//     reply, never the email (the client never receives the body anyway).
//   • Money: only the client's own figures ever appear (clientRate,
//     clientCounterRate, the band). A typed number becomes a rate only through
//     the set-rate card, on the $50 grid, inside the band, and the expert hears
//     their side of it only when the owner presses Offer or Send.
//   • Anything the screen would stop is stopped BEFORE routing: a phone
//     number, an address, a link or an off-platform phrase under Ask returns
//     the screen's own findings and nothing else happens.
//   • Operator voice: first person, one or two sentences, no greeting, no
//     machinery, no follow-up questions. Unclear input gets one quiet line, not
//     a menu.
//
// Pure: no I/O, no React, no server imports. lib/matchyScreen.ts and
// lib/matchyClient.ts are both import-free of server code, which is what keeps
// this module in the browser bundle. scripts/test-matchy-ask.ts covers the
// routing table.

import type { ExpertStatus, Project, RejectionReason } from '../types';
import { screenMessage } from './matchyScreen';
import {
  clientCounterRateOf,
  firstNameOf,
  formatRate,
  formatSlot,
  proposedSlotsOf,
  schedulingLine,
  RATE_FLOOR,
  RATE_STEP,
  type ConversationMessage,
  type ProjectExpertWithCounter,
  type ScreenFinding,
} from './matchyClient';

// ─── The card ─────────────────────────────────────────────────────────────────

export type AskAction =
  | 'dismiss'
  | 'jump'            // scroll the pane to `card.jump`
  | 'set_rate'        // payload.rate — PUT { clientRate }
  | 'propose'         // payload.preferences — POST propose-times { reason: 'initial' }
  | 'move'            // POST propose-times { reason: 'reschedule' }
  | 'pass'            // payload.reason, payload.notes — PUT { status: 'rejected', … }
  | 'approve_intro'   // POST outreach/approve
  | 'switch_live'     // opens the settings strip's own confirmation
  | 'open_expert'     // payload.expertId — select another thread
  | 'use_draft';      // payload.text — put the draft in the composer

export interface AskButton {
  action:    AskAction;
  label:     string;
  primary?:  boolean;
  disabled?: boolean;
  title?:    string;
  expertId?: string;
}

export type AskJump =
  | { to: 'decision' | 'times' | 'booked' | 'intro' }
  | { to: 'message'; messageId: string };

export interface AskQuote {
  /** "Matchy's summary" — what the client is allowed to read of a reply. */
  label:     string;
  when:      string;
  text:      string;
  messageId: string;
}

export interface AskRow {
  expertId: string;
  name:     string;
  status:   ExpertStatus;
  fact:     string;
}

export type AskTint = 'cream' | 'amber' | 'teal' | 'green' | 'sky' | 'blocked';

export interface AskCard {
  /**
   * 'line' renders as one MatchyLine with optional buttons; 'card' is the
   * boxed proposal; 'draft_request' tells the thread to call the draft route
   * with `instruction` and render the answer as a card.
   */
  kind:         'line' | 'card' | 'draft_request';
  tone:         'default' | 'quiet' | 'alert';
  tint:         AskTint;
  line:         string;
  quote?:       AskQuote;
  findings?:    ScreenFinding[];
  rows?:        AskRow[];
  /** Teal card: the editable preferences line, prefilled from what was typed. */
  preferences?: string;
  /** Amber set-rate card: the client figure the primary button sets. */
  rate?:        number;
  /** Pass card: the reason read off the client's words. */
  reason?:      RejectionReason;
  /** The draft route's instruction (kind 'draft_request'). */
  instruction?: string;
  jump?:        AskJump;
  buttons:      AskButton[];
}

export interface AskContext {
  pe:              ProjectExpertWithCounter;
  messages:        ConversationMessage[];
  /** The project, for cross-expert questions and the band. Null when the thread is alone. */
  project:         Pick<Project, 'experts' | 'clientRateMin' | 'clientRateMax'> | null;
  /** Owner or staff — the only people whose asks may end in a verb. */
  canSend:         boolean;
  walkthrough:     boolean;
  /** Client-facing label for a status (components/matchyStatus.CLIENT_STATUS_META). */
  statusLabelOf:   (status: ExpertStatus) => string;
  /** True for every status that has a thread (components/matchyStatus.hasConversation). */
  hasConversation: (status: ExpertStatus) => boolean;
  /** For tests: a fixed zone. Defaults to the browser's. */
  timeZone?:       string;
}

// ─── Plain nouns for what the screen found (shared with the composer) ────────

const FINDING_NOUN: Record<string, string> = {
  phone:               'phone number',
  email:               'email address',
  url:                 'link',
  scheduling_link:     'scheduling link',
  client_firm_name:    'firm name',
  expert_real_name:    'name',
  client_real_name:    'name',
  off_platform_phrase: 'phrase',
  money:               'rate',
};

export function findingNoun(kind: string): string {
  return FINDING_NOUN[kind] ?? kind.replace(/_/g, ' ');
}

// ─── Record helpers ───────────────────────────────────────────────────────────

/** Once the rate is agreed the per-expert rate does not move (server: 409 rate_locked). */
export function isRateLocked(pe: Pick<ProjectExpertWithCounter, 'status' | 'rateAgreedAt'>): boolean {
  return !!pe.rateAgreedAt
    || pe.status === 'scheduling_sent'
    || pe.status === 'scheduled'
    || pe.status === 'completed';
}

const NO_THREAD_YET: ReadonlySet<ExpertStatus> = new Set<ExpertStatus>([
  'discovered', 'shortlisted', 'bookmarked', 'contact_found', 'outreach_drafted', 'rejected',
]);

const WAITING_ON_EXPERT: ReadonlySet<ExpertStatus> = new Set<ExpertStatus>([
  'contacted', 'email2_sent', 'followup_sent', 'scheduling_sent',
]);

function latestInbound(messages: ConversationMessage[]): ConversationMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].direction === 'inbound') return messages[i];
  }
  return null;
}

/** The rate decision the thread's amber card is showing, if any. */
export function decisionOpen(pe: ProjectExpertWithCounter, messages: ConversationMessage[]): boolean {
  return latestInbound(messages)?.intent === 'counter_rate' && clientCounterRateOf(pe) !== null;
}

/** Mirrors the thread's own gate for the "Propose times" control. */
export function canOfferTimes(ctx: AskContext): boolean {
  const { pe, messages, canSend } = ctx;
  const outcome = pe.scheduling?.outcome ?? null;
  return canSend
    && messages.length > 0
    && (pe.status === 'replied' || pe.status === 'followup_sent' || pe.status === 'rate_negotiation')
    && (outcome === null || outcome === 'expert_declined_times' || outcome === 'no_client_availability');
}

function dayOf(iso: string, timeZone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('en-US', { ...(timeZone && { timeZone }), month: 'short', day: 'numeric' }).format(d);
  } catch {
    return '';
  }
}

function whenOf(iso: string, timeZone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('en-US', {
      ...(timeZone && { timeZone }), month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    }).format(d);
  } catch {
    return '';
  }
}

const NUMBER_WORDS = ['No one', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
function countWord(n: number): string {
  return n < NUMBER_WORDS.length ? NUMBER_WORDS[n] : String(n);
}

function line(text: string, opts: { tone?: AskCard['tone']; buttons?: AskButton[]; jump?: AskJump } = {}): AskCard {
  return { kind: 'line', tone: opts.tone ?? 'quiet', tint: 'cream', line: text, buttons: opts.buttons ?? [], ...(opts.jump && { jump: opts.jump }) };
}

const DISMISS = (label = 'Dismiss'): AskButton => ({ action: 'dismiss', label });

// ─── Patterns ─────────────────────────────────────────────────────────────────

const AFFIRM     = /^(yes|yep|yeah|ok|okay|sure|fine|agreed|deal|accept|do it|go ahead)\b[.!]*$/;
const PROJECT_Q  = /\b(who|which|anyone|any of them|everyone|all of them)\b.*\b(replied|reply|quiet|silent|heard|booked|waiting|responded|passed|open|left)\b|\bwhat'?s waiting\b|\bwaiting on me\b|\bwho'?s (on|in) (this|the) project\b/;
const RATE_VERB  = /\b(set|change|make|pay|offer|hold|bump|lower|raise|try|go to|at|to)\b/;
const RATE_NUM   = /\$?\s?(\d{1,2},?\d{3}|\d{3,5})\b/;
const PASS_Q     = /^(pass|reject|drop (him|her|them)|not this one)\b|\b(pass on (him|her|them|this one)|reject (him|her|them)|move on from (him|her|them))\b/;
const APPROVE_Q  = /\b(send (it|it out|the intro|the follow[- ]?up)|approve( it| the intro)?|release it|go ahead and send)\b/;
const DECIDE_Q   = /\b(accept|take)\b.*\b(rate|number|counter|offer|his|her|their|it)\b|\b(offer|hold at|hold) (my|our|the) (rate|number)\b|^hold\b/;
const PROPOSE_Q  = /\b(propose|find (a |some )?(slot|time|times)|(offer|send|suggest|give) (him |her |them )?(some |a few |three )?times|book (a |the )?(call|time)|schedule (a |the )?call|slots?)\b/;
const MOVE_Q     = /\b(move|reschedule|push|shift|postpone)\b.*\b(call|it|meeting|week|day|back|out)\b|\breschedule\b/;
const PREP_Q     = /\b(prep|prepare|questions|what should i ask|interview guide|brief me)\b/;
const NUDGE_Q    = /\b(follow(ed)?[- ]?up|nudge|nudged|chase|chased|ping|pinged|heard back|any word)\b/;
const DRAFT_Q    = /\b(draft|write|what should i say|what do i say|reply saying|tell (him|her|them)|let (him|her|them) know|say back|respond|answer (him|her|them))\b/;
const SAID_Q     = /\b(what|anything|did|does|has|had)\b.*\b(say|said|mention|mentioned|answer|answered|think|want|ask|asked|reply|replied|position)\b|\bsay about\b|\b(his|her|their) (answer|reply|take|position)\b/;
const STATUS_Q   = /\b(where are we|status|where do we stand|how'?s (it|this) going|any update|what'?s (the )?latest|catch me up)\b/;
const IDENTITY_Q = /\b(linkedin|email address|his email|her email|their email|phone number|his number|her number|contact (details|info)|who is (he|she)|real name|full name|what company|where does (he|she) work)\b/;
const SCOPE_Q    = /\b(market size|tam|memo|revenue|financial model|charge (him|her|them)|bill|invoice|refund|delete|remove (him|her|them) from)\b/;

/** Reads a pass reason off the client's own words. */
export function reasonFromWords(low: string): RejectionReason {
  if (/junior|senior|experience|too green|too early in/.test(low)) return 'not_senior_enough';
  if (/industry|sector|wrong space|different market/.test(low))     return 'wrong_industry';
  if (/geograph|region|country|europe|apac|latam|wrong market/.test(low)) return 'wrong_geography';
  if (/conflict|nda|competitor/.test(low))                           return 'conflict_risk';
  if (/found someone|better|closer|someone else|another expert/.test(low)) return 'better_option_available';
  if (/academic|professor|theor/.test(low))                          return 'too_academic';
  if (/vendor|sells|salesy|biased/.test(low))                        return 'vendor_biased';
  if (/generic|vague|broad/.test(low))                               return 'too_generic';
  if (/evidence|unclear background|can'?t verify/.test(low))         return 'weak_evidence';
  return 'other';
}

/** What the slot picker will honour from a preferences line, read back honestly. */
export function preferencesReadBack(low: string): string {
  const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'].filter(d =>
    new RegExp(`\\b${d}s?\\b|\\b${d.slice(0, 3)}s?\\b`).test(low) && !new RegExp(`\\b(not|no|never)\\s+${d}s?\\b`).test(low));
  const parts: string[] = [];
  if (days.length) parts.push(days.map(d => d[0].toUpperCase() + d.slice(1) + 's').join(' and '));
  if (/\bmornings?\b/.test(low))   parts.push('mornings');
  if (/\bafternoons?\b/.test(low)) parts.push('afternoons');
  const not = low.match(/\b(?:not|no|never)\s+(monday|tuesday|wednesday|thursday|friday)s?\b/);
  if (not) parts.push(`not ${not[1][0].toUpperCase() + not[1].slice(1)}s`);
  const before = low.match(/\bbefore\s+(\d{1,2})(?::\d{2})?\s*(am|pm)?\b/);
  if (before) parts.push(`before ${before[1]}${before[2] ? ' ' + before[2] : ''}`);
  const after = low.match(/\bafter\s+(\d{1,2})(?::\d{2})?\s*(am|pm)?\b/);
  if (after) parts.push(`after ${after[1]}${after[2] ? ' ' + after[2] : ''}`);
  return parts.join(', ');
}

/** "What did they say about X": the X a client asks about, and how Matchy's summaries phrase it. */
const TOPICS: ReadonlyArray<{ ask: RegExp; summary: RegExp }> = [
  { ask: /\b(nda|ndas|conflict|conflicts|non-?compete|restriction|employer)\b/, summary: /\b(nda|conflict|non-?compete|restrict|employer|competitor)\b/i },
  { ask: /\b(rate|price|money|number|fee|cost)\b/,                                summary: /(\$|\brate\b|\bwants\b|\boffer)/i },
  { ask: /\b(time|times|when|availability|calendar|week|schedule|free)\b/,         summary: /\b(afternoon|morning|mon|tue|wed|thu|fri|week|time|available|free|pick)/i },
  { ask: /\b(scope|topic|questions|narrow|broad)\b/,                                summary: /\b(scope|topic|narrow|broad|question)/i },
];

// ─── Lines from the record ───────────────────────────────────────────────────

/** One line on where this engagement stands, in client terms. */
export function statusLineFor(ctx: AskContext): string {
  const { pe, messages, walkthrough } = ctx;
  const first  = firstNameOf(pe.expert.name);
  const nudges = pe.nudges?.count ?? 0;
  switch (pe.status) {
    case 'discovered':
    case 'shortlisted':
      return `${first} is in Matches. Bookmark them and I will start.`;
    case 'bookmarked':
    case 'contact_found':
      return `Bookmarked. Looking for an address for ${first}.`;
    case 'outreach_drafted':
      if (pe.introNeedsWhyThem) return 'Intro drafted. Waiting on staff for the personal line.';
      return walkthrough ? 'Intro written and held. Nothing is sent in walkthrough mode.' : 'Intro drafted. Waiting on you to send it.';
    case 'contacted':
    case 'email2_sent':
      return `Intro sent${nudges > 0 ? `, nudged ${nudges} of 4` : ''}. Waiting on ${first}.`;
    case 'replied':
    case 'followup_sent':
    case 'rate_negotiation': {
      const counter = clientCounterRateOf(pe);
      if (decisionOpen(pe, messages) && counter !== null && typeof pe.clientRate === 'number') {
        return `Discussing terms. ${first} countered at ${formatRate(counter)}/hr for you; your rate is ${formatRate(pe.clientRate)}. Your call.`;
      }
      return `Discussing terms with ${first}. Waiting on their answer.`;
    }
    case 'conflict_flagged':
      return `Checking a conflict ${first} raised.`;
    case 'scheduling_sent':
      return schedulingLine(pe, first, { timeZone: ctx.timeZone })?.text ?? `Times are out with ${first}. They pick, I book.`;
    case 'scheduled':
      return schedulingLine(pe, first, { timeZone: ctx.timeZone })?.text ?? `Booked with ${first}.`;
    case 'completed':
      return typeof pe.invoiceAmount === 'number'
        ? `Call done. ${formatRate(pe.invoiceAmount)} charged.`
        : 'Call done.';
    case 'rejected':
    case 'rejected_after_outreach':
      return `Passed. Nothing more goes to ${first}.`;
  }
}

function nudgeLine(ctx: AskContext): string {
  const { pe, messages, walkthrough } = ctx;
  const first = firstNameOf(pe.expert.name);
  if (walkthrough) return 'Nothing is nudged in walkthrough mode.';
  const inbound = latestInbound(messages);
  const n = pe.nudges?.count ?? 0;
  if (n > 0 && pe.nudges) {
    const last = pe.nudges.lastSentAt ? dayOf(new Date(pe.nudges.lastSentAt).toISOString(), ctx.timeZone) : '';
    const left = Math.max(0, 4 - n);
    const next = pe.nudges.scheduledFor ? ' Next one tomorrow morning;' : '';
    return `Nudged ${first} ${n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`}${last ? `, last ${last}` : ''}.${next} ${left === 0 ? 'That was the last one.' : `${countWord(left).toLowerCase()} left after that.`}`.replace(/;\s+(\w)/, (_, c: string) => `; ${c}`);
  }
  if (inbound) return `${first} replied ${dayOf(inbound.createdAt, ctx.timeZone)}. Nothing to nudge.`;
  if (WAITING_ON_EXPERT.has(pe.status)) return `Not yet. The first nudge goes out the next business morning if ${first} stays quiet.`;
  return 'Nothing to nudge.';
}

function factFor(pe: ProjectExpertWithCounter, ctx: AskContext): string {
  const counter = clientCounterRateOf(pe);
  switch (pe.status) {
    case 'bookmarked':
    case 'contact_found':     return 'no address yet';
    case 'outreach_drafted':  return pe.introNeedsWhyThem ? 'intro waiting on staff' : 'intro ready to send';
    case 'contacted':
    case 'email2_sent':       return ctx.walkthrough ? 'nothing is nudged in walkthrough mode' : pe.nudges?.count ? `nudged ${pe.nudges.count} of 4` : 'waiting on a reply';
    case 'replied':
    case 'followup_sent':
    case 'rate_negotiation':  return counter !== null ? `countered at ${formatRate(counter)}/hr, your call` : 'discussing terms';
    case 'conflict_flagged':  return 'checking a conflict';
    case 'scheduling_sent': {
      if (pe.scheduling?.outcome === 'expert_declined_times') return 'none of the times worked';
      const n = proposedSlotsOf(pe).length;
      return n > 0 ? `${countWord(n).toLowerCase()} times out, no pick yet` : 'pick-a-time link out, no pick yet';
    }
    case 'scheduled':         return pe.booking ? formatSlot(pe.booking.startUtc, pe.booking.endUtc, { timeZone: ctx.timeZone }) : 'booked';
    case 'completed':         return 'call done';
    default:                  return 'passed';
  }
}

function rollup(low: string, ctx: AskContext): AskCard {
  if (!ctx.project) return line('I can only see this thread from here.');
  const all = ctx.project.experts
    .filter(e => ctx.hasConversation(e.status))
    .map(e => e as ProjectExpertWithCounter);

  let picked: ProjectExpertWithCounter[];
  let text: string;
  if (/\bbooked\b/.test(low)) {
    picked = all.filter(e => e.status === 'scheduled');
    text = picked.length ? `${countWord(picked.length)} booked.` : 'Nothing booked yet.';
  } else if (/\bwaiting on me\b|\bwhat'?s waiting\b|\bon me\b|\bopen\b/.test(low)) {
    picked = all.filter(e =>
      clientCounterRateOf(e) !== null
      || (e.status === 'outreach_drafted' && !e.introNeedsWhyThem)
      || e.scheduling?.outcome === 'expert_declined_times'
      || e.scheduling?.outcome === 'no_client_availability');
    text = picked.length ? `${countWord(picked.length)} waiting on you.` : 'Nothing waiting on you.';
  } else if (/\bpassed\b/.test(low)) {
    picked = all.filter(e => e.status === 'rejected_after_outreach');
    text = picked.length ? `${countWord(picked.length)} passed.` : 'No one passed.';
  } else if (/\b(replied|reply|quiet|silent|heard|responded|left)\b/.test(low)) {
    picked = all.filter(e => WAITING_ON_EXPERT.has(e.status));
    text = picked.length ? `${countWord(picked.length)} waiting on a reply.` : 'Everyone has replied.';
  } else {
    picked = all;
    text = picked.length ? `${countWord(picked.length)} in conversation.` : 'No conversations yet.';
  }

  return {
    kind: 'card', tone: 'default', tint: 'cream', line: text,
    rows: picked.map(e => ({ expertId: e.expert.id, name: e.expert.name, status: e.status, fact: factFor(e, ctx) })),
    buttons: picked
      .filter(e => e.expert.id !== ctx.pe.expert.id)
      .slice(0, 6)
      .map(e => ({ action: 'open_expert' as const, label: `Open ${firstNameOf(e.expert.name)}`, expertId: e.expert.id })),
  };
}

// ─── The router ──────────────────────────────────────────────────────────────

export function askMatchy(input: string, ctx: AskContext): AskCard {
  const text  = input.trim();
  const low   = text.toLowerCase();
  const words = low.split(/\s+/).filter(Boolean).length;
  const { pe, messages, canSend } = ctx;
  const first     = firstNameOf(pe.expert.name);
  const revealed  = pe.status === 'scheduled' || pe.status === 'completed';
  const open      = decisionOpen(pe, messages);
  const noThread  = NO_THREAD_YET.has(pe.status);
  // The thread's own control offers times at rate_negotiation too, but with a
  // counter still open the honest answer is the rate card first.
  const readyForTimes = canOfferTimes(ctx) && !open;
  const ownerOnly = (): AskCard => line('Only the project owner can do that.');

  if (!text) return line('Nothing for me in that.');

  // 1. Anything the screen would stop is stopped first. A bare number is not a
  //    finding (see MONEY_PATTERNS); a "$" amount is, and is handled as a rate below.
  const findings = screenMessage({ text, direction: 'client_to_expert', identityRevealed: revealed }).findings;
  const contact  = findings.filter(f => f.kind !== 'money');
  if (contact.length > 0) {
    const isLink = contact.some(f => f.kind === 'url' || f.kind === 'email' || f.kind === 'scheduling_link');
    const offer  = readyForTimes;
    return {
      kind: 'card', tone: 'default', tint: 'blocked',
      line: isLink
        ? "I don't look at links, and identities stay off the thread until the call is booked."
        : offer
          ? `Nothing sent. I can put times in front of ${first} instead.`
          : 'Nothing sent. Say it without the contact detail and I will carry it.',
      findings: contact,
      buttons: offer ? [{ action: 'propose', label: 'Propose times', primary: true }] : [],
    };
  }

  // 2. A bare yes while a decision is open.
  if (words <= 4 && AFFIRM.test(low)) {
    const counter = clientCounterRateOf(pe);
    if (open && counter !== null && typeof pe.clientRate === 'number') {
      return line(`Yes to what? Their ${formatRate(counter)}/hr, fee included, or your ${formatRate(pe.clientRate)}? Decide on the card.`,
        { tone: 'default', jump: { to: 'decision' }, buttons: [{ action: 'jump', label: 'Show the rate card' }] });
    }
    return line('Nothing for me in that.');
  }

  // 3. Across the project.
  if (PROJECT_Q.test(low)) return rollup(low, ctx);

  // 4. A number with a rate verb sets your rate for this expert.
  const num = low.match(RATE_NUM);
  if (num && (RATE_VERB.test(low) || findings.some(f => f.kind === 'money'))) {
    const n = Number(num[1].replace(/,/g, ''));
    if (!canSend) return ownerOnly();
    if (pe.status === 'rejected' || pe.status === 'rejected_after_outreach') return line(`${first} is passed. Nothing more goes to them.`);
    if (isRateLocked(pe)) {
      return line(`The rate with ${first} is agreed${typeof pe.clientRate === 'number' ? ` at ${formatRate(pe.clientRate)}/hr` : ''}. It doesn't move after that.`);
    }
    if (!Number.isInteger(n) || n < RATE_FLOOR || n % RATE_STEP !== 0) {
      return line(`Whole dollars, at least ${formatRate(RATE_FLOOR)}, in ${formatRate(RATE_STEP)} steps.`, { tone: 'default' });
    }
    const min = typeof ctx.project?.clientRateMin === 'number' && ctx.project.clientRateMin > 0 ? ctx.project.clientRateMin : null;
    const max = typeof ctx.project?.clientRateMax === 'number' && ctx.project.clientRateMax > 0 ? ctx.project.clientRateMax : null;
    if ((min !== null && n < min) || (max !== null && n > max)) {
      const band = min !== null && max !== null ? `${formatRate(min)} to ${formatRate(max)}` : min !== null ? `at least ${formatRate(min)}` : `at most ${formatRate(max as number)}`;
      return line(`Inside your band, ${band}, in ${formatRate(RATE_STEP)} steps. Change the band above for more room.`, { tone: 'default' });
    }
    if (n === pe.clientRate) return line(`${formatRate(n)}/hr is already your rate for ${first}.`);
    return {
      kind: 'card', tone: 'default', tint: 'amber', rate: n,
      line: `Set your rate for ${first} to ${formatRate(n)}/hr? They hear their side of the number only. Nothing is sent until you press ${open ? 'Offer' : 'Send'}.`,
      buttons: [
        { action: 'set_rate', label: `Set ${formatRate(n)}/hr`, primary: true },
        DISMISS(typeof pe.clientRate === 'number' ? `Keep ${formatRate(pe.clientRate)}` : 'Dismiss'),
      ],
    };
  }

  // 5. Pass.
  if (PASS_Q.test(low)) {
    if (!canSend) return ownerOnly();
    if (pe.status === 'rejected' || pe.status === 'rejected_after_outreach') return line(`${first} is already passed.`);
    if (pe.status === 'completed') return line(`The call with ${first} is done. There is nothing to pass on.`);
    return {
      kind: 'card', tone: 'default', tint: 'amber', reason: reasonFromWords(low),
      line: `I'll mark ${first} passed. Nothing goes to them and I stop nudging.`,
      buttons: [{ action: 'pass', label: `Pass on ${first}`, primary: true }, DISMISS('Keep them')],
    };
  }

  // 6. Send the intro / approve.
  if (APPROVE_Q.test(low)) {
    if (!canSend) return ownerOnly();
    if (pe.status === 'outreach_drafted') {
      if (pe.introNeedsWhyThem) return line('Matchy could not write the personal line for this intro. Staff add it, then it goes.', { tone: 'default', jump: { to: 'intro' } });
      if (ctx.walkthrough) {
        return line('The intro is written and held. Nothing is sent in walkthrough mode.', {
          tone: 'default', jump: { to: 'intro' },
          buttons: [{ action: 'approve_intro', label: 'Send the intro', primary: true, disabled: true, title: 'Nothing is sent in walkthrough mode' }, { action: 'switch_live', label: 'Switch to live' }],
        });
      }
      return line('The intro is drafted and waiting on you.', { tone: 'default', jump: { to: 'intro' }, buttons: [{ action: 'approve_intro', label: 'Send the intro', primary: true }] });
    }
    if (pe.status === 'bookmarked' || pe.status === 'contact_found') return line(`Nothing to send yet. I am still looking for an address for ${first}.`);
    if (messages.some(m => m.author === 'matchy' && m.pendingApproval)) return line('The follow-up is drafted and waiting on you above.', { tone: 'default' });
    return line('That intro has already gone.');
  }

  // 7. Accept or hold, no number.
  if (DECIDE_Q.test(low)) {
    if (!canSend) return ownerOnly();
    const counter = clientCounterRateOf(pe);
    if (open && counter !== null && typeof pe.clientRate === 'number') {
      return line(`Their counter comes to ${formatRate(counter)}/hr for you, fee included. Your rate is ${formatRate(pe.clientRate)}. Decide on the card.`,
        { tone: 'default', jump: { to: 'decision' }, buttons: [{ action: 'jump', label: 'Show the rate card' }] });
    }
    return line('There is no counter to decide on.');
  }

  // 8. Propose times.
  if (PROPOSE_Q.test(low) && !MOVE_Q.test(low)) {
    if (!canSend) return ownerOnly();
    if (pe.status === 'scheduled' && pe.booking) return line(`A call is booked with ${first}. Ask me to move it if it needs to change.`, { jump: { to: 'booked' } });
    if (pe.status === 'scheduling_sent') return line(`Times are already out with ${first}. Ask for different ones on the card.`, { jump: { to: 'times' } });
    if (!readyForTimes) {
      return line("Terms aren't settled yet. I propose times once the rate is agreed.", { tone: 'default', ...(open && { jump: { to: 'decision' } }) });
    }
    const read = preferencesReadBack(low);
    return {
      kind: 'card', tone: 'default', tint: 'teal', preferences: read ? text.slice(0, 200) : '',
      line: read
        ? `${read[0].toUpperCase() + read.slice(1)}. That is all I took from it.`
        : "I'll pick three times from your calendar, business hours, at least a day out.",
      buttons: [{ action: 'propose', label: 'Propose times', primary: true }, DISMISS()],
    };
  }

  // 9. Move the call.
  if (MOVE_Q.test(low)) {
    if (!canSend) return ownerOnly();
    if (pe.status !== 'scheduled' || !pe.booking) return line(`Nothing is booked with ${first} yet.`);
    if (pe.scheduling?.outcome === 'reschedule_requested') return line(`Already asked ${first} for a new time. The current one stays until they pick.`, { jump: { to: 'booked' } });
    return {
      kind: 'card', tone: 'default', tint: 'green',
      line: `I'll ask ${first} for a new time. The current one stays until they pick.`,
      buttons: [{ action: 'move', label: 'Ask for a new time', primary: true }, DISMISS('Keep this time')],
    };
  }

  // 10. Prep lives on the Matches card today.
  if (PREP_Q.test(low)) return line(`The interview guide is on ${first}'s card in Matches.`);

  // 11. A draft.
  if (DRAFT_Q.test(low)) {
    if (!canSend) return line('Only the project owner can message experts.');
    if (noThread) return line(`Nothing to reply to yet. I'll open this up as soon as there is a thread.`);
    if (pe.status === 'rejected_after_outreach') return line(`${first} is passed. Nothing more goes to them.`);
    return { kind: 'draft_request', tone: 'default', tint: 'cream', line: '', instruction: text, buttons: [] };
  }

  // 12. Follow-ups.
  if (NUDGE_Q.test(low)) return line(nudgeLine(ctx), { tone: 'default' });

  // 13. What did they say.
  if (SAID_Q.test(low)) {
    const fromExpert = messages.filter(m => m.author === 'expert' && m.summary);
    if (fromExpert.length === 0) return line(`Nothing from ${first} yet. I'll put their reply here.`);
    const topic = TOPICS.find(t => t.ask.test(low));
    const match = topic ? [...fromExpert].reverse().find(m => topic.summary.test(m.summary ?? '')) : undefined;
    const m = match ?? fromExpert[fromExpert.length - 1];
    const day = dayOf(m.createdAt, ctx.timeZone);
    const buttons: AskButton[] = [{ action: 'jump', label: day ? `Show ${day}` : 'Show it' }];
    if (open) buttons.push({ action: 'jump', label: 'Show the rate card' });
    return {
      kind: 'card', tone: 'default', tint: 'cream',
      line: `${first} answered${day ? ` ${day}` : ''}.${open ? ' The rate is still open.' : ''}`,
      quote: { label: "Matchy's summary", when: whenOf(m.createdAt, ctx.timeZone), text: m.summary ?? '', messageId: m.id },
      jump: { to: 'message', messageId: m.id },
      buttons,
    };
  }

  // 14. Where are we.
  if (STATUS_Q.test(low)) return line(statusLineFor(ctx), { tone: 'default' });

  // 15. Out of scope.
  if (IDENTITY_Q.test(low)) return line('Identities are exchanged when the call is booked.');
  if (SCOPE_Q.test(low))    return line('Not mine.');

  // 16. Relay-shaped prose under the wrong button.
  if (words >= 6 && !/\?\s*$/.test(text)) return line(`Not sent. That reads as a note for ${first}.`);

  return line('Nothing for me in that.');
}
