// -----------------------------------------------------------------------------
// Expert sourcing pipeline — where every candidate expert in the product is born
//
// Called ONLY by lib/sourcingJob.ts (the QStash-backed background worker); no
// route imports it directly. One call runs this pipeline end to end:
//
//   Step 0  inferValueChain()          — Claude Haiku: turn the brief into the
//                                        real supply-chain expert pools
//   Step 1  query generation           — Claude Haiku: 3 natural-language Exa
//                                        queries (Operator / Advisor / Outsider);
//                                        falls back to buildSearchQueriesFromBrief()
//   Step 2  runWithOptionalComparison() — at most 3 web searches (Exa by default),
//                                        each cached 7 days in Upstash
//   Step 3-4 dedupe + compact source context (title/URL/snippet only)
//   Step 5  extraction                 — Claude Opus: read the search snippets,
//                                        extract real people, score, tier, and
//                                        write the ANONYMIZED descriptor fields
//   Step 6-7 parse + validate          — structural normalize, hedge filter,
//                                        full-name resolution, conflict filter,
//                                        same-source clustering, tier split
//
// DATA ORIGIN: every expert here comes from the PUBLIC WEB (search-provider
// snippets), never from a private roster. Nothing is written to the database in
// this file — lib/sourcingJob.ts persists the result onto the project.
//
// Providers / env vars:
//   Anthropic  ANTRHOPICKEYREAL (note the misspelling — it is the real name)
//              claude-haiku-4-5 for steps 0 and 1, claude-opus-4-6 for step 5.
//   Search     EXA_API_KEY | TAVILY_API_KEY | SCRAPINGBEE_KEY via
//              lib/searchProviders. None of these is in validateEnv, so a
//              missing key surfaces at run time as GenerateExpertsError
//              'no_search_provider' (503), not at boot.
//   Cache      UPSTASH_REDIS_REST_URL / _TOKEN + LOG_HASH_SECRET (searchCache).
//
// SECURITY: BriefContext and the research question are client-confidential.
// Nothing in this file may log query text, brief fields, or expert names —
// counts, codes, and shapes only.
// -----------------------------------------------------------------------------

import Anthropic, {
  RateLimitError,
  InternalServerError,
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
} from '@anthropic-ai/sdk';
import {
  searchWithFallback,
  getSearchProvider,
  tavilyProvider,
  scrapingbeeProvider,
} from './searchProviders';
import type { SearchResult } from './searchProviders';
import { getCachedSearchPage, setCachedSearchPage } from './searchCache';
import { classifySeniority, TIER_PRICING } from './seniorityClassifier';
import {
  ANONYMIZATION_RULES,
  MAX_DESCRIPTOR_LEN,
  MAX_JUSTIFICATION_LEN,
} from './anonymizeExpert';

// Module-level Anthropic client, constructed at import time. apiKey is read
// once: changing ANTRHOPICKEYREAL requires a redeploy, and an unset key does not
// fail here — it fails on the first messages.create() with a 401 that lands in
// the generic 'generation_failed' bucket.
const client = new Anthropic({ apiKey: process.env.ANTRHOPICKEYREAL });

// ─── Types ────────────────────────────────────────────────────────────────────

interface CategoryResults {
  category: string;
  query:    string;
  results:  SearchResult[];
}

// Brief context passed from a project workspace.
// SECURITY: Never log any field from this struct — all fields may contain client-sensitive content.
export interface BriefContext {
  industry?:               string;
  function?:               string;
  expertType?:             string;  // "who do you want to talk to" — primary person anchor for Exa queries
  keyQuestions?:           string;
  initialHypotheses?:      string;
  additionalContext?:      string;
  mustHaveExpertise?:      string;
  niceToHaveExpertise?:    string;
  targetCompanies?:        string;
  // Exclusion fields — only injected into Claude prompts, NEVER sent to search providers
  companiesToAvoid?:       string;
  peopleToAvoid?:          string;
  conflictExclusionNotes?: string;
  perspectivesNeeded?:     string[];
  targetExpertCount?:      number;
  // Rejection feedback — anonymized counts of why prior candidates were rejected.
  // ONLY reason codes + counts. No expert names, notes, or any PII. Never logged.
  rejectionFeedback?:      Record<string, number>;
}

// Inferred value chain — produced by inferValueChain() before query generation.
// Maps the stated brief end-market to the actual supply-chain expert pool.
// SECURITY: never log — may contain client-sensitive industry and product context.
interface ValueChainInterpretation {
  endMarket:                  string;
  actualExpertPools:          string[];
  primaryExpertPools:         string[];
  secondaryExpertPools:       string[];
  excludedOrLowPriorityPools: string[];
  keyTechnicalConstraints:    string[];
  mustSearchTerms:            string[];
  mustAvoidWeakMatches:       string[];
  valueChainLabels:           string[];   // human-readable supply-chain position labels (3–5 per brief)
  briefType: 'product_material_substitution' | 'waste_byproduct_reuse' | 'market_entry' | 'operational' | 'acquisition' | 'general';
}

// Build a block of brief context for inclusion in the extraction/ranking prompt.
// DOES NOT include exclusion fields — those go in buildExclusionsBlock.
function buildQueryBriefBlock(bc: BriefContext): string {
  const parts: string[] = [];
  if (bc.industry?.trim())              parts.push(`Industry: ${bc.industry.trim()}`);
  if (bc.function?.trim())              parts.push(`Function / Knowledge need: ${bc.function.trim()}`);
  if (bc.expertType?.trim())            parts.push(`Expert profile sought (who to find): ${bc.expertType.trim()}`);
  if (bc.keyQuestions?.trim())          parts.push(`Knowledge gaps to address:\n${bc.keyQuestions.trim()}`);
  if (bc.initialHypotheses?.trim())     parts.push(`Hypotheses to test (find experts who can confirm, challenge, or nuance these):\n${bc.initialHypotheses.trim()}`);
  if (bc.additionalContext?.trim())     parts.push(`Additional context (use to sharpen query terms):\n${bc.additionalContext.trim()}`);
  if (bc.mustHaveExpertise?.trim())     parts.push(`Must-have expertise — generate queries that surface experts with this background:\n${bc.mustHaveExpertise.trim()}`);
  if (bc.niceToHaveExpertise?.trim())   parts.push(`Nice-to-have expertise (score boost, not hard requirement):\n${bc.niceToHaveExpertise.trim()}`);
  if (bc.targetCompanies?.trim())       parts.push(`Target organizations — include these in company-specific queries:\n${bc.targetCompanies.trim()}`);
  if (bc.perspectivesNeeded?.length)    parts.push(`Perspectives needed (balance the expert pool accordingly): ${bc.perspectivesNeeded.join(', ')}`);
  if (bc.targetExpertCount)             parts.push(`Target expert count: ${bc.targetExpertCount}`);
  return parts.join('\n\n');
}

// Build the exclusions block for the extraction/ranking prompt ONLY.
// NEVER inject into search provider queries.
function buildExclusionsBlock(bc: BriefContext): string {
  const parts: string[] = [];
  if (bc.companiesToAvoid?.trim())       parts.push(`Companies / organizations to avoid: ${bc.companiesToAvoid.trim()}`);
  if (bc.peopleToAvoid?.trim())          parts.push(`People to avoid: ${bc.peopleToAvoid.trim()}`);
  if (bc.conflictExclusionNotes?.trim()) parts.push(`Conflict / exclusion notes: ${bc.conflictExclusionNotes.trim()}`);
  // Rejection feedback — anonymized counts only; no expert names or notes ever reach here.
  if (bc.rejectionFeedback && Object.keys(bc.rejectionFeedback).length > 0) {
    const lines = Object.entries(bc.rejectionFeedback)
      .sort(([, a], [, b]) => b - a)
      .map(([reason, count]) => `  - ${reason.replace(/_/g, ' ')}: ${count} prior candidate${count !== 1 ? 's' : ''}`)
      .join('\n');
    parts.push(
      `Prior rejection pattern (avoid repeating these failure modes):\n${lines}\n` +
      `Adjust scoring and selection accordingly — do NOT surface candidates likely to fail for the same reasons.`,
    );
  }
  return parts.join('\n\n');
}

// ─── Safe JSON extraction ─────────────────────────────────────────────────────
// Extracts the first valid top-level JSON object from LLM output.
// Handles markdown fences, leading/trailing prose, and reports safe metadata
// on failure without leaking raw model output.

class ParseError extends Error {
  constructor(
    message: string,
    public readonly outputLength: number,
    public readonly approximatePosition?: number,
  ) {
    super(message);
    this.name = 'ParseError';
  }
}

