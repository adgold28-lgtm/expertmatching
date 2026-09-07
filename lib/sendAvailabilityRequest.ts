// Transactional email that is NOT part of Matchy's outreach thread.
//
// Two senders live here and nothing else:
//
//   sendInviteEmail   — a new app user's "set up your account" link
//   sendBookingEmail  — a booked or moved call, with the .ics attached
//
// WHY THESE ARE NOT lib/emailSequence.sendSequenceEmail. That chokepoint sets
// Reply-To to the expert's reply token and cannot carry an attachment, and a
// calendar invite is the one outbound message that has to. So the walkthrough
// gate is re-implemented here EXPLICITLY (see sendBookingEmail): an expert copy
// is refused outright when the project has not been switched live, exactly as
// lib/walkthrough.ts requires, and the project is loaded by id rather than
// taken on trust from the caller.
//
// The 3-part availability request flow this file used to serve is GONE. The
// expert now picks a time on /schedule/[token] (lib/matchyScheduling.ts), so
// sendAvailabilityRequest() and sendConfirmationEmail() and their HTML builders
// are deleted rather than left as dead paths.
//
// Required env vars:
//   RESEND_API_KEY       — API key from resend.com
//   OUTREACH_FROM_EMAIL  — "From" address; the domain must be verified in Resend
//
// Never logs: expert or client name, email address, project name, token, the
// meeting link, or the call time.

import { Resend } from 'resend';
import type { IcsEvent } from './generateIcs';
import { generateIcsBuffer } from './generateIcs';
import { buildOutreachFooter } from './outreachFooter';
import { getFromAddress } from './mailFrom';
import { getProject } from './projectStore';
import { isWalkthrough, type HeldReason } from './walkthrough';

// ─── Client (cached per process) ─────────────────────────────────────────────

let _resend: Resend | null = null;

function getResend(): Resend {
  if (_resend) return _resend;
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('[sendAvailabilityRequest] RESEND_API_KEY not configured');
  _resend = new Resend(key);
  return _resend;
}

// ─── Email builders ───────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#39;');
}

// ─── Invite email ─────────────────────────────────────────────────────────────

export async function sendInviteEmail(
  email:     string,
  firmName:  string,
  signupUrl: string,
  /** Invitee's first name, captured at invite time. Falls back to the email local part. */
  inviteeFirstName?: string,
): Promise<void> {
  if (process.env.DISABLE_EMAILS === 'true') {
    console.warn('[sendInviteEmail] suppressed: DISABLE_EMAILS=true');
    return;
  }

  const from = getFromAddress();

  const firstName = (inviteeFirstName ?? '').trim() || (email.split('@')[0] ?? email);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>You're invited to ExpertMatch</title>
</head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:40px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e2e8f0;max-width:600px;">
        <tr>
          <td style="background:#0f172a;padding:24px 32px;">
            <span style="color:#ffffff;font-size:11px;font-weight:bold;letter-spacing:3px;">EXPERTMATCH</span>
          </td>
        </tr>
        <tr>
          <td style="padding:32px;color:#1e293b;font-size:14px;line-height:1.7;">
            <p style="margin:0 0 16px;">Hi ${escapeHtml(firstName)},</p>
            <p style="margin:0 0 16px;">
              Your access to ExpertMatch has been approved for <strong>${escapeHtml(firmName)}</strong>.
            </p>
            <p style="margin:0 0 24px;">
              Set up your account here — the link expires in 24 hours:
            </p>
            <table cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
              <tr>
                <td style="background:#0B1F3B;padding:0;">
                  <a href="${escapeHtml(signupUrl)}"
                     style="display:inline-block;padding:12px 28px;color:#C6A75E;font-size:13px;font-weight:bold;text-decoration:none;letter-spacing:0.5px;">
                    Set Up Account →
                  </a>
                </td>
              </tr>
            </table>
            <p style="margin:0;font-size:12px;color:#94a3b8;word-break:break-all;">
              ${escapeHtml(signupUrl)}
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 32px;border-top:1px solid #e2e8f0;">
            <p style="margin:0;font-size:11px;color:#94a3b8;">Sent via ExpertMatch</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = [
    `Hi ${firstName},`,
    '',
    `Your access to ExpertMatch has been approved for ${firmName}.`,
    '',
    'Set up your account here — the link expires in 24 hours:',
    '',
    signupUrl,
    '',
    '— ExpertMatch',
  ].join('\n');

  const resend = getResend();
  const { error } = await resend.emails.send({
    from,
    to:      email,
    subject: "You're invited to ExpertMatch",
    html,
    text,
  });

  if (error) throw new Error(`[sendInviteEmail] Resend error: ${error.message}`);
}


