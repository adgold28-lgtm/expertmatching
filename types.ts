export interface QueryAnalysis {
  industry: string;
  function: string;
  key_topics: string[];
  keywords: string[];
  confidence: 'High' | 'Medium' | 'Low';
  confidence_reason: string;
}

export interface SourceLink {
  url: string;
  label: string;
  type: 'LinkedIn' | 'Article' | 'Company Website' | 'Professional Directory' | 'Government Website' | 'Other';
}

// A single structured piece of evidence backing an expert recommendation.
// Populated by the extraction LLM; optional for backward compat with stored experts.
export interface EvidenceItem {
  id: string;            // short deterministic id, e.g. "ev-1"
  sourceLabel: string;   // human-readable source name, e.g. "Processing World Interview"
  sourceUrl?: string;    // validated http/https URL or omitted
  claim: string;         // one sentence: what this evidence demonstrates
  relevance: string;     // one sentence: why this matters for the research question
  evidenceType?: 'role' | 'publication' | 'company' | 'conference' | 'credential' | 'other';
  confidence?: 'high' | 'medium' | 'low';
}

export type SeniorityTier = 'executive' | 'senior' | 'mid';
export interface TierPricing {
  tier:        SeniorityTier;
  label:       string;
  callRate:    number;
  expertRate:  number;
  platformFee: number;
}

export interface Expert {
  id: string;
  name: string;
  title: string;
  company: string;
  location: string;
  category: 'Operator' | 'Advisor' | 'Outsider';
  outsider_subcategory?: 'Government' | 'Large Enterprise' | 'Small Business' | null;
  justification: string;
  relevance_score: number;
  source_url: string;
  source_label: string;
  source_links: SourceLink[];
  evidenceItems?: EvidenceItem[];  // 1–3 structured evidence items; absent on legacy stored experts
  linkedin_url?: string;
  linkedin_confidence?: 'high' | 'medium' | 'low';
  linkedin_source?: string;
  valueChainLabel?: string;   // human-readable supply-chain position label (e.g. "Fiber & Textile Science")
  seniorityTier?: SeniorityTier;
  tierPricing?:   TierPricing;
  // ── Anonymized presentation (client-facing before identity reveal) ──────────
  // Generated at sourcing time, or backfilled by lib/anonymizeExpert.ts. Never
  // names the person, their employer, or a product. See lib/redactExpert.ts.
  anonymizedDescriptor?:    string;  // ≤140 chars: role level + org type + scale
  anonymizedJustification?: string;  // ≤200 chars: relevance rationale, de-identified
}

export interface InsufficientExperts {
  category: 'Operator' | 'Advisor' | 'Outsider';
  found: number;
  required: number;
}

export interface ExpertResponse {
  query_analysis: QueryAnalysis;
  experts: Expert[];
  adjacent_experts?: Expert[];
  limited_pool?: boolean;
  value_chain_summary?: {
    briefType:          string;
    primaryExpertPools: string[];
    endMarket:          string;
  } | null;
  insufficient_categories?: InsufficientExperts[];
}

// ─── Contact enrichment ──────────────────────────────────────────────────────

import type { ContactProviderName, ActiveProviderName } from './lib/contactProviders/types';
export type { ContactProviderName, ActiveProviderName };

export type ContactStatus =
  | 'verified'   // non-webmail, non-disposable, valid format, confirmed deliverable
  | 'catchall'   // non-webmail, catch-all domain — delivery not guaranteed
  | 'risky'      // unverified / uncertain
  | 'invalid'    // bad format / gibberish / disposable / not_valid
  | 'not_found'; // no displayable email returned by the provider

// Provider-agnostic stored email — Snov-specific raw fields (smtp_status,
// unknown_status_reason) are kept in the provider layer, not stored here.
export interface EnrichedEmail {
  email: string;
  status: ContactStatus;
  is_valid_format: boolean;
  is_disposable: boolean;
  is_webmail: boolean;
  is_gibberish: boolean;
  provider: ActiveProviderName; // always a real provider — 'none' is never on a found email
}

/**
 * One address Matchy found for an expert during contact discovery, with how it
 * was found and whether mail to it has bounced. STAFF-ONLY: stripped from every
 * client-facing response by lib/redactExpert.ts. Matchy sends to at most one of
 * these; a bounce moves it to the next candidate.
 */
export interface ContactCandidate {
  email:              string;
  source:             ContactProviderName | 'manual' | 'public_page';
  verificationStatus: ContactStatus;
  confidence:         'high' | 'medium' | 'low';
  bounced:            boolean;
}