function extractJSON(raw: string): unknown {
  let text = raw.trim();

  // Strip markdown code fences (```json ... ``` or ``` ... ```)
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\r?\n?/, '').replace(/\r?\n?```$/, '').trim();
  }

  // Fast path: direct parse
  try {
    return JSON.parse(text);
  } catch (firstErr) {
    // Slow path: find the first '{' and walk to its matching '}'
    const start = text.indexOf('{');
    if (start === -1) {
      throw new ParseError('no_json_object_found', raw.length);
    }

    let depth = 0;
    let inString = false;
    let escape = false;
    let end = -1;

    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escape)                   { escape = false; continue; }
      if (ch === '\\' && inString)  { escape = true;  continue; }
      if (ch === '"')               { inString = !inString; continue; }
      if (inString)                 { continue; }
      if (ch === '{')               { depth++; }
      else if (ch === '}')          { depth--; if (depth === 0) { end = i; break; } }
    }

    if (end === -1) {
      const approxPos = firstErr instanceof SyntaxError
        ? parseInt((firstErr.message.match(/position (\d+)/) ?? [])[1] ?? '0', 10) || undefined
        : undefined;
      throw new ParseError('json_truncated', raw.length, approxPos);
    }

    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch (secondErr) {
      const approxPos = secondErr instanceof SyntaxError
        ? parseInt((secondErr.message.match(/position (\d+)/) ?? [])[1] ?? '0', 10) || undefined
        : undefined;
      throw new ParseError('json_malformed', raw.length, approxPos);
    }
  }
}

// ─── Per-expert normalization ─────────────────────────────────────────────────
// Sanitizes a raw candidate object. Returns null if required fields are missing.
// Malformed evidenceItems or source_links are discarded but the expert is kept.
//
// Scope of the guarantee: this is a STRUCTURAL check on a handful of fields, not
// a schema validation. The `...e` spread at the bottom passes every other key the
// model emitted through untouched and untyped (hence the `any` return), so
// `title`, `company`, `location`, `justification`, `tier`, `valueChainLabel` and
// anything unexpected reach the caller exactly as the LLM wrote them. The real
// field-level gate is validateProjectExpert() in lib/projectValidation.ts, which
// lib/sourcingJob.ts runs before anything is persisted.
//
// Note the second-order effect of seniorityTier: it is computed here from the
// LLM's `title` and PERSISTED, because lib/redactExpert.ts blanks `title` for
// pre-scheduling viewers — see the comment at the classifySeniority call.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeExpert(raw: unknown): any | null {
  if (!raw || typeof raw !== 'object') return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const e = raw as Record<string, any>;

  // Required: full name with a space
  if (typeof e.name !== 'string' || !e.name.trim().includes(' ')) return null;
  // Required: a real http source URL
  if (typeof e.source_url !== 'string' || !e.source_url.startsWith('http')) return null;

  // source_links — default to [] if absent/malformed; drop invalid entries
  const source_links = Array.isArray(e.source_links)
    ? e.source_links.filter(
        (l: unknown) =>
          !!l &&
          typeof l === 'object' &&
          typeof (l as Record<string, unknown>).url === 'string' &&
          typeof (l as Record<string, unknown>).label === 'string',
      )
    : [];

  // evidenceItems — default to []; drop malformed items
  let evidenceItems: unknown[] = [];
  if (Array.isArray(e.evidenceItems)) {
    evidenceItems = e.evidenceItems.filter(
      (item: unknown) =>
        !!item &&
        typeof item === 'object' &&
        typeof (item as Record<string, unknown>).claim === 'string' &&
        ((item as Record<string, unknown>).claim as string).length > 0,
    );
  }

  // relevance_score — must be a finite number; default to 0
  const relevance_score =
    typeof e.relevance_score === 'number' && Number.isFinite(e.relevance_score)
      ? e.relevance_score
      : 0;

  // Seniority is classified and PERSISTED here, not recomputed at render time.
  // lib/redactExpert.ts blanks `title` for non-admin viewers before a call is
  // scheduled, so a render site that derives the tier from the title would show
  // every anonymized expert as "Mid-Level".
  const seniorityTier = classifySeniority(typeof e.title === 'string' ? e.title : '');

  // Anonymized presentation fields — trimmed to their stored limits. Absent or
  // malformed values are simply dropped; lib/anonymizeExpert.ts backfills them
  // and the redactor falls back to a deterministic descriptor either way.
  const anonymizedDescriptor = typeof e.anonymizedDescriptor === 'string'
    ? e.anonymizedDescriptor.trim().slice(0, MAX_DESCRIPTOR_LEN)
    : '';
  const anonymizedJustification = typeof e.anonymizedJustification === 'string'
    ? e.anonymizedJustification.trim().slice(0, MAX_JUSTIFICATION_LEN)
    : '';

  return {
    ...e,
    source_links,
    evidenceItems,
    relevance_score,
    seniorityTier,
    tierPricing: TIER_PRICING[seniorityTier],
    ...(anonymizedDescriptor    && { anonymizedDescriptor }),
    ...(anonymizedJustification && { anonymizedJustification }),
  };
}

// ─── Relevance gating ─────────────────────────────────────────────────────────
// Belt-and-suspenders check — the extraction prompt already instructs Claude to
// reject these, but we enforce it in code too.

const HEDGE_PATTERNS: RegExp[] = [
  /\bcould\b/i,
  /\bmay\b/i,
  /\bmight\b/i,
  /\bpossibly\b/i,
  /\badjacent\b/i,
  /\bintersects?\b/i,
  /location proximity/i,
  /geographic proximity/i,
];

function hedgeReason(justification: string): string | null {
  for (const pattern of HEDGE_PATTERNS) {
    const match = justification.match(pattern);
    if (match) return match[0].toLowerCase();
  }
  return null;
}

// ─── Full-name validation (imported from shared lib) ────────────────────────
import {
  HONORIFIC_RE,
  isInitialToken,
  hasInitialStyleName,
  isFullHumanName,
} from './nameValidation';

// ─── Partial-name resolution ──────────────────────────────────────────────────
// For promising candidates (score ≥ 60) with an initial-style name, we run up to
// 3 targeted searches to find their full name. Up to MAX_RESOLVE_ATTEMPTS
// candidates are attempted; resolution searches run in parallel.

const MAX_RESOLVE_ATTEMPTS = 3;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Extracts the surname (last token) from a partial name like "J. Subbiah" → "Subbiah". */
function extractSurname(name: string): string {
  const tokens = name.trim().replace(HONORIFIC_RE, '').trim().split(/\s+/);
  return tokens[tokens.length - 1].replace(/\.$/, '');
}

/**
 * Attempts to resolve a full name by running up to 3 targeted searches.
 * Safe: never logs name, company, URL, or raw results.
 */
async function resolvePartialNameCandidate(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  candidate: Record<string, any>,
): Promise<{ resolved: true; fullName: string; evidenceUrl: string } | { resolved: false }> {
  const surname = extractSurname(candidate.name as string);
  const company = ((candidate.company as string | undefined) ?? '').trim();
  const title   = ((candidate.title   as string | undefined) ?? '').trim();

  const queries: string[] = [];
  if (company) queries.push(`"${surname}" "${company.slice(0, 40)}"`);
  if (typeof candidate.source_url === 'string') {
    try {
      const domain = new URL(candidate.source_url as string).hostname.replace(/^www\./, '');
      queries.push(`"${surname}" site:${domain}`);
    } catch { /* invalid URL — skip */ }
  }
  if (title) queries.push(`"${surname}" "${title.slice(0, 40)}"`);
  queries.push(`"${surname}" researcher professor scientist`);

  const namePattern = new RegExp(
    `([A-Z][a-z]{2,20})\\s+${escapeRegExp(surname)}\\b`,
    'g',
  );

  for (const q of queries.slice(0, 3)) {
    try {
      const results = await runSearchQuery(q);
      for (const r of results) {
        const text = `${r.title ?? ''} ${r.snippet ?? ''}`;
        for (const m of Array.from(text.matchAll(namePattern))) {
          const candidateFull = `${m[1]} ${surname}`;
          if (isFullHumanName(candidateFull)) {
            return { resolved: true, fullName: candidateFull, evidenceUrl: r.url };
          }
        }
      }
    } catch { /* ignore individual search failures */ }
  }

  return { resolved: false };
}

// ─── Conflict filtering ───────────────────────────────────────────────────────

/**
 * Extracts normalized company names from the brief's exclusion fields.
 * SECURITY: result is never logged.
 */
function extractConflictCompanies(bc: BriefContext): string[] {
  const companies: string[] = [];

  // companiesToAvoid is a direct comma/newline list
  if (bc.companiesToAvoid?.trim()) {
    bc.companiesToAvoid
      .split(/[,;\n|]/)
      .map(s => s.trim().toLowerCase())
      .filter(s => s.length > 2)
      .forEach(s => companies.push(s));
  }

  // conflictExclusionNotes: extract "Company Name is a conflict" patterns
  if (bc.conflictExclusionNotes?.trim()) {
    const conflictRe = /([A-Z][\w\s&.,' -]{2,50})\s+(is|are)\s+(a\s+)?conflict/gi;
    for (const m of Array.from(bc.conflictExclusionNotes.matchAll(conflictRe))) {
      companies.push(m[1].trim().toLowerCase());
    }
  }

  return Array.from(new Set(companies)).filter(s => s.length > 2);
}

/** Returns true if the expert's current company matches a conflict company. */
function isConflictedExpert(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expert: Record<string, any>,
  conflictCompanies: string[],
): boolean {
  if (!conflictCompanies.length) return false;
  const co = ((expert.company as string) ?? '').toLowerCase().trim();
  if (!co) return false;
  return conflictCompanies.some(c => co.includes(c) || c.includes(co));
}

// ─── Same-source clustering ───────────────────────────────────────────────────
// Prevents a single article from dominating results. Keeps up to MAX_PER_SOURCE
// experts per source URL (highest relevance_score first).

const MAX_PER_SOURCE = 3;

function applySameSourceClustering(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  experts: Record<string, any>[],
): { kept: typeof experts; suppressed: number } {
  const bySource = new Map<string, typeof experts>();
  for (const e of experts) {
    const key = ((e.source_url as string) ?? 'unknown').toLowerCase();
    if (!bySource.has(key)) bySource.set(key, []);
    bySource.get(key)!.push(e);
  }

  const kept: typeof experts = [];
  let suppressed = 0;

  for (const group of Array.from(bySource.values())) {
    if (group.length <= MAX_PER_SOURCE) {
      kept.push(...group);
    } else {
      const sorted = [...group].sort(
        (a, b) => ((b.relevance_score as number) ?? 0) - ((a.relevance_score as number) ?? 0),
      );
      kept.push(...sorted.slice(0, MAX_PER_SOURCE));
      suppressed += group.length - MAX_PER_SOURCE;
    }
  }

  return { kept, suppressed };
}

// ─── Value-chain reinterpretation ─────────────────────────────────────────────
// Before query generation, infer the ACTUAL expert supply chain from the brief.
// Corrects for the common failure where the stated industry (e.g., "Banking") is
// only the end-market, not the primary expert pool (e.g., card manufacturers).
// Returns call/retry counts so the route handler can track them correctly.
// Non-blocking: returns { vci: null } on any failure.

async function inferValueChain(
  query: string,
  bc:    BriefContext,
): Promise<{ vci: ValueChainInterpretation | null; llmCalls: number; llmRetries: number }> {
  const briefSnippet = buildQueryBriefBlock(bc).slice(0, 600);
  const prompt = `You are a research strategy expert. Analyze this research brief and identify the ACTUAL expert supply chain — not just the stated end-market industry.

Research question: "${query.trim()}"
${briefSnippet ? `Brief context:\n${briefSnippet}` : ''}

GOAL-ORIENTED REFRAMING: When the research question is goal-oriented ("I want to X", "How do I X", "We are considering X"), reframe it as: "Who has successfully done X or directly advised on X?" Then identify the specific job titles, companies, and industry segments where those people work or have worked. A former VP of Manufacturing at a sporting goods company is far more valuable than a market research analyst who studies the sector.

Think through each question:
1. What specific product, process, or object is the research question about?
2. Who manufactures or produces it? (fabricators, assemblers, material makers, component suppliers)
3. Who supplies raw materials, components, or substrates to those manufacturers?
4. Who sets technical or regulatory constraints on the product/process?
5. Who buys or procures it? (the end market)
6. Who analyzes or advises on it?
7. Is the stated industry the END MARKET (buyer) rather than where the real experts live?
8. Who has DONE this before — not who studies it? (former operators, founders, executives who ran this)
9. Who are the adjacent experts that a practitioner would consult? (legal, regulatory, sourcing, distribution)

EXPERT POOL REQUIREMENT: You MUST identify at least 5 distinct expert archetypes even for niche topics. For a manufacturing/market-entry question these always include: (1) materials/ingredient suppliers, (2) equipment vendors, (3) contract manufacturers or operators, (4) industry consultants and former operators, (5) regulatory or compliance experts, (6) import/distribution/logistics specialists, (7) investors or PE professionals in the sector, (8) trade association executives.

Return ONLY valid JSON, no prose, no markdown:
{
  "endMarket": "stated industry or buyer role (e.g. Banking/payment card issuers)",
  "actualExpertPools": ["all relevant expert pools — minimum 5 distinct archetypes"],
  "primaryExpertPools": ["most direct experts — former operators, manufacturers, technical producers, material suppliers — people who HAVE DONE this"],
  "secondaryExpertPools": ["useful but indirect — consultants who advise on it, analysts, buyers with material programs"],
  "excludedOrLowPriorityPools": ["generic end-market roles with no technical evidence value"],
  "keyTechnicalConstraints": ["specific constraints that govern expert relevance"],
  "mustSearchTerms": ["specific company names in this space", "technical job titles", "industry jargon", "relevant trade associations", "contract manufacturer names", "equipment vendor names", "regulatory bodies — minimum 8 terms for market_entry and general briefTypes"],
  "mustAvoidWeakMatches": ["overly broad or generic terms that produce irrelevant results"],
  "valueChainLabels": ["list of 3–5 human-readable position labels for this specific value chain, e.g. for waste-to-textiles: ['Waste Source / Byproducts', 'Fiber & Textile Science', 'Biomaterials / Keratin', 'Commercialization', 'Adjacent Materials']"],
  "briefType": "general",
  "queryDiversityCheck": ["operator archetype covered", "advisor archetype covered", "outsider/regulatory archetype covered"]
}

briefType options:
- "product_material_substitution": brief asks about replacing the MATERIAL or SUBSTRATE of an existing physical product (e.g. plastic card → bamboo card)
- "waste_byproduct_reuse": brief asks about CONVERTING a waste stream, agricultural byproduct, or industrial residue into a new material, product, or application (e.g. poultry feathers → textile fiber, brewery waste → protein material, bone → bioplastic)
- "market_entry": brief asks about entering a specific geographic or segment market — ALWAYS include in mustSearchTerms: former operators at companies in target industry, contract manufacturers, industry consultants, PE/investment professionals who invested in this sector, trade association executives
- "operational": brief asks about improving operations, processes, or AI adoption within an industry
- "acquisition": brief asks about buying, investing in, or acquiring a company, asset, or creator
- "general": any other research question — treat like market_entry for mustSearchTerms depth`;

  try {
    const { value: resp, retries } = await callWithRetry(
      () => client.messages.create({
        model:      'claude-haiku-4-5',
        // The VCI JSON regularly exceeds 1800 tokens (8+ mustSearchTerms,
        // 5+ pools, labels) — 1800 caused mid-JSON truncation and silent
        // vciAvailable:false degradation.
        max_tokens: 4000,
        messages:   [{ role: 'user', content: prompt }],
      }),
      1,
    );

    const block = resp.content.find(b => b.type === 'text');
    if (!block || block.type !== 'text') {
      console.warn('[generate-experts] vci-no-text-block');
      return { vci: null, llmCalls: 1, llmRetries: retries };
    }

    // DIAGNOSTIC: log raw response shape (no content)
    console.log('[generate-experts] vci-llm-response', JSON.stringify({
      responseLength:  block.text.length,
      startsWithBrace: block.text.trim().startsWith('{'),
      startsWithFence: block.text.trim().startsWith('```'),
    }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let parsed: any;
    try {
      parsed = extractJSON(block.text);
    } catch (parseErr) {
      console.warn('[generate-experts] vci-json-parse-failed', JSON.stringify({
        error: parseErr instanceof Error ? parseErr.message.slice(0, 100) : String(parseErr).slice(0, 100),
      }));
      return { vci: null, llmCalls: 1, llmRetries: retries };
    }

    if (!parsed || typeof parsed !== 'object') {
      console.warn('[generate-experts] vci-parsed-not-object', JSON.stringify({ type: typeof parsed }));
      return { vci: null, llmCalls: 1, llmRetries: retries };
    }

    // DIAGNOSTIC: log parsed structure (no content values — only shapes)
    console.log('[generate-experts] vci-parsed-structure', JSON.stringify({
      hasPrimaryPools:    Array.isArray(parsed.primaryExpertPools),
      primaryPoolsLength: Array.isArray(parsed.primaryExpertPools) ? parsed.primaryExpertPools.length : -1,
      hasEndMarket:       typeof parsed.endMarket === 'string',
      briefType:          parsed.briefType ?? '(missing)',
    }));

    // Require at minimum: primaryExpertPools must be a non-empty array
    if (!Array.isArray(parsed.primaryExpertPools) || parsed.primaryExpertPools.length === 0) {
      console.warn('[generate-experts] vci-empty-primary-pools');
      return { vci: null, llmCalls: 1, llmRetries: retries };
    }

    const validBriefTypes = [
      'product_material_substitution', 'waste_byproduct_reuse', 'market_entry', 'operational', 'acquisition', 'general',
    ] as const;

    const vci: ValueChainInterpretation = {
      endMarket:                  String(parsed.endMarket ?? ''),
      actualExpertPools:          Array.isArray(parsed.actualExpertPools)          ? (parsed.actualExpertPools as unknown[]).map(String)          : [],
      primaryExpertPools:         Array.isArray(parsed.primaryExpertPools)         ? (parsed.primaryExpertPools as unknown[]).map(String)         : [],
      secondaryExpertPools:       Array.isArray(parsed.secondaryExpertPools)       ? (parsed.secondaryExpertPools as unknown[]).map(String)       : [],
      excludedOrLowPriorityPools: Array.isArray(parsed.excludedOrLowPriorityPools) ? (parsed.excludedOrLowPriorityPools as unknown[]).map(String) : [],
      keyTechnicalConstraints:    Array.isArray(parsed.keyTechnicalConstraints)    ? (parsed.keyTechnicalConstraints as unknown[]).map(String)    : [],
      mustSearchTerms:            Array.isArray(parsed.mustSearchTerms)            ? (parsed.mustSearchTerms as unknown[]).map(String)            : [],
      mustAvoidWeakMatches:       Array.isArray(parsed.mustAvoidWeakMatches)       ? (parsed.mustAvoidWeakMatches as unknown[]).map(String)       : [],
      valueChainLabels:           Array.isArray(parsed.valueChainLabels)           ? (parsed.valueChainLabels as unknown[]).map(String)           : [],
      briefType:                  validBriefTypes.includes(parsed.briefType) ? parsed.briefType : 'general',
    };

    return { vci, llmCalls: 1, llmRetries: retries };
  } catch (err) {
    // Always log the error message — never the prompt content or brief fields.
    const errMsg = err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120);
    console.warn('[generate-experts] value_chain_inference_failed', JSON.stringify({ error: errMsg }));
    return { vci: null, llmCalls: 0, llmRetries: 0 };
  }
}

