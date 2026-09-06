// Matchy's compliance screen — job #1 in docs/MATCHY_SPEC.md.
//
// Every message that crosses the wall, in either direction, runs through here
// before it is sent. It looks for the four ways an engagement leaks off the
// platform:
//
//   1. a direct contact detail — phone number, email address, any URL, and
//      specifically LinkedIn / Calendly / Zoom / Teams / Meet links
//   2. the client's firm name, before the reveal
//   3. a real full name across the wall before the reveal — the expert's in a
//      client message, the client's in an expert message
//   4. the phrasings people use to arrange it — "let's connect directly",
//      "my direct line", "off platform", "reach me at", "here's my cell"
//
// SHAPE OF THE CONTRACT
//   - `screenMessage` NEVER mutates the text. It reports; the sender fixes.
//     Over-blocking is the known risk, so the findings say exactly what was
//     matched and what to do instead (spec, "Risks").
//   - `blocked` is true when any finding is present. Regex is the first pass
//     and an LLM pass may be added later, but per the spec the LLM never
//     overrides a regex block.
//   - Pure: no I/O, no env, no logging. Unit-checked by
//     scripts/test-matchy-screen.ts.
//
// FALSE POSITIVES ARE THE HARD PART. Money ("$650/hr"), quarters ("Q3 2026"),
// years, times ("Tuesday 2pm", "2:00pm ET"), percentages and ordinary counts
// all look like phone numbers to a naive digit rule. The phone matcher below
// requires a shape a phone number actually has and then rejects anything that
// is really one of those.

export type ScreenFindingKind =
  | 'phone'
  | 'email'
  | 'url'
  | 'scheduling_link'
  | 'client_firm_name'
  | 'expert_real_name'
  | 'client_real_name'
  | 'off_platform_phrase';

export interface ScreenFinding {
  kind: ScreenFindingKind;
  /** The exact substring that matched, so the sender can find and fix it. */
  match: string;
  /** One plain line telling the sender what to do. No machinery talk. */
  hint: string;
}

export interface ScreenResult {
  blocked: boolean;
  findings: ScreenFinding[];
}

export interface ScreenInput {
  /** The message body. Never modified. */
  text: string;
  /** Who wrote it — decides which real name is the one that must not appear. */
  direction: 'client_to_expert' | 'expert_to_client';
  /**
   * True once identities are revealed (status 'scheduled' or later, see
   * lib/redactExpert.isIdentityRevealed). After the reveal, names may cross;
   * contact details still may not.
   */
  identityRevealed?: boolean;
  /** The client's firm name — never allowed to reach an expert. */
  clientFirmName?: string;
  /** The expert's real full name. */
  expertFullName?: string;
  /** The client contact's real full name. */
  clientFullName?: string;
}

// ─── Hints ────────────────────────────────────────────────────────────────────

const HINTS: Record<ScreenFindingKind, string> = {
  phone:               'Remove the phone number. Calls are booked through ExpertMatch and the dial-in comes with the invite.',
  email:               'Remove the email address. Replies come back to this thread on their own.',
  url:                 'Remove the link. Anything the other side needs can go in the message itself.',
  scheduling_link:     'Remove the scheduling or meeting link. Propose times in the thread and the invite follows.',
  client_firm_name:    'Remove the firm name. The expert learns who they are speaking with once the call is booked.',
  expert_real_name:    'Remove the name. Identities are exchanged when the call is booked.',
  client_real_name:    'Remove the name. Identities are exchanged when the call is booked.',
  off_platform_phrase: 'Take out the offer to move the conversation elsewhere. Keep it in this thread.',
};

// ─── Patterns ─────────────────────────────────────────────────────────────────

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/** http(s):// links, bare www., and bare host.tld/path forms. */
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"')]+|\b[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:com|net|org|io|co|ai|app|dev|me|us|uk|ly|gg|xyz|info|biz)\b(?:\/[^\s<>"')]*)?/gi;

/** Hosts that are always a way to meet or connect outside the thread. */
const SCHEDULING_HOSTS = [
  'linkedin.com', 'lnkd.in',
  'calendly.com', 'cal.com', 'savvycal.com', 'hubspot.com/meetings', 'youcanbook.me',
  'zoom.us', 'meet.google.com', 'teams.microsoft.com', 'teams.live.com', 'whereby.com',
  'wa.me', 'signal.me', 't.me', 'telegram.me',
];

