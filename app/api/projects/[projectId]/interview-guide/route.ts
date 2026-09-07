// POST — protected by routeAuthGuard()
// Generates the interview guide a client takes into an expert call.
//
// ANONYMIZATION IS THE PRODUCT. Everywhere else, a client sees "Scott S." and a
// descriptor until the call is booked (lib/redactExpert.ts). This route used to
// be the hole in that: it put the expert's real name, title, company and the
// full sourcing justification straight into a prompt and returned the model's
// answer — which routinely quoted them back — to whoever asked.
//
// So the guide is built from what the viewer is already entitled to see:
//
//   admin, or an expert whose identity is revealed ('scheduled' or later)
//       → the full prompt, name and company included. Staff run escalations;
//         a client with a booked call already has the identity.
//
//   everyone else
//       → the anonymized descriptor (lib/anonymizeExpert.ts writes it and
//         never names a person or an employer), falling back to the bare title
//         with any employer clause cut off, plus the brief. No name, no
//         company, no justification, no source links.
//         The model's answer then goes through redactGuideText on the way out,
//         because a prompt that omits a name is not a guarantee that the answer
//         does — the model can guess, and the brief can mention a company.
//
// NEVER log: research questions, expert names, companies, or guide content.

import { NextRequest } from 'next/server';
import { routeAuthGuard, getSessionUser } from '../../../../../lib/auth';
import { getProjectForUser } from '../../../../../lib/projectStore';
import { isIdentityRevealed } from '../../../../../lib/redactExpert';
import { maskContactDetails, MASK_TOKEN } from '../../../../../lib/matchyScreen';
import { fallbackDescriptor } from '../../../../../lib/anonymizeExpert';
import { openai } from '../../../../../lib/openai';
import type { Expert } from '../../../../../types';

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

    // Ownership / collaborator / admin scoped — 404 on inaccessible/nonexistent.
    const { email, role } = await getSessionUser(request);
    const project = await getProjectForUser(params.projectId, email, role);
    if (!project) return Response.json({ error: 'not_found' }, { status: 404 });

    const pe = project.experts.find(e => e.expert.id === expertId);
    if (!pe) return Response.json({ error: 'expert_not_found' }, { status: 404 });

    const { expert } = pe;
    const identified = role === 'admin' || isIdentityRevealed(pe.status);

    const systemPrompt = `You generate structured interview guides for expert calls at a primary research firm. The client will use this guide on a 45-60 minute call with an industry expert. Questions must be sharp, specific, and non-generic. No em dashes. No filler. Return only valid JSON, no markdown, no code fences.`;

    // The one place the two prompts differ: who the expert is said to be.
    const whoBlock = identified
      ? `Expert: ${expert.name}, ${expert.title} at ${expert.company}
Background: ${expert.justification}`
      : `Expert: an anonymous industry expert described only as "${anonymousDescriptorOf(expert)}".
You do not know their name or employer. Never invent, guess or refer to either.`;

    const userPrompt = `Research question: "${project.researchQuestion}"

${whoBlock}

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

    const parsed = JSON.parse(text) as {
      opening_script: string;
      must_ask: string[];
      questions: string[];
      diligence_risks: string[];
    };

    // Belt and braces: the model was not told the identity, but it may still
    // have reached for a name from the brief or from its own guess.
    const guide = identified ? parsed : {
      opening_script:  redactGuideText(parsed.opening_script ?? '', expert),
      must_ask:        (parsed.must_ask ?? []).map(q => redactGuideText(q, expert)),
      questions:       (parsed.questions ?? []).map(q => redactGuideText(q, expert)),
      diligence_risks: (parsed.diligence_risks ?? []).map(r => redactGuideText(r, expert)),
    };

    return Response.json({ guide });
  } catch (err) {
    console.error('[api/projects/[id]/interview-guide] error:', err instanceof Error ? err.message : String(err));
    return Response.json({ error: 'failed_to_generate_guide' }, { status: 500 });
  }
}

// ─── Anonymized inputs and outputs ────────────────────────────────────────────

/** Employer clauses a title carries: "COO at Acme", "COO, Acme", "COO @ Acme". */
const EMPLOYER_CLAUSE = /\s*(?:\bat\b|@|,|\||·|-{1,2})\s.*$/i;

/**
 * What a non-revealed viewer's prompt is allowed to say about the person: the
 * anonymized descriptor when there is one, otherwise the bare title with the
 * employer clause cut off. Never empty, never a name, never a company.
 */
function anonymousDescriptorOf(expert: Expert): string {
  const descriptor = expert.anonymizedDescriptor?.trim();
  if (descriptor) return descriptor;

  const title = (expert.title ?? '').replace(EMPLOYER_CLAUSE, '').trim();
  if (title) return title;

  return fallbackDescriptor(expert);
}

/**
 * Takes the identity back out of a generated string: every link, address and
 * phone number (lib/matchyScreen.maskContactDetails), then the expert's name
 * and their employer wherever either appears. The surname alone counts — the
 * client is shown "Scott S.", so it is the family name that gives the person
 * away.
 */
function redactGuideText(text: string, expert: Expert): string {
  if (!text) return text;
  let out = maskContactDetails(text);

  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const terms: string[] = [];

  const nameParts = (expert.name ?? '').trim().split(/\s+/).filter(Boolean);
  if (nameParts.length >= 2) terms.push(nameParts.join(' '));
  const surname = nameParts[nameParts.length - 1] ?? '';
  if (surname.length >= 3) terms.push(surname);

  const company = (expert.company ?? '').trim();
  if (company.length >= 3) terms.push(company);

  // Longest first, so masking "Example Coatings Inc" does not leave "Inc"
  // behind after a shorter term was replaced.
  for (const term of terms.sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(`\\b${escape(term)}\\b`, 'gi'), MASK_TOKEN);
  }
  return out;
}
