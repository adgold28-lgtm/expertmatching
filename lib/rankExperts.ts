/**
 * Expert Ranking Utilities
 *
 * Deterministic scoring functions for value chain fit, seniority fit,
 * recency of experience, geography fit, source verifiability, and the
 * industry distance adjustment. AI-scored dimensions (topicRelevance,
 * operationalExposure, coverageOfKeyQuestions) are returned by the API
 * route and merged with these deterministic scores.
 */

import {
  RankableExpert,
  ProjectBrief,
  ScoredDimension,
  ScoreBreakdown,
  ScoringWeights,
  RankedExpertResult,
  ValueChainStage,
  SeniorityLevel,
} from '../rankExpertsTypes';

// ─── Constants ────────────────────────────────────────────────────────────────

export const VALUE_CHAIN_STAGES: ValueChainStage[] = [
  'Raw Materials / Inputs',
  'Manufacturing / Production',
  'Distribution / Logistics',
  'Retail / Sales',
  'End Customer / End User',
  'Service Provider / Vendor',
  'Investor / Advisor',
  'Regulator / Policy',
  'Other / Adjacent',
];

export const SENIORITY_LEVELS: SeniorityLevel[] = [
  'Individual Contributor / Specialist',
  'Manager',
  'Director',
  'VP / GM / Head',
  'C-Suite / Founder',
  'Advisor / Investor / Board',
];

// Adjacency map: stages that are meaningfully related (useful neighbors)
const VALUE_CHAIN_ADJACENCY: Record<ValueChainStage, ValueChainStage[]> = {
  'Raw Materials / Inputs': ['Manufacturing / Production', 'Service Provider / Vendor'],
  'Manufacturing / Production': ['Raw Materials / Inputs', 'Distribution / Logistics', 'Service Provider / Vendor'],
  'Distribution / Logistics': ['Manufacturing / Production', 'Retail / Sales', 'Service Provider / Vendor'],
  'Retail / Sales': ['Distribution / Logistics', 'End Customer / End User'],
  'End Customer / End User': ['Retail / Sales', 'Service Provider / Vendor'],
  'Service Provider / Vendor': ['Manufacturing / Production', 'Distribution / Logistics', 'End Customer / End User'],
  'Investor / Advisor': ['Other / Adjacent'],
  'Regulator / Policy': ['Other / Adjacent'],
  'Other / Adjacent': ['Investor / Advisor', 'Regulator / Policy'],
};

// Numeric seniority ranking (for gap calculation)
const SENIORITY_RANK: Record<SeniorityLevel, number> = {
  'Individual Contributor / Specialist': 1,
  'Manager': 2,
  'Director': 3,
  'VP / GM / Head': 4,
  'C-Suite / Founder': 5,
  'Advisor / Investor / Board': 4, // treated as senior but slightly different
};

// ─── Deterministic Scoring ────────────────────────────────────────────────────

/**
 * Value Chain Fit (0–15)
 * Exact match = 15, adjacent stage = 10, present but not target = 5,
 * unknown or no target set = 7 (neutral).
 */
export function scoreValueChainFit(expert: RankableExpert, brief: ProjectBrief): ScoredDimension {
  const stage = expert.valueChainStage;
  const targets = brief.targetValueChainStages;

  if (!stage) {
    return { score: 4, max: 15, reason: 'Value chain stage not specified — unable to assess fit.' };
  }
  if (targets.length === 0) {
    return { score: 7, max: 15, reason: 'No target value chain stages set in brief — neutral score applied.' };
  }
  if (targets.includes(stage as ValueChainStage)) {
    return { score: 15, max: 15, reason: `Exact match: expert is in "${stage}", which is a primary target stage.` };
  }
  const adjacent = VALUE_CHAIN_ADJACENCY[stage as ValueChainStage] ?? [];
  if (targets.some((t) => adjacent.includes(t))) {
    return {
      score: 10,
      max: 15,
      reason: `Adjacent fit: "${stage}" is not a primary target stage but is directly adjacent to one of the target stages.`,
    };
  }
  return {
    score: 4,
    max: 15,
    reason: `Weak fit: "${stage}" is not among the target stages and is not adjacent to any of them.`,
  };
}

