// Matchy's outbound templates — the intro, the follow-up, and the two one-line
// replies that settle a rate.
//
// These are TEMPLATES, not prompts. Matchy never free-writes to an expert
// (docs/MATCHY_SPEC.md, "Decisions taken"), so both emails are assembled from
// pure string parts here with no LLM in the path. That is also what makes them
// testable: scripts/test-matchy-templates.ts asserts the rules below hold for
// every combination of inputs.
//
// THE RULES:
//
//   Intro (docs/OUTREACH_EMAIL_RUBRIC.md — the founder's rubric is the contract)
//     - subject: "Expert in {domain}: …" — a domain specific to the expert,
//       never the brief's industry; a colon, never an em dash
//     - "Dear {First}," then the WHY-THEM line: one fact only someone who read
//       the expert's background would know. It is an input here, never a slot
//       this module fills (lib/introPersonalization.ts writes it from the
//       sourcing evidence, or staff write it)
//     - then the offer: who the client is (one size word plus one type word),
//       what they want to understand, the EXPERT-side rate, the time range,
//       the scope limit as one clause, and the yes/no question. Nothing else:
//       no scheduling, no agreement, no payment mechanics
//     - the rate is asked, not asserted, and the client number never appears
//     - two trial arms (INTRO_ARMS): the number in the subject or not. The body
//       states the hourly rate either way.
//     - signed "Asher" (first name only, always) over a real signature block
//     - hard rules, enforced in code: zero em dashes, no banned phrases, none of
//       secrets / NDA / confidential / compliance, under 90 words before the
//       sign-off. buildIntroEmail THROWS IntroRubricError rather than send a
//       body that breaks one.
//
//   Follow-up (sent only after a yes)
//     - the conflict / NDA questions, then the rate, ASKED not asserted
//     - quotes the EXPERT-side number, because it is going to the expert. The
//       client-side number never appears in the same message (lib/pricing.ts
//       is the only place the two convert).
//
//   Rate accepted / rate counter (sent when the client presses a button)
//     - same rule: EXPERT-side number only, one line, then it stops
//
// The two email builders return { subject, text, html }; the two rate lines
// return a bare body, because they go out as a reply on an existing thread and
// the sender supplies the subject and the footer.
//
// Every body carries the CAN-SPAM footer from lib/outreachFooter.ts.
//
// Sign-offs. The intro always signs (rubric). The follow-up and the rate lines
// sign only when OUTREACH_SIGNATURE is set (lib/senderIdentity.ts): unset, the
// footer already says who sent it. No em dashes in any body (the house rule for
// outbound mail).
//
// Never logs anything — these functions are pure and do no I/O.

import type { IntroArm, Project } from '../types';
import type { FirmTypeValue, FirmSizeValue } from './supabase/database.types';
import { buildOutreachFooter } from './outreachFooter';
import {
  signOff,
  senderFirstName,
  senderFullName,
  senderFromAddress,
} from './senderIdentity';

export interface MatchyEmail {
  subject: string;
  text:    string;
  html:    string;
}

// ─── Firm phrase ──────────────────────────────────────────────────────────────

/**
 * The type word Matchy uses for each firm type. "family office" carries its
 * own size implicitly, so it takes no size word (see FIRM_TYPES_WITHOUT_SIZE).
 */
const FIRM_TYPE_WORD: Record<FirmTypeValue, string> = {
  pe_firm:         'PE firm',
  family_office:   'family office',
  consulting_firm: 'consulting firm',
  law_firm:        'law firm',
  hedge_fund:      'hedge fund',
  corporate:       'corporate strategy team',
  other:           'investment firm',
};

const FIRM_SIZE_WORD: Record<FirmSizeValue, string> = {
  boutique: 'boutique',
  mid_size: 'mid-size',
  large:    'large',
};

/**
 * "a family office" reads right; "a mid-size family office" does not — a family
 * office is understood to be small. Same for the generic fallback.
 */
const FIRM_TYPES_WITHOUT_SIZE: ReadonlySet<FirmTypeValue> = new Set<FirmTypeValue>([
  'family_office',
  'other',
]);

/** What Matchy says when we have captured nothing about the firm. */
export const DEFAULT_FIRM_PHRASE = 'an investment firm';

function articleFor(word: string): 'a' | 'an' {
  return /^[aeiou]/i.test(word) ? 'an' : 'a';
}

/**
 * One size word plus one type word, with the right article:
 *   ('pe_firm', 'mid_size')        → "a mid-size PE firm"
 *   ('consulting_firm','boutique') → "a boutique consulting firm"
 *   ('law_firm', 'large')          → "a large law firm"
 *   ('family_office', anything)    → "a family office"
 *   (unknown, anything)            → "an investment firm"
 */
export function firmPhrase(
  firmType?: FirmTypeValue | null,
  firmSize?: FirmSizeValue | null,
): string {
  if (!firmType || !(firmType in FIRM_TYPE_WORD)) return DEFAULT_FIRM_PHRASE;

  const typeWord = FIRM_TYPE_WORD[firmType];
  const sizeWord = !FIRM_TYPES_WITHOUT_SIZE.has(firmType) && firmSize
    ? FIRM_SIZE_WORD[firmSize]
    : '';

  const phrase = sizeWord ? `${sizeWord} ${typeWord}` : typeWord;
  return `${articleFor(phrase)} ${phrase}`;
}

