// lib/mailFrom.ts — the one place that decides the From: address for Resend.
//
// Resend only delivers from a domain verified in its dashboard. expertmatch.fit
// is verified; a personal mailbox (gmail.com etc.) is rejected with 403 and,
// because most senders are fire-and-forget, the failure was invisible. Every
// sender goes through getFromAddress() so a misconfigured OUTREACH_FROM_EMAIL
// can never silently stop mail again.

export const MAIL_DOMAIN           = 'expertmatch.fit';
export const DEFAULT_FROM_ADDRESS  = `ExpertMatch <notifications@${MAIL_DOMAIN}>`;

let warned = false;

/** Bare address inside "Name <addr>" or the value itself. */
export function bareAddress(from: string): string {
  return from.match(/<([^>]+)>/)?.[1]?.trim() ?? from.trim();
}

/**
 * OUTREACH_FROM_EMAIL when it is on the verified sending domain, otherwise
 * DEFAULT_FROM_ADDRESS. Never throws — mail must not depend on env hygiene.
 */
export function getFromAddress(): string {
  const configured = process.env.OUTREACH_FROM_EMAIL?.trim();
  if (configured) {
    const domain = bareAddress(configured).split('@')[1]?.toLowerCase();
    if (domain === MAIL_DOMAIN) return configured;
    if (!warned) {
      warned = true;
      console.warn(`[mailFrom] OUTREACH_FROM_EMAIL is not on ${MAIL_DOMAIN}; sending from the default address instead`);
    }
  }
  return DEFAULT_FROM_ADDRESS;
}
