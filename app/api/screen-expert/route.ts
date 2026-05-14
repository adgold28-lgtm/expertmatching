import Anthropic from '@anthropic-ai/sdk';
import { NextRequest, NextResponse } from 'next/server';
import { routeAuthGuard } from '../../../lib/auth';

const client = new Anthropic({ apiKey: process.env.ANTRHOPICKEYREAL });

// Repair literal newlines/tabs inside JSON string values before parsing
function repairJsonStrings(str: string): string {
  let result = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    if (escaped) { result += char; escaped = false; continue; }
    if (char === '\\') { escaped = true; result += char; continue; }
    if (char === '"') { inString = !inString; result += char; continue; }
    if (inString && char === '\n') { result += '\\n'; continue; }
    if (inString && char === '\r') { result += '\\r'; continue; }
    if (inString && char === '\t') { result += '\\t'; continue; }
    result += char;
  }
  return result;
}

export async function POST(req: NextRequest) {
  // Route-level auth guard (defense in depth — supplements middleware).
  const authErr = await routeAuthGuard(req);
  if (authErr) return authErr;

  try {
    const body = await req.json();
    const {
      project_brief,
      industry,
      target_expert_types,
      key_topics,
      candidate_profile,
      candidate_name,
      candidate_role,
      candidate_company,
      geography,
      seniority,
      known_conflicts,
      team_coverage,
    } = body;

    if (!project_brief?.trim() || !candidate_profile?.trim() || !candidate_name?.trim()) {
      return NextResponse.json(
        { error: 'project_brief, candidate_profile, and candidate_name are required.' },
        { status: 400 }
      );
    }

    const optionalFields = [
      geography ? `Geography preference: ${geography}` : '',
      seniority ? `Seniority preference: ${seniority}` : '',
      known_conflicts ? `Known conflicts: ${known_conflicts}` : '',
      team_coverage ? `Experts already selected (coverage context): ${team_coverage}` : '',
    ].filter(Boolean).join('\n');

    const prompt = `You are an expert viability screener for a primary research firm. Your job is to evaluate whether a specific candidate expert is a strong fit for a client's project brief. You are commercially minded and skeptical. You reward practical usefulness, not prestige.

## CLIENT BRIEF

Project brief: ${project_brief}
Industry: ${industry || 'Not specified'}
Target expert types: ${target_expert_types || 'Not specified'}
Key topics: ${Array.isArray(key_topics) ? key_topics.join(', ') : (key_topics || 'Not specified')}
${optionalFields}

## CANDIDATE PROFILE

Name: ${candidate_name}
Role: ${candidate_role || 'Not specified'}
Company: ${candidate_company || 'Not specified'}

Profile / background:
${candidate_profile}

## YOUR TASK

Evaluate this candidate against the brief. Be skeptical. Penalize candidates who sound impressive but cannot answer a specific project question. Prefer people who can answer the client's questions in a real call tomorrow.

Score using this weighting:
- 30%: Direct relevance to project brief
- 20%: Clarity of value chain fit
- 20%: Practical usefulness on an expert call
- 10%: Recency of relevant experience
- 10%: Distinctiveness / non-generic perspective
- 10%: Compliance / conflict cleanliness

Value chain positions to choose from: Raw materials / sourcing, Manufacturing / processing, Co-manufacturing, Packaging, Distribution / logistics, Retail / category management, Consumer insights / demand, Pricing / risk / policy, Cross-functional operator, Other

Archetypes: operator, advisor, outsider, hybrid

Recommendations: Strong yes, Yes, Backup only, No

## OUTPUT FORMAT

Respond with ONLY a valid JSON object matching this exact schema. All string values must be on a single line — no literal newlines or tabs inside string values.

{
  "primaryFit": {
    "valueChainPosition": "string — the most specific value chain position",
    "archetype": "operator | advisor | outsider | hybrid",
    "scope": "broad | surgical",
    "scopeExplanation": "string — one sentence on why broad or surgical"
  },
  "viabilityScore": {
    "score": number between 1 and 100,
    "recommendation": "Strong yes | Yes | Backup only | No",
    "scoreBreakdown": {
      "directRelevance": number out of 30,
      "valueChainClarity": number out of 20,
      "callUsefulness": number out of 20,
      "recency": number out of 10,
      "distinctiveness": number out of 10,
      "complianceClean": number out of 10
    }
  },
  "whyFits": ["string", "string", "string"],
  "questionsCanAnswer": ["string", "string", "string"],
  "risksLimitations": ["string", "string"],
  "bottomLine": "string — 2 to 4 sentences on whether this person is truly viable for the brief"
}`;

    const response = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';

    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1) {
      throw new Error('No JSON found in Claude response.');
    }

    const evaluation = JSON.parse(repairJsonStrings(text.slice(start, end + 1)));

    return NextResponse.json({
      evaluation,
      candidate: { name: candidate_name, role: candidate_role, company: candidate_company },
    });
  } catch (err) {
    console.error('[screen-expert]', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Screening failed. Please try again.' },
      { status: 500 }
    );
  }
}
