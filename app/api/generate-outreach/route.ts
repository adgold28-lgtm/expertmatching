import { generateText } from 'ai';
import { NextRequest } from 'next/server';
import { routeAuthGuard } from '../../../lib/auth';

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
    let prompt: string;

    if (contactType === 'general_company_contact') {
      // Outreach via a shared/role inbox (info@, contact@, etc.) — the expert
      // may not read this directly. Ask to be forwarded rather than addressing
      // the expert as if this is a personal email.
      prompt = `Write a brief, professional inquiry to be sent to a general company contact inbox (such as info@ or contact@) on behalf of a researcher trying to reach ${name}, ${title} at ${company}.

Context:
- The researcher's question: "${query}"
- Why ${name} is relevant: "${justification}"

Requirements:
- 2-3 short paragraphs
- Address the recipient generically (e.g. "Hello" or "Hi there,") — NOT by the expert's first name
- Explain briefly who you are looking to reach and why
- Ask to be forwarded to ${name} or the most relevant person
- Be concise, polite, and professional — not salesy
- Subject line on first line formatted as: Subject: [subject here]
- Then a blank line, then the message starting with "Hello," or "Hi there,"

Return only the message text with subject line. No extra commentary.`;
    } else {
      // Default: personal outreach to the expert directly
      prompt = `Write a cold outreach message to ${name}, ${title} at ${company}.

Context:
- The researcher's question: "${query}"
- Why this expert is relevant: "${justification}"

Requirements:
- 3-4 short paragraphs max
- Mention their specific role and company naturally
- Ask for a 20-30 minute introductory call
- Be warm, respectful, and direct — not salesy
- Reference the specific topic/question naturally
- Sound human, not like a template
- Subject line on first line formatted as: Subject: [subject here]
- Then a blank line, then the message body starting with "Hi [First Name],"

Return only the message text with subject line. No extra commentary.`;
    }

    const { text } = await generateText({
      model: 'anthropic/claude-opus-4.6',
      prompt,
      maxOutputTokens: 600,
    });

    return Response.json({ message: text.trim() });
  } catch (err) {
    console.error('generate-outreach error:', err instanceof Error ? err.message : String(err));
    return Response.json({ error: 'generation_failed' }, { status: 500 });
  }
}
