import Anthropic from '@anthropic-ai/sdk';
import { NextRequest } from 'next/server';
import { getProject } from '../../../../../lib/projectStore';
import type { ValueChainPosition } from '../../../../../types';

const client = new Anthropic({ apiKey: process.env.ANTRHOPICKEYREAL });
const ID_RE  = /^[a-f0-9]{24}$/;

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

  const prompt = `You are preparing vetting questions for an expert screening call.

Research Question: "${project.researchQuestion}"
Expert: ${expert.title} at ${expert.company}${vcLabel}
Background: ${expert.justification}
${sources ? `Evidence sources:\n${sources}` : ''}

Generate exactly 3 targeted vetting questions to assess:
1. Depth of specific knowledge on the research question
2. Directness of hands-on experience relative to their background and value chain position
3. Any conflict of interest, confidentiality restrictions, or recency of their knowledge

Return ONLY a JSON array of 3 strings — no markdown, no code fences, no wrapper object:
["Question 1", "Question 2", "Question 3"]`;

  try {
    const response = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages:   [{ role: 'user', content: prompt }],
    });

    const block = response.content.find(b => b.type === 'text');
    if (!block || block.type !== 'text') throw new Error('no text block');

    let text = block.text.trim();
    if (text.startsWith('```')) {
      text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }
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
