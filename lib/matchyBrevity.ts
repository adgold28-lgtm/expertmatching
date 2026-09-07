// lib/matchyBrevity.ts — the length limit on everything a model writes to an
// expert.
//
// THE PROBLEM THIS SOLVES, in the founder's words: "We need to put a limit on
// the GPT outputs, because AI tends to overwrite; the emails need to stay at
// 1 to 2 sentences maximum."
//
// A model asked for one line returns three, adds a markdown bullet, invents a
// dollar figure, or drops in a link. Any of those reaching an expert is a
// product failure: the rate is settled by the platform and never restated
// casually, a link in a nudge looks like phishing, and an em dash is the single
// clearest tell that nobody wrote the sentence.
//
// So this is a GUARD, not a formatter. It trims to the first N sentences and
// then REFUSES anything still wrong, because the caller always has a
// deterministic template line to fall back on. A silently repaired sentence is
// a sentence nobody checked.
//
// WHAT FAILS, and why each one:
//   empty     nothing survived the trim
//   too_long  still over the character budget after trimming
//   money     '$', '€', '£', 'USD' or the word "dollars". The expert-side rate
//             and the client-side rate never share a message (docs/MATCHY_SPEC,
//             "Pricing rule"), and a model has no business quoting either.
//   link      'http://', 'https://', 'www.' — a cold follow-up carrying a URL
//             a human did not put there is indistinguishable from phishing.
//   em_dash   U+2014 anywhere, or an en dash / double hyphen used as one. House
//             rule: no em dashes in outbound email text.
//   markdown  '**', a heading '#', a backtick, or a '- ' list prefix. Outbound
//             mail is plain text; markdown arrives as literal punctuation.
//
// Pure: no I/O, no env, never throws. Unit-tested by scripts/test-brevity.ts.
// Imported by lib/nudges.ts, and by the Phase 2 scheduling reply lines.

// ─── Shapes ───────────────────────────────────────────────────────────────────

export interface BrevityOptions {
  /** Sentences kept. Default 2. */
  maxSentences?: number;
  /** Hard character ceiling on the kept text. Default 200. */
  maxChars?: number;
}

export type BrevityFailure =
  | 'empty'
  | 'too_long'
  | 'money'
  | 'link'
  | 'em_dash'
  | 'markdown';

/**
 * On success, `text` is what to send. On failure, `text` is the trimmed
 * candidate — useful for a test or a diagnostic, NEVER for sending.
 */
export type BrevityResult =
  | { ok: true;  text: string }
  | { ok: false; reason: BrevityFailure; text: string };

export const DEFAULT_MAX_SENTENCES = 2;
export const DEFAULT_MAX_CHARS     = 200;

// ─── Sentence splitting ───────────────────────────────────────────────────────

/**
 * Abbreviations whose full stop does NOT end a sentence. Lower-cased, matched
 * case-insensitively and anchored on a word boundary. Deliberately short: this
 * guards our own one-liners and a model's rephrasing of them, and every entry
 * added is a place a real sentence break could be missed ("No." as an answer is
 * why 'no.' is not on this list).
 */
const ABBREVIATIONS: readonly string[] = [
  'e.g.', 'i.e.', 'etc.', 'vs.', 'approx.',
  'a.m.', 'p.m.',
  'u.s.', 'u.k.',
  'dr.', 'mr.', 'mrs.', 'ms.', 'prof.', 'jr.', 'sr.',
  'inc.', 'ltd.', 'corp.',
  'ph.d.',
];

/** A control character that cannot occur in real copy, standing in for a dot. */
const DOT_SENTINEL = '\u0001';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Longest first, so 'ph.d.' is protected before a shorter entry could take a
 * bite out of it. Built once rather than per call.
 *
 * The leading \b is what keeps 'ms.' matching "Ms." and not the tail of
 * "items." — there is no word boundary inside a word.
 */
const ABBREVIATION_PATTERNS: readonly RegExp[] = [...ABBREVIATIONS]
  .sort((a, b) => b.length - a.length)
  .map(abbr => new RegExp(`\\b${escapeRegExp(abbr)}`, 'gi'));