/**
 * Seniority Fit (0–10)
 * Exact match = 10, 1 level off = 7, 2 levels off = 5, 3+ levels = 3,
 * unknown = 5 (neutral).
 */
export function scoreSeniorityFit(expert: RankableExpert, brief: ProjectBrief): ScoredDimension {
  const expertLevel = expert.seniorityLevel;
  const preferred = brief.preferredSeniority;

  if (!expertLevel) {
    return { score: 4, max: 10, reason: 'Seniority level not specified.' };
  }
  if (!preferred) {
    return { score: 6, max: 10, reason: 'No preferred seniority set in brief — neutral score applied.' };
  }
  if (expertLevel === preferred) {
    return { score: 10, max: 10, reason: `Exact match: expert is ${expertLevel}, which is the preferred seniority.` };
  }
  const diff = Math.abs(
    SENIORITY_RANK[expertLevel as SeniorityLevel] - SENIORITY_RANK[preferred as SeniorityLevel]
  );
  if (diff === 1) {
    return { score: 7, max: 10, reason: `Close fit: expert is ${expertLevel} — one level from the preferred ${preferred}.` };
  }
  if (diff === 2) {
    return { score: 5, max: 10, reason: `Partial fit: expert is ${expertLevel}, two levels from the preferred ${preferred}.` };
  }
  return { score: 3, max: 10, reason: `Poor fit: expert is ${expertLevel}, three or more levels from the preferred ${preferred}.` };
}

/**
 * Recency of Relevant Experience (0–10)
 * Currently in role = 10, <2y out = 8, 2–4y = 6, 4–7y = 3, >7y = 1.
 */
export function scoreRecency(expert: RankableExpert): ScoredDimension {
  const currentYear = new Date().getFullYear();

  // Derive years out of industry
  let yearsOut: number | null = null;
  if (expert.yearsOutsideIndustry !== null && expert.yearsOutsideIndustry >= 0) {
    yearsOut = expert.yearsOutsideIndustry;
  } else if (expert.lastDirectIndustryRoleYear !== null) {
    yearsOut = currentYear - expert.lastDirectIndustryRoleYear;
  }

  if (yearsOut === null) {
    return { score: 5, max: 10, reason: 'Recency unknown — neither years outside industry nor last role year provided.' };
  }
  if (yearsOut === 0) {
    return { score: 10, max: 10, reason: 'Currently active in the relevant industry or function.' };
  }
  if (yearsOut <= 2) {
    return { score: 8, max: 10, reason: `Left the relevant role within the last 2 years (${yearsOut}y ago) — experience is recent.` };
  }
  if (yearsOut <= 4) {
    return { score: 6, max: 10, reason: `Left the relevant role ${yearsOut} years ago — moderately recent.` };
  }
  if (yearsOut <= 7) {
    return { score: 3, max: 10, reason: `Left the relevant role ${yearsOut} years ago — experience may be dated.` };
  }
  return { score: 1, max: 10, reason: `Left the relevant role more than 7 years ago (${yearsOut}y) — industry may have changed significantly.` };
}

/**
 * Geography Fit (0–5)
 * Matching geography = 5, no preference set = 5, different = 2, unknown = 2.
 */
export function scoreGeographyFit(expert: RankableExpert, brief: ProjectBrief): ScoredDimension {
  const preferred = brief.preferredGeography.trim().toLowerCase();
  const geo = expert.geography.trim().toLowerCase();

  if (!preferred || preferred === 'any geography' || preferred === 'global') {
    return { score: 5, max: 5, reason: 'No specific geography required — all geographies accepted.' };
  }
  if (!geo) {
    return { score: 2, max: 5, reason: 'Expert geography not specified.' };
  }
  if (geo.includes(preferred) || preferred.includes(geo)) {
    return { score: 5, max: 5, reason: `Geography matches: expert is based in "${expert.geography}".` };
  }
  // Rough continental overlap (US ≈ North America, etc.)
  const continentGroups: Record<string, string[]> = {
    'north america': ['united states', 'canada', 'mexico', 'us', 'usa'],
    'europe': ['uk', 'germany', 'france', 'italy', 'spain', 'netherlands', 'nordic', 'eu'],
    'asia pacific': ['china', 'japan', 'south korea', 'australia', 'india', 'singapore', 'apac'],
    'latin america': ['brazil', 'mexico', 'colombia', 'argentina'],
    'middle east': ['uae', 'saudi', 'qatar', 'israel'],
  };
  const preferredContinent = Object.entries(continentGroups).find(([c, countries]) =>
    preferred === c || countries.some((x) => preferred.includes(x))
  )?.[0];
  const expertContinent = Object.entries(continentGroups).find(([c, countries]) =>
    geo === c || countries.some((x) => geo.includes(x))
  )?.[0];
  if (preferredContinent && expertContinent && preferredContinent === expertContinent) {
    return { score: 3, max: 5, reason: `Regional match: both are in ${preferredContinent} but different sub-markets.` };
  }
  return { score: 1, max: 5, reason: `Geography mismatch: expert is in "${expert.geography}", brief targets "${brief.preferredGeography}".` };
}