// ─── Contact path discovery ────────────────────────────────────────────────────
//
// SuggestedDomain is the canonical type for both heuristic and resolver-found
// domain suggestions. domainSuggestions.ts re-exports it for backward compat.

export interface SuggestedDomain {
  domain:           string;
  label:            string;
  confidence:       'high' | 'medium' | 'low';
  reason:           string;
  sourceUrl?:       string;   // originating URL, if derived from a source_link or search result
  sourceType?:      'company_website' | 'search_result' | 'known_alias' | 'source_link' | 'heuristic';
  verifiedOfficial?: boolean; // true when origin is a confirmed company website or search-verified
}

// A publicly listed role-based contact email found on an official company page.
// Never a personal email. Never used as input to Snov/Hunter.
export interface PublicContactEmail {
  email:       string;
  label:       string;
  sourceUrl?:  string;
  confidence:  'high' | 'medium' | 'low';
  contactType: 'general' | 'department' | 'media' | 'sales' | 'support' | 'unknown';
  reason:      string;
}

// Resolved set of contact paths — returned by /api/resolve-contact-paths
// and optionally persisted to ProjectExpert.
export interface ContactPathSuggestion {
  domains:             SuggestedDomain[];
  publicContactEmails: PublicContactEmail[];
  notes?:              string[];
  resolvedAt?:         number; // unix ms
}

// ─── Project workspaces ───────────────────────────────────────────────────────

/** Terminal outcomes written by bookmark / contact discovery (see lib/contactDiscovery.ts). */
export type MatchyOutcome =
  | 'intro_sent'
  | 'intro_drafted'
  | 'intro_failed'
  | 'contact_found'
  | 'contact_not_found'
  | 'contact_suppressed'
  | 'contact_check_unavailable'
  | 'contact_discovery_unavailable'
  // Walkthrough mode: the client bookmarked an expert we have no address for.
  // Matchy did NOT go looking (a provider call spends credits) and nothing was
  // sent. See lib/walkthrough.ts.
  | 'walkthrough_held';

export type ExpertStatus =
  | 'discovered'
  | 'shortlisted'
  // Matchy: the client saved this expert and outreach starts. Conceptually
  // after 'shortlisted' — see lib/expertPipeline.ts for the derived stage.
  | 'bookmarked'
  | 'rejected'
  | 'contact_found'
  | 'outreach_drafted'
  | 'contacted'
  | 'replied'
  // Matchy: the follow-up (conflict / NDA questions + the rate ask) has gone
  // out and we are waiting on the expert's terms. Replaces the retired
  // 'email2_sent' of the 3-email cadence.
  | 'followup_sent'
  | 'scheduled'
  | 'completed'
  | 'email2_sent'
  | 'rate_negotiation'
  | 'conflict_flagged'
  | 'rejected_after_outreach'
  | 'scheduling_sent';

export type EmailStep = 'email1' | 'email2' | 'email3';
export type ReplyIntent =
  | 'interested' | 'declined' | 'counter_rate' | 'conflict' | 'unclear'
  // Matchy Phase 2 (lib/matchyScheduling.ts): read off a reply while a call is
  // being scheduled or has been booked.
  | 'time_chosen' | 'time_unavailable' | 'reschedule';

// ─── Matchy Phase 2: scheduling ───────────────────────────────────────────────
// All three states below ride in project_experts.data (jsonb) — no migration.

/** One concrete call slot Matchy proposed, in UTC. */
export interface ProposedSlot { startUtc: string; endUtc: string; durationMin: number; }

export type SchedulingOutcome =
  | 'times_proposed'          // proposals emailed, waiting on the expert
  | 'link_sent'               // no usable overlap / no client slots: picker link only
  | 'expert_declined_times'   // expert said none work and gave nothing usable
  | 'booked'
  | 'reschedule_requested'    // client or expert asked to move a booked call
  | 'no_client_availability'; // owner has no usable calendar connection

export interface SchedulingState {
  round:           number;            // proposal rounds sent; MAX_PROPOSAL_ROUNDS = 3
  proposed:        ProposedSlot[];    // latest proposals, max 3
  proposedAt:      number | null;
  expertTimezone:  string | null;     // IANA when known (picker page / parsed reply)
  preferences:     string | null;     // client's stated preference, <= 200 chars, screened
  outcome:         SchedulingOutcome | null;
  pickTokenHash:   string | null;     // SHA-256 of the picker token — stripped for clients
  pickTokenExpiry: number | null;     // unix ms
}