// ─── Retry / overload handling ────────────────────────────────────────────────
// Retries on 429 (rate limit), 529 (overloaded), 503 (unavailable), and
// transient connection errors. Does NOT retry on validation/schema errors.
// Max 2 retries with 1 s then 3 s backoff.

function isRetryableError(err: unknown): boolean {
  if (err instanceof RateLimitError)     return true;  // 429
  if (err instanceof InternalServerError) {
    // 529 overloaded_error, 503 unavailable
    return err.status === 529 || err.status === 503;
  }
  if (err instanceof APIConnectionError)        return true;
  if (err instanceof APIConnectionTimeoutError) return true;
  // Belt-and-suspenders: string match for SDKs that wrap status differently
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return msg.includes('overloaded') || msg.includes('529') || msg.includes('rate_limit');
  }
  return false;
}

function isProviderOverloaded(err: unknown): boolean {
  // Any retryable error that exhausted all attempts is reported as "overloaded"
  // to the client — the specific status code doesn't matter for the UI message.
  return isRetryableError(err);
}

interface CallResult<T> { value: T; retries: number; }

async function callWithRetry<T>(fn: () => Promise<T>, maxRetries = 2): Promise<CallResult<T>> {
  const BACKOFF_MS = [1_000, 3_000]; // delay before retry 1, retry 2
  let retries = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return { value: await fn(), retries };
    } catch (err) {
      if (!isRetryableError(err) || attempt === maxRetries) throw err;
      retries++;
      const delayMs = BACKOFF_MS[attempt] ?? 3_000;
      if (process.env.NODE_ENV === 'development') {
        // Safe log: no prompts, no keys, no brief content
        console.warn('[generate-experts] llm_retry', JSON.stringify({
          attempt:   attempt + 1,
          delayMs,
          errorType: err instanceof Error ? err.constructor.name : 'unknown',
          status:    err instanceof APIError ? err.status : undefined,
        }));
      }
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw new Error('retry_loop_exhausted'); // unreachable
}

// ─── Programmatic search query builder ───────────────────────────────────────
// Generates 12–16 targeted search queries from the brief context.
// Replaces the prior LLM query-generation step — zero additional Claude calls.
//
// Trade-off vs Claude-generated queries: loses the ability to look up specific
// named companies / trade publications on-the-fly, but gains reliability and
// eliminates a full Opus call. Quality is preserved by the extraction step.

