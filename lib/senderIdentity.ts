// Sender identity utilities for outreach emails.
//
// Enforces the RFC 5322 "Display Name <email@domain.com>" format for
// OUTREACH_FROM_EMAIL and provides a configurable reply-to domain.
//
// Required env vars:
//   OUTREACH_FROM_EMAIL   — "Display Name <email@domain.com>" (display name required)
// Optional env vars:
//   OUTREACH_REPLY_DOMAIN — domain used for reply+token@ addresses
//                           defaults to the domain extracted from OUTREACH_FROM_EMAIL

export interface SenderIdentity {
  displayName: string;
  email: string;
  domain: string;
  raw: string;
}

// Matches: Any display name + space + <local@domain.tld>
// Display name is required — bare email addresses are rejected.
const SENDER_RE = /^(.+?)\s*<([^@\s]+@([^@\s]+\.[^@\s.]+))>$/;

export function parseSenderIdentity(raw: string): SenderIdentity {
  // Strip surrounding double-quotes that some tools add (e.g. in .env files)
  const cleaned = raw.trim().replace(/^"(.*)"$/, '$1').trim();

  const match = cleaned.match(SENDER_RE);
  if (!match) {
    throw new Error(
      '[senderIdentity] OUTREACH_FROM_EMAIL must be in format "Display Name <email@domain.com>"' +
      ` — got: ${raw}`,
    );
  }

  const [, displayName, email, domain] = match as [string, string, string, string];

  if (!displayName.trim()) {
    throw new Error(
      '[senderIdentity] OUTREACH_FROM_EMAIL must include a display name, e.g. "ExpertMatch <outreach@yourdomain.com>"',
    );
  }

  return {
    displayName: displayName.trim(),
    email:       email.trim(),
    domain:      domain.trim(),
    raw:         cleaned,
  };
}

export function getSenderIdentity(): SenderIdentity {
  const raw = process.env.OUTREACH_FROM_EMAIL;
  if (!raw) throw new Error('[senderIdentity] OUTREACH_FROM_EMAIL not configured');
  return parseSenderIdentity(raw);
}

// Returns the domain to use for reply-tracking addresses (reply+token@<domain>).
// Prefers the explicit OUTREACH_REPLY_DOMAIN env var; falls back to the domain
// in OUTREACH_FROM_EMAIL so no extra config is needed when both live on the same domain.
export function getReplyToDomain(): string {
  const override = process.env.OUTREACH_REPLY_DOMAIN;
  if (override) return override.trim().replace(/^@/, '');
  return getSenderIdentity().domain;
}
