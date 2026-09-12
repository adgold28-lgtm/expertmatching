// Anonymized-descriptor generation for the client-facing privacy layer.
//
// ExpertMatch's business depends on clients not going around the platform to
// contact experts directly. lib/redactExpert.ts blanks name, title, company,
// LinkedIn, sources and evidence for non-admin viewers until a call is
// scheduled. What the client sees instead is the `anonymizedDescriptor` —
// enough to judge legitimacy, not enough to identify the person.
//
// Two producers:
//   1. lib/generateExperts.ts writes both fields at sourcing time (opus).
//   2. This module backfills experts stored before that shipped (haiku).
//
// And one guarantee: `fallbackDescriptor` is deterministic, synchronous and
// never empty, so the redactor always has something to show even when the LLM
// is unavailable or an expert predates the backfill.

import Anthropic from '@anthropic-ai/sdk';
import type { Expert, SeniorityTier } from '../types';
import { classifySeniority } from './seniorityClassifier';
import { maskContactDetails } from './matchyScreen';
import { getProject, updateExpertStatus } from './projectStore';

// ─── Limits ───────────────────────────────────────────────────────────────────

export const MAX_DESCRIPTOR_LEN    = 140;
export const MAX_JUSTIFICATION_LEN = 200;

/** How many experts a single backfill pass will enrich, and how many at once. */
const BACKFILL_BATCH_SIZE  = 12;
const BACKFILL_CONCURRENCY = 3;

// ─── Deterministic fallback ───────────────────────────────────────────────────

const TIER_LABEL: Record<SeniorityTier, string> = {
  executive: 'Executive',
  senior:    'Senior',
  mid:       'Mid-Level',
};

/** Minimum shape the fallback needs — usable on a full Expert or a fragment. */
export type DescriptorSource = Pick<
  Expert,
  'title' | 'category' | 'valueChainLabel' | 'seniorityTier'
>;

/**
 * Deterministic descriptor built from stored classification only — no I/O, no
 * LLM, never empty. e.g. "Executive · Operator · Veterinary services".
 *
 * Used when the LLM is unavailable and as the render-time floor in the
 * redactor, so an anonymized card never shows a blank descriptor.
 */
export function fallbackDescriptor(expert: DescriptorSource): string {
  const tier = expert.seniorityTier ?? classifySeniority(expert.title ?? '');
  return [TIER_LABEL[tier], expert.category, expert.valueChainLabel?.trim()]
    .filter((part): part is string => !!part && part.length > 0)
    .join(' · ')
    .slice(0, MAX_DESCRIPTOR_LEN);
}

// ─── Anonymity check on generated text ────────────────────────────────────────
//
// THE PROMPT IS NOT THE GUARANTEE (audit H-18). ANONYMIZATION_RULES tells the
// model not to name the person or the employer; nothing used to check that it
// obeyed, and the redactor substituted whatever came back straight onto the
// client's card. This is the post-hoc check — the same shape
// app/api/projects/[projectId]/interview-guide/route.ts already applies to its
// model output — run BOTH where the text is produced and again at render time,
// because text generated before this shipped is already in the database.
//
// A failure is not an error: the caller drops the text and uses the
// deterministic fallback, which is what an expert with no descriptor has always
// been shown.

/** The identity a descriptor must not give away, plus the vocabulary it may use. */
export type IdentitySource = Partial<Pick<
  Expert,
  'name' | 'company' | 'category' | 'valueChainLabel'
>>;

/**
 * Company words that identify nobody on their own. "Bayview" is the employer;
 * "group" is a scale word the anonymized style guide actively asks for
 * ("regional veterinary clinic group"). Mirrors GENERIC_TAIL in
 * lib/matchyScreen.ts, which makes the same distinction for firm names.
 */
const GENERIC_COMPANY_WORDS = new Set([
  'group', 'holdings', 'partners', 'capital', 'ventures', 'associates', 'advisors',
  'management', 'company', 'corporation', 'incorporated', 'limited', 'international',
  'global', 'national', 'regional', 'services', 'solutions', 'systems', 'technologies',
  'industries', 'enterprises', 'consulting', 'labs',
]);

