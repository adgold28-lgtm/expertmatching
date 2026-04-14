// ─── Value Chain ─────────────────────────────────────────────────────────────

export type ValueChainStage =
  | 'Raw Materials / Inputs'
  | 'Manufacturing / Production'
  | 'Distribution / Logistics'
  | 'Retail / Sales'
  | 'End Customer / End User'
  | 'Service Provider / Vendor'
  | 'Investor / Advisor'
  | 'Regulator / Policy'
  | 'Other / Adjacent';

// ─── Seniority ────────────────────────────────────────────────────────────────

export type SeniorityLevel =
  | 'Individual Contributor / Specialist'
  | 'Manager'
  | 'Director'
  | 'VP / GM / Head'
  | 'C-Suite / Founder'
  | 'Advisor / Investor / Board';

// ─── Perspective Type ─────────────────────────────────────────────────────────

export type PerspectiveType =
  | 'Operator'
  | 'Advisor'
  | 'Academic'
  | 'Customer'
  | 'Regulator'
  | 'Investor';

// ─── Project Brief ────────────────────────────────────────────────────────────

export interface ProjectBrief {
  researchQuestion: string;
  projectObjective: string;
  mustHaveKnowledge: string;
  preferredGeography: string;
  preferredSeniority: SeniorityLevel | '';
  targetValueChainStages: ValueChainStage[];
  additionalNotes: string;
}

// ─── Expert Input Record ──────────────────────────────────────────────────────

export interface RankableExpert {
  id: string;
  fullName: string;
  currentTitle: string;
  currentCompany: string;
  previousTitle: string;
  previousCompany: string;
  geography: string;
  linkedinOrSourceUrl: string;
  sourceNotes: string;
  yearsInIndustry: number | null;
  yearsOutsideIndustry: number | null;
  lastDirectIndustryRoleYear: number | null;
  valueChainStage: ValueChainStage | '';
  seniorityLevel: SeniorityLevel | '';
  perspectiveType: PerspectiveType | '';
  whyRelevant: string;
  conflictsOrConcerns: string;
  internalNotes: string;
}

// ─── Score Breakdown ──────────────────────────────────────────────────────────

// Each category: score given + the max possible + a one-line reason
export interface ScoredDimension {
  score: number;
  max: number;
  reason: string;
}

export interface ScoreBreakdown {
  topicRelevance: ScoredDimension;        // AI-scored  0–30
  operationalExposure: ScoredDimension;   // AI-scored  0–20
  valueChainFit: ScoredDimension;         // Deterministic 0–15
  seniorityFit: ScoredDimension;          // Deterministic 0–10
  recencyOfExperience: ScoredDimension;   // Deterministic 0–10
  geographyFit: ScoredDimension;          // Deterministic 0–5
  sourceVerifiability: ScoredDimension;   // Deterministic 0–5
  coverageOfKeyQuestions: ScoredDimension; // AI-scored  0–5
}

// ─── Weight Customization ─────────────────────────────────────────────────────

export interface ScoringWeights {
  topicRelevance: number;
  operationalExposure: number;
  valueChainFit: number;
  seniorityFit: number;
  recencyOfExperience: number;
  geographyFit: number;
  sourceVerifiability: number;
  coverageOfKeyQuestions: number;
}

export const DEFAULT_WEIGHTS: ScoringWeights = {
  topicRelevance: 30,
  operationalExposure: 20,
  valueChainFit: 15,
  seniorityFit: 10,
  recencyOfExperience: 10,
  geographyFit: 5,
  sourceVerifiability: 5,
  coverageOfKeyQuestions: 5,
};

export const WEIGHT_KEYS = Object.keys(DEFAULT_WEIGHTS) as (keyof ScoringWeights)[];

export const WEIGHT_LABELS: Record<keyof ScoringWeights, string> = {
  topicRelevance: 'Topic Relevance',
  operationalExposure: 'Operational Exposure',
  valueChainFit: 'Value Chain Fit',
  seniorityFit: 'Seniority Fit',
  recencyOfExperience: 'Recency of Experience',
  geographyFit: 'Geography Fit',
  sourceVerifiability: 'Source Verifiability',
  coverageOfKeyQuestions: 'Coverage of Key Questions',
};

// ─── Perspective Note ─────────────────────────────────────────────────────────

export interface PerspectiveNote {
  valueChainEffect: string;
  seniorityEffect: string;
  timeOutsideEffect: string;
}

// ─── Full Ranked Result ───────────────────────────────────────────────────────

export interface RankedExpertResult {
  expert: RankableExpert;
  scoreBreakdown: ScoreBreakdown;
  rawScore: number;                         // Sum of all scored dimensions
  industryDistanceAdjustment: number;       // 0 to -10
  industryDistanceReason: string;
  finalScore: number;                       // rawScore + adjustment, clamped 0–100
  confidence: 'High' | 'Medium' | 'Low';
  rationale: string;                        // 2–4 sentence narrative
  perspectiveNote: PerspectiveNote;
  strengths: string[];
  gaps: string[];
  missingData: string[];
  vettingQuestions: string[];
}

// ─── API payload types ────────────────────────────────────────────────────────

export interface RankExpertsRequest {
  brief: ProjectBrief;
  experts: RankableExpert[];
  weights: ScoringWeights;
}

export interface RankExpertsResponse {
  results: RankedExpertResult[];
}
