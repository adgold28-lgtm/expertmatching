// Expert anonymization for client-facing views — the single chokepoint.
//
// WHY: ExpertMatch's business depends on clients not going around the platform
// to contact experts directly. Before a call is booked there is no reason a
// client needs a name, an employer, a LinkedIn URL or a source link — those are
// exactly the fields that let them do the outreach themselves.
//
// THE RULE: a viewer with role 'user' sees an expert ANONYMIZED until that
// expert's status reaches 'scheduled' or later. Admins (ExpertMatch staff) see
// everything, always. Raw data is always stored — this is a presentation-layer
// filter applied at the API boundary, never in the store, because
// server-internal callers (triggerOverlapCheck, invoicing, ICS generation,
// email sequences) need the real identity.
//
// WHERE: every route that returns `{ project }` to the browser calls
// redactProjectForViewer. lib/projectStore.getProject stays raw.
//
// Pure functions — no I/O, no throwing. Unit-checked by scripts/check-redaction.ts.

import type { Expert, ExpertStatus, Project, ProjectExpert } from '../types';
import { EXPERT_STATUSES } from './expertPipeline';
import { toInitialForm } from './nameValidation';
import { fallbackDescriptor } from './anonymizeExpert';
import { classifySeniority, TIER_PRICING } from './seniorityClassifier';

export interface Viewer {
  role: 'admin' | 'user';
}

// ─── Reveal predicate ─────────────────────────────────────────────────────────

/** Identity is revealed once the expert reaches this point in EXPERT_STATUSES. */
const REVEAL_AT: ExpertStatus = 'scheduled';
const REVEAL_INDEX = EXPERT_STATUSES.indexOf(REVEAL_AT);

/**
 * `rejected` and `rejected_after_outreach` sit after 'scheduled' in
 * EXPERT_STATUSES only because that array lists terminal outcomes last, not
 * because they represent later pipeline progress. Neither ever had a call
 * booked, so neither reveals identity.
 */
const NEVER_REVEALED = new Set<ExpertStatus>(['rejected', 'rejected_after_outreach']);

/** True once a client is entitled to the expert's real identity. */
export function isIdentityRevealed(status: ExpertStatus): boolean {
  if (NEVER_REVEALED.has(status)) return false;
  const index = EXPERT_STATUSES.indexOf(status);
  // An unrecognised status fails closed — stay anonymized.
  return index >= 0 && index >= REVEAL_INDEX;
}

// ─── Field stripping ──────────────────────────────────────────────────────────

function omitKeys<T extends object>(obj: T, keys: readonly (keyof T)[]): T {
  const out = { ...obj } as Record<string, unknown>;
  for (const key of keys) delete out[key as string];
  return out as T;
}

/**
 * ProjectExpert fields a non-admin must never receive, at any status:
 * outreach plumbing (the contact path itself), the expert-side rate,
 * staff-only assessments, and every credential/token. `userNotes` are the
 * client's own notes — kept. `clientRate`, `zoomJoinUrl` and
 * `stripePaymentLinkUrl` are client-facing — kept.
 *
 * Note on `expert.tierPricing`: it stays, and it carries the TIER DEFAULT
 * opening offer, not this engagement's number. The 50/50 split is published
 * on the pricing page and clientRate is shown "includes ExpertMatch fee", so
 * the default is derivable either way. What must not leak is the negotiated
 * `expertRate` above — that is the expert's own counter.
 */
const INTERNAL_PROJECT_EXPERT_KEYS: readonly (keyof ProjectExpert)[] = [
  // Contact path — the whole point of the platform is that clients don't get this
  'contactEmail',
  'contactCandidates',
  'emailVerificationStatus',
  'emailProvider',
  'emailCheckedAt',
  'contactStatus',
  'suggestedDomains',
  'publicContactEmails',
  'selectedDomain',
  'selectedContactPathType',
  // The expert-side rate. Per docs/MATCHY_SPEC.md "Pricing rule", the two
  // numbers of an engagement never share an audience: the client sees
  // `clientRate` (kept below), the expert and staff see `expertRate`. It is
  // stripped at every status, including after the identity reveal — what we
  // pay the expert stays between us and the expert.
  'expertRate',
  // The expert's own counter, expert-side. Same rule: the client is shown
  // `clientCounterRate` (kept), which is clientRateFor() of this number.
  // `counterRateProposed` is the legacy field the retired cadence wrote — it
  // holds the same expert-side figure, so it is stripped too.
  'expertCounterRate',
  'counterRateProposed',
  // Staff-only assessment and drafting
  'rejectionNotes',
  'screeningNotes',
  'outreachSubject',
  'outreachDraft',
  // Credentials and tokens — never leave the server
  'availabilityTokenHash',
  'calendarAccessToken',
  'calendarRefreshToken',
  'calendlyAccessToken',
  'oauthState',
  'outreachToken',
  'zoomStartUrl',
  // Expert-side payout internals
  'stripeConnectAccountId',
  'stripeTransferId',
  'expertPaidAt',
  'expertOnboardingStatus',
];

