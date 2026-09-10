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
// The rubric intro (lib/matchyTemplates.buildIntroEmail) signs differently from
// the rest: first name only, ALWAYS — "Asher" when nothing is configured — with
// a block underneath carrying the full name and the From address.
// senderFirstName / senderFullName / senderFromAddress below are the pieces of
// that block, each derived from the env, none of them invented.
//
// The founder's question was whether Matchy should write "on behalf of" them.
// This module makes that a one-variable decision rather than a code change:
// set the signature and the From name together and every template signs the
// same way. Nothing here reads the project or the recipient, so it is pure.

import { bareAddress, getFromAddress } from './mailFrom';

const MAX_SIGNATURE_CHARS = 120;

/** The founder's rule for the intro: it is always signed with this first name. */
export const DEFAULT_SENDER_FIRST_NAME = 'Asher';

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

/** First line of the configured signature, or '' — the name part of a multi-line sign-off. */
function signatureFirstLine(): string {
  return senderSignature().split('\n')[0]?.trim() ?? '';
}

/** The display name inside "Name <addr>", or '' for a bare address. */
function fromDisplayName(): string {
  const from = getFromAddress();
  const match = from.match(/^\s*"?([^"<]+?)"?\s*</);
  return match?.[1]?.trim() ?? '';
}

/**
 * The first name the intro signs with. The first word of OUTREACH_SIGNATURE
 * when it is set ("Asher Goldstein\nExpertMatch" → "Asher"), otherwise the
 * founder's default. Never empty.
 */
export function senderFirstName(): string {
  const word = signatureFirstLine().split(/\s+/)[0]?.replace(/[.,;:!?"]+$/, '') ?? '';
  return word || DEFAULT_SENDER_FIRST_NAME;
}

/**
 * The full name for the signature block: the From display name when it reads
 * as a person (two or more words — "ExpertMatch" alone is the product, not a
 * person), else the first line of OUTREACH_SIGNATURE when THAT has two or more
 * words, else ''. A surname is never made up.
 */
export function senderFullName(): string {
  const fromName = fromDisplayName();
  if (fromName.split(/\s+/).filter(Boolean).length >= 2) return fromName;
  const sigName = signatureFirstLine();
  if (sigName.split(/\s+/).filter(Boolean).length >= 2) return sigName;
  return '';
}

/** The bare From address (lib/mailFrom.getFromAddress, so always on the verified domain). */
export function senderFromAddress(): string {
  return bareAddress(getFromAddress());
}
