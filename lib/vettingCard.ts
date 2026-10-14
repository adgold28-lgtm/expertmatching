// The vetting card: what a client may know about an expert's background and
// their conflict answers BEFORE the call is booked.
//
// THE PROMISE (the launch offer): "the expert's tenure dates and employer type
// from public records, months since they left, and their answers to the
// conflict and NDA questions." Two rules shape it:
//   • identity stays hidden until the booking (lib/redactExpert.ts), and
//   • anonymized descriptors carry no numerals at all (PR #39): a figure is a
//     fingerprint.
// So every date becomes a BAND IN WORDS, and every field is a level, a type or
// a band. No year, no number, no company and no person's name, in any field.
//
// WHERE IT RUNS. lib/redactExpert.redactExpertForViewer calls deriveVetting on
// the RAW record and attaches the result as `vetting`, because the title and
// evidence it reads are stripped for clients before they leave the server.
// Staff already hold the raw record, so components/VettingCard.tsx derives the
// same card in the browser for them; that is why this module imports nothing
// server-side (no model SDK, no store), only lib/matchyScreen and
// lib/seniorityClassifier, both of which already run in the browser.
//
// DETERMINISTIC. Regexes over the sourced title and evidence claims: no model
// call, no network. When the record does not support a band, the band is null
// and the card says "Not in public records". Guessing is worse than silence.
//
// HOW DATES ARE READ
//   • Only the title and claims that are ABOUT A ROLE count (served, worked,
//     held, ran, led, joined, left, "as VP", "at <employer>"). "Grew revenue
//     between 2015 and 2018" is an achievement window, not a tenure. Sentences
//     about a prior role ("previously", "earlier in her career") and
//     publication, conference and credential claims are skipped.
//   • Tenure, in priority order: a range inside one sentence ("2015-2021",
//     "2018 to present", "March 2019 to June 2024", "between 2015 and 2021");
//     a stated duration ("for six years", "over a decade", "18 months"); a
//     start and an end found in different sentences.
//   • Former: "Former" / "ex-" / "retired" in the title or descriptor, a leave
//     verb ("left", "retired", "later joined"), or a past end date in a
//     sentence that is plainly about employment. Current ("still there") needs
//     a present marker ("to present", "since 2019", "currently") and no former
//     marker anywhere.
//   • A YEAR-ONLY end date is read as December of that year, so the card never
//     says someone left longer ago than they might have. For a compliance read,
//     overstating how recently someone left is the safe error.
//
// CONFLICTS: WHERE THE ANSWER LIVES TODAY
//   lib/matchyClassify reads every reply. app/api/inbound-email sends a
//   'conflict' intent to advanceConflict, which writes status
//   'conflict_flagged', replyIntent 'conflict' and `conflictNote` (screened and
//   masked by screenAndMask at classify time) and emits `conflict_flagged`.
//   The follow-up that asks the questions stamps `followupSentAt` (the retired
//   cadence's `email2SentAt` carried the same ask). `conflictRisk` is the staff
//   screening verdict. All of these already reach a client's payload
//   (lib/redactExpert, "NOT on the list above"); the card reads nothing else.
//   Matchy's per-reply summary lives on conversation_messages, which this pure
//   function never sees, so an answer with nothing in the way reads as a fixed
//   line and the thread carries the rest.
//
// Pure. Never throws. Unit-checked by scripts/test-vetting-card.ts, and the
// "no identifying data" guarantee again by scripts/check-redaction.ts.

import type {
  EvidenceItem,
  Expert,
  ExpertVetting,
  ProjectExpert,
  VettingConflict,
  VettingSinceLeftBand,
  VettingTenureBand,
} from '../types';
import { maskContactDetails, MASK_TOKEN } from './matchyScreen';
import { classifySeniority } from './seniorityClassifier';

// ─── Words the card renders ───────────────────────────────────────────────────

/** What the card says for a field the record does not support. */
export const NOT_IN_PUBLIC_RECORDS = 'Not in public records';

/** The one line for the conflict and NDA questions. */
export function conflictLine(conflict: VettingConflict): string {
  switch (conflict.status) {
    case 'not_asked': return 'Not asked yet';
    case 'waiting':   return 'Asked, waiting on their answer';
    default:          return conflict.flagged ? 'Raised a possible conflict' : 'Answered, nothing flagged';
  }
}

