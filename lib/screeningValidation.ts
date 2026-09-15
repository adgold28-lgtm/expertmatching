// lib/screeningValidation.ts — everything the Structured Request & Screening
// Flow accepts from a browser, and the exact reason it refuses the rest
// (docs/SCREENING_FLOW_PLAN.md).
//
// Five boundaries, five validators:
//   validateIntakeInput         POST /api/requests            — the client's brief
//   validateObjectiveEdits      PATCH /api/requests/[id]      — inline stem edits
//   validateScreeningSubmission POST /api/s/[token]           — the EXPERT, no login
//   validateCandidateInput      POST /api/requests/[id]/tokens — staff adding a candidate
//   validateOutcomesInput       POST …/tokens/[id]/outcomes    — what the call covered
//
// The third of those is the one that matters most: it is reached with no
// session at all, by anyone holding a signed link, so it is the only thing
// standing between an anonymous caller and rows on a client's request.
//
// TWO SHAPES OF RULE, and the difference is deliberate:
//   REJECT  — anything the client must see and fix: a missing topic, two
//             objectives instead of three, a rate off the $50 grid, a deadline
//             in the past. Every one returns a snake_case code plus a SENTENCE,
//             because the UI shows the sentence and never the code.
//   SANITISE — the optional targeting block only: blanks dropped, entries
//             trimmed and de-duplicated case-insensitively, over-long entries
//             cut to the limit, over-long lists cut to 30. These are sourcing
//             hints on a collapsed `<details>` panel that a client can finish
//             the intake without opening; refusing the whole brief because a
//             pasted company list had a duplicate in it would be the wrong
//             trade. lib/projectValidation.sanitizeText does the same thing for
//             the same reason.
//
// Pure — no I/O, no database, no clock beyond Date.now() for the deadline
// window, and no model. `normalizeExpertId` is the ONE non-deterministic
// function here (its anonymous branch draws random bytes); everything else
// gives the same answer every time.
//
// The email check below is a local regex rather than
// lib/contactDiscovery.isValidEmailSyntax, which is the stricter and better
// test: importing it would pull contactDiscovery's whole dependency tree
// (projectStore, the Supabase admin client, the rate limiter, the contact
// providers) into a module the offline test script loads with no environment.
// The address validated here is only ever used to send one screening link, and
// a bad one fails visibly at send time.
//
// NEVER LOGS ANYTHING. Every input on this path is confidential: the topic, the
// objectives, the expert's name and address, the expert's own sentences.

import { createHash, randomBytes } from 'crypto';
import type {
  CallOutcome,
  CallOutcomeValue,
  ExpertBackgroundLine,
  ScreeningAnswer,
  ScreeningAvailability,
  ScreeningTargeting,
} from '../types';
import { isValidClientRateUsd } from './pricing';

// ─── Limits ───────────────────────────────────────────────────────────────────

export const LIMITS = {
  // Intake
  topicStatement:      300,
  objectiveText:       500,
  objectivesMin:         3,
  objectivesMax:         6,
  callCountMin:          1,
  callCountMax:         50,
  deadlineMinDays:       1,
  deadlineMaxDays:      90,
  // Targeting (sanitised, not rejected)
  targetingListMax:     30,
  targetingEntry:      120,
  targetingText:       200,
  // Objective edits
  stem:                300,
  proofPrompt:         300,
  // Expert submission
  proofText:           400,
  rateAskMin:           50,
  rateAskMax:         5000,
  // Candidate
  candidateName:       120,
  candidateHeadline:   160,
  backgroundLinesMax:    8,
  backgroundField:     120,
  email:               254,
} as const;

/** The call lengths the screening header can offer, in minutes. */
export const CALL_LENGTHS = [30, 45, 60] as const;
export type CallLengthMin = (typeof CALL_LENGTHS)[number];

/** Defaults applied when the client leaves an optional intake field alone. */
export const DEFAULT_CALL_COUNT      = 1;
export const DEFAULT_CLIENT_RATE     = 1300;
export const DEFAULT_CALL_LENGTH_MIN: CallLengthMin = 60;
export const DEFAULT_DEADLINE_DAYS   = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

const ANSWERS: readonly ScreeningAnswer[] = ['yes', 'no', 'unsure'];
const AVAILABILITIES: readonly ScreeningAvailability[] = ['this_week', 'next_week', 'later'];
const OUTCOMES: readonly CallOutcomeValue[] = ['answered', 'partial', 'unanswered'];

