// lib/autoReply.ts
//
// Automatic replies are not replies (founder, 2026-10-17: "reply counts
// shouldn't be out of office or message blocked").
//
// An inbound email on an expert's reply address can be a person answering, or
// a machine answering for them: an out-of-office note, or a "message blocked" /
// "undeliverable" notice from their mail system that came back to the reply
// address. A machine answer must not
//   - count as a reply (lib/outreachStats.ts reads intent 'auto_reply'),
//   - move the engagement's stage or stamp replyDetectedAt,
//   - stop the follow-up nudges (lib/nudges.waitingSinceFor skips it).
// It is still stored on the thread, so staff can read it and the client sees
// one plain Matchy line.
//
// TWO STRENGTHS. A STRONG signal decides on its own: an automatic-reply or
// delivery-notice SUBJECT PREFIX ("Automatic reply:", "Out of Office:",
// "Undeliverable:"), or delivery-notice wording in the body ("Your message
// couldn't be delivered", "has been blocked", an SMTP 5.x.x code). A WEAK
// signal is out-of-office wording in a short body ("I'm out of the office
// until Monday"): a person can write that and still answer ("...but yes, I'm
// interested"), so the caller only treats it as automatic when the reply
// classifier also found nothing to act on ('unclear'). Subjects are matched
// on their PREFIX only, after stripping Re:/Fwd:, because our own intro
// subject carries the expert's domain ("Expert in absence management: ...").
//
// Pure. No I/O. Tested by scripts/test-auto-reply.ts.

export type AutomatedReplyKind = 'out_of_office' | 'delivery_notice';

export interface AutomatedReplyVerdict {
  kind:     AutomatedReplyKind;
  strength: 'strong' | 'weak';
}

/** The intent stored on an automatic reply's thread row. Never a reply. */
export const AUTO_REPLY_INTENT = 'auto_reply' as const;

/** A weak out-of-office signal only counts in a body this short. */
export const WEAK_OOO_MAX_WORDS = 80;

/** Reply / forward prefixes, in the languages experts are likely to use. */
const REPLY_PREFIX = /^\s*((re|fw|fwd|aw|wg|sv|vs|tr|rv|r)\s*(\[\d+\])?\s*:\s*)+/i;

const OOO_SUBJECT_PREFIX = new RegExp(
  '^(' + [
    'automatic reply', 'auto(matic)?[- ]?reply', 'autoreply', 'auto[- ]?response', 'autoresponse',
    'auto', 'out of (the )?office', 'ooo', 'away( from (the |my )?(office|desk))?',
    'on (vacation|holiday|leave|annual leave|parental leave|maternity leave|paternity leave|sabbatical)',
    'abwesenheit(snotiz)?', 'automatische antwort', 'r[ée]ponse automatique', 'absence',
    'respuesta autom[áa]tica', 'fuera de la oficina', 'risposta automatica', 'fuori sede',
    'automatisch antwoord', 'afwezig',
  // A few words may sit before the colon: "Out of Office AutoReply:".
  ].join('|') + ')\\b[^:\\n]{0,25}[:\\-]',
  'i',
);

const DELIVERY_SUBJECT_PREFIX = new RegExp(
  '^(' + [
    'undeliverable', 'undelivered( mail)?', 'not delivered', 'delivery (status notification|failure|failed|has failed|incomplete|notification)',
    'mail delivery (failed|failure|subsystem|system)', 'returned mail', 'failure notice', 'non[- ]?delivery( report| notification)?',
    'message (blocked|not delivered|rejected|undeliverable|could not be delivered)', 'blocked', 'rejected',
    'your message (was|has been) (blocked|rejected)', 'unzustellbar', 'non remis', 'no se puede entregar',
  ].join('|') + ')\\b',
  'i',
);

/** Wording only a delivery notice uses. Specific on purpose: a person rarely writes these. */
const DELIVERY_BODY = new RegExp(
  [
    "your message( to [^\\n]{0,120})? (couldn't|could not|wasn't|was not|has not been|cannot|can't) (be )?delivered",
    'message (was|has been) (blocked|rejected|quarantined)',
    '(was|has been) blocked by',
    'delivery has failed to these recipients',
    'the following (message|recipients?|addresses?) (could not|cannot|couldn\'t) be (delivered|reached)',
    'was undeliverable',
    'automatically generated delivery status notification',
    'remote server returned',
    '\\b55[0-4][ -]5\\.\\d{1,3}\\.\\d{1,3}\\b',
  ].join('|'),
  'i',
);

/** Wording a machine uses to say it is a machine. */
const OOO_BODY_STRONG = /\b(this is an automatic (reply|response|message)|this (message|email) (was|is) (sent )?automatically|automatically generated (reply|response))\b/i;

/** Out-of-office wording a person could also write. Weak. */
const OOO_BODY_WEAK = new RegExp(
  [
    "\\b(i am|i'm|i will be|i'll be)\\s+(currently\\s+)?(out of (the )?office|away|out|on (vacation|holiday|leave|pto|annual leave|parental leave|maternity leave|paternity leave|sabbatical)|travel+ing)\\b",
    '\\bwill (be back|return)( to (the )?office)? (on|in|after|from)\\b',
    '\\blimited (access to|ability to check) (e-?mail|my e-?mail|messages)\\b',
    '\\b(out of (the )?office|ooo) (until|through|till)\\b',
  ].join('|'),
  'i',
);

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Is this inbound email a machine answering for the expert? Null when it reads
 * as a person. `text` is the CLEANED body (quoted history already stripped by
 * lib/emailClean), so our own intro quoted underneath never triggers a match.
 */
export function detectAutomatedReply(input: {
  subject?: string | null;
  text?:    string | null;
}): AutomatedReplyVerdict | null {
  const subject = (input.subject ?? '').replace(REPLY_PREFIX, '').trim();
  const text    = (input.text ?? '').trim();

  if (subject && DELIVERY_SUBJECT_PREFIX.test(subject)) return { kind: 'delivery_notice', strength: 'strong' };
  if (text && DELIVERY_BODY.test(text))                 return { kind: 'delivery_notice', strength: 'strong' };
  if (subject && OOO_SUBJECT_PREFIX.test(subject))      return { kind: 'out_of_office',   strength: 'strong' };
  if (text && OOO_BODY_STRONG.test(text))               return { kind: 'out_of_office',   strength: 'strong' };
  if (text && wordCount(text) <= WEAK_OOO_MAX_WORDS && OOO_BODY_WEAK.test(text)) {
    return { kind: 'out_of_office', strength: 'weak' };
  }
  return null;
}

/**
 * The one line the client reads in place of an automatic reply (expert
 * messages are summary-only for clients). No machinery words.
 */
export function automatedReplySummary(kind: AutomatedReplyKind): string {
  return kind === 'out_of_office'
    ? "An automatic out-of-office reply. Not an answer yet, so I'll keep following up."
    : 'An automatic notice came back instead of a reply. Staff are looking at it.';
}
