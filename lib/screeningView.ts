// lib/screeningView.ts — the wire shapes every /api/requests route returns, and
// the redaction boundary that decides what a given viewer is allowed to see
// (docs/SCREENING_FLOW_PLAN.md).
//
// THIS IS WHERE THE ANONYMITY PROMISE IS KEPT. lib/requestStore returns every
// candidate in FULL — name, email address, the expert's own rate ask — because
// staff routes need all three. A client must never see any of them. The rule
// the plan states is the rule here: the client sees "Candidate N", the
// background lines and the expert's own words; platform admins see the name.
//
// So every view below is built FIELD BY FIELD. There is no spread of a stored
// record anywhere in this file, and that is deliberate rather than stylistic: a
// spread is how a new staff-only column on `screening_tokens` silently reaches a
// client the day it is added. Adding a field to a wire shape has to be a
// decision someone typed.
//
// The three redacted fields, and where they are allowed:
//   name       ExpertSnapshot.name  → admin only
//   email      expertEmail          → admin only
//   expertAsk  rateAsk (EXPERT-side) → admin only, and only when it exists
// A client whose candidate countered sees `rate.clientRate` — the CLIENT-side
// conversion of that ask (lib/pricing.clientRateFor) — and never the expert's
// number, which is the rate rule from docs/MATCHY_SPEC.md holding here too.
//
// PURE. No I/O, no clock, no model, no environment. Steps 4 and 5 build on
// these same two functions, and scripts/test-screening-redaction.ts checks that
// a 'user' view never carries a name, an address or an expert ask.
//
// NEVER LOGS ANYTHING — every argument is confidential.

import type {
  CallOutcome,
  Coverage,
  ExpertBackgroundLine,
  ScreeningAvailability,
  ScreeningCandidate,
  ScreeningObjective,
  ScreeningRequest,
  ScreeningRequestStatus,
  ScreeningResponse,
  ScreeningTargeting,
} from '../types';
import { computeCoverage, sortRespondents } from './screeningCoverage';
import { clientRateFor } from './pricing';

// ─── Shapes ───────────────────────────────────────────────────────────────────

/**
 * What one respondent costs, CLIENT-side. Null until they have submitted —
 * before that there is no rate to show, and a placeholder number would read as
 * a quote.
 */
export interface RespondentRateView {
  /** True when the expert took the request's standing rate. */
  accepted:   boolean;
  /** Always CLIENT-side whole dollars per hour — what this client would pay. */
  clientRate: number;
  /** EXPERT-side, ADMIN ONLY, and only present when the expert countered. */
  expertAsk?: number;
}

/**
 * One screening link as the caller is allowed to see it.
 *
 * `label` is "Candidate N", assigned by mint order and stable for the life of
 * the request — a client refers to "Candidate 3" and it is still Candidate 3
 * after the table re-sorts on the next submission.
 */
export interface RespondentView {
  id:              string;
  label:           string;
  /** ADMIN ONLY. Absent for a client. */
  name?:           string;
  /** ADMIN ONLY. Absent for a client. */
  email?:          string;
  headline:        string;
  background:      ExpertBackgroundLine[];
  expiresAt:       string;
  submittedAt:     string | null;
  revokedAt:       string | null;
  callRequestedAt: string | null;
  /** Computed from the answers, never stored. Null until they submit. */
  coverage:        Coverage | null;
  rate:            RespondentRateView | null;
  availability:    ScreeningAvailability | null;
  /** The expert's own words, unsummarised. Empty until they submit. */
  answers:         ScreeningResponse[];
  outcomes:        CallOutcome[];
}

/** The request as a page renders it: its own fields, plus who may do what. */
export interface ScreeningRequestView {
  id:              string;
  organizationId:  string;
  ownerId:         string;
  ownerEmail:      string;
  status:          ScreeningRequestStatus;
  topicStatement:  string;
  targeting:       ScreeningTargeting;
  callCount:       number;
  deadline:        string;
  clientRate:      number;
  callLengthMin:   30 | 45 | 60;
  approvedAt:      string | null;
  createdAt:       string;
  updatedAt:       string;
  objectives:      ScreeningObjective[];
  respondents:     RespondentView[];
  /** Whether this viewer may edit and approve the screening set. */
  canEdit:         boolean;
  isAdmin:         boolean;
}

// ─── Respondent ───────────────────────────────────────────────────────────────

/**
 * One candidate, redacted for `role`.
 *
 * `clientRate` is the REQUEST's rate — the number the client already agreed to
 * — whenever the expert accepted it, and the conversion of their counter when
 * they did not. When an unaccepted row somehow carries no ask (the submission
 * validator makes that impossible, but a hand-written row could), the request's
 * rate is shown rather than a converted zero: "$0/hr" in a table is a lie, and
 * the request rate is the honest floor.
 */