// ─── Booking email (with the calendar invite attached) ────────────────────────

export interface SendBookingEmailOptions {
  /**
   * Who is reading it. 'expert' adds the CAN-SPAM opt-out footer and is
   * REFUSED in walkthrough mode. 'client' gets neither: a paying customer must
   * never be able to add themselves to the do-not-contact list, and a client
   * has always been allowed to see what their own walkthrough would do.
   */
  recipient: 'expert' | 'client';
  /** The project this booking belongs to. Loaded here, never trusted from the caller. */
  projectId: string;
}

/** Whether the invite actually went out, and why it did not. */
export type BookingSendOutcome =
  | { sent: true }
  | { sent: false; held: HeldReason };

/**
 * The one place a calendar invite leaves the platform.
 *
 * `invite.ics` rides as an attachment whose MIME method matches the ICS body's
 * own METHOD line — Outlook silently ignores an invite where the two disagree,
 * which is what makes a reschedule land as a MOVE rather than as a second
 * event (lib/generateIcs.ts, SEQUENCE).
 *
 * Fails soft on a Resend error: the call is already booked in our database and
 * the client can download the same invite from
 * GET /api/projects/[projectId]/experts/[expertId]/booking/ics.
 */
export async function sendBookingEmail(
  to:      string,
  subject: string,
  text:    string,
  html:    string,
  ics:     IcsEvent,
  options: SendBookingEmailOptions,
): Promise<BookingSendOutcome> {
  if (process.env.DISABLE_EMAILS === 'true') {
    console.warn('[sendBookingEmail] suppressed (DISABLE_EMAILS=true)',
      JSON.stringify({ recipient: options.recipient }));
    return { sent: false, held: 'disabled' };
  }

  const address = to.trim();
  if (!address) return { sent: false, held: 'disabled' };

  // The walkthrough gate. It FAILS CLOSED on an expert copy: a project we
  // cannot load is a project we cannot prove is live.
  if (options.recipient === 'expert') {
    const project = await getProject(options.projectId).catch(() => null);
    if (!project || isWalkthrough(project)) {
      console.warn('[sendBookingEmail] held (walkthrough)',
        JSON.stringify({ recipient: options.recipient }));
      return { sent: false, held: 'walkthrough' };
    }
  }

  const method      = ics.method === 'CANCEL' ? 'CANCEL' : 'REQUEST';
  const contentType = `text/calendar; charset=utf-8; method=${method}`;

  const footer = options.recipient === 'expert'
    ? buildOutreachFooter(address)
    : { text: '', html: '' };

  try {
    const { error } = await getResend().emails.send({
      from:    getFromAddress(),
      to:      address,
      subject,
      text:    `${text}${footer.text}`,
      html:    `${html}${footer.html}`,
      attachments: [{
        filename:    'invite.ics',
        content:     generateIcsBuffer(ics).toString('base64'),
        contentType,
      }],
    });

    if (error) {
      console.error('[sendBookingEmail] Resend error:', error.message.slice(0, 120));
      return { sent: false, held: 'disabled' };
    }
  } catch (err) {
    console.error('[sendBookingEmail] send failed:',
      err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return { sent: false, held: 'disabled' };
  }

  console.info('[sendBookingEmail] sent', JSON.stringify({ recipient: options.recipient, status: 'ok' }));
  return { sent: true };
}