/** Replaces the dots inside known abbreviations with the sentinel. */
function protectAbbreviations(text: string): string {
  let out = text;
  for (const pattern of ABBREVIATION_PATTERNS) {
    out = out.replace(pattern, match => match.split('.').join(DOT_SENTINEL));
  }
  return out;
}

function restoreAbbreviations(text: string): string {
  return text.split(DOT_SENTINEL).join('.');
}

const TERMINATORS = '.!?';

/**
 * Splits into sentences on '.', '!' or '?' followed by whitespace or the end of
 * the string. A run of terminators ("Really?!") counts once, a dot glued to the
 * next character ("3.5") is not an ending, and a trailing fragment with no
 * terminator is still a sentence.
 */
export function splitSentences(text: string): string[] {
  const source = protectAbbreviations(text);
  const out: string[] = [];
  let current = '';

  for (let i = 0; i < source.length; i++) {
    current += source[i];
    if (!TERMINATORS.includes(source[i])) continue;

    // Swallow a run: "Really?!" is one ending, not two.
    while (i + 1 < source.length && TERMINATORS.includes(source[i + 1])) {
      current += source[++i];
    }

    const next = source[i + 1];
    if (next !== undefined && !/\s/.test(next)) continue;

    const sentence = restoreAbbreviations(current).trim();
    if (sentence) out.push(sentence);
    current = '';
  }

  const tail = restoreAbbreviations(current).trim();
  if (tail) out.push(tail);
  return out;
}

/** How many sentences the text contains, after whitespace normalization. */
export function countSentences(text: string): number {
  return splitSentences(normalizeWhitespace(text)).length;
}

// ─── Checks ───────────────────────────────────────────────────────────────────

/** Collapses every run of whitespace (newlines included) to one space. */
function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

const MONEY_RE   = /[$€£]|\bUSD\b|\bdollars?\b/i;
const LINK_RE    = /https?:\/\/|\bwww\./i;
/** U+2014 anywhere; an en dash or double hyphen used as sentence punctuation. */
const EM_DASH_RE = /—|\s–\s|\s--\s/;
/** Bold markers, inline code, a heading, or a bullet at the start of a line. */
const MARKDOWN_RE = /\*\*|`|^\s{0,3}#{1,6}\s|^\s{0,3}[-*+]\s/m;

/**
 * Trim to the first `maxSentences` sentences, then accept or refuse.
 *
 * The markdown check runs against the ORIGINAL text as well as the trimmed
 * result: whitespace normalization flattens a bullet list onto one line, and a
 * model that produced markdown anywhere produced markdown.
 */
export function enforceBrevity(text: string, opts: BrevityOptions = {}): BrevityResult {
  const maxSentences = Math.max(1, Math.trunc(opts.maxSentences ?? DEFAULT_MAX_SENTENCES));
  const maxChars     = Math.max(1, Math.trunc(opts.maxChars     ?? DEFAULT_MAX_CHARS));

  const raw = typeof text === 'string' ? text : '';
  if (MARKDOWN_RE.test(raw)) {
    return { ok: false, reason: 'markdown', text: normalizeWhitespace(raw) };
  }

  const normalized = normalizeWhitespace(raw);
  if (!normalized) return { ok: false, reason: 'empty', text: '' };

  const kept = splitSentences(normalized).slice(0, maxSentences).join(' ').trim();
  if (!kept) return { ok: false, reason: 'empty', text: '' };

  if (kept.length > maxChars) return { ok: false, reason: 'too_long', text: kept };
  if (MONEY_RE.test(kept))    return { ok: false, reason: 'money',    text: kept };
  if (LINK_RE.test(kept))     return { ok: false, reason: 'link',     text: kept };
  if (EM_DASH_RE.test(kept))  return { ok: false, reason: 'em_dash',  text: kept };
  if (MARKDOWN_RE.test(kept)) return { ok: false, reason: 'markdown', text: kept };

  return { ok: true, text: kept };
}