/** "three to ten years" → "Three to ten years". */
export function sentenceCase(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

// ─── Bands ────────────────────────────────────────────────────────────────────

/**
 * Years in a role → a band. The edges: under one year; one up to (not
 * including) three; three through ten; more than ten. Exported for tests.
 */
export function tenureBand(years: number): VettingTenureBand | null {
  if (!Number.isFinite(years) || years < 0 || years > 70) return null;
  if (years < 1)   return 'under a year';
  if (years < 3)   return 'one to three years';
  if (years <= 10) return 'three to ten years';
  return 'over ten years';
}

/** Months since they left → a band. Exported for tests. */
export function sinceLeftBand(months: number): VettingSinceLeftBand | null {
  if (!Number.isFinite(months) || months < 0) return null;
  if (months < 12)  return 'left within the last year';
  if (months <= 36) return 'one to three years ago';
  return 'more than three years ago';
}

// ─── Role level ───────────────────────────────────────────────────────────────

/**
 * A level, never the title: "Former SVP, Southeast Distribution" becomes
 * "Senior vice president". First match wins, most senior first. "President" is
 * tested on the title with every "vice president" taken out.
 */
const ROLE_LEVELS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(chief\s+[a-z]+(?:\s+[a-z]+)?\s+officer|ceo|cfo|coo|cto|cmo|cio|ciso|chro|cco|cro|cpo|cdo)\b/i, 'C-suite executive'],
  [/\b(co-?founder|founder|founding partner)\b/i, 'Founder'],
  [/\b(chair(?:man|woman|person)?|board member|board director|non-executive director|independent director)\b/i, 'Board member'],
  [/\bpresident\b/i, 'President'],
  [/\bmanaging director\b/i, 'Managing director'],
  [/\b(general partner|managing partner|senior partner|partner)\b/i, 'Partner'],
  [/\bprincipal\b/i, 'Principal'],
  [/\b(svp|evp|senior vice president|executive vice president)\b/i, 'Senior vice president'],
  [/\b(vp|avp|vice president)\b/i, 'Vice president'],
  [/\b(head of|global head|senior director|director)\b/i, 'Director'],
  [/\bgeneral manager\b/i, 'General manager'],
  [/\b(senior manager|manager|team lead)\b/i, 'Manager'],
  [/\b(professor|lecturer|researcher|research fellow|scientist|economist)\b/i, 'Academic or researcher'],
  [/\b(consultant|advisor|adviser)\b/i, 'Advisor'],
  [/\b(engineer|analyst|specialist)\b/i, 'Specialist'],
];

const TIER_ROLE_LEVEL = { executive: 'Executive', senior: 'Senior leader', mid: 'Mid-level' } as const;

function roleLevelOf(expert: Pick<Expert, 'title' | 'seniorityTier'>): string | null {
  const title = (expert.title ?? '').trim();
  if (title) {
    const withoutVice = title.replace(/\b(?:senior\s+|executive\s+|assistant\s+)?vice[\s-]+president\b/gi, ' vp ');
    for (const [pattern, level] of ROLE_LEVELS) {
      const subject = level === 'President' ? withoutVice : title;
      if (pattern.test(subject)) return level;
    }
  }
  const tier = expert.seniorityTier ?? (title ? classifySeniority(title) : null);
  return tier ? TIER_ROLE_LEVEL[tier] : null;
}

// ─── Identity guards on free text ─────────────────────────────────────────────
//
// Two card fields can carry words the card did not choose itself: the employer
// type lifted from the anonymized descriptor, and Matchy's masked read of a
// conflict. Both pass this check or are dropped. It mirrors
// lib/anonymizeExpert.descriptorIsAnonymous (which this module cannot import:
// that file loads the model SDK) and is STRICTER: no digit at all, no `$`, no
// mask token, and no proper noun the card cannot account for, because the card
// promises no company name at all, not just not the expert's own.

/** Company words that identify nobody. Mirrors lib/anonymizeExpert.ts. */
const GENERIC_COMPANY_WORDS = new Set([
  'group', 'holdings', 'partners', 'capital', 'ventures', 'associates', 'advisors',
  'management', 'company', 'corporation', 'incorporated', 'limited', 'international',
  'global', 'national', 'regional', 'services', 'solutions', 'systems', 'technologies',
  'industries', 'enterprises', 'consulting', 'labs',
]);

/** Capitalized tokens that are vocabulary, not names. */
const ALLOWED_CAPITALIZED = new Set([
  'NDA', 'NDAs', 'PE', 'VC', 'US', 'USA', 'UK', 'EU', 'CEO', 'CFO', 'COO', 'CTO', 'CMO', 'VP',
  'SVP', 'EVP', 'ET', 'PT', 'CT', 'MT', 'HR', 'IT', 'IP', 'OEM', 'CPG', 'QSR', 'DTC', 'MSO',
  'DSO', 'ASC', 'CRO', 'CDMO', 'HVAC', 'SaaS', 'M&A', 'F&B', 'LTL', 'I',
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
]);

/**
 * Words that may open a sentence of a conflict note with a capital letter. A
 * capitalized word that opens a sentence and is NOT one of these could be a
 * company ("Zoetis has me under an NDA"), so the note is dropped rather than
 * shown. The list is the shape the classifier's notes take in practice.
 */
const SENTENCE_STARTERS = new Set([
  'a', 'an', 'the', 'under', 'currently', 'current', 'bound', 'has', 'have', 'had', 'is', 'was',
  'are', 'were', 'possible', 'potential', 'no', 'not', 'none', 'cannot', "can't", 'can', 'works',
  'working', 'worked', 'consults', 'consulting', 'restricted', 'restriction', 'restrictions',
  'employer', 'their', 'they', 'he', 'she', 'his', 'her', 'signed', 'holds', 'subject', 'covered',
  'must', 'needs', 'need', 'will', 'would', 'might', 'may', 'nda', 'ndas', 'non-compete',
  'noncompete', 'former', 'previous', 'still', 'already', 'also', 'active', 'ongoing', 'advises',
  'advising', 'serves', 'serving', 'sits', 'only', 'open', 'nothing', 'any', 'some', 'standard',
  'general', 'limited', 'mentions', 'mentioned', 'says', 'said', 'requires', 'required', 'wants',
  'asks', 'asked', 'one', 'two', 'both', 'existing', 'competitor', 'competing', 'confidentiality',
  'conflict', 'conflicts', 'engaged', 'engagement', 'retained', 'on', 'with', 'at', 'in', 'for',
  'unable', 'happy', 'fine', 'avoid', 'avoids', 'prefers', 'prefer',
]);