export interface BookingMove { startUtc: string; endUtc: string; movedAt: number; by: 'client' | 'expert' | 'matchy'; }

export interface BookingState {
  startUtc:         string;
  endUtc:           string;
  durationMin:      number;
  zoomMeetingId:    string | null;
  icsUid:           string;
  icsSequence:      number;           // +1 on every reschedule (ICS SEQUENCE)
  bookedAt:         number;
  rescheduledCount: number;
  history:          BookingMove[];    // previous times, oldest first
}

// ─── Matchy Phase 2: follow-up nudges (lib/nudges.ts) ─────────────────────────

export type NudgeStage = 'intro' | 'terms' | 'times';

export interface NudgeState {
  stage:        NudgeStage;
  waitingSince: number;          // unix ms of the outbound we are waiting on
  count:        number;          // sent in this waiting stage; MAX_NUDGES = 4
  lastSentAt:   number | null;
  scheduledFor: string | null;   // ISO of the queued QStash job, null when none
  scheduledDay: string | null;   // 'YYYY-MM-DD' in the schedule zone; one per business day
  linesUsed:    string[];        // exact lines already sent, never repeat
}

export type RejectionReason =
  | 'too_generic'
  | 'wrong_industry'
  | 'wrong_geography'
  | 'weak_evidence'
  | 'no_contact_path'
  | 'conflict_risk'
  | 'not_senior_enough'
  | 'too_academic'
  | 'vendor_biased'
  | 'better_option_available'
  | 'other';

export type ValueChainPosition =
  | 'supplier'
  | 'equipment_vendor'
  | 'producer_operator'
  | 'processor_manufacturer'
  | 'distributor'
  | 'retail_customer'
  | 'regulator_academic'
  | 'investor_advisor'
  | 'other';

export type ScreeningStatus =
  | 'not_screened'
  | 'vetting_questions_ready'
  | 'outreach_sent'
  | 'expert_replied'
  | 'screening_scheduled'
  | 'screened'
  | 'client_ready'
  | 'rejected_after_screen';

// ─── Availability scheduling ───────────────────────────────────────────────────

export interface AvailabilitySlot {
  dayOfWeek?:  string;                          // e.g. "Monday"
  date?:       string;                          // ISO date if exact, e.g. "2026-05-19"
  startTime:   string;                          // e.g. "9:00 AM"
  endTime:     string;                          // e.g. "10:00 AM"
  timezone:    string;                          // e.g. "ET"
  confidence?: 'high' | 'medium' | 'low';       // LLM parsing confidence
}

export interface OverlapSlot {
  startUtc:    string;  // ISO 8601
  endUtc:      string;  // ISO 8601
  startExpert: string;  // formatted in expert's timezone
  startClient: string;  // formatted in client's timezone
  durationMin: number;
  score:       number;
}

export interface OverlapResult {
  found:          boolean;
  slots:          OverlapSlot[];
  bestSlot:       OverlapSlot | null;
  expertTimezone: string;
  clientTimezone: string;
}

