// Email cleaning — turning a raw inbound reply into the few lines the expert
// actually wrote.
//
// This is the messy engineering the spec names as a risk (docs/MATCHY_SPEC.md,
// "Risks"): a reply email carries the whole prior thread, a signature block, a
// mobile footer and, because our own intro is quoted back, the CAN-SPAM footer
// and opt-out link we sent. None of that is the message. The classifier reads
// what comes out of here, the client reads what comes out of here, and the
// compliance screen runs on what comes out of here — so a phone number sitting
// in a quoted signature must not read as the expert handing over their number.
//
// THREE PASSES, in order:
//
//   1. QUOTED HISTORY — everything from the first quote marker to the end.
//      Gmail's "On <date> <person> wrote:", Outlook's
//      "-----Original Message-----" and its bare "From: / Sent: / To: /
//      Subject:" header block, Apple Mail's "> " prefixes, and the horizontal
//      rule Outlook Web draws before a quoted header.
//
//   2. SIGNATURE — everything from the first signature marker to the end.
//      The RFC 3676 "-- " delimiter, "Sent from my iPhone", "Get Outlook for
//      iOS", and a bare sign-off ("Best,", "Thanks,") followed by a short name
//      block at the very end of the message.
//
//   3. WHITESPACE — trailing spaces per line, collapsed blank runs, trimmed
//      ends.
//
// FAILS OPEN. If the passes leave nothing, the original trimmed text is
// returned: a message we cannot parse is better shown whole than shown blank.
//
// Pure — no I/O, no env, no logging, never sees a network. Unit-checked by
// scripts/test-email-clean.ts against real-shaped Gmail, Outlook, iPhone and
// Apple Mail replies.

// ─── Quoted-history markers ───────────────────────────────────────────────────

/**
 * A line that is itself the start of quoted history. Matched against a single
 * trimmed line.
 */
const QUOTE_LINE_PATTERNS: RegExp[] = [
  // Apple Mail / Gmail plain-text quoting.
  /^>/,
  // Outlook desktop and most Windows clients.
  /^-{2,}\s*original message\s*-{2,}$/i,
  /^-{2,}\s*forwarded message\s*-{2,}$/i,
  // Outlook Web draws a rule, then the From:/Sent: block.
  /^_{10,}$/,
  /^-{10,}$/,
  // Gmail's one-line attribution, when it fits on one line.
  /^on\s+.{6,120}\s+wrote:$/i,
  // Some clients write "<name> wrote:" or "El ... escribió:".
  /^.{0,80}\bwrote:$/i,
  // Yahoo / older clients.
  /^-{2,}\s*on\s+.{6,120}\s+wrote\s*-{2,}$/i,
];

/**
 * Gmail's attribution wraps when the sender's name and address are long:
 *
 *   On Mon, Sep 1, 2026 at 3:04 PM ExpertMatch
 *   <reply+abc@expertmatch.fit> wrote:
 *
 * So a line opening with "On <something>" that does NOT close with "wrote:" is
 * only a quote marker if a following line (within three) closes it.
 */
const WRAPPED_ATTRIBUTION_OPEN = /^on\s+\w.{4,}$/i;
const WRAPPED_ATTRIBUTION_CLOSE = /wrote:\s*$/i;
const WRAPPED_ATTRIBUTION_LOOKAHEAD = 3;

/**
 * Outlook pastes a bare header block with no rule above it:
 *
 *   From: ExpertMatch <reply+abc@expertmatch.fit>
 *   Sent: Monday, September 1, 2026 3:04 PM
 *   To: Scott Smithers
 *   Subject: Paid expert call
 *
 * A lone "From:" line is not enough — people write "From: my side, yes" — so a
 * second header field must follow within the next few lines.
 */
const HEADER_FROM = /^from:\s*\S/i;
const HEADER_FOLLOWERS = /^(sent|date|to|cc|bcc|subject|reply-to):\s*/i;
const HEADER_LOOKAHEAD = 4;

// ─── Signature markers ────────────────────────────────────────────────────────

/** The RFC 3676 signature delimiter: two dashes, a space, end of line. */
const SIG_DELIMITER = /^--\s?$/;

/** Mobile and client footers, which are always the end of the message. */
const SIG_FOOTER_PATTERNS: RegExp[] = [
  /^sent from my\b/i,
  /^sent from\s+(a|an|the)?\s*\w+\s+(phone|device|mobile|mail)\b/i,
  /^get outlook for (ios|android)\b/i,
  /^sent via\b.{0,40}$/i,
  /^this email was sent from my (phone|mobile)\b/i,
];

/**
 * A line that is nothing but a sign-off. Deliberately anchored at both ends so
 * "Thanks, that works for me." — a sentence — is never mistaken for one.
 */