function containsWord(text: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- input is escaped
  return new RegExp(`\\b${escaped}\\b`, 'i').test(text);
}

function wordsOf(value: string | undefined | null): string[] {
  return (value ?? '').toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean);
}

type IdentityFields = Partial<Pick<Expert, 'name' | 'company' | 'category' | 'valueChainLabel'>>;

/** True when no name part and no distinctive employer word appears in the text. */
function namesNobody(text: string, expert: IdentityFields): boolean {
  const parts = (expert.name ?? '').replace(/[.,]/g, ' ').trim().split(/\s+/).filter(p => p.length >= 3);
  const surname = parts.length >= 2 ? parts[parts.length - 1] : parts[0];
  for (const part of parts) {
    // The surname (or a one-word name) anywhere, in any case; any other part
    // only as written, so "Will" the person does not sink "will need to".
    const escaped = part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- input is escaped
    const asWritten = new RegExp(`\\b${escaped}\\b`);
    if (part === surname ? containsWord(text, part) : asWritten.test(text)) return false;
  }

  const company = (expert.company ?? '').trim();
  if (company && containsWord(text, company)) return false;
  const vocabulary = new Set([...wordsOf(expert.category), ...wordsOf(expert.valueChainLabel)]);
  for (const word of wordsOf(company)) {
    if (word.length <= 3 || GENERIC_COMPANY_WORDS.has(word) || vocabulary.has(word)) continue;
    if (containsWord(text, word)) return false;
  }
  return true;
}

/** The common floor for any free text on the card. */
function carriesNothing(text: string): boolean {
  if (!text.trim()) return false;
  if (/\d/.test(text)) return false;                  // no year, no figure, no count
  if (text.includes(MASK_TOKEN)) return false;        // a hole where an identity was
  if (/[$@]/.test(text)) return false;
  return maskContactDetails(text) === text;           // no address, link or phone
}

