import { NextRequest } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { getProject } from '../../../../../lib/projectStore';

const client = new Anthropic({ apiKey: process.env.ANTRHOPICKEYREAL });
const ID_RE  = /^[a-f0-9]{24}$/;

export async function POST(
  request: NextRequest,
  { params }: { params: { projectId: string } },
) {
  if (!ID_RE.test(params.projectId)) {
    return Response.json({ error: 'invalid_project_id' }, { status: 400 });
  }

  try {
    const body     = await request.json() as Record<string, unknown>;
    const expertId = typeof body.expertId === 'string' ? body.expertId : null;
    if (!expertId) return Response.json({ error: 'expertId is required' }, { status: 400 });

    const project = await getProject(params.projectId);
    if (!project) return Response.json({ error: 'not_found' }, { status: 404 });

    const pe = project.experts.find(e => e.expert.id === expertId);
    if (!pe) return Response.json({ error: 'expert_not_found' }, { status: 404 });

    const { expert } = pe;

    const prompt = `You are preparing for an expert call as part of a due diligence or research project.

Research Question: "${project.researchQuestion}"

Expert: ${expert.name}
Title: ${expert.title}
Company: ${expert.company}
Background: ${expert.justification}

Generate a structured interview guide. Return ONLY valid JSON (no markdown, no code fences):
{
  "opening_script": "2-3 sentences to open the call, establish context, and frame the conversation",
  "must_ask": [
    "Question 1 — non-negotiable, gets at the core research question",
    "Question 2 — non-negotiable, probes unique insight only this expert can provide",
    "Question 3 — non-negotiable, challenges conventional wisdom"
  ],
  "questions": [
    "Question 1",
    "Question 2",
    "Question 3",
    "Question 4",
    "Question 5",
    "Question 6",
    "Question 7",
    "Question 8",
    "Question 9",
    "Question 10"
  ],
  "diligence_risks": [
    "Risk 1 this expert can help assess",
    "Risk 2 this expert can help assess",
    "Risk 3 this expert can help assess"
  ]
}

Make all questions specific to this expert's background and the research question. Avoid generic questions.`;

    const response = await client.messages.create({
      model:      'claude-opus-4-6',
      max_tokens: 2000,
      messages:   [{ role: 'user', content: prompt }],
    });

    const block = response.content.find(b => b.type === 'text');
    if (!block || block.type !== 'text') throw new Error('No text in response');

    let text = block.text.trim();
    if (text.startsWith('```')) {
      text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    const guide = JSON.parse(text) as {
      opening_script: string;
      must_ask: string[];
      questions: string[];
      diligence_risks: string[];
    };

    return Response.json({ guide });
  } catch (err) {
    console.error('[api/projects/[id]/interview-guide] error:', err instanceof Error ? err.message : String(err));
    return Response.json({ error: 'failed_to_generate_guide' }, { status: 500 });
  }
}