function wordsOf(value: string | undefined): string[] {
  return (value ?? '').toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean);
}

function containsWord(text: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(text);
}

/**
 * True when this text gives nothing away about who the expert is.
 *
 * Rejects, in order:
 *   1. an email address, a link or a phone number (lib/matchyScreen's own
 *      context-free sweep — reused rather than re-implemented)
 *   2. the expert's full name, or their surname alone: the client is shown
 *      "Scott S.", so the family name is the identifying half
 *   3. a distinctive word from the employer's name, longer than three
 *      characters
 *
 * ONE EXCEPTION on (3), and it is deliberate: a company word that also appears
 * in the expert's own category or value-chain label is allowed through, because
 * the deterministic fallback we would swap in is BUILT from those two fields.
 * Rejecting "veterinary" for an expert at "Bayview Veterinary Partners" and
 * then showing them "Executive · Operator · Veterinary services" instead would
 * be incoherent, and it would throw away every good descriptor whose employer
 * happens to be named after its industry. "Bayview" is still rejected.
 *
 * Pure. Unit-checked by scripts/check-redaction.ts.
 */
/**
 * Named awards, rankings and publications identify a person almost as surely
 * as their employer does: there is one "Ad Age 40 Under 40" CMO of a beverage
 * brand. The prompt asks for "won a significant industry award" instead; this
 * is the check that it obeyed.
 */
