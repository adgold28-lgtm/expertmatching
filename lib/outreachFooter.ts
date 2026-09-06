// Compliant footer for every outbound email that reaches an expert.
//
// CAN-SPAM requires a physical postal address and a working opt-out in any
// commercial message. The opt-out link is per-recipient: an HMAC of the
// address (lib/optOutToken.ts) that the public unsubscribe route verifies, so
// nobody can unsubscribe a third party by editing a query string.
//
// OUTREACH_POSTAL_ADDRESS is optional — when it is unset the address line is
// omitted, but the opt-out link is ALWAYS rendered.
//
// Never logs: the recipient address, the token.

import { generateOptOutToken } from './optOutToken';

export interface OutreachFooter {
  text: string;
  html: string;
}

function getBaseUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? process.env.NEXT_PUBLIC_BASE_URL ?? 'https://expertmatch.fit';
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildOptOutUrl(recipientEmail: string): string {
  const token = generateOptOutToken(recipientEmail);
  return `${getBaseUrl()}/api/outreach/unsubscribe?token=${encodeURIComponent(token)}`;
}

/**
 * Build the text and HTML footer for one recipient.
 * Senders append `.text` to a plain-text body and `.html` to an HTML body —
 * a plain-text cold email stays plain text.
 */
export function buildOutreachFooter(recipientEmail: string): OutreachFooter {
  const optOutUrl = buildOptOutUrl(recipientEmail);
  const address   = process.env.OUTREACH_POSTAL_ADDRESS?.trim();
  const identity  = address ? `ExpertMatch · ${address}` : 'ExpertMatch';

  const text = [
    '',
    '',
    '--',
    identity,
    `Prefer not to hear from us? Opt out: ${optOutUrl}`,
  ].join('\n');

  const html = `<div style="margin-top:28px;padding-top:12px;border-top:1px solid #e2e8f0;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.7;color:#94a3b8;">
  <div>${escapeHtml(identity)}</div>
  <div>Prefer not to hear from us? <a href="${escapeHtml(optOutUrl)}" style="color:#94a3b8;text-decoration:underline;">Opt out of future emails</a>.</div>
</div>`;

  return { text, html };
}