export interface ProjectExpert {
  expert: Expert;
  status: ExpertStatus;
  userNotes?: string;
  rejectionReason?: RejectionReason;
  rejectionNotes?: string;  // free-text note on rejection — never sent to AI or logged
  rejectedAt?: number;      // unix ms timestamp of rejection
  contactEmail?: string;
  emailVerificationStatus?: ContactStatus;  // quality of the found email
  emailProvider?: 'hunter' | 'snov' | 'none';  // provider that found it
  emailCheckedAt?: number;  // unix ms when last lookup was performed
  contactStatus?: string;   // legacy free-text field; kept for backward compat
  /**
   * Client-safe mirror of the last Matchy outcome for this expert, derived from
   * contactStatus by lib/redactExpert for non-admins (admins read contactStatus
   * directly). Never carries an address — just which line Matchy should show.
   */
  matchyOutcome?: MatchyOutcome;
  contactedAt?: number;     // unix ms timestamp when status first became 'contacted'
  // Every address discovery turned up, best-first. Staff-only — never sent to
  // a client (lib/redactExpert.ts strips it).
  contactCandidates?: ContactCandidate[] | null;
  // Contact path discovery (resolver results — never passed to email providers)
  suggestedDomains?: SuggestedDomain[];
  publicContactEmails?: PublicContactEmail[];
  selectedDomain?: string;
  selectedContactPathType?: 'personal_email' | 'general_company_email' | 'linkedin_source' | 'unknown';
  outreachSubject?: string;
  outreachDraft?: string;
  // Screening fields
  valueChainPosition?: ValueChainPosition;
  screeningStatus?: ScreeningStatus;
  vettingQuestions?: string[];
  screeningNotes?: string;
  knowledgeFit?: 1 | 2 | 3 | 4 | 5;
  communicationQuality?: 1 | 2 | 3 | 4 | 5;
  conflictRisk?: 'low' | 'medium' | 'high' | 'unknown';
  availability?: string;
  rateExpectation?: string;
  recommendToClient?: boolean;
  scheduledTime?: string;
  screenedAt?: number;
  // Availability token fields — never logged
  availabilityTokenHash?:   string;    // SHA-256(raw token) — for revocation check only
  availabilityTokenExpiry?: number;    // unix ms; 7 days from generation
  availabilityRequestedAt?: number;    // unix ms when last request email was sent
  availabilitySubmitted?:   boolean;   // true once the expert has submitted their slots
  availabilitySlots?:       AvailabilitySlot[];  // structured slots parsed by LLM or from Calendly
  availabilityRaw?:         string;    // sanitized original free-text — never logged
  calendarProvider?:        'google' | 'calendly' | 'manual';
  // Calendar OAuth fields — never logged; tokens stored encrypted at rest
  calendarAccessToken?:     string;    // AES-256-GCM encrypted Google access token
  calendarRefreshToken?:    string;    // AES-256-GCM encrypted Google refresh token
  calendarTokenExpiry?:     number;    // unix ms when access token expires
  calendarEmail?:           string;    // Google account email used for calendar auth
  calendlyUrl?:             string;    // Calendly scheduling link provided by expert
  calendlyAccessToken?:     string;    // reserved for future Calendly OAuth
  oauthState?:              string | null;  // HMAC-signed nonce for Google OAuth CSRF protection; null after callback
  // Overlap engine results
  overlapResult?:    OverlapSlot | null;
  overlapCheckedAt?: number;
  calendarEventId?:  string;
  agreedRate?: number;
  // Email sequence fields
  outreachToken?:        string;
  outreachStep?:         'email1' | 'email2' | 'email3';
  email1SentAt?:         number;
  email2SentAt?:         number;
  email3SentAt?:         number;
  replyDetectedAt?:      number;
  replyIntent?:          'interested' | 'declined' | 'counter_rate' | 'conflict' | 'unclear';
  counterRateProposed?:  number;
  // Matchy: the EXPERT-side hourly rate the expert countered with, in whole
  // dollars, as read off their reply. Staff- and expert-side only — the client
  // is shown clientRateFor(expertCounterRate) instead, never this number
  // (docs/MATCHY_SPEC.md, "Pricing rule").
  expertCounterRate?:    number | null;
  // The SAME counter expressed as what the client would pay:
  // lib/pricing.clientRateFor(expertCounterRate). This is the only counter
  // number a client may ever see, and it is what the negotiation decision card
  // renders. Derived, never entered by hand.
  clientCounterRate?:    number | null;
  conflictNote?:         string;
  // Unix ms when Matchy's follow-up (conflicts + rate ask) was sent. Set once;
  // its presence is what stops a second reply producing a second follow-up.
  followupSentAt?:       number;
  // Billing / Stripe
  // The two numbers of the engagement — see lib/pricing.ts, the only place
  // that converts between them. clientRate is client-facing everywhere;
  // expertRate is expert- and staff-only and never reaches a client.
  clientRate?:           number | null;  // hourly rate billed to the client, incl. the ExpertMatch fee
  expertRate?:           number | null;  // hourly rate offered to / paid the expert; clientRateFor() derives clientRate
  callDurationMin?:      number | null;  // actual call duration in minutes, set at completion
  invoiceAmount?:        number | null;  // computed: rate * duration / 60
  stripePaymentLinkId?:  string | null;
  stripePaymentLinkUrl?: string | null;
  stripePaymentIntentId?: string | null;
  paymentStatus?:        'unpaid' | 'invoice_sent' | 'paid' | 'failed' | null;
  paidAt?:               number | null;
  // Zoom meeting fields — zoomStartUrl is host-only, never exposed to frontend
  zoomMeetingId?:      string | null;
  zoomJoinUrl?:        string | null;
  zoomStartUrl?:       string | null;  // host link — stored in Redis only, never sent to frontend
  zoomMeetingStarted?: boolean;
  zoomMeetingEndedAt?: number | null;  // Unix ms timestamp
  actualDurationMin?:  number | null;  // from Zoom webhook, overrides manual callDurationMin
  // Stripe Connect — expert payouts
  stripeConnectAccountId?:  string;
  stripeTransferId?:        string;
  expertPaidAt?:            number;
  expertOnboardingStatus?:  'pending' | 'complete' | 'failed';
  // Matchy Phase 2 — scheduling, the booked call, and the follow-up nudges.
  scheduling?: SchedulingState | null;
  booking?:    BookingState | null;
  nudges?:     NudgeState | null;
  addedAt: number;
  updatedAt: number;
}

