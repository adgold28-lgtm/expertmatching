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
// server-internal callers (scheduling, invoicing, ICS generation,
// email sequences) need the real identity.
//
// WHERE: every route that returns `{ project }` to the browser calls
// redactProjectForViewer. lib/projectStore.getProject stays raw.
//
// Pure functions — no I/O, no throwing. Unit-checked by scripts/check-redaction.ts.

import type {
  Expert, ExpertStatus, Project, ProjectExpert, MatchyOutcome, SchedulingState,
} from '../types';
import { EXPERT_STATUSES } from './expertPipeline';
import { toInitialForm } from './nameValidation';
import { fallbackDescriptor, descriptorIsAnonymous } from './anonymizeExpert';
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

/** The two facts the reveal is decided from. */
export type RevealSubject = Pick<ProjectExpert, 'status' | 'booking' | 'zoomMeetingId'>;

/**
 * True once a client is entitled to the expert's real identity.
 *
 * THE SERVER DECIDES, NOT THE STATUS FIELD. `status` alone used to be enough,
 * and `status` is a field a project owner can write through
 * PUT /api/projects/[id]/experts/[eid] — so one request could reveal an expert
 * nobody had booked. The reveal now also needs evidence a call was actually
 * booked: `booking` (written only by lib/bookCall.ts when Zoom + ICS go out)
 * or, for engagements booked before Phase 2, the legacy `zoomMeetingId`.
 * Neither is accepted from a client request (the PUT route's allowlist), so a
 * client cannot manufacture the reveal condition.
 */
export function isIdentityRevealed(subject: RevealSubject): boolean {
  const { status } = subject;
  if (NEVER_REVEALED.has(status)) return false;
  const index = EXPERT_STATUSES.indexOf(status);
  // An unrecognised status fails closed — stay anonymized.
  if (index < 0 || index < REVEAL_INDEX) return false;
  return Boolean(subject.booking?.bookedAt) || Boolean(subject.zoomMeetingId);
}

// ─── Field stripping ──────────────────────────────────────────────────────────