const NAMED_RECOGNITION = [
  /\b\d+\s+under\s+\d+\b/i,            // "40 Under 40", "30 under 30"
  /\btop\s+\d+\b/i,                       // "Top 100 CMOs"
  /\binc\.?\s*5000\b/i,
  /\bfortune\s+(?!500\b|100\b|1000\b)\d+\b/i, // "Fortune 40 Under 40" — scale words stay allowed
  /\b(forbes|ad\s*age|adweek|fast\s+company|crain'?s|bloomberg|wsj|wall\s+street\s+journal|new\s+york\s+times|techcrunch|business\s+insider|ernst\s*&\s*young|ey\s+entrepreneur|pulitzer|emmy|grammy|clio|cannes\s+lions|effie)\b/i,
];

/**
 * Figures are fingerprints too ("4000+ restaurants" names one QSR chain), so
 * the rules allow none at all: scale is conveyed in words. Any numeral in the
 * text is refused. Only "Fortune 500"-style scale vocabulary is exempt.
 */
function hasFigure(value: string): boolean {
  const stripped = value.replace(/\bfortune\s+(500|100|1000)\b/gi, '');
  return /\d/.test(stripped);
}

export function descriptorIsAnonymous(text: string, expert: IdentitySource): boolean {
  const value = (text ?? '').trim();
  if (!value) return true;                                  // nothing to give away
  if (maskContactDetails(value) !== value) return false;     // email, link or phone
  if (NAMED_RECOGNITION.some(re => re.test(value))) return false;
  if (hasFigure(value)) return false;

  const nameParts = (expert.name ?? '').trim().split(/\s+/).filter(Boolean);
  if (nameParts.length >= 2) {
    const surname = nameParts[nameParts.length - 1];
    if (containsWord(value, nameParts.join(' '))) return false;
    if (surname.length >= 3 && containsWord(value, surname)) return false;
  } else if (nameParts.length === 1 && nameParts[0].length >= 3) {
    if (containsWord(value, nameParts[0])) return false;
  }

  const safeVocabulary = new Set([
    ...wordsOf(expert.category),
    ...wordsOf(expert.valueChainLabel),
  ]);
  for (const word of wordsOf(expert.company)) {
    if (word.length <= 3) continue;
    if (GENERIC_COMPANY_WORDS.has(word) || safeVocabulary.has(word)) continue;
    if (containsWord(value, word)) return false;
  }

  return true;
}

// ─── LLM generation ───────────────────────────────────────────────────────────

export interface AnonymizedFields {
  anonymizedDescriptor:    string;
  anonymizedJustification: string;
}

/**
 * The anonymization contract. Kept in one exported constant because
 * lib/generateExperts.ts embeds the identical rules in its sourcing prompt —
 * the two producers must not drift.
 */
export const ANONYMIZATION_RULES = `ANONYMIZATION RULES (both fields):
- NEVER include the person's name, their employer's name, a product name, a fund name, or any other detail that identifies one specific company or person.
- Generalize organizations by type and scale instead: "regional veterinary clinic group", "national specialty retailer", "mid-market PE fund", "Fortune 500 industrial manufacturer".
- NEVER name an award, ranking, list, publication, conference, school or investor. Say "won a significant industry award", "named to a national industry ranking", "published in a leading trade journal". Never write the awarding body or the list's title (no "40 Under 40", no "Top 100", no magazine or newspaper names).
- Lead with a strong ownership verb that shows what the person is responsible for: owns, runs, leads, built, scaled, oversees. "Owns and runs a multi-site veterinary group" beats "involved in veterinary operations".
- NO NUMERALS. Never write a figure of any kind — no revenue, AUM, headcount, site counts, deal counts, years, percentages or budgets as numbers. A figure is a fingerprint. Convey scale with words only: "dozens of locations", "hundreds of engineers", "thousands of restaurants", "a multi-million-dollar budget", "a nine-figure business", "a billion-dollar fund", "more than a decade in role", "a Fortune 500 manufacturer".
- HARD RULE: every scale word you write must be supported by the evidence provided. Never invent, estimate or extrapolate. If no figures exist, use honest scale words instead: boutique / regional / national / multi-site / enterprise / Fortune 500.
- No hedging ("could", "may", "possibly"). State what the evidence shows.`;

/**
 * Builds the single-shot prompt. Everything interpolated here — title, company,
 * justification, evidence claims — is text an earlier LLM wrote about a person
 * found on the open web, so it is untrusted content sitting in an instruction
 * position. The blast radius is small by construction: the caller keeps only
 * two strings from the reply, both length-capped, and both are shown to the
 * client rather than executed or persisted as identity. The real risk is not
 * injection but LEAKAGE — a model that echoes the company name it was given
 * straight into the descriptor — which is what ANONYMIZATION_RULES is for.
 */
function buildPrompt(expert: Expert): string {
  const claims = (expert.evidenceItems ?? [])
    .slice(0, 5)
    .map(ev => `- ${ev.claim}${ev.relevance ? ` (${ev.relevance})` : ''}`)
    .join('\n');

  return `You write anonymized profiles for an expert network. A client sees this profile BEFORE a call is booked, so it must convey seniority, scope and credibility without letting the client identify or contact the expert directly.

EXPERT DATA (internal — never echo verbatim):
Title: ${expert.title || 'unknown'}
Company: ${expert.company || 'unknown'}
Category: ${expert.category}
Value chain position: ${expert.valueChainLabel ?? 'unspecified'}
Relevance rationale: ${expert.justification || 'none provided'}
${claims ? `Evidence:\n${claims}` : 'Evidence: none provided'}

${ANONYMIZATION_RULES}

anonymizedDescriptor (max ${MAX_DESCRIPTOR_LEN} characters):
Role level + generalized organization type + scale/scope.
Example: "Owns and ran a regional veterinary clinic group as President & CEO — scaled it to dozens of locations and a nine-figure revenue"

anonymizedJustification (max ${MAX_JUSTIFICATION_LEN} characters):
The relevance rationale above, rewritten with every identifying name generalized. One sentence.

Return ONLY this JSON object, no markdown fences and no prose:
{"anonymizedDescriptor":"...","anonymizedJustification":"..."}`;
}

function parseFields(text: string, expert: Expert): AnonymizedFields {
  const start = text.indexOf('{');
  const end   = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no_json_object');

  const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  const descriptor = typeof parsed.anonymizedDescriptor === 'string'
    ? parsed.anonymizedDescriptor.trim().slice(0, MAX_DESCRIPTOR_LEN)
    : '';
  const justification = typeof parsed.anonymizedJustification === 'string'
    ? parsed.anonymizedJustification.trim().slice(0, MAX_JUSTIFICATION_LEN)
    : '';

  // The model was told the rules; this is where we check it followed them
  // (audit H-18). A descriptor that names the person or the employer is
  // dropped for the deterministic one; a justification that does is dropped
  // entirely, which is already what a failed generation returns.
  return {
    anonymizedDescriptor: descriptor && descriptorIsAnonymous(descriptor, expert)
      ? descriptor
      : fallbackDescriptor(expert),
    anonymizedJustification: descriptorIsAnonymous(justification, expert) ? justification : '',
  };
}

/**
 * Generates both anonymized fields for one stored expert with a single
 * claude-haiku-4-5 call. Falls back to the deterministic descriptor (and an
 * empty justification) when the key is missing, the call fails, or the model
 * returns unusable output — this function never throws.
 */
export async function generateAnonymizedFields(expert: Expert): Promise<AnonymizedFields> {
  const apiKey = process.env.ANTRHOPICKEYREAL;
  if (!apiKey) {
    return { anonymizedDescriptor: fallbackDescriptor(expert), anonymizedJustification: '' };
  }

  try {
    const client   = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model:      'claude-haiku-4-5',
      max_tokens: 400,
      messages:   [{ role: 'user', content: buildPrompt(expert) }],
    });

    const block = response.content.find(b => b.type === 'text');
    if (!block || block.type !== 'text') throw new Error('no_text_block');

    return parseFields(block.text, expert);
  } catch (err) {
    // No PII in logs — expert id only, never name/title/company/evidence.
    console.warn('[anonymizeExpert] generation failed', JSON.stringify({
      expertId: expert.id,
      reason:   err instanceof Error ? err.message : 'unknown',
    }));
    return { anonymizedDescriptor: fallbackDescriptor(expert), anonymizedJustification: '' };
  }
}

