// Send an availability request email to an expert.
// Uses Resend for email delivery.
//
// Required env vars:
//   RESEND_API_KEY       — API key from resend.com
//   OUTREACH_FROM_EMAIL  — "From" address, e.g. "ExpertMatch <team@yourdomain.com>"
//                          Domain must be verified in Resend.
//
// Never logs: expert name, email address, project name, token.

import { Resend } from 'resend';
import type { IcsEvent } from './generateIcs';
import { generateIcsBuffer } from './generateIcs';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AvailabilityRequestParams {
  toEmail:          string;   // expert's email address — never logged
  expertName:       string;   // used in greeting — never logged
  projectName:      string;   // used in subject — never logged
  availabilityLink: string;   // full URL including token — never logged
}

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

function buildEmailHtml(expertName: string, projectName: string, availabilityLink: string): string {
  const firstName = expertName.split(' ')[0] ?? expertName;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Scheduling Request</title>
</head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:40px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e2e8f0;max-width:600px;">

        <!-- Header -->
        <tr>
          <td style="background:#0f172a;padding:24px 32px;">
            <span style="color:#ffffff;font-size:11px;font-weight:bold;letter-spacing:3px;">EXPERTMATCH</span>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:32px;color:#1e293b;font-size:14px;line-height:1.7;">
            <p style="margin:0 0 16px;">Hi ${escapeHtml(firstName)},</p>

            <p style="margin:0 0 16px;">
              Thank you for your willingness to speak with our team regarding
              <strong>${escapeHtml(projectName)}</strong>.
            </p>

            <p style="margin:0 0 24px;">
              Please use the link below to share a few times that work for you.
              The process takes less than a minute — no account required.
            </p>

            <!-- CTA button -->
            <table cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
              <tr>
                <td style="background:#0d9488;padding:0;">
                  <a href="${escapeHtml(availabilityLink)}"
                     style="display:inline-block;padding:12px 28px;color:#ffffff;font-size:13px;font-weight:bold;text-decoration:none;letter-spacing:0.5px;">
                    Share My Availability
                  </a>
                </td>
              </tr>
            </table>

            <p style="margin:0 0 8px;font-size:12px;color:#64748b;">
              If the button above doesn't work, copy and paste this link into your browser:
            </p>
            <p style="margin:0 0 24px;font-size:11px;color:#94a3b8;word-break:break-all;">
              ${escapeHtml(availabilityLink)}
            </p>

            <p style="margin:0;font-size:12px;color:#94a3b8;">
              This link expires in 7 days. If you have any questions, please reply to this email.
            </p>
          </td>
        </tr>

        <!-- Footer -->
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
}

function buildEmailText(expertName: string, projectName: string, availabilityLink: string): string {
  const firstName = expertName.split(' ')[0] ?? expertName;
  return [
    `Hi ${firstName},`,
    '',
    `Thank you for your willingness to speak with our team regarding "${projectName}".`,
    '',
    'Please use the link below to share a few times that work for you:',
    '',
    availabilityLink,
    '',
    'This link expires in 7 days.',
    '',
    '— ExpertMatch',
  ].join('\n');
}

// ─── Invite email ─────────────────────────────────────────────────────────────

export async function sendInviteEmail(email: string, firmName: string, signupUrl: string): Promise<void> {
  if (process.env.DISABLE_EMAILS === 'true') {
    console.log('[sendInviteEmail] suppressed in dev mode');
    return;
  }

  const from = process.env.OUTREACH_FROM_EMAIL;
  if (!from) throw new Error('[sendInviteEmail] OUTREACH_FROM_EMAIL not configured');

  const firstName = email.split('@')[0] ?? email;

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
              Set up your account here — the link expires in 7 days:
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
    'Set up your account here — the link expires in 7 days:',
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
  console.log('[sendInviteEmail] email sent', { status: 'ok' });
}

// ─── Availability email ───────────────────────────────────────────────────────

