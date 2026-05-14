// ─── Shared name validation utilities ────────────────────────────────────────
// Used by the generate-experts API route, ContactSection, and any component that
// guards email lookup or expert display on identity completeness.
// Operates solely on display-name strings — never receives brief content, raw
// LLM output, API keys, or other sensitive fields.

/** Common honorific prefixes to strip before token analysis. */
export const HONORIFIC_RE = /^(dr|prof|mr|mrs|ms|mx|sir|rev|gen|col|lt|sgt)\.\s*/i;

/** Org-name keywords — if the name itself contains these, it's likely not a person. */
export const ORG_KEYWORD_RE =
  /\b(inc\.|llc|corp\.?|ltd\.?|foundation|department|dept|bureau|agency|committee|association|society|consortium|coalition|authority|division|program|programme|network|laboratory|institute|center|centre)\b/i;

/**
 * Returns true if the token is an initial: a single letter (optionally with
 * a trailing period), or an all-uppercase abbreviation with no vowels ≤3 chars.
 * e.g. "J." → true, "CA" → true. "John" → false.
 */
export function isInitialToken(token: string): boolean {
  const t = token.replace(/\.$/, '');
  if (t.length === 1) return true;
  // All-uppercase, no vowels, ≤3 chars (e.g. "CA", "JB")
  if (t.length <= 3 && /^[A-Z]+$/.test(t) && !/[AEIOU]/.test(t)) return true;
  return false;
}

/**
 * Returns true if the name uses initials in the first-name or last-name position.
 * "John A. Smith" → false (middle initial is acceptable).
 * "J. Subbiah" / "C. A. Owens" / "Aaron B." → true.
 */
export function hasInitialStyleName(name: string): boolean {
  const stripped = name.trim().replace(HONORIFIC_RE, '').trim();
  const tokens   = stripped.split(/\s+/);
  if (tokens.length < 2) return true;

  const first = tokens[0];
  const last  = tokens[tokens.length - 1];
  if (isInitialToken(first) || isInitialToken(last)) return true;

  // Two consecutive leading initials ("C. A. Owens")
  if (tokens.length >= 3 && isInitialToken(tokens[0]) && isInitialToken(tokens[1])) return true;

  return false;
}

/**
 * Returns true if the name is a plausible full human name: both first and last
 * tokens are real words (not initials, ≥ 2 chars), it is not an org-keyword
 * name, and it is not a placeholder like "Unknown".
 *
 * Accepts:  "Michael Crump", "Chun-Chieh Yang", "John A. Smith"
 * Rejects:  "J. Subbiah", "C. A. Owens", "Aaron B.", "Unknown", "Dr. Smith"
 */
export function isFullHumanName(name: string): boolean {
  if (!name || typeof name !== 'string') return false;
  const stripped = name.trim().replace(HONORIFIC_RE, '').trim();
  if (stripped.length < 4) return false;

  const tokens = stripped.split(/\s+/);
  if (tokens.length < 2) return false;
  if (ORG_KEYWORD_RE.test(stripped)) return false;
  if (/^(unknown|anonymous|tbd|n\/a|not available)$/i.test(stripped)) return false;
  if (hasInitialStyleName(stripped)) return false;

  const first = tokens[0].replace(/\.$/, '');
  const last  = tokens[tokens.length - 1].replace(/\.$/, '');
  return first.length >= 2 && last.length >= 2;
}
