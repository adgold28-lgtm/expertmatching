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

// ─── Public API ───────────────────────────────────────────────────────────────

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