// `keys` is PropertyKey[] rather than (keyof T)[] so a LEGACY key — one that no
// longer exists on the type but can still sit in a jsonb blob written before it
// was removed — can be stripped by name. The typed constants below are what
// actually enforce correctness; this function only deletes.
function omitKeys<T extends object>(obj: T, keys: readonly PropertyKey[]): T {
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
  // Legacy pre-Matchy screening free text, in the client's hands until the
  // 2026-09-08 audit (M-13). `rateExpectation` is the expert-side number in
  // prose ("wants $600/hr"), which defeats the `expertRate` rule above; the
  // free-text `availability` can carry the expert's own words verbatim.
  'rateExpectation',
  'availability',
  // The rubric intro's personal line and subject domain
  // (docs/OUTREACH_EMAIL_RUBRIC.md). `whyThem` names the expert's employer and
  // what they did there — the identity the client is not entitled to before
  // the reveal — and `introDomain` / `introArm` describe the same email, so
  // all three stay with staff. `introNeedsWhyThem` is KEPT: it only says the
  // intro is waiting on a person, which the thread shows the client.
  'whyThem',
  'introDomain',
  'introArm',
  // The expert's own words and addresses from the scheduling flow. The raw
  // free text they typed into the picker (or into a reply) can carry their
  // name, employer or phone number; the Google account they connected IS an
  // email address; a Calendly link is a direct booking path around Matchy.
  'availabilityRaw',
  'calendarEmail',
  'calendlyUrl',
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
 * Keys that are no longer on the ProjectExpert type but may still sit in a
 * `project_experts.data` blob written before they were removed. They are
 * stripped by name, so a legacy row cannot leak what a current one cannot hold.
 *
 *   contactCandidates — every address discovery turned up. The field was
 *     removed 2026-09-09 (W4-1); nothing had written it since discovery moved
 *     to a single `contactEmail`. Stripping it stays unconditional.
 */
const LEGACY_INTERNAL_PROJECT_EXPERT_KEYS: readonly string[] = [
  'contactCandidates',
];

/**
 * NOT on the list above, as of the 2026-09-08 audit — a reader looking for them
 * should know they reach the client today rather than assume an omission:
 *   - the staff screening record: `screeningStatus`, `vettingQuestions`,
 *     `knowledgeFit`, `communicationQuality`, `conflictRisk`,
 *     `recommendToClient`, `valueChainPosition`. Verdicts, not identity — the
 *     client-ready card renders some of them on purpose.
 *   - `conflictNote`: read off the expert's reply, but written by
 *     lib/matchyClassify.ts through screenAndMask, so it arrives masked.
 *   - `nudges`: `linesUsed` holds Matchy's own outbound lines, not the
 *     expert's. Harmless, but it is outreach plumbing on a client payload.
 * None of these can identify an unrevealed expert on their own, which is why
 * they were left. (`rateExpectation` and `availability` used to be on this
 * list; they are stripped now — see the entries above.)
 */

/**
 * Project fields a non-admin must never receive. `clientAvailabilityTokenHash`
 * is deliberately NOT here: it is a SHA-256 digest (not a usable credential)
 * and the client scheduling UI reads its presence to render the
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
 *
 * THE STORED DESCRIPTOR IS RE-CHECKED HERE, not trusted (audit H-18). It is
 * LLM-written text and the check that should have caught a leak at generation
 * time did not exist until now, so anything already in the database gets the
 * same test on the way out: a descriptor or justification naming the person or
 * the employer is replaced by the deterministic descriptor (or dropped), which
 * is exactly what an expert with no descriptor has always been shown.
 */
function anonymizeExpert(expert: Expert): Expert {
  const tier      = expert.seniorityTier ?? classifySeniority(expert.title ?? '');
  const region    = generalizeLocation(expert.location);
  const stored    = expert.anonymizedJustification?.trim() ?? '';
  const rationale = descriptorIsAnonymous(stored, expert) ? stored : '';
  const descriptor = expert.anonymizedDescriptor?.trim() ?? '';

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
    anonymizedDescriptor:    descriptor && descriptorIsAnonymous(descriptor, expert)
      ? descriptor
      : fallbackDescriptor(expert),
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

  const stripped = {
    ...omitKeys(pe, [...INTERNAL_PROJECT_EXPERT_KEYS, ...LEGACY_INTERNAL_PROJECT_EXPERT_KEYS]),
    ...matchyOutcomeOf(pe),
    ...redactScheduling(pe.scheduling),
  };
  if (isIdentityRevealed(pe)) return stripped;

  return { ...stripped, expert: anonymizeExpert(pe.expert) };
}

// ─── Scheduling (Matchy Phase 2) ──────────────────────────────────────────────

/**
 * `scheduling` is client-facing almost in full: the client is meant to see the
 * round, the times Matchy proposed, the outcome and the expert's zone — that is
 * the whole point of the scheduling card.
 *
 * TWO KEYS ARE NOT. `pickTokenHash` and `pickTokenExpiry` describe the expert's
 * private booking link (lib/matchyScheduling.ts). The hash is not a usable
 * credential on its own, but it is the revocation record for a link that BOOKS
 * A CALL, and the expiry tells an attacker exactly how long a guessed token
 * would stay live. Neither has a reason to reach a browser, so neither does.
 *
 * A DEEP COPY, always: `scheduling` on the stored ProjectExpert is the live
 * object the store handed us, and deleting a key from it would strip the hash
 * out of the record itself. `booking` needs no filter — `zoomMeetingId` is the
 * same id `zoomJoinUrl` already exposes, and `zoomStartUrl` (the host link) is
 * stripped at the ProjectExpert level above and never rides on `booking`.
 */
function redactScheduling(
  scheduling: SchedulingState | null | undefined,
): { scheduling?: SchedulingState | null } {
  if (scheduling === undefined) return {};
  if (scheduling === null)      return { scheduling: null };

  return {
    scheduling: {
      round:           scheduling.round,
      proposed:        scheduling.proposed.map(slot => ({ ...slot })),
      proposedAt:      scheduling.proposedAt,
      expertTimezone:  scheduling.expertTimezone,
      preferences:     scheduling.preferences,
      outcome:         scheduling.outcome,
      pickTokenHash:   null,
      pickTokenExpiry: null,
    },
  };
}

const MATCHY_OUTCOMES: ReadonlySet<string> = new Set<MatchyOutcome>([
  'intro_sent', 'intro_drafted', 'intro_failed', 'contact_found',
  'contact_not_found', 'contact_suppressed', 'contact_check_unavailable',
  'contact_discovery_unavailable', 'walkthrough_held',
]);

/**
 * The one thing a client may learn from the internal contactStatus: which
 * Matchy line to show. Legacy free-text values are dropped, so no stray note
 * ever reaches the browser.
 */
function matchyOutcomeOf(pe: ProjectExpert): { matchyOutcome?: MatchyOutcome } {
  const raw = pe.contactStatus;
  return raw && MATCHY_OUTCOMES.has(raw) ? { matchyOutcome: raw as MatchyOutcome } : {};
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