// ─── Topic derivation ─────────────────────────────────────────────────────────

/**
 * Phrases a research question routinely opens with. Stripping them turns
 * "How are multi-site veterinary groups handling staffing costs?" into
 * "multi-site veterinary groups handling staffing costs" — one clause, which
 * is what the sentence "…evaluating {topic}" needs.
 */
const QUESTION_OPENERS = [
  /^(how|what|why|when|where|which|who)\s+(do|does|did|are|is|was|were|will|would|can|could|should|has|have|had)\s+/i,
  /^(how|what|why|when|where|which|who)\s+/i,
  /^(we\s+(are|'re)\s+)?(looking\s+to|trying\s+to|seeking\s+to|hoping\s+to)\s+/i,
  /^(we\s+(are|'re)\s+)?(evaluating|assessing|researching|exploring|investigating|understanding)\s+/i,
  /^(i|we)\s+(want|need|would\s+like)\s+to\s+(understand|know|learn)\s+(about\s+)?/i,
  /^(please\s+)?(help\s+(me|us)\s+)?(understand|assess|evaluate)\s+/i,
  /^(the\s+)?(question|topic|brief)\s+is[:,]?\s+/i,
];

/** Trailing clauses that only make sense to the client, not to an expert. */
const TRAILING_NOISE = [
  /\s*[—–-]\s*(for|on\s+behalf\s+of)\b.*$/i,
  /\s*\bfor\s+(a|our|an)\s+(potential\s+)?(portfolio\s+company|client|deal|acquisition|investment|diligence)\b.*$/i,
  /\s*\b(as\s+part\s+of|in\s+support\s+of)\b.*$/i,
];

const MAX_TOPIC_WORDS = 22;

/**
 * Common abbreviations whose full stop does not end a sentence. Without these,
 * "U.S. Southeast" or "Acme Inc. Reports" would split in the wrong place.
 */
const ABBREVIATIONS = /(?:\b(?:Inc|Ltd|Co|Corp|Bros|No|vs|etc|al|Dr|Mr|Mrs|Ms|Jr|Sr|St|Mt|Ave|Est|approx|Fig)|\b[A-Z])\.$/;

/**
 * The first sentence of a brief, or the whole string when it is one sentence.
 *
 * The topic is a single clause dropped into the middle of a sentence an expert
 * reads ("a 60 minute paid call about {topic}"). A multi-sentence brief used to
 * flow straight through, and because a capitalised word can be dropped as a
 * company name — taking its full stop with it — two sentences could fuse into
 * one run-on ("…in the US We need to understand…"). Cutting at the first
 * sentence removes that class of bug and keeps the clause to the point the
 * client led with.
 */
function firstSentence(text: string): string {
  const parts = text.split(/(?<=[a-z0-9)\]])([.?!]+)\s+(?=[A-Z])/);
  if (parts.length < 3) return text;

  let out = parts[0];
  // Re-join where the split landed on an abbreviation rather than a real stop.
  for (let i = 1; i < parts.length; i += 2) {
    const candidate = out + parts[i];
    if (!ABBREVIATIONS.test(candidate)) return candidate;
    out = candidate + ' ' + (parts[i + 1] ?? '');
  }
  return out;
}

/**
 * Words that mark a token as a real word rather than a company name, so a
 * Capitalised token here is not treated as a proper noun.
 */
const COMMON_CAPITALIZED = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'for', 'in', 'on', 'at', 'to', 'of',
  'us', 'uk', 'eu', 'apac', 'emea', 'latam', 'north', 'south', 'east', 'west',
  'european', 'american', 'asian', 'african', 'global', 'national', 'federal',
  'i', 'we', 'they',
]);

/**
 * Words a research brief ordinarily OPENS with. A sentence-initial capital is
 * ambiguous — "Margins in specialty pharma" and "Zoetis pricing power" both
 * start with a capital letter — and the first used to be excused because a
 * sentence starts there, which is exactly how a target's name reached an
 * expert. Now the opening word keeps its place only when it is one of these
 * ordinary words; anything else in first position is treated as a name and
 * dropped. Losing "Fermentation" from "Fermentation capacity in Europe" costs a
 * little specificity; leaking "Zoetis" costs the client's confidentiality.
 */
