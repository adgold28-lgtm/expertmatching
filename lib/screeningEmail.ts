// lib/screeningEmail.ts — the one place a screening link leaves the platform.
//
// One sender, one recipient, one message: the expert who was added to an
// approved request gets the link to their screening form. It is a COLD email to
// someone who has not agreed to anything yet, which decides everything below.
//
// THE THREE GATES, in this order, and none of them is skippable:
//   1. DISABLE_EMAILS — the global off switch every sender here honours.
//   2. lib/outreachSuppressions.isSuppressed — the global do-not-contact list,
//      keyed on the address rather than on a project, so someone who opted out
//      of Matchy's outreach is never cold-emailed by the screening flow either.
//      It FAILS CLOSED: `{ ok: false }` means we could not establish the
//      answer, and that is held, never sent.
//   3. lib/outreachFooter.buildOutreachFooter — the CAN-SPAM identity and
//      opt-out line, appended to both bodies. A cold email does not go without
//      it, which is why the body builder (lib/screeningPublic) deliberately
//      never sees an address and cannot add it itself.
//
// NOT lib/emailSequence.sendSequenceEmail. That chokepoint belongs to Matchy's
// outreach thread — it sets Reply-To to a project reply token and files the
// message into a conversation. A screening link belongs to no thread and no
// project, and a reply to it goes to a person, so this sends through Resend
// directly, exactly as lib/sendAvailabilityRequest does.
//
// NEVER THROWS. A send that fails comes back `{ sent: false, held: … }` and the
// mint route still returns the link, because staff can hand it over another
// way — losing the minted link because an email bounced would be the worse
// outcome.
//
// Required env: RESEND_API_KEY, OUTREACH_FROM_EMAIL (lib/mailFrom).
//
// NEVER LOGS: the address, the link, the topic, the expert's name, or the
// subject line. The one warning carries a reason string and nothing else.

import { Resend } from 'resend';
import { buildOutreachFooter } from './outreachFooter';
import { getFromAddress } from './mailFrom';
import { isSuppressed } from './outreachSuppressions';
import { buildScreeningLinkEmail } from './screeningPublic';

// ─── Client (cached per process) ─────────────────────────────────────────────

let _resend: Resend | null = null;

function getResend(): Resend | null {
  if (_resend) return _resend;
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  _resend = new Resend(key);
  return _resend;
}

// ─── Send ─────────────────────────────────────────────────────────────────────

export interface SendScreeningLinkEmailInput {
  /** The expert's address. Never logged. */
  to:              string;
  /** The full screening URL — a credential. Never logged. */
  link:            string;
  topic:           string;
  firmPhrase:      string;
  /** EXPERT-side whole dollars per hour. */
  expertRate:      number;
  callLengthMin:   number;
  deadline:        string;
  expertFirstName: string;
  /** How many questions the form holds, so the email can say so honestly. */
  itemCount?:      number;
}

/**
 * Why a screening link did not go out.
 *
 *   'disabled'                DISABLE_EMAILS=true — a local or staging run
 *   'suppressed'              the address is on the do-not-contact list
 *   'suppression_unavailable' we could not read that list; failed closed
 *   'send_failed'             no API key, or Resend refused
 *
 * Distinguished because STAFF see this, not an expert: the invite panel says
 * "this address has opted out" rather than "something went wrong", and the
 * link is shown either way.
 */
export type ScreeningEmailHeld =
  | 'disabled'
  | 'suppressed'
  | 'suppression_unavailable'
  | 'send_failed';

export type ScreeningEmailOutcome =
  | { sent: true }
  | { sent: false; held: ScreeningEmailHeld };

export async function sendScreeningLinkEmail(
  input: SendScreeningLinkEmailInput,
): Promise<ScreeningEmailOutcome> {
  if (process.env.DISABLE_EMAILS === 'true') {
    return { sent: false, held: 'disabled' };
  }

  const to = input.to.trim();
  if (!to) return { sent: false, held: 'send_failed' };

  // Fail closed: an unreadable suppression list is not permission to send.
  const suppression = await isSuppressed(to);
  if (!suppression.ok)      return { sent: false, held: 'suppression_unavailable' };
  if (suppression.suppressed) return { sent: false, held: 'suppressed' };

  const resend = getResend();
  if (!resend) return { sent: false, held: 'send_failed' };

  const email  = buildScreeningLinkEmail({
    link:            input.link,
    topic:           input.topic,
    firmPhrase:      input.firmPhrase,
    expertRate:      input.expertRate,
    callLengthMin:   input.callLengthMin,
    deadline:        input.deadline,
    expertFirstName: input.expertFirstName,
    itemCount:       input.itemCount,
  });
  const footer = buildOutreachFooter(to);

  try {
    const { error } = await resend.emails.send({
      from:    getFromAddress(),
      to,
      subject: email.subject,
      text:    `${email.text}${footer.text}`,
      html:    `${email.html}${footer.html}`,
    });
    if (error) {
      console.warn('[screeningEmail] send failed', JSON.stringify({ reason: 'resend_error' }));
      return { sent: false, held: 'send_failed' };
    }
  } catch {
    console.warn('[screeningEmail] send failed', JSON.stringify({ reason: 'resend_error' }));
    return { sent: false, held: 'send_failed' };
  }

  return { sent: true };
}