/**
 * Phone shapes we actually block:
 *   +1 415 555 0132 / +44 20 7946 0018   (international, with +)
 *   (415) 555-0132                       (parenthesised area code)
 *   415-555-0132 / 415.555.0132          (separated, 3-3-4)
 *   4155550132                           (10 bare digits)
 * Deliberately NOT matched: any run of digits shorter than 10 without a +,
 * which is where "$650", "Q3", "2026" and "2pm" live.
 */
const PHONE_PATTERNS: RegExp[] = [
  /\+\d[\d\s().-]{7,17}\d/g,                                   // international, leading +
  /\(\d{3}\)\s*\d{3}[\s.-]?\d{4}\b/g,                          // (415) 555-0132
  /\b\d{3}[\s.-]\d{3}[\s.-]\d{4}\b/g,                          // 415-555-0132
  /\b\d{10}\b/g,                                               // 4155550132
];

/** Written-out digits used to smuggle a number past a digit matcher. */
const SPELLED_PHONE_RE =
  /\b(?:(?:zero|one|two|three|four|five|six|seven|eight|nine|oh)[\s.-]+){6,}(?:zero|one|two|three|four|five|six|seven|eight|nine|oh)\b/gi;

/**
 * The phrasings that mean "let's take this off the platform". Kept as explicit
 * phrases rather than a keyword soup so an ordinary "I'm direct about this"
 * or "give me a call once we're booked" does not trip it.
 */
const OFF_PLATFORM_PATTERNS: RegExp[] = [
  /\blet'?s\s+(just\s+)?(connect|talk|speak|chat|deal|work)\s+(directly|offline|off[\s-]?platform|one[\s-]on[\s-]one)\b/gi,
  /\b(my|the)\s+direct\s+(line|number|dial|email|address)\b/gi,
  /\boff[\s-]?platform\b/gi,
  /\b(reach|contact|email|call|text|ping)\s+me\s+(directly|at|on)\b/gi,
  /\bhere'?s\s+my\s+(cell|mobile|number|phone|email|linkedin|calendar)\b/gi,
  /\b(you\s+can\s+)?(find|add)\s+me\s+on\s+(linkedin|whatsapp|signal|telegram)\b/gi,
  /\b(skip|bypass|go\s+around|cut\s+out)\s+(the\s+)?(platform|middle\s?man|intermediary|expertmatch)\b/gi,
  /\bwork\s+together\s+directly\b/gi,
  /\bwithout\s+(the\s+)?(platform|intermediary|middle\s?man)\b/gi,
  /\bmy\s+personal\s+(email|number|cell|phone)\b/gi,
];

// ─── False-positive guards for the phone matcher ──────────────────────────────

/** True when this match is money, a year, a quarter, a percentage or a time. */
function isNotAPhoneNumber(match: string, text: string, index: number): boolean {
  const digits = match.replace(/\D/g, '');

  // A + means the sender wrote an international number on purpose.
  if (match.trim().startsWith('+')) return digits.length < 8;

  // A real NANP-style number is 10 digits (or 11 starting with 1).
  if (digits.length === 10) {
    // Reject 10 bare digits that are actually two glued numbers with a
    // currency or percent marker touching them.
    const before = text.slice(Math.max(0, index - 1), index);
    const after  = text.slice(index + match.length, index + match.length + 1);
    if (before === '$' || after === '%') return true;
    return false;
  }
  if (digits.length === 11 && digits.startsWith('1')) return false;

  return true;
}

// ─── Name matching ────────────────────────────────────────────────────────────

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Matches a person's full name and its ordinary variants: "Scott Smithers",
 * "Smithers, Scott", and the surname on its own (which is the identifying
 * half). The bare first name is NOT matched — "Scott" alone is not an
 * identity, and the platform already shows the client "Scott S.".
 */
function findNameMatches(text: string, fullName: string): string[] {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return [];

  const patterns: RegExp[] = [];
  const first = parts[0];
  const last  = parts[parts.length - 1];

  if (parts.length >= 2) {
    patterns.push(new RegExp(`\\b${escapeRegExp(first)}\\s+${escapeRegExp(last)}\\b`, 'gi'));
    patterns.push(new RegExp(`\\b${escapeRegExp(last)}\\s*,\\s*${escapeRegExp(first)}\\b`, 'gi'));
  }
  // A surname of 3+ letters is identifying on its own.
  if (last.length >= 3) patterns.push(new RegExp(`\\b${escapeRegExp(last)}\\b`, 'gi'));
  if (parts.length === 1 && first.length >= 3) {
    patterns.push(new RegExp(`\\b${escapeRegExp(first)}\\b`, 'gi'));
  }

  const out: string[] = [];
  for (const re of patterns) {
    for (const m of Array.from(text.matchAll(re))) out.push(m[0]);
  }
  return out;
}

