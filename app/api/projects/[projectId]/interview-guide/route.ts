import { NextRequest } from 'next/server';
import { routeAuthGuard } from '../../../../../lib/auth';
import { getProject } from '../../../../../lib/projectStore';
import { openai } from '../../../../../lib/openai';

const ID_RE = /^[a-f0-9]{24}$/;

export async function POST(
  request: NextRequest,
  { params }: { params: { projectId: string } },
) {
  const authErr = await routeAuthGuard(request);
  if (authErr) return authErr;

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

    const systemPrompt = `You generate structured interview guides for expert calls at a primary research firm. The client will use this guide on a 45-60 minute call with an industry expert. Questions must be sharp, specific, and non-generic. No em dashes. No filler. Return only valid JSON, no markdown, no code fences.`;

    const userPrompt = `Research question: "${project.researchQuestion}"

Expert: ${expert.name}, ${expert.title} at ${expert.company}
Background: ${expert.justification}

Generate a client interview guide. Every question must be specific to this expert's background and the research question. No generic questions like "what trends are you seeing."

Return ONLY this JSON structure:
{
  "opening_script": "2-3 sentences to open the call, establish context, frame the conversation. Warm but direct. No em dashes.",
  "must_ask": [
    "Non-negotiable question 1 — core research question",
    "Non-negotiable question 2 — unique insight only this expert has",
    "Non-negotiable question 3 — challenges conventional wisdom on this topic"
  ],
  "questions": [
    "Q1", "Q2", "Q3", "Q4", "Q5",
    "Q6", "Q7", "Q8", "Q9", "Q10"
  ],
  "diligence_risks": [
    "Risk 1 this expert can help assess",
    "Risk 2 this expert can help assess",
    "Risk 3 this expert can help assess"
  ]
}`;

    const response = await openai.chat.completions.create({
      model:      'gpt-4o-mini',
      max_tokens: 2000,
      temperature: 0.5,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    });

    let text = (response.choices[0].message.content ?? '').trim();
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