// ─── Backfill ─────────────────────────────────────────────────────────────────

/** True when an expert stored before this feature still needs enrichment. */
export function needsAnonymization(expert: Expert): boolean {
  const stored = expert.anonymizedDescriptor?.trim() ?? '';
  // No descriptor, or one written under looser rules that the redactor now
  // refuses at render time — either way the client is seeing the deterministic
  // fallback and a fresh generation would serve them better.
  return !stored || !descriptorIsAnonymous(stored, expert);
}

export interface BackfillResult {
  scanned:   number;
  enriched:  number;
  remaining: number;
}

/**
 * Generates and persists anonymized fields for experts in a project that lack
 * them. Bounded: at most BACKFILL_BATCH_SIZE experts per call,
 * BACKFILL_CONCURRENCY LLM calls in flight. Re-running picks up where the last
 * pass stopped, so a large project converges over a few loads.
 *
 * Writes through updateExpertStatus, which merges into the stored expert —
 * raw identity data is never modified.
 */
export async function backfillProjectAnonymization(projectId: string): Promise<BackfillResult> {
  const project = await getProject(projectId);
  if (!project) return { scanned: 0, enriched: 0, remaining: 0 };

  const pending = project.experts.filter(pe => needsAnonymization(pe.expert));
  const batch   = pending.slice(0, BACKFILL_BATCH_SIZE);

  let enriched = 0;
  let cursor   = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= batch.length) return;
      const { expert } = batch[index];

      const fields = await generateAnonymizedFields(expert);
      try {
        await updateExpertStatus(projectId, expert.id, {
          expertPatch: {
            anonymizedDescriptor: fields.anonymizedDescriptor,
            ...(fields.anonymizedJustification && {
              anonymizedJustification: fields.anonymizedJustification,
            }),
          },
        });
        enriched++;
      } catch (err) {
        console.warn('[anonymizeExpert] persist failed', JSON.stringify({
          expertId: expert.id,
          reason:   err instanceof Error ? err.message : 'unknown',
        }));
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(BACKFILL_CONCURRENCY, batch.length) }, () => worker()),
  );

  return {
    scanned:   pending.length,
    enriched,
    remaining: pending.length - enriched,
  };
}