const SIGN_OFF = new RegExp(
  '^(' +
  [
    'best', 'best regards', 'all the best', 'many thanks', 'thanks', 'thanks again',
    'thank you', 'thank you so much', 'regards', 'kind regards', 'warm regards',
    'warmly', 'cheers', 'sincerely', 'yours sincerely', 'yours truly',
    'talk soon', 'speak soon', 'looking forward', 'appreciated', 'cordially',
  ].join('|') +
  ')[,.!]?$',
  'i',
);

/** Most lines a name block may run to before it stops looking like one. */
const MAX_SIGNATURE_BLOCK_LINES = 6;
/** Most words one line of a name block may carry. */
const MAX_SIGNATURE_LINE_WORDS = 7;

// ─── Passes ───────────────────────────────────────────────────────────────────

function normalize(raw: string): string[] {
  return raw
    .replace(/\r\n?/g, '\n')
    // Non-breaking spaces come through Outlook and defeat every trim below.
    .replace(/ /g, ' ')
    // Zero-width characters clients insert around quoted blocks.
    .replace(/[​‌‍﻿]/g, '')
    .split('\n');
}

/** Index of the first line that begins quoted history, or -1. */
export function findQuoteStart(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    for (const pattern of QUOTE_LINE_PATTERNS) {
      if (pattern.test(line)) return i;
    }

    // Wrapped Gmail attribution.
    if (WRAPPED_ATTRIBUTION_OPEN.test(line)) {
      for (let j = i + 1; j <= Math.min(i + WRAPPED_ATTRIBUTION_LOOKAHEAD, lines.length - 1); j++) {
        if (WRAPPED_ATTRIBUTION_CLOSE.test(lines[j])) return i;
      }
    }

    // Outlook's bare header block.
    if (HEADER_FROM.test(line)) {
      for (let j = i + 1; j <= Math.min(i + HEADER_LOOKAHEAD, lines.length - 1); j++) {
        if (HEADER_FOLLOWERS.test(lines[j].trim())) return i;
      }
    }
  }
  return -1;
}

/** Drops everything from the first quote marker onward. */
export function stripQuotedHistory(lines: string[]): string[] {
  const at = findQuoteStart(lines);
  return at === -1 ? lines : lines.slice(0, at);
}

/**
 * True when `lines` (already trimmed of blanks at both ends) look like a name
 * block rather than more message: few lines, each short, none of them a
 * sentence.
 */
function looksLikeNameBlock(lines: string[]): boolean {
  const meaningful = lines.filter(l => l.trim().length > 0);
  if (meaningful.length === 0) return true;
  if (meaningful.length > MAX_SIGNATURE_BLOCK_LINES) return false;

  return meaningful.every(line => {
    const text = line.trim();
    if (text.split(/\s+/).length > MAX_SIGNATURE_LINE_WORDS) return false;
    // A question or a mid-line full stop means the sender is still talking.
    if (/[?]/.test(text)) return false;
    if (/\.\s+\S/.test(text)) return false;
    return true;
  });
}

/** Drops everything from the first signature marker onward. */
export function stripSignature(lines: string[]): string[] {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (SIG_DELIMITER.test(lines[i])) return lines.slice(0, i);
    if (SIG_FOOTER_PATTERNS.some(p => p.test(line))) return lines.slice(0, i);
  }

  // A bare sign-off is only a signature when what follows it is a name block
  // and nothing else — otherwise "Thanks" is just how the sentence ended and
  // the message carries on.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || !SIGN_OFF.test(line)) continue;
    if (looksLikeNameBlock(lines.slice(i + 1))) return lines.slice(0, i);
  }

  return lines;
}

/** Trims each line, collapses runs of blank lines, trims the ends. */
function tidyWhitespace(lines: string[]): string {
  const trimmed = lines.map(l => l.replace(/[ \t]+$/g, ''));
  const out: string[] = [];
  for (const line of trimmed) {
    if (line.trim() === '' && out.length > 0 && out[out.length - 1].trim() === '') continue;
    out.push(line);
  }
  return out.join('\n').trim();
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * The displayable body of an inbound reply: quoted history gone, signature
 * gone, whitespace tidy.
 *
 * Returns the original trimmed text when the passes would leave nothing —
 * a reply that is only a quote and a sign-off still has to be shown to
 * somebody.
 */
export function cleanEmailBody(raw: string): string {
  if (typeof raw !== 'string' || !raw.trim()) return '';

  const lines = normalize(raw);
  const cleaned = tidyWhitespace(stripSignature(stripQuotedHistory(lines)));

  if (cleaned) return cleaned;

  // Nothing survived. Try again with the signature pass only — a one-line
  // reply above a quote sometimes trips the sign-off rule.
  const quotedOnly = tidyWhitespace(stripQuotedHistory(lines));
  if (quotedOnly) return quotedOnly;

  return tidyWhitespace(lines);
}