const BRIEF_OPENERS = new Set([
  // verbs / framing
  'understand', 'understanding', 'assess', 'assessing', 'assessment', 'evaluate', 'evaluating',
  'evaluation', 'analyze', 'analyse', 'analyzing', 'analysis', 'review', 'reviewing', 'map',
  'mapping', 'size', 'sizing', 'benchmark', 'benchmarking', 'compare', 'comparing', 'explore',
  'exploring', 'validate', 'validating', 'identify', 'identifying', 'estimate', 'estimating',
  'model', 'modeling', 'modelling', 'forecast', 'forecasting', 'due', 'commercial', 'diligence',
  'strategy', 'strategic', 'operational', 'operations', 'entry', 'exit', 'expansion',
  // market words
  'market', 'markets', 'competitive', 'competition', 'competitor', 'competitors', 'landscape',
  'dynamics', 'trends', 'trend', 'growth', 'demand', 'supply', 'pricing', 'price', 'prices',
  'margins', 'margin', 'unit', 'economics', 'cost', 'costs', 'customer', 'customers', 'buyer',
  'buyers', 'vendor', 'vendors', 'supplier', 'suppliers', 'channel', 'channels', 'distribution',
  'regulatory', 'regulation', 'regulations', 'reimbursement', 'adoption', 'penetration', 'share',
  'revenue', 'revenues', 'profitability', 'valuation', 'capacity', 'utilization', 'utilisation',
  'labor', 'labour', 'workforce', 'hiring', 'talent', 'churn', 'retention', 'acquisition',
  'acquisitions', 'integration', 'roll-up', 'rollup', 'rollups', 'consolidation', 'fragmentation',
  'outlook', 'risks', 'risk', 'opportunity', 'opportunities', 'business', 'industry', 'sector',
  'segment', 'segments', 'product', 'products', 'service', 'services', 'technology', 'software',
  'hardware', 'platform', 'platforms', 'data', 'digital', 'ai', 'automation', 'infrastructure',
  'logistics', 'freight', 'cold', 'storage', 'warehousing', 'manufacturing', 'industrial',
  'consumer', 'retail', 'wholesale', 'healthcare', 'health', 'medical', 'clinical', 'dental',
  'veterinary', 'pharma', 'pharmaceutical', 'biotech', 'devices', 'diagnostics', 'payer',
  'payers', 'provider', 'providers', 'hospital', 'hospitals', 'insurance', 'banking', 'payments',
  'fintech', 'lending', 'wealth', 'asset', 'assets', 'real', 'estate', 'construction',
  'housing', 'energy', 'power', 'solar', 'wind', 'oil', 'gas', 'utilities', 'water', 'waste',
  'recycling', 'chemicals', 'materials', 'packaging', 'plastics', 'metals', 'steel', 'mining',
  'agriculture', 'agricultural', 'food', 'beverage', 'restaurant', 'restaurants', 'hospitality',
  'travel', 'leisure', 'fitness', 'education', 'edtech', 'media', 'advertising', 'marketing',
  'telecom', 'telecommunications', 'aerospace', 'defense', 'defence', 'automotive', 'mobility',
  'transportation', 'shipping', 'maritime', 'rail', 'aviation', 'textiles', 'apparel', 'fiber',
  'fibre', 'poultry', 'dairy', 'meat', 'seafood', 'crop', 'crops', 'seed', 'fertilizer',
  'equipment', 'machinery', 'components', 'semiconductors', 'electronics', 'cybersecurity',
  'security', 'cloud', 'saas', 'enterprise', 'smb', 'mid-market', 'residential', 'multifamily',
  'specialty', 'generic', 'branded', 'animal', 'companion', 'pet', 'human', 'imaging', 'surgical',
  'therapeutics', 'nutrition', 'wellness', 'senior', 'home', 'care', 'behavioral', 'primary',
  'staffing', 'outsourcing', 'consulting', 'legal', 'accounting', 'compliance', 'government',
  'public', 'private', 'nonprofit', 'international', 'domestic', 'regional', 'local', 'emerging',
  // function words and pronouns
  'how', 'what', 'why', 'who', 'where', 'which', 'when', 'does', 'do', 'is', 'are', 'will',
  'would', 'can', 'could', 'should', 'our', 'we', 'i', 'the', 'a', 'an', 'in', 'on', 'for', 'to',
  'of', 'with', 'from', 'by', 'about', 'key', 'current', 'future', 'recent', 'new', 'early',
  'late', 'best', 'practices', 'total', 'addressable', 'go-to-market', 'end', 'end-market',
  'multi-site', 'multi-year', 'long-term', 'short-term', 'mid-size', 'large', 'small', 'top',
  ...Array.from(COMMON_CAPITALIZED),
]);

/**
 * Words too generic to identify a client on their own, so they never enter the
 * deny list even when they appear in the firm's or a target's name.
 */
const GENERIC_NAME_WORDS = new Set([
  'inc', 'llc', 'ltd', 'plc', 'corp', 'corporation', 'company', 'co', 'group', 'holdings',
  'partners', 'partner', 'capital', 'ventures', 'equity', 'fund', 'funds', 'management',
  'advisors', 'advisory', 'associates', 'consulting', 'services', 'solutions', 'international',
  'global', 'national', 'american', 'european', 'the', 'and', 'of', 'for', 'at', 'in', 'on',
  'a', 'an', 'trial', 'test', 'firm', 'office', 'family', 'limited', 'industries', 'enterprises',
  'labs', 'technologies', 'technology', 'systems', 'health', 'medical', 'veterinary', 'clinic',
  'clinics', 'hospital', 'pharma', 'logistics', 'energy', 'retail', 'software', 'media',
]);