export async function sendAvailabilityRequest(params: AvailabilityRequestParams): Promise<void> {
  // Dev suppression — set DISABLE_EMAILS=true to skip real sends during local dev / testing
  if (process.env.DISABLE_EMAILS === 'true') {
    console.log('[sendAvailabilityRequest] [email] suppressed in dev mode');
    return;
  }

  const from = process.env.OUTREACH_FROM_EMAIL;
  if (!from) throw new Error('[sendAvailabilityRequest] OUTREACH_FROM_EMAIL not configured');

  const resend  = getResend();
  const subject = `Scheduling Request — ${params.projectName}`;

  const { error } = await resend.emails.send({
    from,
    to:      params.toEmail,
    subject,
    html:    buildEmailHtml(params.expertName, params.projectName, params.availabilityLink),
    text:    buildEmailText(params.expertName, params.projectName, params.availabilityLink),
  });

  if (error) {
    throw new Error(`[sendAvailabilityRequest] Resend error: ${error.message}`);
  }

  // Audit log — no PII, no token
  console.log('[sendAvailabilityRequest] email sent', { status: 'ok' });
}

// ─── Confirmation email with .ics attachment ──────────────────────────────────

export async function sendConfirmationEmail(
  expertEmail:  string,
  clientEmail:  string,
  event:        IcsEvent,
  expertName:   string,
  clientName:   string,
): Promise<void> {
  if (process.env.DISABLE_EMAILS === 'true') {
    console.log('[sendConfirmationEmail] suppressed in dev mode');
    return;
  }

  const from = process.env.OUTREACH_FROM_EMAIL;
  if (!from) throw new Error('[sendConfirmationEmail] OUTREACH_FROM_EMAIL not configured');

  const resend = getResend();

  // Format the date in a readable way
  const startDate = new Date(event.startUtc);
  const formattedDate = startDate.toLocaleDateString('en-US', {
    weekday: 'long',
    month:   'long',
    day:     'numeric',
    year:    'numeric',
    hour:    'numeric',
    minute:  '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  });

  const icsBuffer  = generateIcsBuffer(event);
  const icsBase64  = icsBuffer.toString('base64');
  const subject    = `Your expert call is confirmed — ${formattedDate}`;

  const textBody = [
    'Your call is confirmed.',
    '',
    `Expert: ${expertName}`,
    `Date: ${formattedDate}`,
    'Duration: 60 minutes',
    '',
    `Join Zoom: ${event.location}`,
    '',
    'A calendar invitation is attached.',
    '',
    '— ExpertMatch',
  ].join('\n');

  const htmlBody = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
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
            <p style="margin:0 0 16px;font-weight:bold;font-size:16px;">Your call is confirmed.</p>
            <p style="margin:0 0 8px;">Expert: <strong>${escapeHtml(expertName)}</strong></p>
            <p style="margin:0 0 8px;">Date: <strong>${escapeHtml(formattedDate)}</strong></p>
            <p style="margin:0 0 24px;">Duration: <strong>60 minutes</strong></p>
            <table cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
              <tr>
                <td style="background:#0d9488;padding:0;">
                  <a href="${escapeHtml(event.location)}"
                     style="display:inline-block;padding:12px 28px;color:#ffffff;font-size:13px;font-weight:bold;text-decoration:none;">
                    Join Zoom Meeting →
                  </a>
                </td>
              </tr>
            </table>
            <p style="margin:0;font-size:12px;color:#94a3b8;">
              A calendar invitation (.ics) is attached. Open it to add this event to your calendar.
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

  // Send to both expert and client
  const recipients = [expertEmail, clientEmail].filter(e => e.trim().length > 0);

  for (const to of recipients) {
    const { error } = await resend.emails.send({
      from,
      to,
      subject,
      html:        htmlBody,
      text:        textBody,
      attachments: [
        {
          filename:    'invite.ics',
          content:     icsBase64,
          contentType: 'text/calendar; charset=utf-8; method=REQUEST',
        },
      ],
    });

    if (error) {
      console.error('[sendConfirmationEmail] Resend error:', error.message);
      // Don't throw — log and continue to next recipient
    }
  }

  console.log('[sendConfirmationEmail] confirmation sent', { recipientCount: recipients.length });
}