/** A capitalized word the card cannot account for, outside a sentence opener. */
function hasUnknownCapital(text: string, opener: (word: string) => boolean): boolean {
  let sentenceStart = true;
  for (const raw of text.split(/\s+/)) {
    const token = raw.replace(/^[("'[]+/, '').replace(/[)"'\],.;:!?]+$/, '').replace(/'s$/i, '');
    if (token) {
      const parts = token.split(/[-/]/).filter(Boolean);
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (ALLOWED_CAPITALIZED.has(part) || !/^[A-Z]/.test(part)) continue;
        if (sentenceStart && i === 0 && /^[A-Z][a-z'-]*$/.test(part) && opener(part.toLowerCase())) continue;
        return true;
      }
    }
    sentenceStart = /[.!?]["')]*$/.test(raw);
  }
  return false;
}

/**
 * Matchy's read of the conflict, if the card may show it. Already masked when
 * it was written (lib/matchyClassify screenAndMask); this is the card's own,
 * stricter gate on top. A note that fails is dropped, never repaired.
 */
function safeConflictNote(note: string | undefined | null, expert: IdentityFields): string | null {
  const text = (note ?? '').replace(/\s+/g, ' ').trim();
  if (!text || text.length > 200) return null;
  if (!carriesNothing(text) || !namesNobody(text, expert)) return null;
  if (hasUnknownCapital(text, word => SENTENCE_STARTERS.has(word))) return null;
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

// ─── Employer type ────────────────────────────────────────────────────────────

/** Nouns that name a KIND of organization. Plurals are folded before lookup. */
const ORG_NOUNS = new Set([
  'group', 'chain', 'company', 'firm', 'fund', 'agency', 'retailer', 'manufacturer', 'distributor',
  'wholesaler', 'supplier', 'provider', 'operator', 'network', 'hospital', 'clinic', 'practice',
  'bank', 'insurer', 'lender', 'brand', 'startup', 'start-up', 'consultancy', 'university',
  'college', 'laboratory', 'lab', 'institute', 'association', 'regulator', 'department',
  'ministry', 'utility', 'carrier', 'producer', 'processor', 'developer', 'marketplace',
  'franchise', 'franchisor', 'cooperative', 'co-op', 'nonprofit', 'non-profit', 'foundation',
  'publisher', 'studio', 'business', 'enterprise', 'conglomerate', 'multinational',
  'partnership', 'organization', 'organisation', 'authority', 'council', 'exchange', 'grocer',
  'pharmacy', 'airline', 'broker', 'brokerage', 'dealership', 'integrator', 'maker', 'vendor',
]);

/** Two-word kinds whose second word is not a kind on its own. */
const ORG_PAIRS = new Set(['health system', 'hospital system', 'school system', 'family office']);

/** A kind that reads fine with no modifier at all ("Hospital"). */
const SPECIFIC_NOUNS = new Set([
  'hospital', 'bank', 'insurer', 'university', 'college', 'regulator', 'agency', 'ministry',
  'utility', 'airline', 'pharmacy', 'nonprofit', 'non-profit', 'consultancy', 'startup',
  'start-up', 'conglomerate', 'multinational', 'cooperative', 'foundation', 'brokerage',
  'dealership', 'grocer', 'health system', 'hospital system', 'family office',
]);

/** Words a modifier run walks back over and stops at. */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'at', 'of', 'for', 'with', 'in', 'as', 'and', 'or', 'to', 'by', 'from', 'on',
  'into', 'its', 'their', 'his', 'her', 'across', 'within', 'inside', 'who', 'that', 'which',
  'where', 'while', 'now', 'then', 'also', 'both', 'owns', 'owned', 'own', 'runs', 'ran', 'run',
  'running', 'leads', 'led', 'leading', 'built', 'building', 'builds', 'scaled', 'scaling',
  'oversees', 'oversaw', 'overseeing', 'managed', 'manages', 'managing', 'founded', 'co-founded',
  'heads', 'headed', 'heading', 'grew', 'grows', 'sold', 'exited', 'joined', 'left', 'former',
  'formerly', 'current', 'currently', 'previously', 'is', 'was', 'has', 'had', 'been', 'are',
  'were', 'served', 'serves', 'serving', 'worked', 'works', 'advises', 'advised', 'spent', 'more',
  'than', 'over', 'under', 'nearly', 'about', '&', 'president', 'ceo', 'cfo', 'coo', 'cto', 'cmo',
  'cio', 'chief', 'officer', 'vp', 'svp', 'evp', 'vice', 'director', 'head', 'manager', 'partner',
  'principal', 'founder', 'chair', 'chairman', 'owner', 'executive', 'leader', 'consultant',
  'advisor', 'adviser', 'marketing', 'operations', 'sales', 'finance', 'strategy', 'engineering',
]);

/** Scale words that may open a descriptor with a capital ("Regional clinic group"). */
const OPENING_SCALE_WORDS = new Set([
  'regional', 'national', 'global', 'international', 'multinational', 'large', 'mid-size',
  'mid-sized', 'mid-market', 'small', 'boutique', 'leading', 'major', 'public', 'private',
  'independent', 'family-owned', 'multi-site', 'specialty', 'local', 'state', 'federal',
  'municipal', 'enterprise', 'venture-backed', 'publicly',
]);

function singular(word: string): string {
  if (ORG_NOUNS.has(word)) return word;
  if (word.endsWith('ies') && ORG_NOUNS.has(`${word.slice(0, -3)}y`)) return `${word.slice(0, -3)}y`;
  if (word.endsWith('es') && ORG_NOUNS.has(word.slice(0, -2))) return word.slice(0, -2);
  if (word.endsWith('s') && ORG_NOUNS.has(word.slice(0, -1))) return word.slice(0, -1);
  return word;
}

function bareWord(token: string): string {
  return token.replace(/^[("'[]+/, '').replace(/[)"'\]]+$/, '').replace(/'s$/i, '');
}

/**
 * The organization kind the anonymized descriptor already names: "Former
 * President & CEO, regional veterinary clinic group" → "Regional veterinary
 * clinic group". The descriptor is client-facing text, so a phrase lifted from
 * it adds nothing a client could not already read; the guards run anyway.
 */
function employerTypeFromDescriptor(descriptor: string, expert: IdentityFields): string | null {
  // "Fortune 500" is the one figure a descriptor may carry; the card carries none.
  const text = descriptor
    .replace(/\bfortune[\s-]*(?:50|100|500|1000)\b/gi, 'large')
    .replace(/\s[-\u2013\u2014]\s/g, ' | ');

  const clauseRe = /[^,;:.!?\u00b7\u2022|()\u2013\u2014]+/g;
  let clause: RegExpExecArray | null;
  while ((clause = clauseRe.exec(text)) !== null) {
    const startsDescriptor = text.slice(0, clause.index).trim() === '';
    const words = clause[0].trim().split(/\s+/).filter(Boolean);

    for (let i = 0; i < words.length; i++) {
      const word = bareWord(words[i]).toLowerCase();
      const pair = i > 0 ? `${bareWord(words[i - 1]).toLowerCase()} ${word}` : '';
      const isPair = pair !== '' && ORG_PAIRS.has(pair);
      const noun = isPair ? pair : singular(word);
      if (!isPair && !ORG_NOUNS.has(noun)) continue;

      const nounStart = isPair ? i - 1 : i;
      // "clinic group": the kind is the LAST noun of a run, so extend over any
      // kind that follows straight on.
      while (i + 1 < words.length && ORG_NOUNS.has(singular(bareWord(words[i + 1]).toLowerCase()))) i++;
      const lastNoun = singular(bareWord(words[i]).toLowerCase());
      const modifiers: string[] = [];
      for (let j = nounStart - 1; j >= 0 && modifiers.length < 4; j--) {
        const raw = bareWord(words[j]);
        if (!raw || /[^A-Za-z&'-]/.test(raw) || STOP_WORDS.has(raw.toLowerCase())) break;
        modifiers.unshift(raw);
      }
      // A lone vague kind ("a group", "the company") tells the client nothing.
      if (modifiers.length === 0 && i === nounStart && !SPECIFIC_NOUNS.has(lastNoun)) continue;

      const phraseWords = [...modifiers, ...words.slice(nounStart, i + 1).map(bareWord)];
      // A capital on the very first word of the descriptor is sentence case,
      // not a name, but only for a scale word; anywhere else a capital is a
      // name the card will not carry.
      const first = phraseWords[0];
      const opensDescriptor = startsDescriptor && nounStart - modifiers.length === 0;
      if (opensDescriptor && /^[A-Z][a-z-]+$/.test(first) && OPENING_SCALE_WORDS.has(first.toLowerCase())) {
        phraseWords[0] = first.toLowerCase();
      }

      const phrase = phraseWords.join(' ');
      if (phrase.length > 60) continue;
      if (!carriesNothing(phrase) || !namesNobody(phrase, expert)) continue;
      if (hasUnknownCapital(phrase, () => false)) continue;
      return sentenceCase(phrase);
    }
  }
  return null;
}

/** When the descriptor names no kind: the sourcing category, plus the sector. */
function employerTypeFromCategory(expert: Partial<Expert>): string | null {
  let base: string | null = null;
  switch (expert.category) {
    case 'Operator': base = 'Operating company'; break;
    case 'Advisor':  base = 'Advisory or consulting firm'; break;
    case 'Outsider':
      base = expert.outsider_subcategory === 'Government'       ? 'Government or public body'
           : expert.outsider_subcategory === 'Large Enterprise' ? 'Large enterprise'
           : expert.outsider_subcategory === 'Small Business'   ? 'Small business'
           : 'Research, policy or academic institution';
      break;
    default: base = null;
  }
  if (!base) return null;

  // The sector is the value-chain label the client already sees on the card,
  // lower-cased word by word ("Veterinary services" → "veterinary services").
  const label = (expert.valueChainLabel ?? '').trim();
  const sector = label
    .split(/\s+/)
    .map(w => (/^[A-Z][a-z]+$/.test(w) ? w.toLowerCase() : w))
    .join(' ');
  if (sector && sector.length <= 48 && carriesNothing(sector) && namesNobody(sector, expert)
      && !hasUnknownCapital(sector, () => false)) {
    return `${base} in ${sector}`;
  }
  return base;
}

// ─── Reading dates out of the title and claims ────────────────────────────────

interface YearMonth { y: number; m: number | null }   // m: 0-11 when known

interface SentenceRead {
  /** A range inside this one sentence. `end: 'present'` for "to present" / "since". */
  range:    { start: YearMonth; end: YearMonth | 'present' } | null;
  start:    YearMonth | null;
  end:      YearMonth | null;
  present:  boolean;
  years:    number | null;      // a stated duration
  leaves:   boolean;            // a leave verb or a former marker in this sentence
  /** Plainly about employment, not just activity: a past end here means they left. */
  strong:   boolean;
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

const MONTH_SRC = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';
const YEAR_SRC  = '((?:19|20)\\d{2})';
const DATE_SRC  = `(?:${MONTH_SRC}\\s+)?${YEAR_SRC}`;
const PRESENT_SRC = '(present|now|current|today|date)';

// Groups: 1 start month, 2 start year, 3 present word, 4 end month, 5 end year, 6 two-digit end year.
const RANGE_RE   = new RegExp(`\\b(?:from\\s+)?${DATE_SRC}\\s*(?:(?:-|to|until|till|through|thru)\\s*(?:${PRESENT_SRC}\\b|${DATE_SRC}\\b)|-(\\d{2})(?!\\d))`, 'gi');
// Groups: 1 start month, 2 start year, 3 end month, 4 end year.
const BETWEEN_RE = new RegExp(`\\bbetween\\s+${DATE_SRC}\\s+and\\s+${DATE_SRC}\\b`, 'gi');
const SINCE_RE   = new RegExp(`\\bsince\\s+${DATE_SRC}\\b`, 'i');
const START_RE   = new RegExp(`\\b(?:joined|started|began|founded|co-founded|cofounded|launched|took over|became|appointed|promoted|hired)\\b[^.;]{0,60}?\\b(?:in\\s+)?${DATE_SRC}\\b`, 'i');
const LEAVE_RE   = new RegExp(`\\b(?:left|leaving|departed|retired|stepped down|exited|resigned)\\b[^.;]{0,60}?\\b(?:in\\s+)?${DATE_SRC}\\b`, 'i');
const UNTIL_RE   = new RegExp(`\\b(?:until|through|till)\\s+${DATE_SRC}\\b`, 'i');

const LEAVE_WORD_RE   = /\b(left|leaving|departed|retired|stepped down|exited|resigned|later joined|went on to|moved on)\b/i;
const CURRENT_RE      = /\b(currently|presently|to this day|still (?:serves|leads|runs|works|holds|heads|oversees))\b/i;
const FORMER_TITLE_RE = /\b(former(?:ly)?|retired|previously|past|onetime|one-time|erstwhile)\b|\bex-/i;
const FORMER_CLAIM_RE = /\b(former(?:ly)?|retired)\b|\bex-/i;
const PRIOR_ROLE_RE   = /\b(previously|prior to|before joining|earlier in (?:his|her|their) career|(?:began|started) (?:his|her|their) career|early in (?:his|her|their) career|first role)\b/i;

/** Plainly about holding a job: a past end date in one of these means they left. */
const STRONG_CONTEXT_RE = /\b(served|serves|serving|worked|works|working|tenure|employed|employment|role|position|joined|left|leaving|departed|retired|resigned|stepped down|spent|stint|held|holds|career at|as (?:its |the |a |an )?(?:chief|ceo|cfo|coo|cto|cmo|cio|president|vice president|vp|svp|evp|director|head|manager|partner|principal|founder|general manager|officer|lead|chair))\b/i;
/** About running something: dates here are a tenure, but not proof they left. */
const ACTIVITY_CONTEXT_RE = /\b(ran|runs|running|led|leads|leading|headed|heads|heading|oversaw|oversees|overseeing|managed|manages|managing|founded|co-founded|cofounded)\b/i;

/** A range used as an adjective ("the 2018-2020 integration") is not a tenure. */
const AFTER_RANGE_OK = new Set([
  'at', 'as', 'with', 'in', 'for', 'where', 'when', 'before', 'after', 'and', 'while', 'then',
  'until', 'during', 'on', 'of', 'he', 'she', 'they', 'overseeing', 'leading', 'running',
  'managing', 'heading', 'building', 'scaling', 'serving', 'working', 'including', 'across',
]);

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30,
  'half a': 0.5, 'a dozen': 12, 'a couple of': 2, 'a couple': 2,
};

const COUNT_SRC = '(\\d{1,2}(?:\\.\\d)?|half a|a dozen|a couple of|a couple|an|a|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty)';
const QUAL_SRC  = '(?:(over|more than|just over|nearly|almost|about|around|roughly|approximately|close to|under|less than|just under)\\s+)?';
// Groups: 1 qualifier, 2 count, 3 plus, 4 unit.
const DURATION_CORE = `${QUAL_SRC}${COUNT_SRC}(\\+)?[\\s-]*(years?|yrs?|decades?|months?)`;
const DURATION_RES: readonly RegExp[] = [
  new RegExp(`\\bfor\\s+${DURATION_CORE}\\b`, 'i'),
  new RegExp(`\\bspent\\s+${DURATION_CORE}\\b`, 'i'),
  new RegExp(`\\b(?:tenure|stint|run)\\s+of\\s+${DURATION_CORE}\\b`, 'i'),
  new RegExp(`\\b${DURATION_CORE}\\s+(?:at|with|as|in (?:the|that|this) role|in role|tenure|stint|running|leading|heading)\\b`, 'i'),
  new RegExp(`\\b${DURATION_CORE}-long\\s+(?:tenure|stint|career at)\\b`, 'i'),
];
/** "for twenty years in the industry" is experience, not a tenure. */
const EXPERIENCE_NEAR_RE = /\b(industry|career|experience|sector|field)\b/i;

function monthOf(token: string | undefined): number | null {
  if (!token) return null;
  const key = token.toLowerCase().slice(0, 3);
  return key in MONTHS ? MONTHS[key] : null;
}

function ym(monthToken: string | undefined, yearToken: string | undefined): YearMonth | null {
  const y = Number(yearToken);
  if (!Number.isInteger(y) || y < 1950) return null;
  return { y, m: monthOf(monthToken) };
}

function durationYears(match: RegExpMatchArray): number | null {
  const qualifier = (match[1] ?? '').toLowerCase();
  const countRaw  = (match[2] ?? '').toLowerCase();
  const plus      = match[3] === '+';
  const unit      = (match[4] ?? '').toLowerCase();

  const count = /^\d/.test(countRaw) ? Number(countRaw) : NUMBER_WORDS[countRaw];
  if (count === undefined || !Number.isFinite(count) || count <= 0) return null;

  const scale = unit.startsWith('decade') ? 10 : unit.startsWith('month') ? 1 / 12 : 1;
  let years = count * scale;
  // Strictly more, or strictly less, than the round figure: "over a decade" is
  // over ten years; "nearly three years" is under three.
  if (plus || /^(over|more than|just over)$/.test(qualifier)) years += 0.01;
  if (/^(nearly|almost|under|less than|just under|close to)$/.test(qualifier)) years -= 0.01;
  return years;
}

function readSentence(sentence: string, strong: boolean, nowYear: number): SentenceRead {
  const read: SentenceRead = {
    range: null, start: null, end: null, present: false, years: null, leaves: false, strong,
  };
  const valid = (d: YearMonth | null): d is YearMonth => d !== null && d.y <= nowYear;

  // Ranges first, and each one is blanked out of the text so the single-date
  // patterns below never read its two ends a second time.
  let rest = sentence;
  for (const match of Array.from(sentence.matchAll(RANGE_RE))) {
    const next = sentence.slice((match.index ?? 0) + match[0].length).match(/^\s*([A-Za-z]+)/);
    const attributive = next !== null && !AFTER_RANGE_OK.has(next[1].toLowerCase());
    rest = rest.replace(match[0], ' ');
    if (attributive || read.range) continue;

    const start = ym(match[1], match[2]);
    if (!valid(start)) continue;
    if (match[3]) { read.range = { start, end: 'present' }; continue; }

    let end: YearMonth | null = null;
    if (match[6]) {
      let y = Math.floor(start.y / 100) * 100 + Number(match[6]);
      if (y < start.y) y += 100;
      end = { y, m: null };
    } else {
      end = ym(match[4], match[5]);
    }
    if (valid(end) && end.y >= start.y) read.range = { start, end };
  }
  for (const match of Array.from(sentence.matchAll(BETWEEN_RE))) {
    rest = rest.replace(match[0], ' ');
    if (read.range) continue;
    const start = ym(match[1], match[2]);
    const end   = ym(match[3], match[4]);
    if (valid(start) && valid(end) && end.y >= start.y) read.range = { start, end };
  }

  const since = rest.match(SINCE_RE);
  if (since) {
    const start = ym(since[1], since[2]);
    if (valid(start)) { read.start = start; read.present = true; }
  }
  if (!read.start) {
    const started = rest.match(START_RE);
    const start = started ? ym(started[1], started[2]) : null;
    if (valid(start)) read.start = start;
  }
  const left  = rest.match(LEAVE_RE);
  const until = rest.match(UNTIL_RE);
  const endMatch = left ?? until;
  const end = endMatch ? ym(endMatch[1], endMatch[2]) : null;
  if (valid(end)) read.end = end;

  if (read.range?.end === 'present' || CURRENT_RE.test(sentence)) read.present = true;
  read.leaves = LEAVE_WORD_RE.test(sentence) || FORMER_CLAIM_RE.test(sentence);

  for (const pattern of DURATION_RES) {
    const match = sentence.match(pattern);
    if (!match) continue;
    const before = sentence.slice(Math.max(0, (match.index ?? 0) - 40), match.index ?? 0);
    const after  = sentence.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 30);
    if (EXPERIENCE_NEAR_RE.test(before) || /^\s*(?:of\s+(?:experience|industry)|in\s+the\s+(?:industry|sector|field))/i.test(after)) continue;
    const years = durationYears(match);
    if (years !== null) { read.years = years; break; }
  }
  return read;
}

function sentencesOf(text: string): string[] {
  return text
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z])/)
    .map(s => s.trim())
    .filter(Boolean);
}

const SKIPPED_EVIDENCE = new Set<NonNullable<EvidenceItem['evidenceType']>>(['publication', 'conference', 'credential']);

interface RoleSentence {
  text:   string;
  /** About holding the job itself (the title, a tenure verb, the employer named). */
  strong: boolean;
}

/** The sentences the card may read dates from: the title, then role claims. */
function roleSentences(expert: Partial<Expert>): RoleSentence[] {
  const out: RoleSentence[] = [];
  const title = (expert.title ?? '').trim();
  // The title is the role itself: a past end date in it always means they left.
  if (title) out.push(...sentencesOf(title).map(text => ({ text, strong: true })));

  const companyWords = wordsOf(expert.company).filter(w => w.length > 3 && !GENERIC_COMPANY_WORDS.has(w));
  const mentionsEmployer = (s: string) => companyWords.some(w => containsWord(s, w));

  for (const item of expert.evidenceItems ?? []) {
    if (item.evidenceType && SKIPPED_EVIDENCE.has(item.evidenceType)) continue;
    for (const text of sentencesOf(item.claim ?? '')) {
      if (PRIOR_ROLE_RE.test(text)) continue;
      // Naming the employer makes a sentence about the job, not an activity.
      const strong = STRONG_CONTEXT_RE.test(text) || mentionsEmployer(text);
      if (strong || ACTIVITY_CONTEXT_RE.test(text)) out.push({ text, strong });
    }
  }
  return out;
}

interface Timeline {
  employment: ExpertVetting['employment'];
  tenure:     VettingTenureBand | null;
  sinceLeft:  VettingSinceLeftBand | null;
}

function monthsBetween(start: YearMonth, end: YearMonth): number {
  // Year-only on either side counts whole years: "2015-2021" is six years.
  if (start.m === null || end.m === null) return (end.y - start.y) * 12;
  return (end.y * 12 + end.m) - (start.y * 12 + start.m);
}

function readTimeline(expert: Partial<Expert>, now: number): Timeline {
  const today    = new Date(now);
  const nowYear  = today.getUTCFullYear();
  const nowMonth = today.getUTCMonth();
  const nowYM: YearMonth = { y: nowYear, m: nowMonth };

  const title      = (expert.title ?? '').trim();
  const descriptor = (expert.anonymizedDescriptor ?? '').trim();
  const reads = roleSentences(expert).map(s => readSentence(s.text, s.strong, nowYear));

  // The descriptor is held to the narrower claim vocabulary: "over the past
  // decade" in a descriptor says nothing about leaving.
  const formerMarked = FORMER_TITLE_RE.test(title) || FORMER_CLAIM_RE.test(descriptor)
    || reads.some(r => r.leaves);
  const pastEnds = reads.flatMap(r => {
    const ends: YearMonth[] = [];
    if (r.range && r.range.end !== 'present') ends.push(r.range.end);
    if (r.end) ends.push(r.end);
    return ends.map(end => ({ end, strong: r.strong || r.leaves }));
  });
  const former  = formerMarked || pastEnds.some(e => e.strong);
  const present = !former && reads.some(r => r.present);
  const employment: Timeline['employment'] = former ? 'former' : present ? 'current' : null;

  // ── Tenure ──
  let months: number | null = null;
  for (const r of reads) {
    if (!r.range) continue;
    if (r.range.end === 'present') {
      if (former) continue;   // "since 2019" from an older snapshot of a former role
      months = r.range.start.m === null
        ? (nowYear - r.range.start.y) * 12
        : monthsBetween(r.range.start, nowYM);
    } else {
      months = monthsBetween(r.range.start, r.range.end);
    }
    break;
  }
  let years: number | null = months !== null ? months / 12 : null;
  if (years === null) years = reads.find(r => r.years !== null)?.years ?? null;
  if (years === null) {
    const start = reads.find(r => r.start)?.start ?? null;
    const end   = pastEnds[0]?.end ?? null;
    if (start && end && end.y >= start.y) years = monthsBetween(start, end) / 12;
    else if (start && employment === 'current') {
      years = start.m === null ? nowYear - start.y : monthsBetween(start, nowYM) / 12;
    }
  }
  const tenure = years !== null ? tenureBand(years) : null;

  // ── Since they left ──
  let sinceLeft: VettingSinceLeftBand | null = null;
  if (employment === 'current') {
    sinceLeft = 'still there';
  } else if (employment === 'former') {
    const end = (pastEnds.find(e => e.strong) ?? pastEnds[0])?.end ?? null;
    if (end) {
      // Year only: December of that year, the most recent they can have left.
      const endIndex = end.y * 12 + (end.m ?? 11);
      sinceLeft = sinceLeftBand(Math.max(0, nowYear * 12 + nowMonth - endIndex));
    }
  }

  return { employment, tenure, sinceLeft };
}

// ─── Conflicts ────────────────────────────────────────────────────────────────

/** Past the terms: nothing is scheduled until the questions are settled. */
const PAST_TERMS = new Set<ProjectExpert['status']>(['scheduling_sent', 'scheduled', 'completed']);

function conflictOf(pe: ProjectExpert): VettingConflict {
  const risk = pe.conflictRisk === 'low' || pe.conflictRisk === 'medium' || pe.conflictRisk === 'high'
    ? pe.conflictRisk
    : null;

  // A restriction they raised, whether or not the follow-up had asked yet: a
  // conflict in reply to the intro is still their answer to the question.
  const flagged = pe.status === 'conflict_flagged'
    || pe.replyIntent === 'conflict'
    || Boolean(pe.conflictNote?.trim());
  if (flagged) {
    return { status: 'answered', flagged: true, summary: safeConflictNote(pe.conflictNote, pe.expert), risk };
  }

  const askedAt = pe.followupSentAt ?? pe.email2SentAt ?? null;
  if (!askedAt) return { status: 'not_asked', flagged: false, summary: null, risk };

  // A call is only ever scheduled once the terms are settled, and a reply after
  // the ask that Matchy could read was an answer (a 'conflict' read would have
  // been caught above). An unreadable reply is still waiting on a person.
  const repliedSince = (pe.replyDetectedAt ?? 0) > askedAt && pe.replyIntent !== 'unclear';
  if (PAST_TERMS.has(pe.status) || pe.rateAgreedAt || repliedSince) {
    return { status: 'answered', flagged: false, summary: null, risk };
  }
  return { status: 'waiting', flagged: false, summary: null, risk };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Last line of defence: a free-text field carrying a digit is dropped. */
function wordsOnly(text: string | null): string | null {
  return text && !/\d/.test(text) ? text : null;
}

/**
 * The vetting card for one engagement, as of `now` (unix ms).
 *
 * Reads the RAW record when the server calls it (lib/redactExpert) and the
 * staff payload when the browser does; on a record already redacted for a
 * client it degrades to what that record still holds (no title, no evidence)
 * and can only say less, never more.
 */
export function deriveVetting(pe: ProjectExpert, now: number): ExpertVetting {
  const expert = pe.expert ?? ({} as Expert);
  const timeline = readTimeline(expert, now);

  const descriptor = (expert.anonymizedDescriptor ?? '').trim();
  const employerType = (descriptor ? employerTypeFromDescriptor(descriptor, expert) : null)
    ?? employerTypeFromCategory(expert);

  const conflict = conflictOf(pe);
  return {
    roleLevel:    wordsOnly(roleLevelOf(expert)),
    employerType: wordsOnly(employerType),
    employment:   timeline.employment,
    tenure:       timeline.tenure,
    sinceLeft:    timeline.sinceLeft,
    conflict:     { ...conflict, summary: wordsOnly(conflict.summary) },
  };
}
