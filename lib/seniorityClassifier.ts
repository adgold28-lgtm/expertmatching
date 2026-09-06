import type { SeniorityTier, TierPricing } from '../types';

export type { SeniorityTier, TierPricing };

export const TIER_PRICING: Record<SeniorityTier, TierPricing> = {
  // Founder, 2026-09-06: expertRate is the opening offer to the expert;
  // callRate (what the client pays) = expertRate / 0.5 rounded up to $50.
  executive: { tier: 'executive', label: 'Executive',  callRate: 1600, expertRate: 800, platformFee: 800 },
  senior:    { tier: 'senior',    label: 'Senior',     callRate: 1300, expertRate: 650, platformFee: 650 },
  mid:       { tier: 'mid',       label: 'Mid-Level',  callRate:  800, expertRate: 400, platformFee: 400 },
};

const EXECUTIVE_KEYWORDS = [
  'ceo', 'chief executive', 'cfo', 'chief financial', 'coo', 'chief operating',
  'cto', 'chief technology', 'cmo', 'chief marketing', 'founder', 'co-founder',
  'cofounder', 'president', 'managing director', 'general partner', 'managing partner',
  'chairman', 'chairwoman', 'board member', 'board director',
];

const SENIOR_KEYWORDS = [
  'svp', 'senior vice president', 'evp', 'executive vice president',
  'partner', 'principal', 'director', 'senior director', 'head of',
  'global head', 'vp', 'vice president',
];

export function classifySeniority(title: string): SeniorityTier {
  if (!title) return 'mid';
  const t = title.toLowerCase();
  if (EXECUTIVE_KEYWORDS.some(k => t.includes(k))) return 'executive';
  if (SENIOR_KEYWORDS.some(k => t.includes(k))) return 'senior';
  return 'mid';
}

// ─── Ordering ─────────────────────────────────────────────────────────────────

/** Tiers most-senior first — the order the Source list defaults to. */
export const TIER_ORDER: readonly SeniorityTier[] = ['executive', 'senior', 'mid'];

const TIER_RANK: Record<SeniorityTier, number> = { executive: 0, senior: 1, mid: 2 };

/** The two keys any expert list can be sorted by. */
export type ExpertSortKey = 'seniority' | 'score';

export const SORT_LABELS: Record<ExpertSortKey, string> = {
  seniority: 'Seniority (Executive first)',
  score:     'Relevance score (High first)',
};

/** Minimum shape a comparator needs — keeps these usable on Expert and on anything expert-like. */
export interface SortableExpert {
  title?:           string | null;
  relevance_score?: number | null;
}

function rankOf(e: SortableExpert): number {
  return TIER_RANK[classifySeniority(e.title ?? '')];
}

function scoreOf(e: SortableExpert): number {
  return e.relevance_score ?? 0;
}

/** Executive → Senior → Mid, then higher relevance score first. */
export function compareBySeniority(a: SortableExpert, b: SortableExpert): number {
  const diff = rankOf(a) - rankOf(b);
  return diff !== 0 ? diff : scoreOf(b) - scoreOf(a);
}

/** Higher relevance score first, then Executive → Senior → Mid. */
export function compareByScore(a: SortableExpert, b: SortableExpert): number {
  const diff = scoreOf(b) - scoreOf(a);
  return diff !== 0 ? diff : rankOf(a) - rankOf(b);
}

/** Comparator for a sort key — one place so every expert list sorts identically. */
export function expertComparator(key: ExpertSortKey): (a: SortableExpert, b: SortableExpert) => number {
  return key === 'score' ? compareByScore : compareBySeniority;
}

// ─── Rate framing ─────────────────────────────────────────────────────────────

/**
 * Tier rates are what we open a negotiation at, not a fixed price list. Shown
 * wherever a per-call rate is surfaced so nobody reads $800/call as final.
 */
export const RATE_DISCLAIMER =
  'Tier rates shown are opening positions — final rates are negotiated per engagement.';