// Deliberately simple: one @, a dotted domain, no whitespace. See the header.
const EMAIL_RE = /^[^\s@]{1,64}@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/i;

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

// ─── Result shapes ────────────────────────────────────────────────────────────

export interface ValidationError {
  /** Where the UI should point: 'topicStatement', 'learningObjectives[2]', … */
  field:   string;
  /** snake_case code — for branching, never for display. */
  error:   string;
  /** A sentence, shown to the person as written. */
  message: string;
}

export type Validated<T> = { data: T } | { errors: ValidationError[] };

/** Narrowing helper so callers read `if (isValid(result))` instead of `'data' in`. */
export function isValid<T>(result: Validated<T>): result is { data: T } {
  return 'data' in result;
}

function err(field: string, error: string, message: string): ValidationError {
  return { field, error, message };
}

// ─── Primitive helpers ────────────────────────────────────────────────────────

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function absent(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/**
 * A whole number, from a number or from the all-digits string a bare `<input
 * type="number">` hands back. Anything else is null, which every caller turns
 * into its own error — no silent coercion of `true`, `[]` or '12abc'.
 */
function asInteger(value: unknown): number | null {
  if (typeof value === 'number') return Number.isInteger(value) ? value : null;
  if (typeof value === 'string' && /^\s*-?\d+\s*$/.test(value)) return parseInt(value, 10);
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** UTC calendar day number — the granularity the deadline window is judged at. */
function utcDay(ms: number): number {
  return Math.floor(ms / DAY_MS);
}

// ─── Targeting (sanitised) ────────────────────────────────────────────────────

/**
 * Trim, drop blanks, cut each entry to `LIMITS.targetingEntry`, de-duplicate
 * case-insensitively (keeping the first spelling the client used) and cap the
 * list at `LIMITS.targetingListMax`. A non-array is an empty list.
 */
function cleanList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out  = new Map<string, string>();
  for (const raw of value) {
    const entry = trimmed(raw).slice(0, LIMITS.targetingEntry);
    if (!entry) continue;
    const key = entry.toLowerCase();
    if (!out.has(key)) out.set(key, entry);
    if (out.size >= LIMITS.targetingListMax) break;
  }
  return Array.from(out.values());
}

function cleanTargetingText(value: unknown): string {
  return trimmed(value).slice(0, LIMITS.targetingText);
}

/**
 * Builds the targeting object field by field, keeping only what the client
 * actually filled in — an empty string or an empty list is left OUT rather than
 * stored as '' or [], so `{}` in the column means "no targeting given" and a
 * present key always means something.
 */
export function sanitizeTargeting(value: unknown): ScreeningTargeting {
  const raw        = asRecord(value);
  const exclusions = asRecord(raw.exclusions);

  const targetCompanies    = cleanList(raw.targetCompanies);
  const excludedCompanies  = cleanList(exclusions.companies);
  const excludedExperts    = cleanList(exclusions.experts);
  const seniority          = cleanTargetingText(raw.seniority);
  const fn                 = cleanTargetingText(raw.function);
  const tenureWindow       = cleanTargetingText(raw.tenureWindow);
  const geography          = cleanTargetingText(raw.geography);

  const out: ScreeningTargeting = {};
  if (targetCompanies.length > 0) out.targetCompanies = targetCompanies;
  if (seniority)                  out.seniority       = seniority;
  if (fn)                         out.function        = fn;
  if (tenureWindow)               out.tenureWindow    = tenureWindow;
  if (geography)                  out.geography       = geography;
  if (excludedCompanies.length > 0 || excludedExperts.length > 0) {
    out.exclusions = {};
    if (excludedCompanies.length > 0) out.exclusions.companies = excludedCompanies;
    if (excludedExperts.length   > 0) out.exclusions.experts   = excludedExperts;
  }
  return out;
}

// ─── Deadline ─────────────────────────────────────────────────────────────────

/**
 * The instant a deadline value means, or null when it is not a date.
 *
 * A bare 'YYYY-MM-DD' — what a `<input type="date">` submits — means the END of
 * that day in UTC, so a link minted against "the 30th" still works on the 30th.
 * A full ISO timestamp is taken as the instant it names.
 */
function deadlineInstant(value: string): number | null {
  if (DATE_ONLY_RE.test(value)) {
    const [y, m, d] = value.split('-').map(part => parseInt(part, 10));
    const ms = Date.UTC(y, m - 1, d, 23, 59, 59, 999);
    if (!Number.isFinite(ms)) return null;
    // Date.UTC rolls 2026-02-31 over into March; reject rather than accept a
    // date the client did not type.
    const back = new Date(ms);
    if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null;
    return ms;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** The default deadline: exactly 14 days out, as an ISO string. */
export function defaultDeadlineIso(now: number = Date.now()): string {
  return new Date(now + DEFAULT_DEADLINE_DAYS * DAY_MS).toISOString();
}

// ─── Intake ───────────────────────────────────────────────────────────────────

export interface IntakeData {
  topicStatement:     string;
  learningObjectives: string[];
  targeting:          ScreeningTargeting;
  callCount:          number;
  /** ISO. */
  deadline:           string;
  /** CLIENT-side whole dollars per hour, on the $50 grid. */
  clientRate:         number;
  callLengthMin:      CallLengthMin;
}

/**
 * The client's brief. Two fields are required — a topic and three to six
 * learning objectives — and everything else has a default, which is what makes
 * the intake finishable in ninety seconds.
 *
 * Objectives are trimmed and blanks are dropped BEFORE the count is judged, so
 * the three empty rows the form starts with do not count as three objectives
 * and a client who leaves a spare row open is not refused for it. Unknown keys
 * in the body are ignored.
 *
 * Every rule that can fail reports separately: the caller gets the whole list
 * and the intake page can mark every bad field at once.
 */
export function validateIntakeInput(body: Record<string, unknown>): Validated<IntakeData> {
  const errors: ValidationError[] = [];

  // ── Topic ────────────────────────────────────────────────────────────────
  const topicStatement = trimmed(body.topicStatement);
  if (!topicStatement) {
    errors.push(err('topicStatement', 'topic_required',
      'Add a one-line topic so an expert knows what the call is about.'));
  } else if (topicStatement.length > LIMITS.topicStatement) {
    errors.push(err('topicStatement', 'topic_too_long',
      `Keep the topic to ${LIMITS.topicStatement} characters or fewer.`));
  }

  // ── Learning objectives ──────────────────────────────────────────────────
  const rawObjectives = Array.isArray(body.learningObjectives) ? body.learningObjectives : null;
  const learningObjectives: string[] = [];
  if (rawObjectives === null) {
    errors.push(err('learningObjectives', 'objectives_required',
      `List ${LIMITS.objectivesMin} to ${LIMITS.objectivesMax} things you need to learn on the call.`));
  } else {
    rawObjectives.forEach((raw, index) => {
      const text = trimmed(raw);
      if (!text) return;
      if (text.length > LIMITS.objectiveText) {
        errors.push(err(`learningObjectives[${index}]`, 'objective_too_long',
          `Keep each objective to ${LIMITS.objectiveText} characters or fewer.`));
        return;
      }
      learningObjectives.push(text);
    });
    if (learningObjectives.length < LIMITS.objectivesMin) {
      errors.push(err('learningObjectives', 'too_few_objectives',
        `Add at least ${LIMITS.objectivesMin} learning objectives — that is what the expert is screened against.`));
    } else if (learningObjectives.length > LIMITS.objectivesMax) {
      errors.push(err('learningObjectives', 'too_many_objectives',
        `Keep it to ${LIMITS.objectivesMax} objectives or fewer so the screening form stays answerable.`));
    }
  }

  // ── Call count ───────────────────────────────────────────────────────────
  let callCount = DEFAULT_CALL_COUNT;
  if (!absent(body.callCount)) {
    const parsed = asInteger(body.callCount);
    if (parsed === null || parsed < LIMITS.callCountMin || parsed > LIMITS.callCountMax) {
      errors.push(err('callCount', 'invalid_call_count',
        `Ask for between ${LIMITS.callCountMin} and ${LIMITS.callCountMax} calls.`));
    } else {
      callCount = parsed;
    }
  }

  // ── Deadline ─────────────────────────────────────────────────────────────
  const now = Date.now();
  let deadline = defaultDeadlineIso(now);
  if (!absent(body.deadline)) {
    const raw     = trimmed(body.deadline);
    const instant = raw ? deadlineInstant(raw) : null;
    if (instant === null) {
      errors.push(err('deadline', 'invalid_deadline', 'Enter the deadline as a date.'));
    } else {
      const days = utcDay(instant) - utcDay(now);
      if (days < LIMITS.deadlineMinDays) {
        errors.push(err('deadline', 'deadline_too_soon',
          'Pick a deadline at least a day out — experts need time to reply.'));
      } else if (days > LIMITS.deadlineMaxDays) {
        errors.push(err('deadline', 'deadline_too_far',
          `Pick a deadline within ${LIMITS.deadlineMaxDays} days.`));
      } else {
        deadline = new Date(instant).toISOString();
      }
    }
  }

  // ── Client rate ──────────────────────────────────────────────────────────
  let clientRate = DEFAULT_CLIENT_RATE;
  if (!absent(body.clientRate)) {
    const parsed = asInteger(body.clientRate);
    if (parsed === null || !isValidClientRateUsd(parsed)) {
      errors.push(err('clientRate', 'invalid_client_rate',
        'Set the hourly rate in $50 steps, starting at $100.'));
    } else {
      clientRate = parsed;
    }
  }

  // ── Call length ──────────────────────────────────────────────────────────
  let callLengthMin: CallLengthMin = DEFAULT_CALL_LENGTH_MIN;
  if (!absent(body.callLengthMin)) {
    const parsed = asInteger(body.callLengthMin);
    const match  = CALL_LENGTHS.find(len => len === parsed);
    if (match === undefined) {
      errors.push(err('callLengthMin', 'invalid_call_length',
        'Choose a call length of 30, 45 or 60 minutes.'));
    } else {
      callLengthMin = match;
    }
  }

  if (errors.length > 0) return { errors };
  return {
    data: {
      topicStatement,
      learningObjectives,
      targeting: sanitizeTargeting(body.targeting),
      callCount,
      deadline,
      clientRate,
      callLengthMin,
    },
  };
}

// ─── Objective edits ──────────────────────────────────────────────────────────

export interface ObjectiveEdit {
  id:          string;
  stem:        string;
  proofPrompt: string;
}

/**
 * The inline edits from the draft screening set: `{ objectives: [{ id, stem,
 * proofPrompt }] }`. Both texts are required — an editor cannot blank a
 * question and leave the set approvable — and both are one-liners, because the
 * expert reads them on a phone.
 *
 * An EMPTY list is accepted: "approve with no pending edits" is a real thing
 * the page does, and the route writes nothing. Ids are not checked for
 * existence here; lib/requestStore.updateObjectiveItems only writes rows that
 * belong to the request, so an id from another request silently does nothing.
 * Duplicate ids ARE refused: two edits to one row would leave the client
 * looking at whichever won.
 */
export function validateObjectiveEdits(body: Record<string, unknown>): Validated<ObjectiveEdit[]> {
  const errors: ValidationError[] = [];
  const raw = body.objectives;

  if (!Array.isArray(raw)) {
    return { errors: [err('objectives', 'objectives_required', 'Send the objectives you edited.')] };
  }
  if (raw.length > LIMITS.objectivesMax) {
    return {
      errors: [err('objectives', 'too_many_objectives',
        `A request has at most ${LIMITS.objectivesMax} objectives.`)],
    };
  }

  const data: ObjectiveEdit[] = [];
  const seen = new Set<string>();

  raw.forEach((entry, index) => {
    const row         = asRecord(entry);
    const id          = trimmed(row.id);
    const stem        = trimmed(row.stem);
    const proofPrompt = trimmed(row.proofPrompt);

    if (!id) {
      errors.push(err(`objectives[${index}].id`, 'objective_id_required',
        'Every edit must say which objective it belongs to.'));
      return;
    }
    if (seen.has(id)) {
      errors.push(err(`objectives[${index}].id`, 'duplicate_objective_id',
        'Each objective can only be edited once per save.'));
      return;
    }
    seen.add(id);

    if (!stem) {
      errors.push(err(`objectives[${index}].stem`, 'stem_required',
        'A screening question cannot be empty.'));
    } else if (stem.length > LIMITS.stem) {
      errors.push(err(`objectives[${index}].stem`, 'stem_too_long',
        `Keep each question to ${LIMITS.stem} characters or fewer.`));
    }

    if (!proofPrompt) {
      errors.push(err(`objectives[${index}].proofPrompt`, 'proof_prompt_required',
        'A proof prompt cannot be empty.'));
    } else if (proofPrompt.length > LIMITS.proofPrompt) {
      errors.push(err(`objectives[${index}].proofPrompt`, 'proof_prompt_too_long',
        `Keep each proof prompt to ${LIMITS.proofPrompt} characters or fewer.`));
    }

    if (stem && proofPrompt && stem.length <= LIMITS.stem && proofPrompt.length <= LIMITS.proofPrompt) {
      data.push({ id, stem, proofPrompt });
    }
  });

  if (errors.length > 0) return { errors };
  return { data };
}

// ─── Expert submission ────────────────────────────────────────────────────────

export interface ScreeningSubmissionAnswer {
  objectiveId: string;
  answer:      ScreeningAnswer;
  proofText:   string | null;
}

export interface ScreeningSubmissionData {
  answers:      ScreeningSubmissionAnswer[];
  rateAccepted: boolean;
  /** EXPERT-side dollars per hour; null whenever the rate was accepted. */
  rateAsk:      number | null;
  availability: ScreeningAvailability;
}

/**
 * The expert's screening form — the one validator reached with no session.
 *
 * EVERY objective is answered EXACTLY ONCE and nothing extra: a partial
 * submission would show the client a coverage ratio over a denominator the
 * expert never saw, and an unknown objective id would write a row against
 * another request. A Yes needs the one sentence of proof; a No or an Unsure has
 * its proof FORCED to null rather than refused, because the form hides that box
 * and anything arriving in it did not come from the form.
 *
 * `rateAsk` is EXPERT-side dollars and is required exactly when the expert did
 * not accept the offer. Answers come back in `objectiveIds` order, not body
 * order, so the stored rows follow the order the form displayed.
 */
export function validateScreeningSubmission(
  body: Record<string, unknown>,
  objectiveIds: string[],
): Validated<ScreeningSubmissionData> {
  const errors: ValidationError[] = [];

  // ── Answers ──────────────────────────────────────────────────────────────
  const raw = Array.isArray(body.answers) ? body.answers : null;
  const byObjective = new Map<string, ScreeningSubmissionAnswer>();

  if (raw === null) {
    errors.push(err('answers', 'answers_required', 'Answer every question before sending.'));
  } else {
    raw.forEach((entry, index) => {
      const row         = asRecord(entry);
      const objectiveId = trimmed(row.objectiveId);
      const answerRaw   = trimmed(row.answer);
      const answer      = ANSWERS.find(a => a === answerRaw);

      if (!objectiveId || !objectiveIds.includes(objectiveId)) {
        errors.push(err(`answers[${index}].objectiveId`, 'unknown_objective',
          'That question is not part of this screening.'));
        return;
      }
      if (byObjective.has(objectiveId)) {
        errors.push(err(`answers[${index}].objectiveId`, 'duplicate_answer',
          'Each question can only be answered once.'));
        return;
      }
      if (answer === undefined) {
        errors.push(err(`answers[${index}].answer`, 'invalid_answer',
          'Answer yes, no or unsure.'));
        return;
      }

      let proofText: string | null = null;
      if (answer === 'yes') {
        const proof = trimmed(row.proofText);
        if (!proof) {
          errors.push(err(`answers[${index}].proofText`, 'proof_required',
            'Add one sentence saying which role and which years this comes from.'));
          return;
        }
        if (proof.length > LIMITS.proofText) {
          errors.push(err(`answers[${index}].proofText`, 'proof_too_long',
            `Keep it to ${LIMITS.proofText} characters or fewer.`));
          return;
        }
        proofText = proof;
      }

      byObjective.set(objectiveId, { objectiveId, answer, proofText });
    });

    for (const id of objectiveIds) {
      if (!byObjective.has(id)) {
        errors.push(err('answers', 'missing_answer', 'Answer every question before sending.'));
        break;
      }
    }
  }

  // ── Rate ─────────────────────────────────────────────────────────────────
  let rateAccepted = false;
  let rateAsk: number | null = null;
  if (typeof body.rateAccepted !== 'boolean') {
    errors.push(err('rateAccepted', 'invalid_rate_accepted',
      'Say whether the rate works for you.'));
  } else {
    rateAccepted = body.rateAccepted;
    if (!rateAccepted) {
      const parsed = asInteger(body.rateAsk);
      if (parsed === null) {
        errors.push(err('rateAsk', 'rate_ask_required', 'Tell us your hourly rate.'));
      } else if (parsed < LIMITS.rateAskMin || parsed > LIMITS.rateAskMax) {
        errors.push(err('rateAsk', 'invalid_rate_ask',
          `Enter an hourly rate between $${LIMITS.rateAskMin} and $${LIMITS.rateAskMax}.`));
      } else {
        rateAsk = parsed;
      }
    }
  }

  // ── Availability ─────────────────────────────────────────────────────────
  const availability = AVAILABILITIES.find(a => a === trimmed(body.availability));
  if (availability === undefined) {
    errors.push(err('availability', 'invalid_availability',
      'Choose this week, next week or later.'));
  }

  // `availability === undefined` always pushed an error above, so `errors` is
  // never empty when it is; the combined test is what narrows the type.
  if (availability === undefined || errors.length > 0) return { errors };

  return {
    data: {
      answers: objectiveIds.map(id => byObjective.get(id)).filter(
        (a): a is ScreeningSubmissionAnswer => a !== undefined),
      rateAccepted,
      rateAsk,
      availability,
    },
  };
}

// ─── Candidate (staff) ────────────────────────────────────────────────────────

export interface CandidateInput {
  name:       string;
  headline:   string;
  background: ExpertBackgroundLine[];
  /** Lower-cased, or null when the link will be handed over out of band. */
  email:      string | null;
  send:       boolean;
}

/**
 * A candidate being added to an approved request by platform staff.
 *
 * `name` is required and is ADMIN-ONLY for the rest of its life — a client sees
 * "Candidate N", the headline and the background lines. Every background field
 * is a one-liner: the client reads them stacked in a table cell.
 *
 * `email` is optional because a link can be handed over out of band, but
 * `send: true` without one is refused rather than quietly downgraded to
 * "show me the link" — staff who ticked send expect an email to go.
 */
export function validateCandidateInput(body: Record<string, unknown>): Validated<CandidateInput> {
  const errors: ValidationError[] = [];

  const name = trimmed(body.name);
  if (!name) {
    errors.push(err('name', 'name_required', "Add the candidate's name."));
  } else if (name.length > LIMITS.candidateName) {
    errors.push(err('name', 'name_too_long',
      `Keep the name to ${LIMITS.candidateName} characters or fewer.`));
  }

  const headline = trimmed(body.headline);
  if (headline.length > LIMITS.candidateHeadline) {
    errors.push(err('headline', 'headline_too_long',
      `Keep the headline to ${LIMITS.candidateHeadline} characters or fewer.`));
  }

  const rawBackground = Array.isArray(body.background) ? body.background : [];
  const background: ExpertBackgroundLine[] = [];
  if (rawBackground.length > LIMITS.backgroundLinesMax) {
    errors.push(err('background', 'too_many_background_lines',
      `Keep it to ${LIMITS.backgroundLinesMax} background lines or fewer.`));
  } else {
    rawBackground.forEach((entry, index) => {
      const row     = asRecord(entry);
      const company = trimmed(row.company);
      const role    = trimmed(row.role);
      const dates   = trimmed(row.dates);

      if (!company) {
        errors.push(err(`background[${index}].company`, 'company_required',
          'Every background line needs a company.'));
        return;
      }
      if (company.length > LIMITS.backgroundField) {
        errors.push(err(`background[${index}].company`, 'company_too_long',
          `Keep each field to ${LIMITS.backgroundField} characters or fewer.`));
        return;
      }
      if (role.length > LIMITS.backgroundField) {
        errors.push(err(`background[${index}].role`, 'role_too_long',
          `Keep each field to ${LIMITS.backgroundField} characters or fewer.`));
        return;
      }
      if (dates.length > LIMITS.backgroundField) {
        errors.push(err(`background[${index}].dates`, 'dates_too_long',
          `Keep each field to ${LIMITS.backgroundField} characters or fewer.`));
        return;
      }
      background.push({ company, role, dates });
    });
  }

  let email: string | null = null;
  if (!absent(body.email)) {
    const candidate = trimmed(body.email).toLowerCase();
    if (candidate.length > LIMITS.email || !EMAIL_RE.test(candidate)) {
      errors.push(err('email', 'invalid_email', 'That does not look like an email address.'));
    } else {
      email = candidate;
    }
  }

  const send = body.send === true;
  if (send && email === null) {
    errors.push(err('email', 'email_required_to_send',
      'Add an email address, or clear "email it" and copy the link instead.'));
  }

  if (errors.length > 0) return { errors };
  return { data: { name, headline, background, email, send } };
}

// ─── Call outcomes (stage 5) ──────────────────────────────────────────────────

export interface OutcomesInput {
  outcomes: CallOutcome[];
}

/**
 * What the call actually covered, marked by the client afterwards
 * (POST /api/requests/[id]/tokens/[tokenId]/outcomes).
 *
 * PARTIAL BY DESIGN, unlike the expert's submission. A client marks the
 * objectives they got to and saves; they come back and mark the rest, or change
 * their mind about one. So a subset is accepted and the store upserts on
 * (token_id, objective_id) — but an EMPTY list is refused, because "save
 * nothing" is a press that did nothing and the person deserves to be told.
 *
 * The three other rules are the submission validator's rules for the same
 * reasons: an unknown objective id would write a verdict against another
 * request, a duplicate would make the last one in the array silently win, and
 * more entries than the request has objectives is not a list this product can
 * have produced.
 *
 * Outcomes come back in `objectiveIds` order, not body order, so the rows are
 * written in the order the screening set reads.
 */
export function validateOutcomesInput(
  body: Record<string, unknown>,
  objectiveIds: string[],
): Validated<CallOutcome[]> {
  const errors: ValidationError[] = [];

  const raw = Array.isArray(body.outcomes) ? body.outcomes : null;
  if (raw === null) {
    return {
      errors: [err('outcomes', 'outcomes_required',
        'Mark at least one objective before saving.')],
    };
  }
  if (raw.length === 0) {
    return {
      errors: [err('outcomes', 'outcomes_required',
        'Mark at least one objective before saving.')],
    };
  }
  if (raw.length > objectiveIds.length) {
    return {
      errors: [err('outcomes', 'too_many_outcomes',
        'That is more objectives than this request has.')],
    };
  }

  const byObjective = new Map<string, CallOutcomeValue>();

  raw.forEach((entry, index) => {
    const row         = asRecord(entry);
    const objectiveId = trimmed(row.objectiveId);
    const outcomeRaw  = trimmed(row.outcome);
    const outcome     = OUTCOMES.find(o => o === outcomeRaw);

    if (!objectiveId || !objectiveIds.includes(objectiveId)) {
      errors.push(err(`outcomes[${index}].objectiveId`, 'unknown_objective',
        'That question is not part of this screening.'));
      return;
    }
    if (byObjective.has(objectiveId)) {
      errors.push(err(`outcomes[${index}].objectiveId`, 'duplicate_outcome',
        'Each objective can only be marked once.'));
      return;
    }
    if (outcome === undefined) {
      errors.push(err(`outcomes[${index}].outcome`, 'invalid_outcome',
        'Mark each objective answered, partial or unanswered.'));
      return;
    }

    byObjective.set(objectiveId, outcome);
  });

  if (errors.length > 0) return { errors };

  const data: CallOutcome[] = [];
  for (const objectiveId of objectiveIds) {
    const outcome = byObjective.get(objectiveId);
    if (outcome !== undefined) data.push({ objectiveId, outcome });
  }
  return { data };
}

// ─── Expert identity ──────────────────────────────────────────────────────────

/**
 * The cross-request key for one expert (screening_tokens.expert_id).
 *
 * With an address: 'em:' + the first 24 hex of sha256(lowercased, trimmed
 * address). STABLE — the same person screened for two different requests gets
 * the same id, which is the whole basis of the reliability and gap re-match
 * queries in the migration header. It is a one-way digest, so the key itself
 * discloses nothing: the address lives in `expert_email` on the row, behind the
 * staff-only boundary, and nowhere else.
 *
 * Without one: 'anon:' + 12 random hex. Unique per candidate and deliberately
 * NOT derivable from the name — two people with the same name are two experts,
 * and the same person added twice without an address is two rows. That is the
 * honest answer when we have no identifier.
 *
 * The ONLY non-deterministic function in this module.
 */
export function normalizeExpertId(email: string | null): string {
  const normalized = (email ?? '').trim().toLowerCase();
  if (!normalized) return `anon:${randomBytes(6).toString('hex')}`;
  return `em:${createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 24)}`;
}
