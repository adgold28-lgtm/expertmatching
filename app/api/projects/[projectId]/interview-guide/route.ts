// POST — protected by routeAuthGuard() + guardMutatingRequest()
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
import { guardMutatingRequest } from '../../../../../lib/projectsGuard';
import { getProjectForUser } from '../../../../../lib/projectStore';
import { isIdentityRevealed } from '../../../../../lib/redactExpert';
import { maskContactDetails, MASK_TOKEN } from '../../../../../lib/matchyScreen';
import { fallbackDescriptor } from '../../../../../lib/anonymizeExpert';
import { createRateLimiterStore } from '../../../../../lib/rateLimiter';
import { pseudonymize } from '../../../../../lib/contactCache';
import { openai } from '../../../../../lib/openai';
import type { Expert } from '../../../../../types';

const ID_RE = /^[a-f0-9]{24}$/;

// ─── Per-user throttle ────────────────────────────────────────────────────────
//
// Every POST here spends an OpenAI call, and nothing else on this route costs
// the caller anything, so one authenticated account could run up an unbounded
// model bill (audit M-14). Ten guides an hour is far above real use — a client
// generates one per expert before a call — and well below a bill worth having.
//
// FAIL OPEN, like every other in-app limiter (lib/rateLimiter's callers): the
// project workspace stays usable when Redis is down, and the money at risk here
// is ours, not a credential. The key is an HMAC of the email, never the address
// itself.
const GUIDES_PER_HOUR = 10;
const ONE_HOUR_MS     = 60 * 60 * 1000;

const _rlStore = (() => { try { return createRateLimiterStore(); } catch { return null; } })();

async function withinRateLimit(email: string): Promise<boolean> {
  if (!_rlStore || !email) return true;
  try {
    const { count } = await _rlStore.increment(
      `rl:interview-guide:${pseudonymize(email)}:1h`, ONE_HOUR_MS,
    );
    return count <= GUIDES_PER_HOUR;
  } catch {
    return true;
  }
}

// THE GUARD. guardMutatingRequest, like every other project route: the
// PROJECTS_ENABLED kill switch, the content-type CSRF surrogate and the 250 KB
// body cap all apply here too (audit M-14 — this used to be the one project
// route without them). Access to the project is enforced below
// (getProjectForUser, 404 on inaccessible), and any project MEMBER may generate
// a guide — this is a read of material the viewer already has, not an action on
// the expert, so no owner check.
export async function POST(
  request: NextRequest,
  { params }: { params: { projectId: string } },
) {
  // Auth (defence in depth on top of middleware, so a disabled or pending
  // session is refused here too), then the shared mutating guard — the same
  // pairing propose-times and rate-decision use.
  const authErr = await routeAuthGuard(request);
  if (authErr) return authErr;

  const guard = await guardMutatingRequest(request);
  if ('error' in guard) return guard.error;
  const { body } = guard;

  if (!ID_RE.test(params.projectId)) {
    return Response.json({ error: 'invalid_project_id' }, { status: 400 });
  }

  try {
    const expertId = typeof body.expertId === 'string' ? body.expertId : null;
    if (!expertId) return Response.json({ error: 'expertId is required' }, { status: 400 });

    const { email, role } = await getSessionUser(request);
    if (!await withinRateLimit(email)) {
      return Response.json(
        { error: 'rate_limited', message: 'You have generated a lot of guides. Try again in an hour.' },
        { status: 429 },
      );
    }

    // Ownership / collaborator / admin scoped — 404 on inaccessible/nonexistent.
    const project = await getProjectForUser(params.projectId, email, role);
    if (!project) return Response.json({ error: 'not_found' }, { status: 404 });

    const pe = project.experts.find(e => e.expert.id === expertId);
    if (!pe) return Response.json({ error: 'expert_not_found' }, { status: 404 });

    const { expert } = pe;
    const identified = role === 'admin' || isIdentityRevealed(pe);

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

    // SHAPE-CHECK THE MODEL, DO NOT CAST IT (audit M-15). A model that returns
    // "must_ask" as a string rather than an array used to make .map throw and
    // turn into an unexplained 500; anything that is not a string in a string
    // list is dropped here instead, the same Array.isArray + typeof filter
    // lib/projectValidation.ts uses on client input.
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const validated = {
      opening_script:  typeof parsed.opening_script === 'string' ? parsed.opening_script : '',
      must_ask:        stringList(parsed.must_ask),
      questions:       stringList(parsed.questions),
      diligence_risks: stringList(parsed.diligence_risks),
    };

    // Belt and braces: the model was not told the identity, but it may still
    // have reached for a name from the brief or from its own guess.
    const guide = identified ? validated : {
      opening_script:  redactGuideText(validated.opening_script, expert),
      must_ask:        validated.must_ask.map(q => redactGuideText(q, expert)),
      questions:       validated.questions.map(q => redactGuideText(q, expert)),
      diligence_risks: validated.diligence_risks.map(r => redactGuideText(r, expert)),
    };

    return Response.json({ guide });
  } catch (err) {
    console.error('[api/projects/[id]/interview-guide] error:', err instanceof Error ? err.message : String(err));
    return Response.json({ error: 'failed_to_generate_guide' }, { status: 500 });
  }
}

// ─── Model output validation ──────────────────────────────────────────────────

/** How many entries of one list are kept — the prompt asks for at most ten. */
const MAX_LIST_ITEMS = 20;

/**
 * The string entries of what the model claims is a list of questions. A
 * non-array, and every non-string or blank entry inside one, is dropped rather
 * than rendered or thrown over.
 */
function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .slice(0, MAX_LIST_ITEMS);
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
