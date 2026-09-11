// Matchy's scheduling emails — every one of them one or two sentences.
//
// The founder's rule, verbatim: "Emails stay at 1 to 2 sentences." So each
// builder below returns a body shaped exactly the same way:
//
//   Hi {first name},
//   <at most two sentences>
//   <one line per proposed slot, when there are any>
//   <the picker link on its own line, when one is included>
//   <sign-off from lib/senderIdentity.ts, when OUTREACH_SIGNATURE is set>
//   <CAN-SPAM footer from lib/outreachFooter.ts>
//
// THE RULES, enforced by scripts/test-scheduling.ts for every builder:
//   - at most two sentences before the slot list
//   - no currency symbol and no money word: scheduling is not where a rate is
//     discussed, and the client-side number must never reach an expert
//   - no em dashes (the house rule for outbound mail)
//   - no client name, no firm name, no project name — an expert never learns
//     who they are being sourced for until the call is booked
//   - no "we"-speak about machinery, no filler
//
// Slot lines are formatted in the EXPERT's zone when we know it (they told the
// picker page, or a reply named one) and in the client's zone otherwise, with
// the zone label spelled out so a reader in another zone is never guessing.
//
// These are TEMPLATES, not prompts: no LLM writes an outbound line here, which
// is what makes the rules above testable rather than hopeful.
//
// Pure — no I/O, nothing logged.

import type { ProposedSlot } from '../types';
import { buildOutreachFooter } from './outreachFooter';
import { signOff } from './senderIdentity';
import { firstNameOf, type MatchyEmail } from './matchyTemplates';

export type { MatchyEmail };

// ─── HTML shell ───────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The same restrained shell lib/matchyTemplates.ts uses. Duplicated rather
 * than imported because that module does not export its `toHtml` and it is
 * owned by the lead this phase; six lines of markup is a smaller cost than a
 * cross-file edit.
 *
 * A bare URL on its own line becomes a real link so the expert can tap it on a
 * phone. Everything is escaped first, so the link text is never attacker text.
 */
