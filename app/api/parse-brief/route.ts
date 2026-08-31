// POST /api/parse-brief
//
// Accepts an uploaded brief document (PDF, plain text, or markdown) and
// extracts structured project-brief fields with Claude. The client then
// applies the fields to the project via the existing PUT
// /api/projects/[projectId] route, so all authorization and sanitization
// stays in one place.
//
// Body: { filename: string, mediaType: string, data: string (base64) }
// PDF is read natively by the Anthropic API (document block) — no parsing
// dependencies. DOCX is not supported; the UI asks for a PDF export instead.
//
// NEVER log: document contents, extracted fields, or filenames.

import { NextRequest } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { routeAuthGuard } from '../../../lib/auth';

export const maxDuration = 60;

const MAX_BASE64_CHARS = 8_000_000; // ~6 MB decoded — plenty for a brief
const PDF_TYPE         = 'application/pdf';
const TEXT_TYPES       = new Set(['text/plain', 'text/markdown']);

interface ParsedBrief {
  researchQuestion?:   string;
  expertType?:         string;
  keyQuestions?:       string;
  mustHaveExpertise?:  string;
  niceToHaveExpertise?: string;
  targetCompanies?:    string;
  companiesToAvoid?:   string;
  timeline?:           string;
  additionalContext?:  string;
}

const EXTRACTION_PROMPT = `You are reading a client's project brief for an expert-network research project (the client wants to interview industry experts).

Extract the following fields from the document. Return ONLY valid JSON — no prose, no markdown fences. Omit any field the document does not address. Write every value as concise plain text in the client's own terms.

{
  "researchQuestion": "the core business problem or research question, 1-3 sentences",
  "expertType": "who they want to talk to — roles, seniority, example companies",
  "keyQuestions": "the specific questions they want answered, newline-separated",
  "mustHaveExpertise": "non-negotiable expertise requirements",
  "niceToHaveExpertise": "preferred but optional expertise",
  "targetCompanies": "companies whose current/former employees are of interest, comma-separated",
  "companiesToAvoid": "companies to exclude (conflicts, competitors), comma-separated",
  "timeline": "when they need the calls done",
  "additionalContext": "any other context that would help source better experts"
}`;

function fieldOrUndefined(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
}

export async function POST(request: NextRequest): Promise<Response> {
  const authErr = await routeAuthGuard(request);
  if (authErr) return authErr;

  const apiKey = process.env.ANTRHOPICKEYREAL;
  if (!apiKey) return Response.json({ error: 'service_unavailable' }, { status: 503 });

  let body: unknown;
  try { body = await request.json(); } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const b         = body as Record<string, unknown>;
  const mediaType = typeof b.mediaType === 'string' ? b.mediaType : '';
  const data      = typeof b.data      === 'string' ? b.data      : '';

  if (!data) {
    return Response.json({ error: 'file_required', message: 'No document was uploaded.' }, { status: 400 });
  }
  if (data.length > MAX_BASE64_CHARS) {
    return Response.json(
      { error: 'file_too_large', message: 'Document is too large — 5 MB max.' },
      { status: 413 },
    );
  }
  if (mediaType !== PDF_TYPE && !TEXT_TYPES.has(mediaType)) {
    return Response.json(
      { error: 'unsupported_type', message: 'Upload a PDF or plain-text file. For Word documents, export to PDF first.' },
      { status: 415 },
    );
  }

  const client = new Anthropic({ apiKey });

  try {
    const documentBlock = mediaType === PDF_TYPE
      ? { type: 'document' as const, source: { type: 'base64' as const, media_type: 'application/pdf' as const, data } }
      : { type: 'text' as const, text: Buffer.from(data, 'base64').toString('utf8').slice(0, 100_000) };

    const resp = await client.messages.create({
      model:      'claude-haiku-4-5',
      max_tokens: 2_000,
      messages:   [{
        role:    'user',
        content: [documentBlock, { type: 'text', text: EXTRACTION_PROMPT }],
      }],
    });

    const block = resp.content.find(c => c.type === 'text');
    if (!block || block.type !== 'text') {
      return Response.json({ error: 'parse_failed', message: 'Could not read the document. Try again.' }, { status: 502 });
    }

    let text = block.text.trim();
    if (text.startsWith('```')) {
      text = text.replace(/^```(?:json)?\r?\n?/, '').replace(/\r?\n?```$/, '').trim();
    }

    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return Response.json(
        { error: 'parse_failed', message: 'Could not extract brief fields from this document.' },
        { status: 422 },
      );
    }

    // Length caps mirror lib/projectValidation LIMITS; the PUT route
    // re-sanitizes everything before persisting.
    const brief: ParsedBrief = {
      researchQuestion:    fieldOrUndefined(raw.researchQuestion,    2_000),
      expertType:          fieldOrUndefined(raw.expertType,          2_000),
      keyQuestions:        fieldOrUndefined(raw.keyQuestions,        5_000),
      mustHaveExpertise:   fieldOrUndefined(raw.mustHaveExpertise,   3_000),
      niceToHaveExpertise: fieldOrUndefined(raw.niceToHaveExpertise, 3_000),
      targetCompanies:     fieldOrUndefined(raw.targetCompanies,     3_000),
      companiesToAvoid:    fieldOrUndefined(raw.companiesToAvoid,    3_000),
      timeline:            fieldOrUndefined(raw.timeline,            1_000),
      additionalContext:   fieldOrUndefined(raw.additionalContext,   5_000),
    };

    if (!brief.researchQuestion && !brief.expertType) {
      return Response.json(
        { error: 'no_brief_found', message: 'This document does not look like a project brief — no research question found.' },
        { status: 422 },
      );
    }

    return Response.json({ brief });
  } catch (err) {
    console.error('[parse-brief] extraction failed', {
      status: err instanceof Anthropic.APIError ? err.status : 'unknown',
    });
    return Response.json(
      { error: 'parse_failed', message: 'Could not read the document. Try again or fill the brief manually.' },
      { status: 502 },
    );
  }
}
