import type { SeniorityTier, TierPricing } from '../types';

export type { SeniorityTier, TierPricing };

export const TIER_PRICING: Record<SeniorityTier, TierPricing> = {
  executive: { tier: 'executive', label: 'Executive',  callRate: 800, expertRate: 560, platformFee: 240 },
  senior:    { tier: 'senior',    label: 'Senior',     callRate: 600, expertRate: 420, platformFee: 180 },
  mid:       { tier: 'mid',       label: 'Mid-Level',  callRate: 400, expertRate: 280, platformFee: 120 },
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
