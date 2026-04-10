import Anthropic from '@anthropic-ai/sdk';
import { NextRequest } from 'next/server';

const client = new Anthropic();

const SYSTEM_PROMPT = `You are an expert sourcing analyst at a top research firm like AlphaSights or GLG. Your job is to identify the most strategically valuable experts for any business question.

Generate realistic, specific experts — people who would genuinely exist in this space. Make names sound real and diverse. Companies should be real or plausible.

Categories:
- Operators: People actively working in the field at companies in the space (directors, VPs, managers, founders)
- Advisors: People who advise or evaluate the industry (management consultants, PE/VC investors, sell-side analysts, ex-executives turned advisors)
- Outsiders: MUST include a balanced mix of:
  * Government/Regulatory (policy makers, regulators, agency staff, lobbyists)
  * Large Enterprise (procurement, strategy, or operations roles at Fortune 500 companies)
  * Small Business/Independent (owner-operators, independents, freelancers, solopreneurs)

Scoring (0-100):
- Keyword match with the query: 0–40 pts
- Seniority relevance: 0–30 pts
- Specificity to the exact question: 0–30 pts

Return ONLY valid JSON. No markdown, no code fences, no extra text.`;

export async function POST(request: NextRequest) {
  try {
    const { query, geography, seniority } = await request.json();

    if (!query?.trim()) {
      return Response.json({ error: 'Query is required' }, { status: 400 });
    }

    const filters = [
      geography && geography !== 'any' ? `Geography: ${geography}` : null,
      seniority && seniority !== 'any' ? `Seniority: ${seniority}` : null,
    ]
      .filter(Boolean)
      .join('\n');

    const prompt = `Business Question: "${query.trim()}"
${filters ? `\nFilters:\n${filters}` : ''}

Generate a structured expert list. Return exactly this JSON structure:
{
  "query_analysis": {
    "industry": "the primary industry sector",
    "function": "the primary business function (e.g. Operations, Finance, Regulatory)",
    "key_topics": ["topic1", "topic2", "topic3"],
    "keywords": ["keyword1", "keyword2", "keyword3", "keyword4"],
    "confidence": "High or Medium or Low",
    "confidence_reason": "one sentence explaining why this confidence level"
  },
  "experts": [
    {
      "id": "exp-1",
      "name": "Full Name",
      "title": "Specific Job Title",
      "company": "Company Name",
      "location": "City, State or Country",
      "category": "Operator",
      "outsider_subcategory": null,
      "justification": "1-2 sentences on exactly why this person is highly relevant to the specific question asked.",
      "relevance_score": 87
    }
  ]
}

Rules:
- Generate exactly 2-3 Operators, 2-3 Advisors, and 2-3 Outsiders (total 6-9 experts)
- For Outsiders, outsider_subcategory must be one of: "Government", "Large Enterprise", or "Small Business"
- For Operators and Advisors, outsider_subcategory must be null
- Outsiders MUST include at least one Government/Regulatory perspective
- Sort experts within each category by relevance_score descending
- Make names realistic and diverse
- Justifications must directly reference the specific question, not be generic`;

    const stream = await client.messages.stream({
      model: 'claude-opus-4-6',
      max_tokens: 4000,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      thinking: { type: 'adaptive' } as any,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    });

    const response = await stream.finalMessage();

    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      throw new Error('No text in response');
    }

    let text = textBlock.text.trim();

    // Strip any accidental markdown code fences
    if (text.startsWith('```')) {
      text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    const data = JSON.parse(text);

    return Response.json(data);
  } catch (err) {
    console.error('generate-experts error:', err);
    const message = err instanceof Error ? err.message : 'Unknown error';
    return Response.json({ error: message }, { status: 500 });
  }
}
