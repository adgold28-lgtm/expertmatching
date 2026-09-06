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
- QUANTIFY LEGITIMACY whenever the evidence supports it: AUM, revenue, headcount, number of sites/clinics/stores, deals closed, years in role, patents, publications. Use approximate forms — "40+ clinics", "~$200M revenue", "$1B+ AUM", "12 years in role", "30+ peer-reviewed publications".
- HARD RULE: every number you write must appear in, or be directly derivable from, the evidence provided. Never invent, estimate, extrapolate, or round up a figure that is not there. If no figures exist, say nothing numeric and use honest scale words instead: boutique / regional / national / multi-site / enterprise / Fortune 500.
- No hedging ("could", "may", "possibly"). State what the evidence shows.`;

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
Example: "Former President & CEO, regional veterinary clinic group — scaled to 40+ locations, ~$200M revenue"

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

  return {
    anonymizedDescriptor:    descriptor || fallbackDescriptor(expert),
    anonymizedJustification: justification,
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
  return !expert.anonymizedDescriptor?.trim();
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
