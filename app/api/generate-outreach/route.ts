import { NextRequest } from 'next/server';
import { routeAuthGuard } from '../../../lib/auth';
import { openai } from '../../../lib/openai';

const MAX_BODY = 8192; // bytes

// Strip control characters and cap length to prevent prompt injection.
function sanitizeForPrompt(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, max).trim();
}

export async function POST(request: NextRequest) {
  // Route-level auth guard (defense in depth — supplements middleware).
  const authErr = await routeAuthGuard(request);
  if (authErr) return authErr;

  // Content-Type guard
  if (!request.headers.get('content-type')?.includes('application/json')) {
    return Response.json({ error: 'content_type_required' }, { status: 415 });
  }

  // Body size guard (header check, then actual read)
  const cl = request.headers.get('content-length');
  if (cl && parseInt(cl, 10) > MAX_BODY) {
    return Response.json({ error: 'request_too_large' }, { status: 413 });
  }

  let raw: string;
  try { raw = await request.text(); } catch {
    return Response.json({ error: 'invalid_request' }, { status: 400 });
  }
  if (raw.length > MAX_BODY) {
    return Response.json({ error: 'request_too_large' }, { status: 413 });
  }

  let body: Record<string, unknown>;
  try { body = JSON.parse(raw) as Record<string, unknown>; } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const expertRaw    = body.expert && typeof body.expert === 'object' ? body.expert as Record<string, unknown> : {};
  const contactType  = typeof body.contactType === 'string' ? body.contactType : '';

  // Sanitize all fields interpolated into LLM prompts (prevents prompt injection).
  const name          = sanitizeForPrompt(expertRaw.name,          150);
  const title         = sanitizeForPrompt(expertRaw.title,         200);
  const company       = sanitizeForPrompt(expertRaw.company,       200);
  const justification = sanitizeForPrompt(expertRaw.justification, 500);
  const query         = sanitizeForPrompt(body.query,              500);

  if (!name || !company) {
    return Response.json({ error: 'expert name and company are required' }, { status: 400 });
  }

  try {
    let systemPrompt: string;
    let userPrompt: string;

    if (contactType === 'general_company_contact') {
      systemPrompt = `You write brief, professional forwarding requests to company contact inboxes. The goal is to be forwarded to a specific person. Be direct and human. No em dashes. No corporate filler. No exclamation marks. Under 100 words.`;

      userPrompt = `Write a short email to a general company inbox (like info@ or contact@) asking to be connected with ${name}, ${title} at ${company}.

Reason for reaching out: "${query}"
Why ${name} specifically: "${justification}"

Format:
Subject: [subject]

Hello,

[2 short paragraphs]

[Sign-off]`;
    } else {
      systemPrompt = `You write cold outreach emails for an expert network platform. Your emails get responses because they feel like they were written by a sharp analyst who did their homework, not by a sales tool.

STYLE RULES — non-negotiable:
- No em dashes anywhere. Use periods or commas instead.
- No "I wanted to reach out", "I hope this finds you well", "touch base", "pick your brain", "synergy", "leverage", "circle back"
- No exclamation marks
- No "I came across your profile"
- Never say "expert network" or "AlphaSights" or "expert call"
- Short sentences. No padding.
- Sound like a smart 28-year-old analyst, not a recruiter
- The ask is always a 20-30 minute call, framed as a conversation not an interview
- One specific detail about the person that shows you actually know who they are
- End with a soft, confident ask. Not "would you be open to..." — just "Happy to work around your schedule if you have 20 minutes."

FORMAT:
Subject: [subject line]

Hi [First Name],

[3-4 short paragraphs]

[Sign-off]`;

      userPrompt = `Write a cold outreach email to ${name}, ${title} at ${company}.

Research question the analyst is working on: "${query}"

Why this specific person: "${justification}"

The email should reference something specific about their background that connects directly to the research question. Do not make up details not provided above. Keep it under 150 words in the body.`;
    }

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 600,
      temperature: 0.7,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    });
    const text = response.choices[0].message.content ?? '';

    return Response.json({ message: text.trim() });
  } catch (err) {
    console.error('generate-outreach error:', err instanceof Error ? err.message : String(err));
    return Response.json({ error: 'generation_failed' }, { status: 500 });
  }
}