/**
 * Source Verifiability (0–5)
 * Has LinkedIn/URL = 3, has detailed source notes = 2, nothing = 0.
 */
export function scoreSourceVerifiability(expert: RankableExpert): ScoredDimension {
  let score = 0;
  const reasons: string[] = [];

  if (expert.linkedinOrSourceUrl.trim()) {
    score += 3;
    reasons.push('has a source URL');
  }
  if (expert.sourceNotes.trim().length >= 30) {
    score += 2;
    reasons.push('has detailed source notes');
  } else if (expert.sourceNotes.trim().length > 0) {
    score += 1;
    reasons.push('has brief source notes');
  }

  if (score === 0) {
    return { score: 0, max: 5, reason: 'No source URL or notes provided — profile unverified.' };
  }
  return { score, max: 5, reason: `Verifiable: expert ${reasons.join(' and ')}.` };
}

/**
 * Industry Distance Adjustment (0 to −10)
 * Accounts for time spent outside the industry. Penalty is halved for
 * experts who left operating roles but stayed connected (Investor/Advisor).
 */
export function calculateIndustryDistanceAdjustment(expert: RankableExpert): { adjustment: number; reason: string } {
  const currentYear = new Date().getFullYear();

  let yearsOut: number | null = null;
  if (expert.yearsOutsideIndustry !== null && expert.yearsOutsideIndustry >= 0) {
    yearsOut = expert.yearsOutsideIndustry;
  } else if (expert.lastDirectIndustryRoleYear !== null) {
    yearsOut = currentYear - expert.lastDirectIndustryRoleYear;
  }

  if (yearsOut === null || yearsOut === 0) {
    return { adjustment: 0, reason: 'Currently active in the industry — no distance penalty.' };
  }

  let rawPenalty: number;
  if (yearsOut < 2) rawPenalty = -1;
  else if (yearsOut <= 4) rawPenalty = -3;
  else if (yearsOut <= 7) rawPenalty = -6;
  else rawPenalty = -10;

  // Halve penalty for investors/advisors who stayed connected
  const isConnectedAdvisor =
    expert.perspectiveType === 'Investor' ||
    expert.perspectiveType === 'Advisor' ||
    expert.seniorityLevel === 'Advisor / Investor / Board';
  if (isConnectedAdvisor && yearsOut > 0) {
    const reduced = Math.ceil(rawPenalty / 2);
    return {
      adjustment: reduced,
      reason: `Left direct operating role ${yearsOut}y ago, but has stayed connected as ${expert.perspectiveType || 'advisor/investor'} — distance penalty halved (${rawPenalty} → ${reduced}).`,
    };
  }

  return {
    adjustment: rawPenalty,
    reason: `Left the relevant industry/function ${yearsOut} year${yearsOut === 1 ? '' : 's'} ago.`,
  };
}

/**
 * Build the deterministic portions of the ScoreBreakdown.
 * AI-scored dimensions (topicRelevance, operationalExposure,
 * coverageOfKeyQuestions) are placeholders to be merged later.
 */
export function getDeterministicScores(
  expert: RankableExpert,
  brief: ProjectBrief
): Pick<ScoreBreakdown, 'valueChainFit' | 'seniorityFit' | 'recencyOfExperience' | 'geographyFit' | 'sourceVerifiability'> {
  return {
    valueChainFit: scoreValueChainFit(expert, brief),
    seniorityFit: scoreSeniorityFit(expert, brief),
    recencyOfExperience: scoreRecency(expert),
    geographyFit: scoreGeographyFit(expert, brief),
    sourceVerifiability: scoreSourceVerifiability(expert),
  };
}