/**
 * Project fields a non-admin must never receive. `clientAvailabilityTokenHash`
 * is deliberately NOT here: it is a SHA-256 digest (not a usable credential)
 * and components/ClientSchedulingSection reads its presence to render the
 * "requested — awaiting response" state.
 */
const INTERNAL_PROJECT_KEYS: readonly (keyof Project)[] = [
  'confidentialNotes',
  'clientAvailabilityToken',
  'clientCalendarAccessToken',
  'clientCalendarRefreshToken',
  'stripeCustomerId',
];

// ─── Location generalization ──────────────────────────────────────────────────

/**
 * Regions coarse enough to be non-identifying. Anything narrower (a city, a
 * US state) is dropped rather than guessed at.
 */
const SAFE_REGIONS = new Set([
  'us', 'usa', 'u.s.', 'u.s.a.', 'united states', 'united states of america',
  'uk', 'u.k.', 'united kingdom', 'great britain',
  'canada', 'mexico', 'brazil', 'eu', 'europe', 'emea', 'apac', 'latam',
  'ireland', 'germany', 'france', 'spain', 'italy', 'portugal', 'netherlands',
  'belgium', 'switzerland', 'austria', 'sweden', 'norway', 'denmark', 'finland',
  'poland', 'india', 'china', 'japan', 'south korea', 'singapore', 'australia',
  'new zealand', 'israel', 'uae', 'united arab emirates', 'south africa',
]);

/** Keeps a country/region if the string ends in one; otherwise omits location. */
export function generalizeLocation(location: string | undefined): string {
  if (!location) return '';
  const parts = location.split(',').map(p => p.trim()).filter(Boolean);
  if (parts.length === 0) return '';
  const last = parts[parts.length - 1];
  return SAFE_REGIONS.has(last.toLowerCase()) ? last : '';
}

// ─── Expert anonymization ─────────────────────────────────────────────────────

/**
 * Rewrites an Expert into its anonymized presentation:
 *   name          → "Scott S."
 *   title/company → '' , replaced by anonymizedDescriptor
 *   justification → anonymizedJustification (or '')
 *   removed       → linkedin_*, source_url/label, source_links, evidenceItems
 *   generalized   → location (region/country, or dropped)
 *   kept          → id, category, valueChainLabel, seniorityTier, tierPricing,
 *                   relevance_score
 *
 * `title`, `company` and `justification` are required fields on Expert, so they
 * are emptied rather than deleted; every render site treats empty as absent.
 * The descriptor is never empty — it falls back to the deterministic form.
 */
function anonymizeExpert(expert: Expert): Expert {
  const tier      = expert.seniorityTier ?? classifySeniority(expert.title ?? '');
  const region    = generalizeLocation(expert.location);
  const rationale = expert.anonymizedJustification?.trim() ?? '';

  return {
    id:              expert.id,
    name:            toInitialForm(expert.name) || expert.name,
    title:           '',
    company:         '',
    location:        region,
    category:        expert.category,
    ...(expert.outsider_subcategory !== undefined && {
      outsider_subcategory: expert.outsider_subcategory,
    }),
    justification:   rationale,
    relevance_score: expert.relevance_score,
    source_url:      '',
    source_label:    '',
    source_links:    [],
    ...(expert.valueChainLabel && { valueChainLabel: expert.valueChainLabel }),
    seniorityTier:   tier,
    tierPricing:     expert.tierPricing ?? TIER_PRICING[tier],
    anonymizedDescriptor:    expert.anonymizedDescriptor?.trim() || fallbackDescriptor(expert),
    ...(rationale && { anonymizedJustification: rationale }),
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns the ProjectExpert as this viewer is allowed to see it. Admins get the
 * object untouched (identity-equal, so callers can rely on reference equality).
 */
export function redactExpertForViewer(pe: ProjectExpert, viewer: Viewer): ProjectExpert {
  if (viewer.role === 'admin') return pe;

  const stripped = omitKeys(pe, INTERNAL_PROJECT_EXPERT_KEYS);
  if (isIdentityRevealed(pe.status)) return stripped;

  return { ...stripped, expert: anonymizeExpert(pe.expert) };
}

/**
 * Returns the Project as this viewer is allowed to see it: every expert
 * redacted, plus the project-level internal fields removed.
 *
 * Call this in the route layer, on everything returned to the browser. Do NOT
 * call it in lib/projectStore — server-internal callers need raw data.
 */
export function redactProjectForViewer(project: Project, viewer: Viewer): Project {
  if (viewer.role === 'admin') return project;

  return {
    ...omitKeys(project, INTERNAL_PROJECT_KEYS),
    experts: project.experts.map(pe => redactExpertForViewer(pe, viewer)),
    // Adjacent sourcing candidates are pre-project Experts with no status of
    // their own — they have not been contacted, so they are always anonymized.
    ...(project.sourcingAdjacent && {
      sourcingAdjacent: project.sourcingAdjacent.map(anonymizeExpert),
    }),
  };
}
