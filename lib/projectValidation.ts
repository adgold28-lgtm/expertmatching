// Validation and sanitization helpers for Project Workspace data.
// All functions are pure — no I/O, no side effects.
// These run at the API boundary before any data reaches the store.

import type { Expert, ExpertStatus, SourceLink, EvidenceItem } from '../types';

// ─── Limits ───────────────────────────────────────────────────────────────────

export const LIMITS = {
  projectName:          200,
  researchQuestion:    2_000,
  industry:              100,
  functionField:         100,
  geography:             100,
  seniority:             100,
  notes:              10_000,
  confidentialNotes:  10_000,
  expertId:              100,
  expertName:            200,
  expertTitle:           300,
  expertCompany:         300,
  expertLocation:        200,
  expertJustification: 2_000,
  sourceUrl:             500,
  sourceLabel:           200,
  userNotes:           5_000,
  screeningNotes:      5_000,
  contactEmail:          200,
  availability:          500,
  rateExpectation:       200,
  scheduledTime:         200,
  outreachSubject:       300,
  outreachDraft:      10_000,
  timeline:              200,
  keyQuestions:        5_000,
  initialHypotheses:   5_000,
  additionalContext:   5_000,
  mustHaveExpertise:   2_000,
  niceToHaveExpertise: 2_000,
  targetCompanies:     2_000,
  companiesToAvoid:    2_000,
  peopleToAvoid:       2_000,
  conflictExclusions:  2_000,
} as const;

// Valid values for perspectivesNeeded
export const VALID_PERSPECTIVES = new Set([
  'operator',
  'advisor_consultant',
  'regulator',
  'customer_end_user',
  'competitor',
  'supplier_vendor',
  'investor_analyst',
  'academic_researcher',
]);

export const MAX_EXPERTS_PER_PROJECT      = 50;
export const MAX_SOURCE_LINKS_PER_EXPERT  = 10;
export const MAX_EVIDENCE_ITEMS_PER_EXPERT = 5;

// ─── Text helpers ─────────────────────────────────────────────────────────────

export function sanitizeText(value: unknown, maxLen: number): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLen);
}

// ─── URL sanitization ─────────────────────────────────────────────────────────

// Returns the URL only if it is valid http/https. Returns null for anything
// else (javascript:, data:, relative paths, unparseable strings, etc.).
export function sanitizeSourceUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim().slice(0, LIMITS.sourceUrl);
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return trimmed;
  } catch {
    return null;
  }
}

// ─── Source-link validation ───────────────────────────────────────────────────

const VALID_SOURCE_LINK_TYPES = new Set([
  'LinkedIn', 'Article', 'Company Website', 'Professional Directory',
  'Government Website', 'Other',
]);

function validateSourceLink(raw: unknown): SourceLink | null {
  if (!raw || typeof raw !== 'object') return null;
  const l   = raw as Record<string, unknown>;
  const url = sanitizeSourceUrl(l.url);
  if (!url) return null;
  const label = sanitizeText(l.label, LIMITS.sourceLabel) || 'Source';
  const type  = typeof l.type === 'string' && VALID_SOURCE_LINK_TYPES.has(l.type)
    ? (l.type as SourceLink['type'])
    : 'Other';
  return { url, label, type };
}

// ─── EvidenceItem validation ──────────────────────────────────────────────────

const VALID_EVIDENCE_TYPES = new Set(['role', 'publication', 'company', 'conference', 'credential', 'other']);
const VALID_CONFIDENCE     = new Set(['high', 'medium', 'low']);

function validateEvidenceItem(raw: unknown): EvidenceItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  const id         = sanitizeText(e.id,         64);
  const sourceLabel = sanitizeText(e.sourceLabel, 200);
  const claim      = sanitizeText(e.claim,      500);
  const relevance  = sanitizeText(e.relevance,  500);
  if (!id || !sourceLabel || !claim || !relevance) return null;
  const sourceUrl   = typeof e.sourceUrl === 'string' ? sanitizeSourceUrl(e.sourceUrl) ?? undefined : undefined;
  const evidenceType = typeof e.evidenceType === 'string' && VALID_EVIDENCE_TYPES.has(e.evidenceType)
    ? (e.evidenceType as EvidenceItem['evidenceType'])
    : 'other';
  const confidence = typeof e.confidence === 'string' && VALID_CONFIDENCE.has(e.confidence)
    ? (e.confidence as EvidenceItem['confidence'])
    : undefined;
  return { id, sourceLabel, claim, relevance, ...(sourceUrl && { sourceUrl }), evidenceType, ...(confidence && { confidence }) };
}

// ─── Expert validation ────────────────────────────────────────────────────────

const VALID_CATEGORIES  = new Set(['Operator', 'Advisor', 'Outsider']);
const VALID_OUTSIDER_SC = new Set([null, undefined, 'Government', 'Large Enterprise', 'Small Business']);
const VALID_LI_CONF     = new Set(['high', 'medium', 'low']);