/** Strips punctuation so a token can be inspected as a bare word. */
function bareToken(token: string): string {
  return token.replace(/[^A-Za-z0-9&.'-]/g, '');
}

/** Lower-cases and drops a possessive ("Zoetis's" / "Zoetis'" → "zoetis"). */
function comparable(token: string): string {
  return bareToken(token).toLowerCase().replace(/(?:'s|')$/, '').replace(/^'+|'+$/g, '');
}

/** A Capitalised word that is not one of the ordinary ones. */
function looksProper(token: string): boolean {
  const bare = bareToken(token);
  return /^[A-Z][a-z]+/.test(bare) && !COMMON_CAPITALIZED.has(bare.toLowerCase());
}

/**
 * True for a token that looks like a specific company or product name: a
 * Capitalised word, an ALLCAPS ticker, or anything carrying Inc/LLC/Corp/Ltd/
 * Group/Holdings/Partners/Capital. Deliberately blunt — a topic that loses one
 * word is fine; a topic that names the target is not.
 *
 * `sentenceStart` marks the very first word of the question. A capital there
 * is excused ONLY when the word is one a brief ordinarily opens with
 * (BRIEF_OPENERS) — "Margins in specialty pharma" keeps its first word,
 * "Zoetis pricing power" and "Bayview Veterinary Partners pricing" do not.
 */
function looksLikeCompanyName(token: string, sentenceStart: boolean): boolean {
  const bare = bareToken(token);
  if (!bare) return false;

  if (/^(inc|llc|corp|ltd|plc|gmbh|s\.a\.|co)\.?$/i.test(bare)) return true;
  if (/^(group|holdings|partners|capital|ventures|labs|technologies|systems)$/i.test(bare)) return true;

  // ALLCAPS of 2+ letters that is not a known region word — reads as a ticker
  // or a brand, e.g. "NVDA", "IBM".
  if (/^[A-Z]{2,}$/.test(bare) && !COMMON_CAPITALIZED.has(bare.toLowerCase())) return true;

  if (looksProper(bare)) {
    if (!sentenceStart) return true;
    return !BRIEF_OPENERS.has(comparable(bare));
  }

  return false;
}

/**
 * Same test for a structured FRAGMENT ("Veterinary Services", "Operations"),
 * where every word may be title-cased and none is a sentence start: an
 * ordinary topical word (BRIEF_OPENERS) is kept whatever its case; anything
 * else that looks proper is dropped.
 */
function looksLikeCompanyNameInFragment(token: string): boolean {
  const bare = bareToken(token);
  if (!bare) return false;
  if (BRIEF_OPENERS.has(comparable(bare)) && !/^[A-Z]{2,}$/.test(bare)) return false;
  return looksLikeCompanyName(token, false);
}

/** Collapses whitespace and strips a trailing question mark or period. */
function tidy(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(/[?.!,;:]+$/, '').trim();
}

/** Words that cannot end a clause, or stand next to each other, once a name between them is gone. */
const CONNECTORS = new Set([
  'for', 'at', 'in', 'on', 'of', 'to', 'with', 'from', 'by', 'about', 'into', 'across', 'versus', 'vs',
  'and', 'or', 'but', 'the', 'a', 'an', 'its', 'their', 'our',
]);

/**
 * Removing a company name leaves its connectors behind: "commercial diligence
 * for Blackstone" → "commercial diligence for"; "margins at Chewy and Petco" →
 * "margins at and". Drop trailing connectors and collapse runs of them so the
 * clause still reads as a clause.
 */
function trimDangling(text: string): string {
  const tokens = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (const token of tokens) {
    const word = comparable(token);
    const prev = out.length > 0 ? comparable(out[out.length - 1]) : '';
    if (CONNECTORS.has(word) && CONNECTORS.has(prev)) {
      // "for in" → keep the later one; "at and" → keep neither (handled below).
      out[out.length - 1] = token;
      continue;
    }
    out.push(token);
  }
  while (out.length > 0 && CONNECTORS.has(comparable(out[out.length - 1]))) out.pop();
  while (out.length > 0 && /^(and|or|but)$/.test(comparable(out[0]))) out.shift();
  return tidy(out.join(' '));
}

// ─── Client deny list ──────────────────────────────────────────────────────────

/** The project fields deriveTopic reads. */
export type TopicSource = Pick<
  Project,
  'researchQuestion' | 'industry' | 'function' | 'expertType'
> & Partial<Pick<Project, 'name' | 'targetCompanies' | 'companiesToAvoid' | 'peopleToAvoid' | 'firmDomain'>>;

export interface DeriveTopicOptions {
  /**
   * Names that identify the client or their targets and must never reach an
   * expert, however they are capitalised: the organization's name, target
   * companies, people to avoid. Matched as whole phrases and as their
   * distinctive words, possessives included. clientDenyTermsFor() builds the
   * list from a project; callers add the organization name when they have it.
   */
  denyTerms?: readonly string[];
}

/**
 * Splits free text ("Chewy, Petco; Tractor Supply") into candidate names.
 */
function splitNames(text: string | undefined | null): string[] {
  if (!text) return [];
  return text.split(/[,;\n/|]+|\band\b/i).map(t => t.trim()).filter(Boolean);
}

/** The second-level label of a domain: "blackstone.com" → "blackstone". */
function domainLabel(domain: string | undefined | null): string {
  if (!domain) return '';
  const parts = domain.toLowerCase().split('.').filter(Boolean);
  if (parts.length < 2) return parts[0] ?? '';
  // "x.co.uk" → "x"; "trial-ab12.expertmatch.fit" → "trial-ab12" (harmless).
  return parts.length >= 3 && parts[parts.length - 2].length <= 3 ? parts[parts.length - 3] : parts[parts.length - 2];
}

/**
 * Everything on a project that names the client or what they are looking at:
 * the firm's name, the owner's email domain, target companies, companies and
 * people to avoid, and any proper noun in the project's title (which is where
 * a target's name usually lives — "Zoetis diligence").
 */
export function clientDenyTermsFor(project: TopicSource, firmName?: string | null): string[] {
  const terms: string[] = [];
  if (firmName) terms.push(firmName);
  const label = domainLabel(project.firmDomain);
  if (label && !/^(gmail|outlook|hotmail|yahoo|icloud|proton|expertmatch|trial-[a-z0-9]+)$/.test(label)) terms.push(label);
  terms.push(...splitNames(project.targetCompanies));
  terms.push(...splitNames(project.companiesToAvoid));
  terms.push(...splitNames(project.peopleToAvoid));
  for (const token of (project.name ?? '').split(/\s+/)) {
    if (looksProper(token) || /^[A-Z]{2,}$/.test(bareToken(token))) terms.push(bareToken(token));
  }
  return terms.filter(Boolean);
}

interface DenyMatcher {
  phrases: RegExp[];
  words:   Set<string>;
}

function buildDenyMatcher(denyTerms: readonly string[] | undefined): DenyMatcher {
  const phrases: RegExp[] = [];
  const words = new Set<string>();
  const escape = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  for (const raw of denyTerms ?? []) {
    const term = raw.trim();
    if (!term) continue;
    const tokens = term.split(/\s+/).map(comparable).filter(Boolean);
    if (tokens.length === 0) continue;
    if (tokens.length > 1) {
      phrases.push(new RegExp(`\\b${tokens.map(escape).join('\\s+')}(?:'s|')?\\b`, 'gi'));
    }
    for (const t of tokens) {
      if (t.length >= 3 && !GENERIC_NAME_WORDS.has(t)) words.add(t);
    }
  }
  return { phrases, words };
}

/** Removes every deny phrase from the text and every deny word from the tokens. */
function applyDenyList(text: string, matcher: DenyMatcher): string {
  let out = text;
  for (const phrase of matcher.phrases) out = out.replace(phrase, ' ');
  if (matcher.words.size === 0) return tidy(out);
  return tidy(out.split(/\s+/).filter(token => !matcher.words.has(comparable(token))).join(' '));
}

/**
 * Drops anything that looks like a company name from a clause. `fragment`
 * means the text is not a sentence (a structured industry/function value), so
 * no word gets the sentence-start allowance.
 */
function stripCompanyNames(text: string, fragment: boolean): string {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '';
  if (fragment) return tidy(tokens.filter(token => !looksLikeCompanyNameInFragment(token)).join(' '));
  const firstIsSentenceStart = !looksProper(tokens[1] ?? '');
  return tidy(
    tokens
      .filter((token, i) => !looksLikeCompanyName(token, i === 0 && firstIsSentenceStart))
      .join(' '),
  );
}

/**
 * Generalizes a project's research question into the one clause the intro
 * drops into "…evaluating {topic}". Deterministic, no LLM call:
 *
 *   1. remove every client deny term (firm name, targets, project-title names),
 *      as phrases and as words, whatever their capitalisation
 *   2. prefer the brief's structured `industry` + `function` when both exist —
 *      generalized by construction, but still run through the same filters,
 *      because a client can type "Commercial diligence for Blackstone" into
 *      either box
 *   3. otherwise take the research question's FIRST sentence, strip the
 *      interrogative opener and any client-only trailing clause, drop anything
 *      that looks like a company name (including an opening word that is not an
 *      ordinary brief word), and cap the length
 *   4. fall back to the industry alone, then to "this market"
 *
 * Never returns an empty string.
 */
export function deriveTopic(project: TopicSource, options: DeriveTopicOptions = {}): string {
  const deny = buildDenyMatcher([...(options.denyTerms ?? []), ...clientDenyTermsFor(project)]);

  const industry = trimDangling(stripCompanyNames(applyDenyList(tidy(project.industry ?? ''), deny), true));
  const func     = trimDangling(stripCompanyNames(applyDenyList(tidy(project.function ?? ''), deny), true));

  if (industry && func) return `${func.toLowerCase()} in ${industry.toLowerCase()}`;

  let topic = tidy(firstSentence(tidy(project.researchQuestion ?? '')));

  for (const pattern of TRAILING_NOISE) topic = topic.replace(pattern, '');

  // Once an interrogative opener comes off, the word now in front is no longer
  // a sentence start, so its capital is not explained away.
  let openerStripped = false;
  for (const opener of QUESTION_OPENERS) {
    const stripped = topic.replace(opener, '');
    if (stripped !== topic) { topic = stripped; openerStripped = true; break; }
  }
  topic = applyDenyList(tidy(topic), deny);

  if (topic) {
    topic = trimDangling(stripCompanyNames(topic, openerStripped));
    topic = tidy(topic.split(/\s+/).slice(0, MAX_TOPIC_WORDS).join(' '));
  }

  // Lower-case a leading capital so the clause reads mid-sentence, unless the
  // first word is an acronym we deliberately kept.
  if (topic && /^[A-Z][a-z]/.test(topic)) topic = topic[0].toLowerCase() + topic.slice(1);

  if (topic.split(/\s+/).length >= 2) return topic;
  if (industry) return industry.toLowerCase();
  if (topic) return topic;
  return 'this market';
}

/**
 * The "given your background in {…}" fragment, taken from the expert's
 * anonymized descriptor (lib/anonymizeExpert.ts writes it, never naming the
 * person or their employer). The descriptor is rendered as
 * "Executive · Operator · Veterinary services"; the intro wants the most
 * specific part, so the last segment wins, and the whole thing is lower-cased
 * to sit inside a sentence.
 */
export function descriptorFragmentFrom(anonymizedDescriptor: string | undefined | null): string {
  const raw = tidy(anonymizedDescriptor ?? '');
  if (!raw) return '';
  const segments = raw.split('·').map(s => tidy(s)).filter(Boolean);
  const chosen = segments.length > 1 ? segments[segments.length - 1] : raw;
  return chosen.toLowerCase();
}

// ─── HTML ─────────────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Wraps a plain-text body in the same restrained shell both emails use. */
function toHtml(bodyText: string, footerHtml: string): string {
  const paragraphs = bodyText
    .split(/\n{2,}/)
    .map(p => `<p style="margin:0 0 14px;">${escapeHtml(p).replace(/\n/g, '<br />')}</p>`)
    .join('\n  ');

  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.65;color:#0B1F3B;max-width:560px;">
  ${paragraphs}
${footerHtml}
</div>`;
}

/** First name only, for the greeting. Falls back to the whole string. */
export function firstNameOf(fullName: string | undefined | null): string {
  const trimmed = (fullName ?? '').trim();
  if (!trimmed) return 'there';
  return trimmed.split(/\s+/)[0];
}

// ─── Rubric lint ──────────────────────────────────────────────────────────────
//
// docs/OUTREACH_EMAIL_RUBRIC.md, "Hard rules". These are checked on the
// assembled intro (subject and body) AND on every candidate why-them line
// (lib/introPersonalization.ts), so a phrase cannot enter through either door.

/**
 * Phrases the rubric bans outright, as case-insensitive patterns. Each one
 * reads as AI or as a mass send. "space" is banned only in the "the X space"
 * construction; "leverage" and "insights" are banned as words.
 */
export const INTRO_BANNED_PHRASES: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'I hope this finds you well',   pattern: /\bhope\s+this\s+(?:email\s+|note\s+|message\s+)?finds\s+you\b/i },
  { label: 'I came across your profile',   pattern: /\bcame\s+across\s+your\b/i },
  { label: 'I was impressed by',           pattern: /\bimpressed\s+(?:by|with)\b/i },
  { label: 'reach out',                    pattern: /\breach(?:ing|ed)?\s+out\b/i },
  { label: 'circle back',                  pattern: /\bcircl(?:e|ing)\s+back\b/i },
  { label: 'touch base',                   pattern: /\btouch(?:ing)?\s+base\b/i },
  { label: 'real feel for',                pattern: /\breal\s+feel\s+for\b/i },
  { label: 'how things actually work',     pattern: /\bhow\s+things\s+actually\s+work\b/i },
  { label: 'leverage',                     pattern: /\bleverag(?:e|es|ed|ing)\b/i },
  { label: 'insights',                     pattern: /\binsights?\b/i },
  { label: 'the … space',                  pattern: /\bthe\s+[\w-]+\s+space\b/i },
  { label: 'would love to',                pattern: /\bwould\s+love\s+to\b/i },
  { label: 'excited to',                   pattern: /\bexcited\s+(?:to|about)\b/i },
  { label: 'as someone who has',           pattern: /\bas\s+someone\s+who\s+(?:has|have|had)\b/i },
  // "Anything in a list of three": the Oxford-comma triple is the detectable
  // form. Conservative on purpose — single words either side of the commas.
  { label: 'a list of three',              pattern: /\b[\w-]+,\s+[\w-]+,\s+and\s+[\w-]+\b/i },
];

/**
 * Words the rubric forbids because naming the risk plants it ("Scope and
 * compliance language"). Whole words, either number, any case.
 */
export const INTRO_BANNED_WORDS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'secrets',      pattern: /\bsecrets?\b/i },
  { label: 'NDA',          pattern: /\bNDAs?\b/i },
  { label: 'confidential', pattern: /\bconfidential(?:ity)?\b/i },
  { label: 'compliance',   pattern: /\bcomplian(?:ce|t)\b/i },
];

/** An em dash, or the two stand-ins people type for one. */
const EM_DASH_RE = /—|\s[–]\s|--/;

/**
 * The first hard rule the text breaks, or null when it passes. The label is a
 * diagnostic for staff and tests; it never reaches an expert.
 */
export function introRubricViolation(text: string): string | null {
  if (EM_DASH_RE.test(text)) return 'em dash';
  for (const { label, pattern } of INTRO_BANNED_WORDS)   if (pattern.test(text)) return `banned word: ${label}`;
  for (const { label, pattern } of INTRO_BANNED_PHRASES) if (pattern.test(text)) return `banned phrase: ${label}`;
  return null;
}

/** Thrown by buildIntroEmail when the assembled message breaks a hard rule. */
export class IntroRubricError extends Error {
  constructor(public readonly rule: string) {
    super(`intro breaks the rubric: ${rule}`);
    this.name = 'IntroRubricError';
  }
}

// ─── Trial arms ───────────────────────────────────────────────────────────────

export interface IntroArmSpec {
  /** Whether the number appears in the subject line. The body always states it, hourly. */
  priceInSubject: boolean;
}

/**
 * The two arms of the founder's trial (rubric, "Trial arms"). A flat "$X for
 * up to an hour" framing was tried in the draft and dropped by the founder on
 * 2026-09-10; the body is always "$X/hr for 15 to 60 minutes".
 */
export const INTRO_ARMS: Readonly<Record<IntroArm, IntroArmSpec>> = {
  1: { priceInSubject: true  },
  2: { priceInSubject: false },
};

const ALL_ARMS: readonly IntroArm[] = [1, 2];

/** FNV-1a, 32-bit. Small, dependency-free and stable across runtimes. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Which arm this expert's intro goes out under. A deterministic hash of the
 * expert id, so the same expert always lands on the same arm and the split is
 * even over a population. INTRO_ARM=1 or 2 in the environment pins every intro
 * to one arm (to run a single variant, or to reproduce a sample by hand).
 */
export function introArmFor(expertId: string): IntroArm {
  const pinned = Number(process.env.INTRO_ARM);
  if (ALL_ARMS.includes(pinned as IntroArm)) return pinned as IntroArm;
  return ALL_ARMS[fnv1a(expertId) % ALL_ARMS.length];
}

// ─── Intro ────────────────────────────────────────────────────────────────────

export interface IntroEmailInput {
  /** The trial arm — introArmFor(expert.id), or the arm already recorded on the expert. */
  arm:             IntroArm;
  /**
   * The specific domain for the subject line, lower-case, 2 to 5 words:
   * "cold-chain distribution". From the expert's evidence
   * (lib/introPersonalization.ts), never the brief's industry field.
   */
  domain:          string;
  /**
   * The complete "why them" sentence, second person, ending in a full stop:
   * "You ran distribution in the Southeast for Sysco for six years, so I think
   * you'd be a great fit for my client." Never generated here.
   */
  whyThem:         string;
  firmType?:       FirmTypeValue | null;
  firmSize?:       FirmSizeValue | null;
  /** One generalized clause — deriveTopic(project). */
  topic:           string;
  /** EXPERT-side hourly rate in whole dollars. Never the client number. */
  expertRate:      number;
  expertFirstName: string;
  /** Recipient address — the CAN-SPAM footer's opt-out link is per-recipient. */
  recipientEmail:  string;
}

/** Strict: under this many words from "Dear" to the end of the question. */
export const INTRO_MAX_BODY_WORDS = 90;

/** The scope limit, one clause, verbatim from the rubric. */
export const INTRO_SCOPE_CLAUSE = "This wouldn't be anything proprietary and should stay relatively broad.";
/** The yes/no question the intro ends on. */
export const INTRO_QUESTION     = 'Does this sound interesting to you?';

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** A sentence ends in a full stop. Adds one when the line has no terminal mark. */
function ensureFullStop(sentence: string): string {
  const trimmed = tidy(sentence.replace(/\s+/g, ' '));
  if (!trimmed) return '';
  return /[.!?]$/.test(sentence.trim()) ? sentence.trim() : `${trimmed}.`;
}

function introSubject(arm: IntroArm, domain: string, rate: number): string {
  if (!INTRO_ARMS[arm].priceInSubject) return `Expert in ${domain}: a paid call for my client?`;
  return `Expert in ${domain}: compensated $${rate}/hr for your time?`;
}

function offerSentence(_arm: IntroArm, firm: string, topic: string, rate: number): string {
  const money = `they want to compensate you $${rate}/hr for 15 to 60 minutes of your time`;
  return `They are ${firm} looking to understand ${topic}, and ${money}. ${INTRO_SCOPE_CLAUSE} ${INTRO_QUESTION}`;
}

/**
 * The signature block under the first-name sign-off: full name and From
 * address. Each line comes from the environment (lib/senderIdentity.ts); a
 * line we do not have is omitted, never faked. (A LinkedIn line was in the
 * draft; the founder dropped it on 2026-09-10.) Returned as text lines and as
 * the HTML for the same block.
 */
function signatureBlock(): { lines: string[]; html: string } {
  const first   = senderFirstName();
  const full    = senderFullName();
  const address = senderFromAddress();

  const lines = [first];
  if (full && full !== first) lines.push(full);
  lines.push(address);

  const htmlLines = lines.map(line => escapeHtml(line));

  return { lines, html: `<p style="margin:0 0 14px;">${htmlLines.join('<br />')}</p>` };
}

/**
 * Email one of the expert outreach sequence, to the founder's rubric
 * (docs/OUTREACH_EMAIL_RUBRIC.md). Pure assembly: the why-them line and the
 * domain are inputs; this function decides nothing about the expert.
 *
 * ENFORCED HERE, NOT HOPED FOR. The finished subject and body are checked for
 * an em dash, every banned phrase and word, and the 90-word ceiling. The topic
 * clause is the one part that may be shortened to fit (it is the least
 * specific part of the email and is never a sentence of its own); anything
 * else out of bounds throws IntroRubricError, and the caller holds the intro
 * for a person rather than sending it.
 */
export function buildIntroEmail(input: IntroEmailInput): MatchyEmail {
  const rate = Math.round(input.expertRate);
  if (!Number.isFinite(rate) || rate <= 0) throw new IntroRubricError('no expert rate');

  const domain  = tidy(input.domain).toLowerCase();
  if (!domain) throw new IntroRubricError('no domain');

  const whyThem = ensureFullStop(input.whyThem);
  if (!whyThem) throw new IntroRubricError('no why-them line');

  const firm  = firmPhrase(input.firmType, input.firmSize);
  const name  = firstNameOf(input.expertFirstName);
  const arm   = input.arm;

  // Shorten the topic clause, one word at a time from the end, until the body
  // is under the ceiling. Two words is the floor — below that it stops being a
  // topic — and if the body is still too long the why-them line is the cause.
  let topicWords = tidy(input.topic).split(/\s+/).filter(Boolean);
  if (topicWords.length === 0) topicWords = ['this', 'market'];

  let body = '';
  for (;;) {
    const topic = trimDangling(topicWords.join(' ')) || 'this market';
    body = [`Dear ${name},`, whyThem, offerSentence(arm, firm, topic, rate)].join('\n\n');
    if (countWords(body) < INTRO_MAX_BODY_WORDS || topicWords.length <= 2) break;
    topicWords = topicWords.slice(0, -1);
  }
  if (countWords(body) >= INTRO_MAX_BODY_WORDS) throw new IntroRubricError('body over 90 words');

  const subject = introSubject(arm, domain, rate);

  const violation = introRubricViolation(subject) ?? introRubricViolation(body);
  if (violation) throw new IntroRubricError(violation);

  const signature = signatureBlock();
  const footer    = buildOutreachFooter(input.recipientEmail);

  const text = `${body}\n\n${signature.lines.join('\n')}${footer.text}`;

  const bodyHtml = body
    .split(/\n{2,}/)
    .map(p => `<p style="margin:0 0 14px;">${escapeHtml(p)}</p>`)
    .join('\n  ');
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.65;color:#0B1F3B;max-width:560px;">
  ${bodyHtml}
  ${signature.html}
${footer.html}
</div>`;

  return { subject, text, html };
}

// ─── Follow-up ────────────────────────────────────────────────────────────────

export interface FollowUpEmailInput {
  /** The same generalized clause the intro used. */
  topic:           string;
  /** EXPERT-side hourly rate in whole dollars. Never the client number. */
  expertRate:      number;
  expertFirstName: string;
  recipientEmail:  string;
}

/**
 * Sent after a yes. Three questions: NDAs, current involvements, and the rate.
 * The rate is ASKED — "does that work for you?" — never asserted, because the
 * expert's answer is the input to the negotiation, not a formality.
 */
export function buildFollowUpEmail(input: FollowUpEmailInput): MatchyEmail {
  const topic = tidy(input.topic) || 'this market';
  const name  = firstNameOf(input.expertFirstName);
  const rate  = Math.max(0, Math.round(input.expertRate));

  const body = [
    `Hi ${name},`,
    'Glad to hear it. Three quick things before we schedule.',
    [
      `1. Any NDAs or employer restrictions that would limit discussing ${topic}?`,
      '2. Any current involvement with companies in this space we should know about?',
      `3. We compensate experts at $${rate}/hr, billed per minute. Does that work for you?`,
    ].join('\n'),
    'Answer those three and I will propose a couple of times.',
  ].join('\n\n');

  const footer = buildOutreachFooter(input.recipientEmail);

  return {
    subject: `Re: Paid expert call — ${topic}`,
    text:    `${signOff(body)}${footer.text}`,
    html:    toHtml(signOff(body), footer.html),
  };
}

// ─── Rate decision ────────────────────────────────────────────────────────────

export interface RateDecisionInput {
  /** The expert's first name, for the greeting. */
  firstName:  string;
  /** EXPERT-side hourly rate in whole dollars. NEVER the client number. */
  expertRate: number;
}

/**
 * The two lines Matchy sends an expert once the client has decided on a rate.
 *
 * THE RULE THESE EXIST TO ENFORCE (docs/MATCHY_SPEC.md, "Pricing rule"): the
 * client's number and the expert's number never share a message. The client
 * presses Accept or Offer on a card showing CLIENT-side dollars; what leaves
 * the platform is one of these templates, carrying only `expertRate`. Nothing
 * the client typed is relayed, so there is no path for the client-side figure
 * to reach an expert's inbox.
 *
 * Bodies only — POST .../rate-decision builds the subject from the thread and
 * lib/emailSequence appends the CAN-SPAM footer. No em dashes (house rule for
 * outbound mail), no contractions, one dry line and then it stops.
 */
export function rateAcceptedTemplate(input: RateDecisionInput): string {
  const name = firstNameOf(input.firstName);
  const rate = Math.max(0, Math.round(input.expertRate));
  return signOff(`Thanks, ${name}. $${rate}/hr works. Next I will find a time that suits you both.`);
}

/** The counter: the client is holding at their standing rate. Asked, not told. */
export function rateCounterTemplate(input: RateDecisionInput): string {
  const name = firstNameOf(input.firstName);
  const rate = Math.max(0, Math.round(input.expertRate));
  return signOff(`Thanks, ${name}. Could you do $${rate}/hr? If so I will get a time on the calendar.`);
}