// Builds natural-language person-description queries optimised for Exa neural search.
// Exa's neural engine finds semantically similar content — it does NOT support boolean
// operators (OR/AND), site: filters, or quoted keyword phrases. Queries must read like
// a LinkedIn bio description of the person you are trying to find.
function buildSearchQueriesFromBrief(
  researchQuestion: string,
  geography: string | undefined,
  seniority: string | undefined,
  bc: BriefContext,
  vci?: ValueChainInterpretation,
): Array<{ category: string; query: string }> {
  const expertTypeText  = bc.expertType?.trim() ?? '';
  const domain          = researchQuestion.trim().slice(0, 120);
  const industry        = bc.industry?.trim() ?? '';
  const targetCo        = bc.targetCompanies?.trim().split(/[,\n;]/)[0]?.trim().slice(0, 60) ?? '';
  const vciPool         = vci?.primaryExpertPools[0]?.slice(0, 60) ?? '';

  // Seniority phrasing for natural-language descriptions
  let seniorPhrase = 'director or VP level';
  if (seniority && seniority !== 'any') {
    if (/executive|c.suite/i.test(seniority))   seniorPhrase = 'C-suite executive, CEO, COO, or President';
    else if (/senior/i.test(seniority))          seniorPhrase = 'senior director, VP, or head of department';
    else if (/mid|manager/i.test(seniority))     seniorPhrase = 'manager or senior manager';
  }

  const geoPhrase = (geography && geography !== 'any') ? `, based in ${geography}` : '';

  // Primary subject phrase: prefer VCI pool > expertType subject > industry+domain
  const subject = vciPool || industry || domain.split(/,/)[0].slice(0, 70);

  const pairs: Array<{ category: string; query: string }> = [];

  // ── Operator: direct practitioner ────────────────────────────────────────
  // Anchor on expertType if provided — it is the most specific person description
  const operatorBase = expertTypeText
    ? expertTypeText.slice(0, 200)
    : `${seniorPhrase} professional who has directly managed or operated in ${subject}`;
  const operatorSuffix = domain && !expertTypeText ? `, with hands-on experience in: ${domain.slice(0, 80)}` : '';
  pairs.push({ category: 'Operator', query: `${operatorBase}${operatorSuffix}${geoPhrase}`.trim() });

  // ── Advisor: consultant or published expert ───────────────────────────────
  const advisorBase = expertTypeText
    ? `independent advisor or consultant with a background similar to: ${expertTypeText.slice(0, 150)}, now advising companies on ${subject}`
    : `independent consultant or advisor who specialises in ${subject}, formerly a ${seniorPhrase} practitioner`;
  pairs.push({ category: 'Advisor', query: `${advisorBase}${geoPhrase}`.trim() });

  // ── Outsider: researcher, regulator, or academic ─────────────────────────
  const outsiderBase = `researcher, academic, or policy expert on ${subject}${domain ? ` and ${domain.slice(0, 60)}` : ''}, with institutional or government background`;
  pairs.push({ category: 'Outsider', query: `${outsiderBase}${geoPhrase}`.trim() });

  // Optional: company-specific operator query when target companies are named
  if (targetCo) {
    pairs.push({ category: 'Operator', query:
      `former or current ${seniorPhrase} at ${targetCo} with expertise in ${subject}${geoPhrase}`.trim() });
  }

  // When value chain interpretation narrows the expert pool, add a targeted query
  if (vci && vci.mustSearchTerms.length > 0) {
    const scTerm    = vci.mustSearchTerms[0]?.slice(0, 60) ?? '';
    const scPool    = vci.primaryExpertPools[0]?.slice(0, 60) ?? subject;
    if (scTerm) {
      pairs.push({ category: 'Operator', query:
        `${seniorPhrase} with deep expertise in ${scTerm} within the ${scPool} industry${geoPhrase}`.trim() });
    }

    // For market_entry and general briefTypes, add practitioner-focused angles
    if (vci.briefType === 'market_entry' || vci.briefType === 'general') {
      pairs.push({ category: 'Advisor', query:
        `former executive turned advisor who has led market entry or expansion in ${scPool}${geoPhrase}`.trim() });
      pairs.push({ category: 'Operator', query:
        `founder or president of a company in ${scPool}, with operational history in ${subject}${geoPhrase}`.trim() });
      pairs.push({ category: 'Outsider', query:
        `trade association or industry group executive with deep knowledge of ${subject}${geoPhrase}`.trim() });
      pairs.push({ category: 'Operator', query:
        `${seniorPhrase} with experience in import, distribution, or supply chain management within ${scPool}${geoPhrase}`.trim() });
    }
  }

  // ── queryDiversityCheck ────────────────────────────────────────────────────
  // Safeguard: ensure all three archetypes are present (VCI queries may be Operator-heavy)
  const archetypesCovered = new Set(pairs.map(p => p.category));
  if (!archetypesCovered.has('Operator')) {
    pairs.push({ category: 'Operator', query:
      `${seniorPhrase} practitioner with direct operational experience in ${subject}${geoPhrase}`.trim() });
  }
  if (!archetypesCovered.has('Advisor')) {
    pairs.push({ category: 'Advisor', query:
      `independent consultant or advisor specialising in ${subject}${geoPhrase}`.trim() });
  }
  if (!archetypesCovered.has('Outsider')) {
    pairs.push({ category: 'Outsider', query:
      `academic researcher or government policy expert on ${subject}${geoPhrase}`.trim() });
  }

  return pairs;
}

// ─── Quality / performance log ────────────────────────────────────────────────

interface PerfLog {
  provider:                     string;
  queryGenMethod:               'llm' | 'programmatic';
  valueChainInferred:           boolean;
  briefType:                    string;
  searchQueryCount:             number;
  totalSearchResults:           number;
  dedupedSearchResults:         number;
  dupeCount:                    number;
  llmCallCount:                 number;
  llmRetryCount:                number;
  initialCandidatesExtracted:   number;
  candidatesAfterIdentityCheck: number;
  identityResolvedCount:        number;
  incompleteNameRejectedCount:  number;
  conflictRejectedCount:        number;
  sameSourceSuppressedCount:    number;
  coreExpertCount:              number;
  adjacentExpertCount:          number;
  suppressedFromTiering:        number;
  candidatesRejected:           number;
  expertsReturned:              number;
  rejectedByReason:             Record<string, number>;
  averageScore:                 number;
  sourceTypeBreakdown:          Record<string, number>;
  confidenceDistribution:       Record<string, number>;
  parseStatus:                  'ok' | 'failed';
  durationMs:                   number;
}

function logPerf(log: PerfLog): void {
  if (process.env.NODE_ENV !== 'development') return;
  // Safe log: no research question, no brief content, no API keys, no raw LLM output
  console.log('[generate-experts] perf-metrics', JSON.stringify(log));
}

// ─── Search helpers ───────────────────────────────────────────────────────────

const MAX_RESULTS_PER_QUERY = 10;
// NOTE (stale sizing): 160 was chosen when every generated query was executed.
// runWithOptionalComparison() now caps execution at one query per category
// (3 total), so the real ceiling is ~30 results and this cap never binds. Left
// as-is because raising the executed-query count is the intended future change.
const MAX_TOTAL_RESULTS     = 160; // up to 16 queries × 10 (niche technical briefs need broader search)
const MAX_ADJACENT          = 6;   // adjacent experts are supplementary — cap to avoid overwhelming core results

// One cached web search. The cache (lib/searchCache.ts) is keyed on the
// normalized query text ONLY — not the provider and not maxResults — so a run
// that switches SEARCH_PROVIDER still reads the previous provider's results for
// up to 7 days. Cache misses cost a provider credit; cache write failures are
// swallowed (fail-open: a broken Upstash slows sourcing, never breaks it).
async function runSearchQuery(query: string): Promise<SearchResult[]> {
  const cached = await getCachedSearchPage(query);
  if (cached) {
    if (process.env.NODE_ENV === 'development') {
      console.log('[generate-experts] cache-hit', JSON.stringify({ provider: cached.provider }));
    }
    return cached.results;
  }

  const results = await searchWithFallback({ query, maxResults: MAX_RESULTS_PER_QUERY });
  if (results.length > 0) {
    await setCachedSearchPage(query, results, getSearchProvider().name).catch(() => {});
  }
  return results;
}

// Runs searches sequentially (not in parallel) with a small inter-request delay
// to avoid hitting Exa's 10 req/s rate limit.
// Caps at one query per category (max 3 total) so we never exceed 3 Exa calls
// per sourcing run. Includes dev-only provider comparison when enabled.
async function runWithOptionalComparison(
  queryPairs: Array<{ category: string; query: string }>,
): Promise<CategoryResults[]> {
  // Pick the first query for each of the 3 categories — max 3 Exa calls total
  const seen: Set<string> = new Set();
  const cappedPairs = queryPairs.filter(({ category }) => {
    if (seen.has(category)) return false;
    seen.add(category);
    return true;
  });

  const primary       = getSearchProvider();
  const shouldCompare =
    process.env.SEARCH_COMPARE_PROVIDERS === 'true' &&
    process.env.NODE_ENV !== 'production';
  const altProvider   = primary.name === 'scrapingbee' ? tavilyProvider : scrapingbeeProvider;
  const canCompare    = shouldCompare && altProvider.isConfigured();

  if (shouldCompare && !altProvider.isConfigured()) {
    console.log('[generate-experts] compare: alt provider not configured, skipping');
  }

  const output: CategoryResults[] = [];

  for (let i = 0; i < cappedPairs.length; i++) {
    const { category, query: q } = cappedPairs[i];

    // 150 ms gap between calls keeps well under Exa's 10 req/s limit
    if (i > 0) await new Promise(r => setTimeout(r, 150));

    const comparisonPromise = canCompare
      ? altProvider.search({ query: q, maxResults: MAX_RESULTS_PER_QUERY }).catch(() => null)
      : null;

    const results = await runSearchQuery(q);

    if (comparisonPromise) {
      const altResults = await comparisonPromise;
      if (altResults !== null) {
        console.log('[generate-experts] compare', JSON.stringify({
          primary:          primary.name,
          alt:              altProvider.name,
          query:            q.slice(0, 70),
          primary_count:    results.length,
          alt_count:        altResults.length,
          primary_linkedin: results.filter(r => r.url.includes('linkedin.com')).length,
          alt_linkedin:     altResults.filter(r => r.url.includes('linkedin.com')).length,
        }));
      }
    }

    output.push({ category, query: q, results });
  }

  return output;
}

// ─── Public contract ─────────────────────────────────────────────────────────

/** Expected failure with a stable code + HTTP status for callers to map. */
export class GenerateExpertsError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'GenerateExpertsError';
  }
}