function toHtml(bodyText: string, footerHtml: string): string {
  const paragraphs = bodyText
    .split(/\n{2,}/)
    .map(p => {
      const escaped = escapeHtml(p).replace(/\n/g, '<br />');
      const linked  = escaped.replace(
        /(https?:\/\/[^\s<]+)/g,
        '<a href="$1" style="color:#0B1F3B;">$1</a>',
      );
      return `<p style="margin:0 0 14px;">${linked}</p>`;
    })
    .join('\n  ');

  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.65;color:#0B1F3B;max-width:560px;">
  ${paragraphs}
${footerHtml}
</div>`;
}

// ─── Slot formatting ──────────────────────────────────────────────────────────

/**
 * "Tue Sep 15, 2:00 PM ET" — one slot, in the zone the reader is being shown.
 *
 * The zone abbreviation comes from Intl rather than a hand-rolled table, so it
 * is right across DST and outside North America. A zone Intl cannot abbreviate
 * falls back to the IANA name, which is still unambiguous.
 */
export function formatSlotLine(startUtc: string, tzIana: string): string {
  const date = new Date(startUtc);
  if (Number.isNaN(date.getTime())) return '';

  let stamp: string;
  try {
    stamp = new Intl.DateTimeFormat('en-US', {
      timeZone:     tzIana,
      weekday:      'short',
      month:        'short',
      day:          'numeric',
      hour:         'numeric',
      minute:       '2-digit',
      hour12:       true,
      timeZoneName: 'short',
    }).format(date);
  } catch {
    return formatSlotLine(startUtc, 'UTC');
  }

  // Intl renders "Tue, Sep 15, 2:00 PM EDT"; the house style drops the comma
  // after the weekday and keeps everything else.
  return stamp.replace(/^([A-Za-z]{3}),\s/, '$1 ');
}

/** The slot lines for a body, one per line. '' when there are none. */
export function formatSlotLines(slots: ProposedSlot[], tzIana: string): string {
  return slots
    .map(slot => formatSlotLine(slot.startUtc, tzIana))
    .filter(line => line.length > 0)
    .join('\n');
}

/** "Times shown in America/Chicago" — the zone caption under a slot list. */
export function zoneCaption(tzIana: string): string {
  return `Times shown in ${tzIana}.`;
}

// ─── Assembly ─────────────────────────────────────────────────────────────────

interface BodyParts {
  firstName: string;
  /** At most two sentences. The one thing every caller must keep short. */
  sentences: string;
  slotLines?: string;
  pickUrl?:   string;
  /** Recipient address — the CAN-SPAM opt-out link is per-recipient. */
  recipientEmail: string;
  subject: string;
  /**
   * Set for the booking emails, whose footer is decided by the SENDER rather
   * than the template: lib/sendAvailabilityRequest.sendBookingEmail adds the
   * opt-out footer to the expert's copy and deliberately none to the client's
   * (a paying customer must never be able to suppress their own address). The
   * thread emails keep building their own, because lib/emailSequence is told
   * `footerIncluded: true` and would otherwise append a second one.
   */
  omitFooter?: boolean;
}

function assemble(parts: BodyParts): MatchyEmail {
  const blocks = [
    `Hi ${firstNameOf(parts.firstName)},`,
    parts.sentences.trim(),
    ...(parts.slotLines && parts.slotLines.trim() ? [parts.slotLines.trim()] : []),
    ...(parts.pickUrl ? [parts.pickUrl] : []),
  ];

  const body   = signOff(blocks.join('\n\n'));
  const footer = parts.omitFooter
    ? { text: '', html: '' }
    : buildOutreachFooter(parts.recipientEmail);

  return {
    subject: parts.subject,
    text:    `${body}${footer.text}`,
    html:    toHtml(body, footer.html),
  };
}

/** `Re: {thread subject}`, the continuity every reply on the thread keeps. */
export function threadSubject(outreachSubject: string | undefined | null): string {
  const base = outreachSubject?.trim() || 'Paid expert call';
  return /^re:/i.test(base) ? base : `Re: ${base}`;
}

// ─── Templates ────────────────────────────────────────────────────────────────

export interface ProposeTimesInput {
  expertFirstName: string;
  slots:           ProposedSlot[];
  pickUrl:         string;
  /** 1 for the first ask, 2 or 3 for the rounds after a "none of these work". */
  round:           number;
  /** IANA zone the slot lines are rendered in. */
  zone:            string;
  recipientEmail:  string;
  subject:         string;
}

/**
 * The ask. Round one opens; every later round acknowledges that the last set
 * missed and offers a different one. Two sentences either way.
 */
export function proposeTimesEmail(input: ProposeTimesInput): MatchyEmail {
  const sentences = input.round <= 1
    ? 'Great. Would any of these work for a 60 minute call? If not, pick a time here:'
    : 'None of those worked, so here are a few more. Pick one here if easier:';

  return assemble({
    firstName:      input.expertFirstName,
    sentences,
    slotLines:      formatSlotLines(input.slots, input.zone),
    pickUrl:        input.pickUrl,
    recipientEmail: input.recipientEmail,
    subject:        input.subject,
  });
}

export interface LinkOnlyInput {
  expertFirstName: string;
  pickUrl:         string;
  recipientEmail:  string;
  subject:         string;
}

/**
 * No usable overlap, so there is nothing to list. One sentence and the link.
 */
export function linkOnlyEmail(input: LinkOnlyInput): MatchyEmail {
  return assemble({
    firstName:      input.expertFirstName,
    sentences:      'Great. Pick a time that suits you here:',
    pickUrl:        input.pickUrl,
    recipientEmail: input.recipientEmail,
    subject:        input.subject,
  });
}

export interface ConfirmedInput {
  expertFirstName: string;
  /** Pre-formatted, in the recipient's zone. */
  whenLabel:       string;
  recipientEmail:  string;
  subject:         string;
}

/** The expert's copy of a booked call. The Zoom link rides in the ICS. */
export function confirmedEmail(input: ConfirmedInput): MatchyEmail {
  return assemble({
    firstName:      input.expertFirstName,
    sentences:      `Booked for ${input.whenLabel}. The Zoom link and calendar invite are attached.`,
    recipientEmail: input.recipientEmail,
    subject:        input.subject,
    omitFooter:     true,
  });
}

export interface ClientConfirmedInput {
  clientFirstName: string;
  whenLabel:       string;
  /** The expert's real name. By this point the identity is revealed. */
  expertName:      string;
  recipientEmail:  string;
  subject:         string;
}

/**
 * The client's copy. It may name the expert: the booking is exactly the point
 * lib/redactExpert.ts stops anonymizing them.
 */
export function clientConfirmedEmail(input: ClientConfirmedInput): MatchyEmail {
  return assemble({
    firstName:      input.clientFirstName,
    sentences:      `Your call with ${input.expertName} is booked for ${input.whenLabel}. The Zoom link and calendar invite are attached.`,
    recipientEmail: input.recipientEmail,
    subject:        input.subject,
    omitFooter:     true,
  });
}

export interface RescheduleAskInput {
  expertFirstName: string;
  slots:           ProposedSlot[];
  pickUrl:         string;
  /** The booked time we are moving away from. */
  whenLabel:       string;
  zone:            string;
  recipientEmail:  string;
  subject:         string;
}

/** We need to move a booked call. Says so, offers alternatives, stops. */
export function rescheduleAskEmail(input: RescheduleAskInput): MatchyEmail {
  return assemble({
    firstName:      input.expertFirstName,
    sentences:      `We need to move our call on ${input.whenLabel}. Would any of these work instead, or pick here:`,
    slotLines:      formatSlotLines(input.slots, input.zone),
    pickUrl:        input.pickUrl,
    recipientEmail: input.recipientEmail,
    subject:        input.subject,
  });
}

export interface MovedInput {
  firstName:      string;
  whenLabel:      string;
  recipientEmail: string;
  subject:        string;
}

/** The call moved. The updated ICS carries the same UID, so calendars follow. */
export function movedEmail(input: MovedInput): MatchyEmail {
  return assemble({
    firstName:      input.firstName,
    sentences:      `Moved to ${input.whenLabel}. The updated invite is attached.`,
    recipientEmail: input.recipientEmail,
    subject:        input.subject,
    omitFooter:     true,
  });
}

export interface NoTimesLeftInput {
  expertFirstName: string;
  pickUrl:         string;
  recipientEmail:  string;
  subject:         string;
}

/**
 * Three rounds and no overlap. Matchy stops proposing and asks them to say
 * when they are free instead.
 */
export function noTimesLeftEmail(input: NoTimesLeftInput): MatchyEmail {
  return assemble({
    firstName:      input.expertFirstName,
    sentences:      'I could not find an overlap. Send me a few windows that work and I will book one:',
    pickUrl:        input.pickUrl,
    recipientEmail: input.recipientEmail,
    subject:        input.subject,
  });
}

// ─── Wave 5: cancelling a booked call ─────────────────────────────────────────
//
// docs/CALL_POLICIES_DRAFT.md founder decisions 3 and 4. Three templates, all
// under the same two-sentence rule as everything above:
//
//   cancelledEmail            the EXPERT's copy. Names no client, no firm, no
//                             project, and no money, exactly like every other
//                             expert-facing body here.
//   clientCancelledEmail      the CLIENT's copy. May name the expert (the
//                             booking already revealed them) and may name the
//                             late-cancellation fee, because the client is the
//                             only party the client-side number belongs to.
//   expertRemovedApologyEmail the apology when the EXPERT was at fault. Names
//                             nobody at all: not the expert, not their company,
//                             not the project.

export interface CancelledInput {
  /** The expert's first name; assemble() shortens it. */
  expertFirstName: string;
  /** Pre-formatted, in the recipient's zone. */
  whenLabel:       string;
  recipientEmail:  string;
  subject:         string;
}

/**
 * The expert's copy of a cancelled call. The withdrawal itself rides in the
 * attached METHOD:CANCEL invite, so the body only has to say it plainly.
 */
export function cancelledEmail(input: CancelledInput): MatchyEmail {
  return assemble({
    firstName:      input.expertFirstName,
    sentences:      `The call on ${input.whenLabel} is cancelled. The calendar invite has been withdrawn.`,
    recipientEmail: input.recipientEmail,
    subject:        input.subject,
    omitFooter:     true,
  });
}

export interface ClientCancelledInput {
  clientFirstName: string;
  whenLabel:       string;
  /** The expert's real name. By this point the identity is revealed. */
  expertName:      string;
  /**
   * Whole dollars charged for the late cancellation, when one was. Omitted or
   * zero means the cancel was free and the body says nothing about money.
   */
  feeDollars?:     number | null;
  recipientEmail:  string;
  subject:         string;
}

/** The client's copy. Says what the cancel cost, when it cost anything. */
export function clientCancelledEmail(input: ClientCancelledInput): MatchyEmail {
  const fee = typeof input.feeDollars === 'number' && input.feeDollars > 0
    ? ` The 15 minute late cancellation fee of $${input.feeDollars.toLocaleString('en-US')} applies.`
    : '';

  return assemble({
    firstName:      input.clientFirstName,
    sentences:      `Your call with ${input.expertName} on ${input.whenLabel} is cancelled.${fee}`,
    recipientEmail: input.recipientEmail,
    subject:        input.subject,
    omitFooter:     true,
  });
}

export interface ExpertRemovedApologyInput {
  clientFirstName: string;
  recipientEmail:  string;
  subject:         string;
}

/**
 * The apology, on ExpertMatch's behalf, when the expert cancelled late or did
 * not turn up (founder decision 3).
 *
 * IT NAMES NOBODY. Not the expert, not their employer, not the project: a
 * removal is our decision about our database, and the client needs the outcome
 * rather than the identity. There is no charge, and the body says so.
 */
export function expertRemovedApologyEmail(input: ExpertRemovedApologyInput): MatchyEmail {
  return assemble({
    firstName:      input.clientFirstName,
    sentences:      'I am sorry: the expert did not hold up their end, so they have been removed from our database and you have not been charged. Say the word and I will find you someone else.',
    recipientEmail: input.recipientEmail,
    subject:        input.subject,
    omitFooter:     true,
  });
}