export function toRespondentView(
  candidate: ScreeningCandidate,
  label:     string,
  role:      'admin' | 'user',
  clientRate: number,
): RespondentView {
  const submitted = candidate.submittedAt !== null;
  const accepted  = candidate.rateAccepted === true;

  const view: RespondentView = {
    id:              candidate.id,
    label,
    headline:        candidate.snapshot.headline,
    background:      candidate.snapshot.background.map(line => ({
      company: line.company,
      role:    line.role,
      dates:   line.dates,
    })),
    expiresAt:       candidate.expiresAt,
    submittedAt:     candidate.submittedAt,
    revokedAt:       candidate.revokedAt,
    callRequestedAt: candidate.callRequestedAt,
    coverage:        submitted ? computeCoverage(candidate.responses) : null,
    rate:            null,
    availability:    candidate.availability,
    answers:         submitted
      ? candidate.responses.map(r => ({
          objectiveId: r.objectiveId,
          answer:      r.answer,
          proofText:   r.proofText,
        }))
      : [],
    outcomes:        candidate.outcomes.map(o => ({ objectiveId: o.objectiveId, outcome: o.outcome })),
  };

  if (submitted) {
    const rate: RespondentRateView = {
      accepted,
      clientRate: accepted || candidate.rateAsk === null
        ? clientRate
        : clientRateFor(candidate.rateAsk),
    };
    // STAFF ONLY, and only when there is an ask to show.
    if (role === 'admin' && candidate.rateAsk !== null) rate.expertAsk = candidate.rateAsk;
    view.rate = rate;
  }

  // STAFF ONLY. A client never learns who Candidate N is.
  if (role === 'admin') {
    view.name  = candidate.snapshot.name;
    if (candidate.expertEmail !== null) view.email = candidate.expertEmail;
  }

  return view;
}

// ─── Request ──────────────────────────────────────────────────────────────────

/** ISO 8601 in UTC sorts lexicographically, so mint order needs no date parsing. */
function byCreatedAt(a: ScreeningCandidate, b: ScreeningCandidate): number {
  if (a.createdAt < b.createdAt) return -1;
  if (a.createdAt > b.createdAt) return 1;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/**
 * The whole request for one viewer.
 *
 * LABELS ARE ASSIGNED BEFORE SORTING, in mint order, and that ordering is the
 * point: the table sorts by coverage and re-sorts on every submission, so a
 * label derived from display position would rename every candidate whenever one
 * of them replied. "Candidate 2" has to mean the same person tomorrow.
 *
 * `canEdit` is owner-or-admin. It is a UI affordance, not the gate: the routes
 * run their own checks, and a viewer who is neither owner nor admin never gets
 * this far — lib/requestStore.getRequestForUser returned null and the route
 * already 404'd.
 */
export function buildRequestView(
  request:    ScreeningRequest,
  candidates: ScreeningCandidate[],
  viewer:     { email: string; role: 'admin' | 'user' },
): ScreeningRequestView {
  const isAdmin = viewer.role === 'admin';

  const labelled = [...candidates].sort(byCreatedAt).map((candidate, index) => ({
    view:        toRespondentView(candidate, `Candidate ${index + 1}`, viewer.role, request.clientRate),
    coverage:    candidate.submittedAt !== null ? computeCoverage(candidate.responses) : null,
    submittedAt: candidate.submittedAt,
    createdAt:   candidate.createdAt,
  }));

  return {
    id:             request.id,
    organizationId: request.organizationId,
    ownerId:        request.ownerId,
    ownerEmail:     request.ownerEmail,
    status:         request.status,
    topicStatement: request.topicStatement,
    targeting:      request.targeting,
    callCount:      request.callCount,
    deadline:       request.deadline,
    clientRate:     request.clientRate,
    callLengthMin:  request.callLengthMin,
    approvedAt:     request.approvedAt,
    createdAt:      request.createdAt,
    updatedAt:      request.updatedAt,
    objectives:     request.objectives.map(o => ({
      id:            o.id,
      requestId:     o.requestId,
      position:      o.position,
      objectiveText: o.objectiveText,
      stem:          o.stem,
      proofPrompt:   o.proofPrompt,
      clientEdited:  o.clientEdited,
      source:        o.source,
    })),
    respondents:    sortRespondents(labelled).map(row => row.view),
    // The empty-email floor from lib/auth.getSessionUser must never match the
    // empty ownerEmail a deleted profile leaves behind.
    canEdit:        isAdmin || (viewer.email !== '' && request.ownerEmail === viewer.email),
    isAdmin,
  };
}