/**
 * Matches a firm name, and also its distinctive first word when the name has a
 * generic tail ("Sequoia Vet Holdings" → also "Sequoia"), because the shorthand
 * identifies the firm just as well.
 */
function findFirmMatches(text: string, firmName: string): string[] {
  const name = firmName.trim();
  if (name.length < 3) return [];

  const GENERIC_TAIL = /\b(capital|partners|holdings|group|advisors|management|ventures|associates|llc|inc|lp|llp|company|co)\b/i;

  const patterns = [new RegExp(`\\b${escapeRegExp(name)}\\b`, 'gi')];

  const words = name.split(/\s+/).filter(Boolean);
  if (words.length >= 2 && GENERIC_TAIL.test(words[words.length - 1]) && words[0].length >= 4) {
    patterns.push(new RegExp(`\\b${escapeRegExp(words[0])}\\b`, 'gi'));
  }

  const out: string[] = [];
  for (const re of patterns) {
    for (const m of Array.from(text.matchAll(re))) out.push(m[0]);
  }
  return out;
}

// ─── Screen ───────────────────────────────────────────────────────────────────

function push(
  findings: ScreenFinding[],
  seen: Set<string>,
  kind: ScreenFindingKind,
  match: string,
): void {
  const trimmed = match.trim();
  if (!trimmed) return;
  const key = `${kind}:${trimmed.toLowerCase()}`;
  if (seen.has(key)) return;
  seen.add(key);
  findings.push({ kind, match: trimmed, hint: HINTS[kind] });
}

/**
 * Screen one message. Returns every problem found — the sender fixes them all
 * at once rather than being told about them one at a time. `text` comes back
 * untouched; this function never rewrites a message.
 */
export function screenMessage(input: ScreenInput): ScreenResult {
  const text = input.text ?? '';
  const findings: ScreenFinding[] = [];
  const seen = new Set<string>();

  if (!text.trim()) return { blocked: false, findings: [] };

  // ── Email addresses ──────────────────────────────────────────────────────
  for (const m of Array.from(text.matchAll(EMAIL_RE))) push(findings, seen, 'email', m[0]);

  // ── Links, with scheduling / social links called out separately ──────────
  for (const m of Array.from(text.matchAll(URL_RE))) {
    const url = m[0];
    // An email address already reported would otherwise re-match as a host.
    if (findings.some(f => f.kind === 'email' && f.match.includes(url))) continue;
    const lower = url.toLowerCase();
    const isScheduling = SCHEDULING_HOSTS.some(host => lower.includes(host));
    push(findings, seen, isScheduling ? 'scheduling_link' : 'url', url);
  }

  // ── Phone numbers ────────────────────────────────────────────────────────
  for (const pattern of PHONE_PATTERNS) {
    for (const m of Array.from(text.matchAll(pattern))) {
      const at = m.index ?? 0;
      if (isNotAPhoneNumber(m[0], text, at)) continue;
      // Skip a hit that sits inside an already-reported email or URL.
      if (findings.some(f => (f.kind === 'email' || f.kind === 'url' || f.kind === 'scheduling_link')
                          && f.match.includes(m[0].trim()))) continue;
      push(findings, seen, 'phone', m[0]);
    }
  }
  for (const m of Array.from(text.matchAll(SPELLED_PHONE_RE))) push(findings, seen, 'phone', m[0]);

  // ── "Let's take this elsewhere" ──────────────────────────────────────────
  for (const pattern of OFF_PLATFORM_PATTERNS) {
    for (const m of Array.from(text.matchAll(pattern))) push(findings, seen, 'off_platform_phrase', m[0]);
  }

  // ── The client's firm name, in either direction ──────────────────────────
  // An expert who has worked out who the client is must not have it confirmed
  // back to them, so this is checked both ways until the reveal.
  if (!input.identityRevealed && input.clientFirmName) {
    for (const m of findFirmMatches(text, input.clientFirmName)) {
      push(findings, seen, 'client_firm_name', m);
    }
  }

  // ── Real names, pre-reveal only ──────────────────────────────────────────
  if (!input.identityRevealed) {
    if (input.direction === 'client_to_expert' && input.expertFullName) {
      for (const m of findNameMatches(text, input.expertFullName)) {
        push(findings, seen, 'expert_real_name', m);
      }
    }
    if (input.direction === 'expert_to_client' && input.clientFullName) {
      for (const m of findNameMatches(text, input.clientFullName)) {
        push(findings, seen, 'client_real_name', m);
      }
    }
  }

  return { blocked: findings.length > 0, findings };
}
