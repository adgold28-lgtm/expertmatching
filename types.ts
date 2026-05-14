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

export type ExpertStatus =
  | 'discovered'
  | 'shortlisted'
  | 'rejected'
  | 'contact_found'
  | 'outreach_drafted'
  | 'contacted'
  | 'replied'
  | 'scheduled'
  | 'completed';

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
  contactedAt?: number;     // unix ms timestamp when status first became 'contacted'
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
  // Billing / Stripe
  expertRate?:           number | null;  // hourly rate in USD, set during outreach
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
}

export interface ProjectSummary {
  id: string;
  name: string;
  researchQuestion: string;
  expertCount: number;
  shortlistedCount: number;
  createdAt: number;
  updatedAt: number;
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