export interface Project {
  id: string;
  name: string;
  researchQuestion: string;
  industry: string;
  function: string;
  geography: string;
  seniority: string;
  createdAt: number;
  updatedAt: number;
  experts: ProjectExpert[];
  notes?: string;
  confidentialNotes?: string;
  // Brief context fields
  timeline?: string;
  targetExpertCount?: number;
  keyQuestions?: string;
  initialHypotheses?: string;
  additionalContext?: string;
  mustHaveExpertise?: string;
  niceToHaveExpertise?: string;
  targetCompanies?: string;
  companiesToAvoid?: string;
  peopleToAvoid?: string;
  conflictExclusions?: string;      // stored field; UI label: "Conflict / Exclusion Notes"
  perspectivesNeeded?: string[];
  // Stripe customer — one per project (keyed to clientEmail)
  stripeCustomerId?: string | null;
  // Client scheduling fields — on the Project, not on ProjectExpert
  clientEmail?:                  string | null;
  clientName?:                   string | null;
  clientAvailabilityToken?:      string | null;
  clientAvailabilityTokenHash?:  string | null;
  clientAvailabilityTokenExpiry?: number | null;
  clientAvailabilitySubmitted?:  boolean;
  clientAvailabilitySlots?:      AvailabilitySlot[] | null;
  clientCalendarProvider?:       'google' | 'calendly' | 'manual' | null;
  clientCalendarAccessToken?:    string | null;  // encrypted
  clientCalendarRefreshToken?:   string | null;  // encrypted
  clientCalendarEmail?:          string | null;
  clientCalendlyUrl?:            string;
  // New brief fields (simplified two-field brief)
  expertType?: string;              // "who do you want to talk to"
  // ── Matchy (projects.review_first / client_rate_min / client_rate_max) ─────
  // false (the default) means bookmarking an expert sends the intro straight
  // away; true means Matchy drafts it and waits for the client.
  reviewFirst?: boolean;
  /**
   * Walkthrough mode (unpromoted — rides in projects.brief, no migration).
   * `undefined` means WALKTHROUGH: the client can click through the whole flow
   * and see exactly what Matchy would say, but no email reaches an expert and
   * no contact-discovery provider is called. Only an explicit `false` is live.
   * Read it through lib/walkthrough.isWalkthrough, never directly.
   */
  walkthrough?: boolean;
  // The CLIENT-side hourly band Matchy negotiates inside, in whole dollars.
  // Null/absent = no bound; tier defaults apply.
  clientRateMin?: number | null;
  clientRateMax?: number | null;
  // Server-side expert sourcing job — survives navigation and refresh.
  // Written by POST /api/projects/[id]/source-experts and its worker.
  sourcingStatus?:      'running' | 'completed' | 'failed' | null;
  sourcingStartedAt?:   number | null;
  sourcingError?:       string | null;   // short human message — never raw internals
  // Adjacent (indirect-relevance) candidates from the last run. Not auto-added
  // to the project — surfaced in the Source panel for manual selection.
  sourcingAdjacent?:    Expert[] | null;
  sourcingLimitedPool?: boolean | null;
  // Ownership
  ownerEmail:     string;
  collaborators:  string[];
  firmDomain:     string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  researchQuestion: string;
  expertCount: number;
  shortlistedCount: number;
  /** Experts per status — drives the stage pill on /app (lib/expertPipeline.summaryStage). */
  stageCounts?: Partial<Record<ExpertStatus, number>>;
  createdAt: number;
  updatedAt: number;
  ownerEmail:    string;
  collaborators: string[];
}

// ─── Contact enrichment ──────────────────────────────────────────────────────

export interface ContactEnrichment {
  best_email: EnrichedEmail | null; // null if only webmail/risky/invalid found or no result
  domain_used: string;
  name_used: { first: string; last: string };
  looked_up_at: number; // Date.now()
  expires_at: number;
  lookup_status: 'found' | 'not_found';
  provider: ContactProviderName;
}
