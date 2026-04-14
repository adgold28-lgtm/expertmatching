import Anthropic from '@anthropic-ai/sdk';
import { NextRequest, NextResponse } from 'next/server';
import {
  RankableExpert,
  RankedExpertResult,
  ScoreBreakdown,
  ScoringWeights,
  RankExpertsRequest,
} from '../../../rankExpertsTypes';
import {
  getDeterministicScores,
  calculateIndustryDistanceAdjustment,
  VALUE_CHAIN_PERSPECTIVE,
  SENIORITY_PERSPECTIVE,
} from '../../../lib/rankExperts';

const client = new Anthropic({ apiKey: process.env.ANTRHOPICKEYREAL });

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildExpertSummary(expert: RankableExpert): string {
  const lines = [
    `ID: ${expert.id}`,
    `Name: ${expert.fullName}`,
    `Current: ${expert.currentTitle} at ${expert.currentCompany}`,
    expert.previousTitle ? `Previous: ${expert.previousTitle} at ${expert.previousCompany}` : '',
    `Geography: ${expert.geography || 'Unknown'}`,
    `Value Chain Stage: ${expert.valueChainStage || 'Not specified'}`,
    `Seniority: ${expert.seniorityLevel || 'Not specified'}`,
    `Perspective Type: ${expert.perspectiveType || 'Not specified'}`,
    expert.yearsInIndustry !== null ? `Years in Industry: ${expert.yearsInIndustry}` : '',
    expert.yearsOutsideIndustry !== null ? `Years Outside Industry: ${expert.yearsOutsideIndustry}` : '',
    expert.lastDirectIndustryRoleYear !== null ? `Last Direct Industry Role Year: ${expert.lastDirectIndustryRoleYear}` : '',
    `Why Relevant: ${expert.whyRelevant || 'Not provided'}`,
    expert.conflictsOrConcerns ? `Conflicts/Concerns: ${expert.conflictsOrConcerns}` : '',
    expert.sourceNotes ? `Source Notes: ${expert.sourceNotes}` : '',
    expert.linkedinOrSourceUrl ? `Source URL: ${expert.linkedinOrSourceUrl}` : '',
  ].filter(Boolean);
  return lines.join('\n');
}

function computeRawScore(breakdown: ScoreBreakdown, weights: ScoringWeights): number {
  const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);
  if (totalWeight === 0) return 0;

  const b = breakdown;
  const raw =
    (b.topicRelevance.score / b.topicRelevance.max) * (weights.topicRelevance / totalWeight) * 100 +
    (b.operationalExposure.score / b.operationalExposure.max) * (weights.operationalExposure / totalWeight) * 100 +
    (b.valueChainFit.score / b.valueChainFit.max) * (weights.valueChainFit / totalWeight) * 100 +
    (b.seniorityFit.score / b.seniorityFit.max) * (weights.seniorityFit / totalWeight) * 100 +
    (b.recencyOfExperience.score / b.recencyOfExperience.max) * (weights.recencyOfExperience / totalWeight) * 100 +
    (b.geographyFit.score / b.geographyFit.max) * (weights.geographyFit / totalWeight) * 100 +
    (b.sourceVerifiability.score / b.sourceVerifiability.max) * (weights.sourceVerifiability / totalWeight) * 100 +
    (b.coverageOfKeyQuestions.score / b.coverageOfKeyQuestions.max) * (weights.coverageOfKeyQuestions / totalWeight) * 100;

  return Math.round(raw);
}

