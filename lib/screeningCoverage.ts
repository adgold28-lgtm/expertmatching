// lib/screeningCoverage.ts — coverage arithmetic and respondent ordering for
// the Structured Request & Screening Flow (docs/SCREENING_FLOW_PLAN.md).
//
// COVERAGE IS COMPUTED, NEVER STORED. It is `yes / total` over one candidate's
// screening answers and nothing else: no weighting, no model score, no quality
// judgement. A stored number would be a second source of truth the moment an
// objective is added or an answer is corrected, and a weighted one would be the
// platform putting its thumb on the scale in a product whose whole claim is
// that the client sees the expert's own words.
//
// The three bands exist so a client can read a table at a glance, not so the
// platform can rank experts for them: nothing in the product hides or filters a
// respondent on a band, and the expanded row always shows the per-objective
// answers behind the badge.
//
// Pure — no I/O, no env, no clock. Unit-checked by
// scripts/test-screening-core.ts.

import type { Coverage, ScreeningAnswer } from '../types';

// ─── Bands ────────────────────────────────────────────────────────────────────

/** At or above this ratio a respondent reads green. */
export const COVERAGE_GREEN_MIN = 0.66;
/** At or above this ratio (and below green) a respondent reads amber. */
export const COVERAGE_AMBER_MIN = 0.34;

export type CoverageBand = 'green' | 'amber' | 'red';

/**
 * The badge colour for a coverage ratio. Two thirds and up is green, one third
 * and up is amber, anything less is red — the thresholds sit just below the
 * exact thirds so 4/6 and 2/3 land green and 2/6 and 1/3 land red, which is
 * what "can speak to most of it" and "can speak to a third of it" mean in
 * practice.
 */
export function coverageBand(ratio: number): CoverageBand {
  if (!Number.isFinite(ratio)) return 'red';
  if (ratio >= COVERAGE_GREEN_MIN) return 'green';
  if (ratio >= COVERAGE_AMBER_MIN) return 'amber';
  return 'red';
}

// ─── Coverage ─────────────────────────────────────────────────────────────────

/**
 * How many of the objectives a candidate answered yes to, out of how many they
 * answered at all. `ratio` is 0 for an empty set — a candidate who has not
 * submitted has no coverage, and dividing by zero would put NaN in a badge.
 *
 * `total` counts the ANSWERS, not the request's objectives: a submission is
 * validated to cover every objective exactly once (lib/screeningValidation.
 * validateScreeningSubmission), so the two agree, and if an objective were ever
 * added after a submission this reports what the expert was actually asked.
 */
export function computeCoverage(
  responses: ReadonlyArray<{ answer: ScreeningAnswer }>,
): Coverage {
  const total = responses.length;
  if (total === 0) return { yes: 0, total: 0, ratio: 0 };
  const yes = responses.reduce((n, r) => (r.answer === 'yes' ? n + 1 : n), 0);
  return { yes, total, ratio: yes / total };
}

// ─── Ordering ─────────────────────────────────────────────────────────────────

/**
 * The respondents table order: who answered, best coverage first.
 *
 *   1. Submitted before unsubmitted — an outstanding link is not a candidate
 *      the client can act on, so it never sits above one who replied.
 *   2. Among the submitted: coverage ratio descending, then raw yes count
 *      descending (6 of 6 outranks 3 of 3), then oldest first.
 *   3. Among the unsubmitted: oldest first, so the link that has been waiting
 *      longest is the one staff chase.
 *
 * Returns a NEW array; the input is not reordered. `createdAt` is an ISO
 * string and ISO 8601 in UTC sorts lexicographically, so no date parsing is
 * needed for the tie-break.
 */
export function sortRespondents<
  T extends { coverage: Coverage | null; submittedAt: string | null; createdAt: string },
>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const aSubmitted = a.submittedAt !== null;
    const bSubmitted = b.submittedAt !== null;
    if (aSubmitted !== bSubmitted) return aSubmitted ? -1 : 1;

    if (aSubmitted && bSubmitted) {
      const aRatio = a.coverage?.ratio ?? 0;
      const bRatio = b.coverage?.ratio ?? 0;
      if (aRatio !== bRatio) return bRatio - aRatio;

      const aYes = a.coverage?.yes ?? 0;
      const bYes = b.coverage?.yes ?? 0;
      if (aYes !== bYes) return bYes - aYes;
    }

    if (a.createdAt < b.createdAt) return -1;
    if (a.createdAt > b.createdAt) return 1;
    return 0;
  });
}