// ─── Weight-adjusted Re-ranking ───────────────────────────────────────────────

/**
 * Re-compute finalScore for every result using new weights, then re-sort.
 * Proportional: each dimension's contribution = (score/max) * weight.
 * Weights are normalized so they don't need to sum to 100.
 */
export function recomputeWithWeights(
  results: RankedExpertResult[],
  weights: ScoringWeights
): RankedExpertResult[] {
  const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);
  if (totalWeight === 0) return results;

  return results
    .map((r) => {
      const b = r.scoreBreakdown;
      const raw =
        (b.topicRelevance.score / b.topicRelevance.max) * (weights.topicRelevance / totalWeight) * 100 +
        (b.operationalExposure.score / b.operationalExposure.max) * (weights.operationalExposure / totalWeight) * 100 +
        (b.valueChainFit.score / b.valueChainFit.max) * (weights.valueChainFit / totalWeight) * 100 +
        (b.seniorityFit.score / b.seniorityFit.max) * (weights.seniorityFit / totalWeight) * 100 +
        (b.recencyOfExperience.score / b.recencyOfExperience.max) * (weights.recencyOfExperience / totalWeight) * 100 +
        (b.geographyFit.score / b.geographyFit.max) * (weights.geographyFit / totalWeight) * 100 +
        (b.sourceVerifiability.score / b.sourceVerifiability.max) * (weights.sourceVerifiability / totalWeight) * 100 +
        (b.coverageOfKeyQuestions.score / b.coverageOfKeyQuestions.max) * (weights.coverageOfKeyQuestions / totalWeight) * 100;

      const rawScore = Math.round(raw);
      const finalScore = Math.max(0, Math.min(100, rawScore + r.industryDistanceAdjustment));
      return { ...r, rawScore, finalScore };
    })
    .sort((a, b) => b.finalScore - a.finalScore);
}

// ─── Perspective Explainers ───────────────────────────────────────────────────

export const VALUE_CHAIN_PERSPECTIVE: Record<ValueChainStage, string> = {
  'Raw Materials / Inputs':
    'Upstream view: supply constraints, commodity pricing, procurement dynamics, and input cost pressure.',
  'Manufacturing / Production':
    'Operations view: throughput, process efficiency, yield, bottlenecks, and manufacturing economics.',
  'Distribution / Logistics':
    'Channel view: lead times, handoff friction, logistics cost, carrier relationships, and last-mile complexity.',
  'Retail / Sales':
    'Demand view: buyer behavior, shelf dynamics, pricing pressure, sell-through, and channel competition.',
  'End Customer / End User':
    'Adoption view: product usability, pain points, switching costs, and real-world purchase criteria.',
  'Service Provider / Vendor':
    'Support view: service delivery, contracts, recurring revenue, and implementation complexity.',
  'Investor / Advisor':
    'Portfolio view: broader market pattern recognition, capital allocation signals, and sector-level trends — but typically less tactically grounded.',
  'Regulator / Policy':
    'Compliance view: legal constraints, incentive structures, permitting, and how policy shapes market behavior.',
  'Other / Adjacent':
    'Peripheral view: relevant context from a related market or function — useful for comparative insight.',
};

export const SENIORITY_PERSPECTIVE: Record<SeniorityLevel, string> = {
  'Individual Contributor / Specialist':
    'Strongest on tactical detail and day-to-day operational reality. Narrower strategic view, but often the most grounded in how things actually work.',
  'Manager':
    'Process-level insight with team and workflow visibility. Balances execution detail with some cross-functional context.',
  'Director':
    'Cross-functional execution lens. Meaningful strategic context combined with hands-on oversight of programs and initiatives.',
  'VP / GM / Head':
    'Economic and strategic lens. Strong on decisions, trade-offs, and business outcomes — may be less close to execution detail.',
  'C-Suite / Founder':
    'Highest strategic context and cross-industry pattern recognition. Furthest from daily execution, but uniquely positioned on market dynamics and organizational choices.',
  'Advisor / Investor / Board':
    'Broad pattern recognition across many companies and markets. Valuable for benchmarks and strategic framing — but one step removed from current operations.',
};
