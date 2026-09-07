// lib/senderIdentity.ts — who signs Matchy's emails.
//
// Two env vars decide how an expert experiences the sender, and neither is
// code:
//
//   OUTREACH_FROM_EMAIL  — the From: header. lib/mailFrom.ts already owns it
//                          and only accepts an address on expertmatch.fit, so
//                          "Asher Goldstein <asher@expertmatch.fit>" works and
//                          a gmail address falls back to the default.
//   OUTREACH_SIGNATURE   — the sign-off appended to every outbound body, e.g.
//                          "Asher" or "Asher Goldstein\nExpertMatch". Unset
//                          means no sign-off (the footer already names the
//                          sender), which is how Phase 1 shipped.
//
// The founder's question was whether Matchy should write "on behalf of" them.
// This module makes that a one-variable decision rather than a code change:
// set the signature and the From name together and every template signs the
// same way. Nothing here reads the project or the recipient, so it is pure.

const MAX_SIGNATURE_CHARS = 120;

/** The configured sign-off, trimmed and bounded, or '' when none is set. */
export function senderSignature(): string {
  const raw = process.env.OUTREACH_SIGNATURE;
  if (typeof raw !== 'string') return '';
  // Env values arrive with literal "\n" when set through a dashboard.
  return raw.replace(/\\n/g, '\n').trim().slice(0, MAX_SIGNATURE_CHARS);
}

/**
 * Appends the sign-off to a plain-text body when one is configured. The body
 * is returned untouched otherwise, so callers can apply this unconditionally.
 */
export function signOff(body: string): string {
  const sig = senderSignature();
  if (!sig) return body;
  const trimmed = body.replace(/\s+$/, '');
  return `${trimmed}\n\n${sig}`;
}