// Returns a sanitized Expert or null if required fields are missing.
// Strips any fields not present in the Expert interface so no raw provider
// response data can slip through.
export function validateProjectExpert(raw: unknown): Expert | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;

  const id   = sanitizeText(e.id,   LIMITS.expertId);
  const name = sanitizeText(e.name, LIMITS.expertName);
  if (!id || !name) return null;

  const sourceLinks: SourceLink[] = Array.isArray(e.source_links)
    ? e.source_links
        .slice(0, MAX_SOURCE_LINKS_PER_EXPERT)
        .map(validateSourceLink)
        .filter((l): l is SourceLink => l !== null)
    : [];

  const evidenceItems: EvidenceItem[] | undefined = Array.isArray(e.evidenceItems)
    ? e.evidenceItems
        .slice(0, MAX_EVIDENCE_ITEMS_PER_EXPERT)
        .map(validateEvidenceItem)
        .filter((ev): ev is EvidenceItem => ev !== null)
    : undefined;

  const category = typeof e.category === 'string' && VALID_CATEGORIES.has(e.category)
    ? (e.category as Expert['category'])
    : 'Operator';

  const outsiderSC = typeof e.outsider_subcategory === 'string'
    ? VALID_OUTSIDER_SC.has(e.outsider_subcategory)
      ? (e.outsider_subcategory as Expert['outsider_subcategory'])
      : null
    : undefined;

  const liConf = typeof e.linkedin_confidence === 'string' && VALID_LI_CONF.has(e.linkedin_confidence)
    ? (e.linkedin_confidence as Expert['linkedin_confidence'])
    : undefined;

  const liUrl = sanitizeSourceUrl(e.linkedin_url) ?? undefined;

  return {
    id,
    name,
    title:          sanitizeText(e.title,         LIMITS.expertTitle),
    company:        sanitizeText(e.company,        LIMITS.expertCompany),
    location:       sanitizeText(e.location,       LIMITS.expertLocation),
    category,
    outsider_subcategory: outsiderSC,
    justification:  sanitizeText(e.justification,  LIMITS.expertJustification),
    relevance_score: typeof e.relevance_score === 'number'
      ? Math.min(Math.max(Math.round(e.relevance_score), 0), 100)
      : 0,
    source_url:    sanitizeSourceUrl(e.source_url) ?? '',
    source_label:  sanitizeText(e.source_label,   LIMITS.sourceLabel),
    source_links:  sourceLinks,
    ...(evidenceItems && evidenceItems.length > 0 && { evidenceItems }),
    ...(liUrl  !== undefined && { linkedin_url:        liUrl }),
    ...(liConf !== undefined && { linkedin_confidence: liConf }),
    ...(typeof e.linkedin_source === 'string' && {
      linkedin_source: sanitizeText(e.linkedin_source, LIMITS.sourceLabel),
    }),
  };
}

// ─── Project creation input validation ───────────────────────────────────────

export interface ProjectCreateData {
  name:              string;
  researchQuestion?: string;  // optional — filled later when user runs search
  industry:          string;
  function:          string;
  geography:         string;
  seniority:         string;
  notes?:            string;
  experts:           Array<{ expert: Expert; status?: ExpertStatus }>;
}

export interface FieldError { field: string; error: string; }

export function validateCreateProjectInput(
  body: Record<string, unknown>,
): { errors: FieldError[] } | { data: ProjectCreateData } {
  const errors: FieldError[] = [];

  const name             = sanitizeText(body.name,             LIMITS.projectName);
  const researchQuestion = sanitizeText(body.researchQuestion, LIMITS.researchQuestion);
  const industry         = sanitizeText(body.industry,         LIMITS.industry);
  const fn               = sanitizeText(body.function,         LIMITS.functionField);
  const geography        = sanitizeText(body.geography,        LIMITS.geography);
  const seniority        = sanitizeText(body.seniority,        LIMITS.seniority);
  const notes            = typeof body.notes === 'string'
    ? sanitizeText(body.notes, LIMITS.notes) || undefined
    : undefined;

  if (!name) errors.push({ field: 'name', error: 'required' });
  if (errors.length > 0) return { errors };

  // Validate experts array (may be empty for a fresh project)
  const rawExperts = Array.isArray(body.experts) ? body.experts : [];
  if (rawExperts.length > MAX_EXPERTS_PER_PROJECT) {
    errors.push({ field: 'experts', error: `max ${MAX_EXPERTS_PER_PROJECT} experts per project` });
    return { errors };
  }

  const VALID_STATUSES: ExpertStatus[] = [
    'discovered', 'shortlisted', 'rejected', 'contact_found',
    'outreach_drafted', 'contacted', 'replied', 'scheduled', 'completed',
  ];

  const experts: Array<{ expert: Expert; status?: ExpertStatus }> = [];
  for (const raw of rawExperts) {
    if (!raw || typeof raw !== 'object') continue;
    const entry  = raw as Record<string, unknown>;
    const expert = validateProjectExpert(entry.expert);
    if (!expert) continue;
    const status = typeof entry.status === 'string' && VALID_STATUSES.includes(entry.status as ExpertStatus)
      ? (entry.status as ExpertStatus)
      : undefined;
    experts.push({ expert, status });
  }

  return { data: { name, researchQuestion: researchQuestion || '', industry, function: fn, geography, seniority, notes, experts } };
}
