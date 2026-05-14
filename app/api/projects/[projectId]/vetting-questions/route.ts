import { NextRequest } from 'next/server';
import { routeAuthGuard } from '../../../../../lib/auth';
import { getProject } from '../../../../../lib/projectStore';
import { openai } from '../../../../../lib/openai';
import type { ValueChainPosition } from '../../../../../types';

const ID_RE = /^[a-f0-9]{24}$/;

const VALUE_CHAIN_LABEL: Record<ValueChainPosition, string> = {
  supplier:               'Supplier / Input Provider',
  equipment_vendor:       'Equipment Vendor',
  producer_operator:      'Producer / Operator',
  processor_manufacturer: 'Processor / Manufacturer',
  distributor:            'Distributor / Logistics',
  retail_customer:        'Retail / End Customer',
  regulator_academic:     'Regulator / Academic',
  investor_advisor:       'Investor / Advisor',
  other:                  'Other',
};

function fallbackQuestions(researchQuestion: string): string[] {
  const topic = researchQuestion.length > 70
    ? researchQuestion.slice(0, 67) + '…'
    : researchQuestion;
  return [
    `Can you describe your direct experience with: ${topic}?`,
    'Which part of the value chain did your work primarily touch, and for how long?',
    'Are there any confidentiality or conflict restrictions that would limit what you can discuss on this topic?',
  ];
}

export async function POST(
  request: NextRequest,
  { params }: { params: { projectId: string } },
) {
  const authErr = await routeAuthGuard(request);
  if (authErr) return authErr;

  if (!ID_RE.test(params.projectId)) {
    return Response.json({ error: 'invalid_project_id' }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const expertId = typeof body.expertId === 'string' ? body.expertId.trim() : null;
  if (!expertId) return Response.json({ error: 'expertId required' }, { status: 400 });

  const project = await getProject(params.projectId);
  if (!project) return Response.json({ error: 'not_found' }, { status: 404 });

  const pe = project.experts.find(e => e.expert.id === expertId);
  if (!pe) return Response.json({ error: 'expert_not_found' }, { status: 404 });

  const vcPos: ValueChainPosition | undefined =
    typeof body.valueChainPosition === 'string' && body.valueChainPosition in VALUE_CHAIN_LABEL
      ? (body.valueChainPosition as ValueChainPosition)
      : pe.valueChainPosition;

  const vcLabel = vcPos ? ` — value chain position: ${VALUE_CHAIN_LABEL[vcPos]}` : '';
  const { expert } = pe;

  // Only non-confidential, non-PII data sent to LLM: title, company, justification, source labels
  const sources = expert.source_links
    .map(l => `- ${l.label}`)
    .join('\n');

  const userPrompt = `Research question: "${project.researchQuestion}"
Expert: ${expert.title} at ${expert.company}${vcLabel}
Background: ${expert.justification}
${sources ? `Evidence:\n${sources}` : ''}

Write 3 vetting questions for a screening call with this expert. Each question must:
- Be specific to this person's background and the research question
- Not be answerable with a yes/no
- Take under 30 seconds to ask out loud

Question 1: Probe depth of direct experience on the research question
Question 2: Probe which part of the value chain they actually touched and for how long
Question 3: Surface any conflicts, NDAs, or recency issues

Return ONLY: ["Question 1", "Question 2", "Question 3"]`;

  try {
    const response = await openai.chat.completions.create({
      model:      'gpt-4o-mini',
      max_tokens: 400,
      temperature: 0.4,
      messages: [
        { role: 'system', content: 'You generate sharp, specific vetting questions for expert screening calls. Return only a JSON array of 3 strings. No markdown. No code fences. No explanation.' },
        { role: 'user', content: userPrompt },
      ],
    });

    const text = response.choices[0].message.content ?? '';
    // Extract array even if wrapped in extra text
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('no array in response');

    const questions = JSON.parse(match[0]) as unknown[];
    if (!Array.isArray(questions) || questions.length === 0 || !questions.every(q => typeof q === 'string')) {
      throw new Error('invalid question array');
    }

    return Response.json({ questions: questions as string[], source: 'llm' });
  } catch {
    return Response.json({
      questions: fallbackQuestions(project.researchQuestion),
      source: 'fallback',
    });
  }
}