// ─── Route Handler ────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as RankExpertsRequest;
    const { brief, experts, weights } = body;

    if (!experts || experts.length === 0) {
      return NextResponse.json({ error: 'No experts provided.' }, { status: 400 });
    }
    if (!brief.researchQuestion.trim()) {
      return NextResponse.json({ error: 'Research question is required.' }, { status: 400 });
    }

    // Step 1: compute deterministic scores for every expert
    const deterministicByExpert = experts.map((e) => ({
      expert: e,
      deterministic: getDeterministicScores(e, brief),
      distanceInfo: calculateIndustryDistanceAdjustment(e),
    }));

    // Step 2: ask Claude for AI-scored dimensions + narratives
    const briefSummary = [
      `Research Question: ${brief.researchQuestion}`,
      brief.projectObjective ? `Objective: ${brief.projectObjective}` : '',
      brief.mustHaveKnowledge ? `Must-Have Knowledge: ${brief.mustHaveKnowledge}` : '',
      brief.preferredGeography ? `Preferred Geography: ${brief.preferredGeography}` : '',
      brief.preferredSeniority ? `Preferred Seniority: ${brief.preferredSeniority}` : '',
      brief.targetValueChainStages.length > 0
        ? `Target Value Chain Stages: ${brief.targetValueChainStages.join(', ')}`
        : '',
      brief.additionalNotes ? `Additional Notes: ${brief.additionalNotes}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const deterministicContext = deterministicByExpert
      .map(({ expert, deterministic, distanceInfo }) =>
        `Expert ID: ${expert.id}
Deterministic Scores (pre-computed — do NOT override these):
  Value Chain Fit: ${deterministic.valueChainFit.score}/15 — ${deterministic.valueChainFit.reason}
  Seniority Fit: ${deterministic.seniorityFit.score}/10 — ${deterministic.seniorityFit.reason}
  Recency: ${deterministic.recencyOfExperience.score}/10 — ${deterministic.recencyOfExperience.reason}
  Geography Fit: ${deterministic.geographyFit.score}/5 — ${deterministic.geographyFit.reason}
  Source Verifiability: ${deterministic.sourceVerifiability.score}/5 — ${deterministic.sourceVerifiability.reason}
  Industry Distance Adjustment: ${distanceInfo.adjustment}/−10 — ${distanceInfo.reason}

Expert Profile:
${buildExpertSummary(expert)}`
      )
      .join('\n\n---\n\n');

    const prompt = `You are an expert evaluation specialist. Your job is to score and analyze each expert against the project brief below.

IMPORTANT RULES:
- Do NOT invent facts not present in the expert's profile or source notes.
- If information is missing or ambiguous, note it as unknown and reduce confidence accordingly.
- Do NOT reward prestige, brand-name firms, or seniority alone. Reward actual topic fit.
- Clearly separate observed facts from inferred judgments in your rationale.
- Keep rationale to 2–4 sentences. Be specific, not generic.

PROJECT BRIEF:
${briefSummary}

SCORING RUBRIC — YOU MUST SCORE ONLY THESE THREE AI DIMENSIONS:

1. Topic Relevance (0–30): How directly does this expert's actual experience match the exact research question?
   26–30 = direct first-hand experience on the exact topic
   20–25 = strong adjacent experience, very likely useful
   12–19 = somewhat relevant but not exact match
   0–11  = broad industry relevance only

2. First-Hand Operational Exposure (0–20): Did this person actually operate in the relevant function, market, or process?
   17–20 = hands-on operator or direct owner of the function
   12–16 = meaningful operational oversight
   6–11  = second-hand or partial exposure
   0–5   = mostly advisory or general exposure

3. Coverage of Key Questions (0–5): Based on the brief, how likely is this expert to answer the questions that matter?

PRE-COMPUTED DETERMINISTIC SCORES (context for your rationale — do not change these values):
${deterministicContext}

EXPERTS TO EVALUATE:
${experts.map((e) => buildExpertSummary(e)).join('\n\n---\n\n')}

Respond with ONLY a valid JSON array — no markdown, no explanation, no code fences.
One object per expert, in the same order as listed. Use this exact schema:

[
  {
    "expertId": "<id>",
    "topicRelevance": { "score": <0-30>, "reason": "<one sentence>" },
    "operationalExposure": { "score": <0-20>, "reason": "<one sentence>" },
    "coverageOfKeyQuestions": { "score": <0-5>, "reason": "<one sentence>" },
    "rationale": "<2–4 sentence narrative explaining overall fit — specific, not generic>",
    "perspectiveNote": {
      "valueChainEffect": "<one sentence on how their value chain position shapes their view>",
      "seniorityEffect": "<one sentence on how their seniority shapes their view>",
      "timeOutsideEffect": "<one sentence on how time out of industry affects their perspective>"
    },
    "strengths": ["<specific strength>", "<specific strength>"],
    "gaps": ["<specific gap>", "<specific gap>"],
    "missingData": ["<what we don't know that would change the score>"],
    "vettingQuestions": ["<question 1>", "<question 2>", "<question 3>"],
    "confidence": "High" | "Medium" | "Low"
  }
]

Confidence criteria:
- High: most fields are specific and supported by source material
- Medium: some gaps or inferred information
- Low: important details missing, heavy inference required`;

    const response = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = response.content.find((b) => b.type === 'text')?.text ?? '';
    if (!raw) throw new Error('No response from Claude.');

    // Extract JSON — handle any stray markdown fences
    const jsonStr = raw.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
    let aiResults: Array<{
      expertId: string;
      topicRelevance: { score: number; reason: string };
      operationalExposure: { score: number; reason: string };
      coverageOfKeyQuestions: { score: number; reason: string };
      rationale: string;
      perspectiveNote: { valueChainEffect: string; seniorityEffect: string; timeOutsideEffect: string };
      strengths: string[];
      gaps: string[];
      missingData: string[];
      vettingQuestions: string[];
      confidence: 'High' | 'Medium' | 'Low';
    }>;

    try {
      aiResults = JSON.parse(jsonStr);
    } catch {
      throw new Error('Failed to parse Claude response as JSON.');
    }

    // Step 3: merge deterministic + AI scores into full results
    const results: RankedExpertResult[] = deterministicByExpert.map(({ expert, deterministic, distanceInfo }) => {
      const ai = aiResults.find((r) => r.expertId === expert.id);
      if (!ai) throw new Error(`Missing AI result for expert ${expert.id}`);

      const breakdown: ScoreBreakdown = {
        topicRelevance: { score: ai.topicRelevance.score, max: 30, reason: ai.topicRelevance.reason },
        operationalExposure: { score: ai.operationalExposure.score, max: 20, reason: ai.operationalExposure.reason },
        coverageOfKeyQuestions: { score: ai.coverageOfKeyQuestions.score, max: 5, reason: ai.coverageOfKeyQuestions.reason },
        ...deterministic,
      };

      const rawScore = computeRawScore(breakdown, weights);
      const finalScore = Math.max(0, Math.min(100, rawScore + distanceInfo.adjustment));

      // Enrich perspectiveNote with value chain and seniority context
      const vcContext = expert.valueChainStage
        ? VALUE_CHAIN_PERSPECTIVE[expert.valueChainStage as keyof typeof VALUE_CHAIN_PERSPECTIVE]
        : '';
      const senContext = expert.seniorityLevel
        ? SENIORITY_PERSPECTIVE[expert.seniorityLevel as keyof typeof SENIORITY_PERSPECTIVE]
        : '';

      return {
        expert,
        scoreBreakdown: breakdown,
        rawScore,
        industryDistanceAdjustment: distanceInfo.adjustment,
        industryDistanceReason: distanceInfo.reason,
        finalScore,
        confidence: ai.confidence,
        rationale: ai.rationale,
        perspectiveNote: {
          valueChainEffect: ai.perspectiveNote.valueChainEffect || vcContext,
          seniorityEffect: ai.perspectiveNote.seniorityEffect || senContext,
          timeOutsideEffect: ai.perspectiveNote.timeOutsideEffect,
        },
        strengths: ai.strengths,
        gaps: ai.gaps,
        missingData: ai.missingData,
        vettingQuestions: ai.vettingQuestions,
      };
    });

    // Sort by finalScore descending
    results.sort((a, b) => b.finalScore - a.finalScore);

    return NextResponse.json({ results });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[rank-experts]', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