export interface GenerateExpertsInput {
  query:                string;
  geography?:           string;
  seniority?:           string;
  briefContext?:        BriefContext;
  supplementarySearch?: boolean;
  excludeNames?:        string[];
  additionalContext?:   string;
}

export interface GenerateExpertsResult {
  query_analysis:          unknown;
  // Raw expert shapes straight off the extraction LLM, structurally validated.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  experts:                 Record<string, any>[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adjacent_experts:        Record<string, any>[];
  limited_pool:            boolean;
  value_chain_summary:     { briefType: string; primaryExpertPools: string[]; endMarket: string } | null;
  insufficient_categories: Array<{ category: string; found: number; required: number }>;
}

// ─── Core generation ─────────────────────────────────────────────────────────
// Used by the background sourcing worker (POST /api/jobs/source-experts). Expected
// failures throw GenerateExpertsError; callers map code + status.

export async function generateExperts(input: GenerateExpertsInput): Promise<GenerateExpertsResult> {
  const startMs     = Date.now();
  let llmCallCount  = 0;
  let llmRetryCount = 0;
  let parseStatus: 'ok' | 'failed' = 'ok';

  try {
    try { getSearchProvider(); } catch (err) {
      throw new GenerateExpertsError(
        err instanceof Error ? err.message : 'No search provider configured',
        'no_search_provider',
        503,
      );
    }

    const { query, geography, seniority } = input;
    // SECURITY: briefContext fields are never logged — they may contain client-sensitive content.
    const briefContext: BriefContext = input.briefContext ?? {};

    // Supplementary search fields — used to broaden queries and exclude already-found experts.
    const supplementarySearch: boolean = input.supplementarySearch === true;
    const excludeNames: string[] = Array.isArray(input.excludeNames)
      ? input.excludeNames
          .filter((n): n is string => typeof n === 'string')
          .map(n => n.trim())
          .filter(Boolean)
          .slice(0, 50)
      : [];
    const excludeNamesSet = excludeNames.length > 0
      ? new Set(excludeNames.map(n => n.toLowerCase()))
      : null;
    const topLevelAdditionalContext = typeof input.additionalContext === 'string'
      ? input.additionalContext.trim().slice(0, 2000)
      : '';

    if (!query?.trim()) {
      throw new GenerateExpertsError('Query is required', 'query_required', 400);
    }

    // ── Step 0: Infer value chain ────────────────────────────────────────────
    // Identifies the actual supply-chain expert pool before generating queries.
    // Corrects for end-market overweighting (e.g., "Banking" → card manufacturers).
    // Non-blocking: if inference fails, query generation continues unguided.
    const { vci, llmCalls: vciCalls, llmRetries: vciRetries } =
      await inferValueChain(query, briefContext);
    llmCallCount  += vciCalls;
    llmRetryCount += vciRetries;

    if (process.env.NODE_ENV === 'development' && vci) {
      // Safe log: only counts and type, no content
      console.log('[generate-experts] value_chain_inferred', JSON.stringify({
        briefType:          vci.briefType,
        primaryPoolCount:   vci.primaryExpertPools.length,
        mustSearchTerms:    vci.mustSearchTerms.length,
        excludedPoolCount:  vci.excludedOrLowPriorityPools.length,
      }));
    }

    const filters = [
      geography && geography !== 'any' ? `Geography: ${geography}` : null,
      seniority && seniority !== 'any' ? `Seniority: ${seniority}` : null,
    ].filter(Boolean).join('\n');

    const queryBriefBlock = buildQueryBriefBlock(briefContext) +
      (topLevelAdditionalContext ? `\n\nAdditional search context (use to sharpen queries):\n${topLevelAdditionalContext}` : '');
    const exclusionsBlock = buildExclusionsBlock(briefContext) +
      (excludeNames.length > 0 ? `\n\nAlready-found experts — do NOT re-surface:\n${excludeNames.slice(0, 50).join(', ')}` : '');

    // ── Step 1: Build 12 targeted search queries ──────────────────────────────
    // Primary: Haiku LLM call — knows real company/publication/conference names.
    // Fallback: programmatic builder — used silently if LLM fails for any reason
    //   (wrong model name, overload, parse error, insufficient output).
    // Either way, extraction (Step 5) is the quality gatekeeper.
    let allQueryPairs:  Array<{ category: string; query: string }>;
    let queryGenMethod: 'llm' | 'programmatic' = 'programmatic';

    const vciQueryBlock = vci
      ? `
VALUE CHAIN ANALYSIS — read this before generating ANY queries:
The stated industry is the END MARKET (the buyer), NOT the primary expert pool.
End market: ${vci.endMarket}
PRIMARY expert pools — generate MOST queries targeting these: ${vci.primaryExpertPools.join(' | ')}
Secondary expert pools (1–2 queries only): ${vci.secondaryExpertPools.join(' | ')}
AVOID over-indexing on these generic end-market roles: ${vci.excludedOrLowPriorityPools.join(' | ')}
Key technical constraints to search: ${vci.keyTechnicalConstraints.join(', ')}
MUST USE these terms in queries (specific companies, technical vocabulary): ${vci.mustSearchTerms.slice(0, 10).join(', ')}
Avoid these weak/generic terms: ${vci.mustAvoidWeakMatches.join(', ')}

CRITICAL: Do NOT generate queries for generic "${vci.endMarket}" roles. Generate queries targeting the PRIMARY expert pools above — the manufacturers, material suppliers, and technical constraint-setters.
`
      : '';

    // Exa uses neural/semantic search — queries must be natural-language person descriptions,
    // NOT boolean keyword strings. Do not use site:, OR, AND, or quoted keyword phrases.
    const expertTypeBlock = briefContext.expertType?.trim()
      ? `\nExpert profile sought (who the client wants to speak with): "${briefContext.expertType.trim()}"\nAnchor the Operator query closely on this description.\n`
      : '';

    const queryGenPrompt = `You are a research sourcing expert building queries for Exa neural semantic search.

CRITICAL: Exa is NOT Google. It finds semantically similar content. Queries must be 1–2 sentence natural-language descriptions of a PERSON — not keyword strings. Do NOT use OR, AND, site:, quoted keyword phrases, or boolean operators of any kind.

Business Question: "${query.trim()}"
${filters ? `Filters:\n${filters}` : ''}
${expertTypeBlock}
${vciQueryBlock}
${queryBriefBlock ? `\nBRIEF CONTEXT:\n${queryBriefBlock}\n` : ''}
Generate exactly ONE query per category. Each query should read like a LinkedIn bio description of the ideal expert — their role, industry, seniority level, and what they've done. Be specific: name real companies, sub-sectors, or technical disciplines where relevant.

Categories:
1. Operator: a practitioner who has directly run operations, led teams, or held a line role in this space (e.g. "former VP of operations at a mid-size cold chain logistics company serving Southeast US food manufacturers, with experience scaling frozen food distribution networks")
2. Advisor: a consultant, independent advisor, or published expert who advises companies in this space (e.g. "independent supply chain consultant who previously held director-level roles at Sysco or US Foods, now advising food distributors on cold chain network design")
3. Outsider: a researcher, regulator, academic, or policy expert who studies or oversees this space (e.g. "university professor or USDA researcher specialising in food safety and cold chain regulations for perishable goods distribution")

Return ONLY valid JSON, no markdown, no prose:
{"queries":{"Operator":"...","Advisor":"...","Outsider":"..."}}`;

    try {
      llmCallCount++;
      const { value: queryGenResponse, retries: queryRetries } = await callWithRetry(
        () => client.messages.create({
          model:      'claude-haiku-4-5',
          max_tokens: 600,
          messages:   [{ role: 'user', content: queryGenPrompt }],
        }),
        1, // 1 retry only — query gen is less critical than extraction
      );
      llmRetryCount += queryRetries;

      const queryBlock = queryGenResponse.content.find(b => b.type === 'text');
      if (!queryBlock || queryBlock.type !== 'text') throw new Error('no_text_block');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const gq = extractJSON(queryBlock.text) as any;

      // Support both string (new) and array (legacy) values per category
      const pick = (v: unknown): string[] => {
        if (typeof v === 'string' && v.trim()) return [v.trim()];
        if (Array.isArray(v))                  return (v as unknown[]).filter((s): s is string => typeof s === 'string' && Boolean(s.trim())).slice(0, 1);
        return [];
      };
      const operatorQ = pick(gq?.queries?.Operator);
      const advisorQ  = pick(gq?.queries?.Advisor);
      const outsiderQ = pick(gq?.queries?.Outsider);

      const llmPairs: Array<{ category: string; query: string }> = [
        ...operatorQ.map(q => ({ category: 'Operator', query: q })),
        ...advisorQ.map(q  => ({ category: 'Advisor',  query: q })),
        ...outsiderQ.map(q => ({ category: 'Outsider', query: q })),
      ];

      // Require at least one query per category
      if (llmPairs.length < 3) throw new Error(`query_gen_insufficient:${llmPairs.length}`);

      allQueryPairs  = llmPairs;
      queryGenMethod = 'llm';
    } catch (queryGenErr) {
      // Don't count a failed query-gen attempt toward llmCallCount
      llmCallCount--;
      if (process.env.NODE_ENV === 'development') {
        console.warn('[generate-experts] query_gen_fallback', JSON.stringify({
          reason: queryGenErr instanceof Error ? queryGenErr.message.slice(0, 80) : 'unknown',
        }));
      }
      allQueryPairs  = buildSearchQueriesFromBrief(query, geography, seniority, briefContext, vci ?? undefined);
      queryGenMethod = 'programmatic';
    }

    // ── Supplementary search: append diversity-broadening queries ────────────
    // Only when supplementarySearch=true — targets different profile types
    // (startups, independents, academics) to surface experts the primary run missed.
    if (supplementarySearch) {
      const domainSnippet = query.trim().slice(0, 80);
      const etSnippet     = briefContext.expertType?.trim().slice(0, 100) ?? domainSnippet;
      allQueryPairs.push(
        { category: 'Operator',  query: `independent freelance specialist or startup founder with hands-on experience in ${etSnippet}` },
        { category: 'Advisor',   query: `emerging or non-traditional advisor who has worked on ${domainSnippet}, from an academic, nonprofit, or independent consulting background` },
        { category: 'Outsider',  query: `university professor or nonprofit researcher with published work on ${domainSnippet}` },
      );
      // Broaden VCI mustSearchTerms with diversity signals so programmatic
      // query builder also picks them up if it runs again.
      if (vci) {
        vci.mustSearchTerms = [
          ...vci.mustSearchTerms,
          'alternative', 'emerging', 'startup', 'academic', 'independent consultant',
        ];
      }
    }

    // ── Step 2: Run all 12 queries in parallel (with optional comparison) ────
    const serpResults = await runWithOptionalComparison(allQueryPairs);

    // ── Step 3: Deduplicate search results by URL (and fuzzy title match) ────
    // Deduplicates across all query results so Claude sees each page only once.
    let totalSearchResults = 0;
    const seenUrls       = new Set<string>();
    const seenTitleKeys  = new Set<string>();
    let dupeCount        = 0;

    for (const r of serpResults) {
      totalSearchResults += r.results.length;
      r.results = r.results.filter(result => {
        const urlKey   = result.url.toLowerCase();
        const titleKey = result.title?.toLowerCase().trim().slice(0, 50) ?? '';
        if (seenUrls.has(urlKey) || (titleKey && seenTitleKeys.has(titleKey))) {
          dupeCount++;
          return false;
        }
        seenUrls.add(urlKey);
        if (titleKey) seenTitleKeys.add(titleKey);
        return true;
      });
    }

    const dedupedSearchResults = totalSearchResults - dupeCount;

    // Hard cap: trim to MAX_TOTAL_RESULTS after dedup
    let running = 0;
    for (const r of serpResults) {
      if (running >= MAX_TOTAL_RESULTS) {
        r.results = [];
      } else if (running + r.results.length > MAX_TOTAL_RESULTS) {
        r.results = r.results.slice(0, MAX_TOTAL_RESULTS - running);
      }
      running += r.results.length;
    }

    // ── Step 4: Group by category and build compact source context ───────────
    const grouped: Record<string, CategoryResults[]> = { Operator: [], Advisor: [], Outsider: [] };
    for (const r of serpResults) {
      if (grouped[r.category]) grouped[r.category].push(r);
    }

    // Compact format: title + URL + snippet only — no raw page content
    const formattedResults = Object.entries(grouped)
      .map(([cat, catResults]) => {
        const text = catResults
          .map(cr =>
            `Query: "${cr.query}"\nResults:\n${cr.results
              .map((r, i) => `  ${i + 1}. Title: ${r.title}\n     URL: ${r.url}\n     Snippet: ${r.snippet ?? ''}\n     Source: ${r.source ?? ''}`)
              .join('\n')}`
          )
          .join('\n\n');
        return `=== ${cat.toUpperCase()} SEARCH RESULTS ===\n${text}`;
      })
      .join('\n\n');

    // ── Step 5: Extraction LLM call — extract, score, rank, and format ──────
    // Receives the full brief and compact source context; outputs complete
    // experts JSON in one shot. (Steps 0 and 1 precede this with VCI + query gen.)
    //
    // This is the single most expensive call in the product: claude-opus-4-6,
    // max_tokens 12000, up to 2 retries (see callWithRetry below). It does five
    // jobs at once — extract people, score them 0-100, split core vs adjacent,
    // attach evidence items, and WRITE THE ANONYMIZED DESCRIPTOR that clients see
    // before a call is scheduled (rules imported from lib/anonymizeExpert.ts, so
    // the prompt and the server-side backfill can never diverge).
    //
    // PROMPT-INJECTION SURFACE: `formattedResults` below is attacker-influenced
    // text — titles and snippets scraped from third-party web pages are
    // interpolated straight into the prompt with no delimiting or escaping. A
    // crafted page could try to steer scoring or inject a fabricated candidate.
    // The downstream defences are structural, not semantic: normalizeExpert()
    // requires a real http source_url, the hedge filter, isFullHumanName(), the
    // conflict filter and the score floor. None of them stops a plausible-looking
    // fake person on an attacker-controlled page from being surfaced.
    const extractionPrompt = `You are an expert sourcing analyst. Extract REAL, verifiable people from the search results below. Apply strict evidence standards — do not include weak or inferred matches.

Business Question: "${query.trim()}"
${filters ? `Filters:\n${filters}` : ''}
${queryBriefBlock ? `\nBRIEF REQUIREMENTS — Score every candidate against these criteria:\n${queryBriefBlock}\n` : ''}
${exclusionsBlock ? `\nEXCLUSIONS — AUTOMATICALLY DISQUALIFY any candidate who matches any of the following:\n${exclusionsBlock}\n` : ''}
${vci ? `
━━━ VALUE CHAIN CONTEXT — READ BEFORE EVALUATING CANDIDATES ━━━

This brief is about: ${vci.briefType.replace(/_/g, ' ')}.
The stated industry ("${vci.endMarket}") is the END MARKET — the BUYER — not the primary expert pool.

PRIMARY expert pools (candidates from here qualify as CORE):
${vci.primaryExpertPools.map(p => `  • ${p}`).join('\n')}

Secondary expert pools (candidates here qualify as ADJACENT):
${vci.secondaryExpertPools.map(p => `  • ${p}`).join('\n')}

LOW PRIORITY / EXCLUDED from core (generic end-market roles — mark ADJACENT or SUPPRESS):
${vci.excludedOrLowPriorityPools.map(p => `  ✗ ${p}`).join('\n')}

Key technical constraints (relevant expertise signals):
${vci.keyTechnicalConstraints.map(c => `  • ${c}`).join('\n')}
` : ''}
SEARCH RESULTS:
${formattedResults}

${vci?.briefType === 'product_material_substitution' ? `━━━ CANDIDATE ACCEPTANCE PATHWAYS (product/material substitution) — MANDATORY ━━━

Each candidate MUST qualify through at least one pathway. Candidates that do not qualify for ANY pathway must be SUPPRESSED (score < 55).

Pathway 1 — Manufacturing/production:
Person works/worked at a company that manufactures, produces, or assembles the physical product described in the brief. Evidence connects them to production, R&D, materials, operations, or product strategy for that specific product.

Pathway 2 — Sustainable/alternative program (buyer side):
Person works/worked at a buyer, platform, or end-market participant and evidence connects them SPECIFICALLY to alternative material procurement or product programs for THIS product — not generic ESG or sustainability strategy.

Pathway 3 — Material/substrate expertise:
Person has direct technical expertise in materials relevant to replacing the incumbent material for this specific product. The rationale must explicitly connect their expertise to the product's physical constraints (thickness, durability, processing temperature, component embedding, etc.).

Pathway 4 — Manufacturing technical constraints:
Person has expertise in the specific manufacturing process for this product (lamination, chip embedding, personalization, certification, durability testing) that constrains material choice.

Pathway 5 — Market/advisory:
Person has published, presented, or advised SPECIFICALLY on sustainable or alternative-material versions of this product. General sustainability expertise alone does NOT qualify.

ASSIGN TIER "adjacent" (not "core") for:
• Generic end-market roles with no physical material or procurement evidence
• Generic ESG/sustainability executives without product-specific material evidence
• Generic materials researchers without this product's specific constraint relevance
• Indirect inspiration candidates ("their expertise could apply" is NOT a pathway)

` : vci?.briefType === 'waste_byproduct_reuse' ? `━━━ CANDIDATE ACCEPTANCE PATHWAYS (waste/byproduct reuse) — MANDATORY ━━━

Each candidate MUST qualify through at least one pathway. "adjacent" is a valid tier — use it for candidates with related but not direct expertise rather than suppressing them.

Pathway 1 — Direct waste-to-application expertise:
Person has direct evidence of working on converting this specific waste stream or a closely related byproduct into the target application (textiles, fiber, material, product). This is the strongest pathway.

Pathway 2 — Transformation process expertise:
Person has expertise in the specific scientific or technical process that converts the waste into usable material (e.g., keratin extraction, protein fiber spinning, enzymatic processing, biopolymer conversion, nonwoven fabrication). Even if not specific to this waste stream, relevant process expertise qualifies as CORE.

Pathway 3 — Waste source / byproduct management:
Person works in the waste-generating industry (e.g., poultry processing) and has evidence of byproduct valorization, material recovery, circular use, or rendering. Generic poultry executives with no material/valorization angle do NOT qualify.

Pathway 4 — End application expertise:
Person has direct expertise in the target application domain (e.g., textile materials, nonwovens, bio-based fibers for apparel) and the rationale explicitly connects their expertise to the conversion challenge or bio-based/waste-derived material.

Pathway 5 — Commercialization of waste-derived materials:
Person commercializes or markets bio-based, waste-derived, or alternative-source materials for the target application. Evidence must be specific to this type of application.

ASSIGN TIER "adjacent" (not core, not suppressed) for:
• Material scientists working on related protein fibers or biopolymers but not this specific waste stream
• Sustainability innovators with bio-based material commercialization evidence but not this waste stream specifically
• Waste valorization experts from related industries (e.g., other agricultural byproducts) without direct evidence for this specific waste

ASSIGN TIER "adjacent" if in doubt — do not suppress candidates who have genuine but indirect relevance.

` : ''}━━━ EVIDENCE REQUIREMENTS — MANDATORY ━━━

A candidate is ONLY acceptable if their justification cites SPECIFIC evidence from the search result demonstrating direct, verifiable involvement in the exact domain described by the business question. Inferred or adjacent relevance does NOT qualify.

AUTOMATIC DISQUALIFICATION — do NOT include a candidate if:
- The justification relies on hedging language: "could", "may", "might", "possibly", "likely", "would"
- ${vci?.briefType === 'waste_byproduct_reuse' ? 'The candidate has ZERO connection to the value chain — no material, process, application, or waste-stream link at all (candidates with indirect relevance should be marked "adjacent", not suppressed)' : 'The match is based only on adjacency: "adjacent to", "intersects with", "could apply to", "transferable" — with no direct evidence pathway'}
- The only evidence is location proximity to the industry (same city, region, or country is NOT evidence)
- The candidate has generic AI/ML/technology experience without explicit evidence of applying it to this specific domain
- The search result names only an organization, not a person

REQUIRED for every included candidate:
1. A real person's full name appears explicitly in the search result
2. Their professional background directly involves the specific industry + technology/function in the business question
3. The justification names a specific company, role, project, publication, conference, or statement from the search result as evidence — not a general inference

For the business question "${query.trim()}", strong candidates will show direct evidence in at least two of: (a) the specific industry sector, (b) the specific operational or technical function, (c) the specific technology or methodology. Evidence must come from the search results, not from general knowledge.

${vci?.briefType === 'waste_byproduct_reuse' ? `━━━ TIERING — ASSIGN TO EVERY CANDIDATE ━━━

Assign every extracted candidate a tier field:
  "tier": "core"     — Direct, specific evidence tied to the waste stream conversion or primary application. Score usually 70–100.
  "tier": "adjacent" — Related domain expertise that provides useful context but is not directly primary. Score 45–69.

For "waste_byproduct_reuse" briefs: DO NOT suppress candidates simply because they work on related waste streams or related fiber/material types. If a keratin researcher works on wool protein fibers (not specifically poultry), they are "adjacent" not suppressed. If a biopolymer scientist has no connection to this specific waste, they are "adjacent" not suppressed. Only suppress candidates with ZERO connection to the value chain.

NEVER include candidates with score below 45.

CONFIDENCE LABEL:
  85–100: "High confidence"
  70–84:  "Strong confidence"
  55–69:  "Adjacent perspective"
  45–54:  "Broad adjacency"
  <45:    SUPPRESSED — do not include

` : `━━━ TIERING — ASSIGN TO EVERY CANDIDATE ━━━

Assign every extracted candidate a tier field:
  "tier": "core"     — Direct evidence tied to primary expert pools. Score usually 75–100.
  "tier": "adjacent" — Useful indirect perspective. Not directly in the primary pool. Score 55–74.

NEVER include candidates with score below 55.

CONFIDENCE LABEL (use this mapping in your justification language):
  85–100: "High confidence"
  70–84:  "Strong confidence"
  55–69:  "Adjacent perspective" or "Indirect relevance"
  <55:    SUPPRESSED — do not include at all

`}
${vci?.briefType === 'product_material_substitution' ? `━━━ SCORING RUBRIC (product/material substitution) ━━━

Start from 0 for each candidate and add:
  +30  Direct experience with this product's manufacturing or value chain
  +25  Direct materials/substrate expertise relevant to this specific product
  +20  Direct evidence of a sustainable or alternative material program for this product
  +15  Technical constraints knowledge (durability, certification, processing, embedded components)
  +10  Market/procurement insight from buyer or platform side

Penalties:
  −25  Generic end-market role with no manufacturing or material evidence
  −20  Generic ESG/sustainability without product-specific material evidence
  −20  Generic material science without this product's application constraint
  −15  LinkedIn-only evidence with no corroboration
  −30  Speculative rationale ("could apply", "may be relevant", "likely involved")

` : vci?.briefType === 'waste_byproduct_reuse' ? `━━━ SCORING RUBRIC (waste/byproduct reuse) ━━━

Primary expert pools for this brief: ${vci.primaryExpertPools.join(', ')}
Key technical constraints: ${vci.keyTechnicalConstraints.join(', ')}

Start from 0 for each candidate and add:
  +35  Direct evidence of converting THIS waste stream (or a nearly identical one) into the target application
  +30  Expertise in the specific transformation process relevant to this brief (${vci.keyTechnicalConstraints[0] ?? 'extraction, processing, conversion'})
  +25  Direct expertise in the target application area (${vci.primaryExpertPools[0] ?? 'target application domain'})
  +20  Byproduct valorization expertise in the relevant source material or a closely analogous waste stream (${vci.primaryExpertPools[1] ?? 'related waste stream'})
  +15  Related technical expertise in the same material class, even if not this exact waste stream
  +10  Market/commercialization evidence for waste-derived or bio-based materials in this application

Penalties:
  −20  Generic industry executive in the source sector with no waste valorization or material evidence
  −20  Generic end-market role with no bio-based material science or waste-stream evidence
  −20  Generic sustainability/ESG without specific waste-to-material program evidence
  −25  Speculative rationale ("could apply", "may be relevant", "likely could be useful")

Adjacent threshold (score 45–69): assign tier "adjacent"
Core threshold (score ≥70): assign tier "core"
Suppress (score <45): do not include

` : ''}━━━ EXTRACTION INSTRUCTIONS ━━━

- Use the person's name exactly as it appears in the search result
- Every expert MUST have a real source_url from the search results — do NOT fabricate URLs
- source_label: "LinkedIn", "Company Website", "News Article", "Professional Directory", or "Government Website"
- source_links: include ALL relevant URLs from the search results for this person with descriptive labels
- If a category has no candidates meeting these standards, return [] for that category — do not fill slots with weak matches

Return ONLY valid JSON. Critical formatting rules:
- No markdown fences, no prose before or after the JSON object
- No trailing commas anywhere
- All string values must be properly JSON-escaped: use \\n for newlines, \\" for quotes within strings — never raw newlines or unescaped double-quotes inside string values
- Keep claim, relevance, and justification fields to one concise sentence each — do not embed complex punctuation or quotation marks in these fields
- evidenceItems is optional — omit the field entirely rather than including malformed entries

{
  "query_analysis": {
    "industry": "primary industry sector",
    "function": "primary business function",
    "key_topics": ["topic1", "topic2", "topic3"],
    "keywords": ["kw1", "kw2", "kw3", "kw4"],
    "confidence": "High",
    "confidence_reason": "one sentence"
  },
  "experts": [
    {
      "id": "exp-1",
      "name": "Full Name",
      "title": "Job Title",
      "company": "Company Name",
      "location": "City, State",
      "category": "Operator",
      "outsider_subcategory": null,
      "justification": "Specific evidence from the search result showing direct domain involvement.",
      "relevance_score": 85,
      "tier": "core",
      "valueChainLabel": "Manufacturing / Production",
      "anonymizedDescriptor": "Owns and ran a regional veterinary clinic group as President & CEO — scaled it to dozens of locations and a nine-figure revenue",
      "anonymizedJustification": "Ran multi-site consolidation across a regional clinic group through two ownership transitions.",
      "source_url": "https://...",
      "source_label": "LinkedIn",
      "source_links": [
        { "url": "https://...", "label": "LinkedIn Profile", "type": "LinkedIn" }
      ],
      "evidenceItems": [
        {
          "id": "ev-1",
          "sourceLabel": "Processing World Interview",
          "sourceUrl": "https://...",
          "claim": "One sentence: what specific thing this evidence proves about the person.",
          "relevance": "One sentence: why this evidence matters for the research question.",
          "evidenceType": "role",
          "confidence": "high"
        }
      ]
    }
  ]
}

evidenceItems rules:
- Include 1–3 items per expert; omit the field entirely if no strong evidence exists
- evidenceType: "role" | "publication" | "company" | "conference" | "credential" | "other"
- confidence: "high" (directly stated in the result) | "medium" (reasonably inferred) | "low" (do not include)
- claim and relevance must be distinct sentences — do not repeat the justification
- sourceUrl must be a real URL from the search results; omit if none available

- outsider_subcategory: "Government", "Large Enterprise", or "Small Business" for Outsiders; null for others
- valueChainLabel: a short human-readable label describing where in the value chain this expert sits. Use the labels provided in the VALUE CHAIN CONTEXT above if available, or describe their position: "Waste Source / Byproducts", "Fiber & Textile Science", "Biomaterials / Processing", "Commercialization", "Adjacent Materials", "Manufacturing", "Supply Chain", "Market / Advisory", etc.

━━━ ANONYMIZED PROFILE (required for every expert) ━━━

Clients see an anonymized version of each expert until a call is scheduled — that is how this platform stays in the middle of the relationship. Write both of these fields for EVERY expert, from the same evidence you used for the justification.

- anonymizedDescriptor (max ${MAX_DESCRIPTOR_LEN} characters): strong ownership verb + role level + generalized organization type + scale in words, never numerals. Example: "Owns and ran a regional veterinary clinic group as President & CEO — scaled it to dozens of locations and a nine-figure revenue"
- anonymizedJustification (max ${MAX_JUSTIFICATION_LEN} characters): the relevance rationale above, one sentence, with every identifying name generalized.

${ANONYMIZATION_RULES}

RELEVANCE SCORING GUIDANCE (0–100):
- Base score from direct evidence of domain experience
- +10–15 if candidate can directly address the key questions stated in the brief
- +10 if candidate's background lets them validate or challenge the initial hypotheses
- +15 if candidate clearly has the must-have expertise specified in the brief
- +5 if candidate has any nice-to-have expertise
- +5 if candidate fits a perspective type listed in perspectives needed
- +5 if candidate has strong, multiple source links
- −20 or EXCLUDE if candidate only matches generic keywords without specific domain evidence
- EXCLUDE if candidate matches any company or person in the exclusions list
- Sort by relevance_score descending within each category
- Aim for 4–5 experts per category (12–15 total) when the evidence supports it — quality over quantity
- "Medium confidence" is acceptable when evidence is direct but incomplete (e.g., role is clear but one dimension is inferred)
- Do NOT include "low confidence" candidates where the connection to the domain relies primarily on inference
- If a category has fewer than 4 strong candidates, return only those that pass — do not pad with weak matches`;

    llmCallCount++;
    const { value: extractionResponse, retries: extractRetries } = await callWithRetry(
      () => client.messages.create({
        model:      'claude-opus-4-6',
        max_tokens: 12000,
        messages:   [{ role: 'user', content: extractionPrompt }],
      }),
      2,
    );
    llmRetryCount += extractRetries;

    const extractionBlock = extractionResponse.content.find(b => b.type === 'text');
    if (!extractionBlock || extractionBlock.type !== 'text') throw new Error('No text in extraction response');

    // ── Step 6: Validate and parse JSON output ───────────────────────────────
    let extractedData: Record<string, unknown>;
    try {
      extractedData = extractJSON(extractionBlock.text) as Record<string, unknown>;
    } catch (parseErr) {
      parseStatus = 'failed';
      if (process.env.NODE_ENV === 'development') {
        const pe = parseErr instanceof ParseError ? parseErr : null;
        console.error('[generate-experts] parse_failed', JSON.stringify({
          reason:              pe?.message ?? String(parseErr),
          outputLength:        pe?.outputLength ?? extractionBlock.text.length,
          approximatePosition: pe?.approximatePosition,
          // No raw output, no brief content, no API keys logged
        }));
      }
      throw new GenerateExpertsError(
        'Expert generation failed while formatting results',
        'expert_generation_parse_failed',
        500,
      );
    }

    const rawCandidates: unknown[] = Array.isArray(extractedData.experts) ? extractedData.experts : [];

    // ── Step 7: Multi-stage validation pipeline ──────────────────────────────
    // Everything the model returned is untrusted. Stages run in order and each
    // records why it dropped a candidate into `discardReasons`, which is the only
    // place the reject breakdown is visible (dev-only perf log, Step 8):
    //   7a structural + hedge-language filter   7b full-name identity (may spend
    //   up to 3 extra searches resolving "J. Subbiah")   7c conflict companies
    //   from the brief   7d same-source clustering   7e already-found names
    //   7e(bis) score floor + core/adjacent tier split.
    // Nothing here is persisted; lib/sourcingJob.ts does the writing.
    const conflictCompanies                    = extractConflictCompanies(briefContext);
    const discardReasons: Record<string, number> = {};
    let identityResolvedCount       = 0;
    let incompleteNameRejectedCount = 0;
    let conflictRejectedCount       = 0;

    // 7a: Structural normalize + hedge filter (synchronous)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const structurallyValid = rawCandidates.map(normalizeExpert).filter((expert: any) => {
      if (!expert) {
        discardReasons['invalid_structure'] = (discardReasons['invalid_structure'] ?? 0) + 1;
        return false;
      }
      if (expert.name === expert.name.toUpperCase() && expert.name.length > 3) {
        discardReasons['all_caps_name'] = (discardReasons['all_caps_name'] ?? 0) + 1;
        return false;
      }
      const hedge = hedgeReason(expert.justification ?? '');
      if (hedge) {
        const key = `hedge:${hedge}`;
        discardReasons[key] = (discardReasons[key] ?? 0) + 1;
        return false;
      }
      return true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as Record<string, any>[];

    const initialCandidatesExtracted = structurallyValid.length;

    // 7b: Identity validation — full name check, with targeted search resolution
    //     for promising partial-name candidates (score ≥ 60). Cap at
    //     MAX_RESOLVE_ATTEMPTS to bound extra latency.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toResolve = new Set<Record<string, any>>(
      structurallyValid
        .filter(e => !isFullHumanName(e.name as string) && (e.relevance_score ?? 0) >= 60)
        .sort((a, b) => ((b.relevance_score as number) ?? 0) - ((a.relevance_score as number) ?? 0))
        .slice(0, MAX_RESOLVE_ATTEMPTS),
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const identityPromises = structurallyValid.map(async (expert: Record<string, any>) => {
      if (isFullHumanName(expert.name as string)) return expert;

      if (toResolve.has(expert)) {
        const resolution = await resolvePartialNameCandidate(expert);
        if (resolution.resolved) {
          identityResolvedCount++;
          return {
            ...expert,
            name: resolution.fullName,
            source_links: [
              ...((expert.source_links as unknown[]) ?? []),
              { url: resolution.evidenceUrl, label: 'Name resolved via search', type: 'News Article' },
            ],
          };
        }
      }

      incompleteNameRejectedCount++;
      discardReasons['incomplete_name_unresolved'] =
        (discardReasons['incomplete_name_unresolved'] ?? 0) + 1;
      return null;
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const identityValidated = (await Promise.all(identityPromises)).filter(Boolean) as Record<string, any>[];

    // 7c: Conflict filtering — reject current employees of conflicted companies
    const conflictFiltered = identityValidated.filter(expert => {
      if (isConflictedExpert(expert, conflictCompanies)) {
        conflictRejectedCount++;
        discardReasons['conflict_company'] = (discardReasons['conflict_company'] ?? 0) + 1;
        return false;
      }
      return true;
    });

    // 7d: Same-source clustering — suppress weak extras from the same article
    const { kept: clusteredExperts, suppressed: sameSourceSuppressedCount } =
      applySameSourceClustering(conflictFiltered);

    // 7e: Exclude already-found experts (supplementary search dedup)
    // Case-insensitive match on name only — company may differ across sources.
    const validatedExperts = excludeNamesSet
      ? clusteredExperts.filter(e => !excludeNamesSet.has(((e.name as string) ?? '').toLowerCase().trim()))
      : clusteredExperts;

    // ── Step 7e: Tier splitting ─────────────────────────────────────────────
    // Split validated experts into core and adjacent based on Claude's tier field.
    // Enforce a score floor: score < 50 is always suppressed regardless of tier.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const coreExperts: Record<string, any>[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adjacentExperts: Record<string, any>[] = [];
    let suppressedFromTiering = 0;

    // DIAGNOSTIC: log all raw scores + tiers before any suppression is applied
    {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const _floor = vci?.briefType === 'waste_byproduct_reuse' ? 45
                   : vci?.briefType === 'product_material_substitution' ? 55 : 50;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const _pairs = (validatedExperts as Record<string, any>[]).map(e => ({
        score: (e.relevance_score as number) ?? 0,
        tier:  (e.tier as string) ?? '(missing)',
      }));
      console.log('[generate-experts] tier-split-diagnostic', JSON.stringify({
        vciAvailable:     vci !== null,
        briefType:        vci?.briefType ?? 'null',
        suppressionFloor: _floor,
        totalCandidates:  validatedExperts.length,
        belowFloor:       _pairs.filter(p => p.score < _floor).length,
        scoreTiers:       _pairs,
      }));
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const e of validatedExperts as Record<string, any>[]) {
      const score = (e.relevance_score as number) ?? 0;
      const tier  = (e.tier as string) ?? 'core'; // default to core if missing

      // Suppression floor is briefType-specific: waste/byproduct briefs have shallower expert pools
      // and adjacent experts are more valuable — lower floor prevents over-suppression.
      const suppressionFloor = vci?.briefType === 'waste_byproduct_reuse' ? 45
                             : vci?.briefType === 'product_material_substitution' ? 55
                             : 50;

      if (score < suppressionFloor) {
        suppressedFromTiering++;
        discardReasons['score_below_floor'] = (discardReasons['score_below_floor'] ?? 0) + 1;
        continue;
      }

      // When VCI failed the extraction prompt had no definition of "primary expert pools",
      // so Claude cannot meaningfully distinguish core from adjacent — everything becomes
      // "adjacent" as a safe default. Treat all passing candidates as core in that case.
      const effectiveTier = vci === null ? 'core' : tier;

      if (effectiveTier === 'adjacent') {
        adjacentExperts.push(e);
      } else {
        coreExperts.push(e);
      }
    }

    // Cap adjacent experts — they are supplementary, not primary results
    const trimmedAdjacent = adjacentExperts
      .sort((a, b) => ((b.relevance_score as number) ?? 0) - ((a.relevance_score as number) ?? 0))
      .slice(0, MAX_ADJACENT);

    // ── Step 8: Performance log (dev only) ───────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scores = coreExperts.map((e: any) => (e.relevance_score as number) ?? 0);
    const averageScore = scores.length
      ? Math.round(scores.reduce((a: number, b: number) => a + b, 0) / scores.length)
      : 0;

    const sourceTypeBreakdown: Record<string, number> = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const e of [...coreExperts, ...trimmedAdjacent] as any[]) {
      const label = (e.source_label as string) ?? 'Unknown';
      sourceTypeBreakdown[label] = (sourceTypeBreakdown[label] ?? 0) + 1;
    }

    // Confidence distribution from scores
    const confidenceDistribution: Record<string, number> = { high: 0, strong: 0, adjacent: 0 };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const e of coreExperts as any[]) {
      const s = (e.relevance_score as number) ?? 0;
      if (s >= 85)      confidenceDistribution['high']     = (confidenceDistribution['high'] ?? 0) + 1;
      else if (s >= 70) confidenceDistribution['strong']   = (confidenceDistribution['strong'] ?? 0) + 1;
      else              confidenceDistribution['adjacent']  = (confidenceDistribution['adjacent'] ?? 0) + 1;
    }

    logPerf({
      provider:                     getSearchProvider().name,
      searchQueryCount:             allQueryPairs.length,
      totalSearchResults,
      dedupedSearchResults,
      dupeCount,
      llmCallCount,
      llmRetryCount,
      queryGenMethod,
      valueChainInferred:           vci !== null,
      briefType:                    vci?.briefType ?? 'general',
      initialCandidatesExtracted,
      candidatesAfterIdentityCheck: identityValidated.length,
      identityResolvedCount,
      incompleteNameRejectedCount,
      conflictRejectedCount,
      sameSourceSuppressedCount,
      coreExpertCount:              coreExperts.length,
      adjacentExpertCount:          trimmedAdjacent.length,
      suppressedFromTiering,
      candidatesRejected:           rawCandidates.length - coreExperts.length - trimmedAdjacent.length,
      expertsReturned:              coreExperts.length,
      rejectedByReason:             discardReasons,
      averageScore,
      sourceTypeBreakdown,
      confidenceDistribution,
      parseStatus,
      durationMs:                   Date.now() - startMs,
    });

    // ── Step 9: Compute insufficient_categories and return ───────────────────
    const categories = ['Operator', 'Advisor', 'Outsider'] as const;
    const insufficient_categories = categories
      .map(cat => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const count = coreExperts.filter((e: any) => (e.category as string) === cat).length;
        return count < 2 ? { category: cat as string, found: count, required: 2 } : null;
      })
      .filter((c): c is { category: string; found: number; required: number } => c !== null);

    // Flag limited pool: fewer than 3 core experts found despite a valid brief.
    // Client should surface "Limited direct expert pool" message when true.
    const limited_pool = coreExperts.length < 3;

    // Provide a safe value chain summary for client-side transparency.
    // Contains only the inferred pool names, no raw brief content.
    const value_chain_summary = vci
      ? {
          briefType:          vci.briefType,
          primaryExpertPools: vci.primaryExpertPools,
          endMarket:          vci.endMarket,
        }
      : null;

    return {
      query_analysis:       extractedData.query_analysis,
      experts:              coreExperts,
      adjacent_experts:     trimmedAdjacent,
      limited_pool,
      value_chain_summary,
      insufficient_categories,
    };

  } catch (err) {
    // Expected failures already carry a code + status — pass them through.
    if (err instanceof GenerateExpertsError) throw err;
    // ── Overload / rate-limit → 503 so the caller can show a friendly retry ──
    if (isProviderOverloaded(err)) {
      throw new GenerateExpertsError(
        'Expert generation is temporarily overloaded. Please retry in a minute.',
        'provider_overloaded',
        503,
      );
    }
    // Safe error log: message only, no prompt content, no keys
    console.error('[generate-experts] unhandled error', err instanceof Error ? err.message : String(err));
    throw new GenerateExpertsError(
      err instanceof Error ? err.message : 'Unknown error',
      'generation_failed',
      500,
    );
  }
}
