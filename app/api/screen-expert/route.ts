import { NextRequest, NextResponse } from 'next/server';
import { routeAuthGuard } from '../../../lib/auth';
import { openai } from '../../../lib/openai';

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

    const prompt = `You are a skeptical expert screener for a primary research firm. Evaluate whether this candidate can answer a client's specific research question on a 30-minute call tomorrow. Reward practical usefulness. Penalize prestige without substance.

CLIENT BRIEF
Research question: "${project_brief}"
Industry: ${industry || 'not specified'}
Target expert types: ${target_expert_types || 'not specified'}
Key topics: ${Array.isArray(key_topics) ? key_topics.join(', ') : (key_topics || 'not specified')}
${optionalFields}

CANDIDATE
Name: ${candidate_name}
Role: ${candidate_role || 'not specified'}
Company: ${candidate_company || 'not specified'}
Background: ${candidate_profile}

SCORING WEIGHTS
- Direct relevance to research question: 30 points
- Value chain clarity: 20 points
- Practical call usefulness: 20 points
- Recency of experience: 10 points
- Distinctive perspective: 10 points
- No conflicts: 10 points

Value chain positions: Raw materials / sourcing, Manufacturing / processing, Co-manufacturing, Packaging, Distribution / logistics, Retail / category management, Consumer insights / demand, Pricing / risk / policy, Cross-functional operator, Other
Archetypes: operator, advisor, outsider, hybrid
Recommendations: Strong yes, Yes, Backup only, No

Return ONLY valid JSON. No markdown. No explanation. All string values on a single line.

{
  "primaryFit": {
    "valueChainPosition": "most specific position from the list above",
    "archetype": "operator | advisor | outsider | hybrid",
    "scope": "broad | surgical",
    "scopeExplanation": "one sentence"
  },
  "viabilityScore": {
    "score": 0-100,
    "recommendation": "Strong yes | Yes | Backup only | No",
    "scoreBreakdown": {
      "directRelevance": 0-30,
      "valueChainClarity": 0-20,
      "callUsefulness": 0-20,
      "recency": 0-10,
      "distinctiveness": 0-10,
      "complianceClean": 0-10
    }
  },
  "whyFits": ["string", "string", "string"],
  "questionsCanAnswer": ["string", "string", "string"],
  "risksLimitations": ["string", "string"],
  "bottomLine": "2-4 sentences on whether this person is truly viable"
}`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 1500,
      temperature: 0.3,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.choices[0].message.content ?? '';

    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1) {
      throw new Error('No JSON found in response.');
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
