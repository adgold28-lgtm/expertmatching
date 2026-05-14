// POST /api/availability/:token
//
// Public endpoint — no session auth required. Access is gated by the signed token.
// Accepts availability from the expert or client and persists parsed slots.
//
// provider=calendly  → stores the Calendly URL; no LLM call needed.
// provider=manual    → passes sanitized free text to Claude Haiku for structured parsing.
//
// Never logs: expert name, email, project name, token, raw availability text.

import { NextRequest, NextResponse } from 'next/server';
import { generateText }              from 'ai';
import { verifyAvailabilityToken, hashToken } from '../../../../lib/availabilityToken';
import { getProject, updateExpertStatus, updateProjectFields } from '../../../../lib/projectStore';
import { fetchCalendlySlots }                 from '../../../../lib/fetchCalendlySlots';
import { createRateLimiterStore }             from '../../../../lib/rateLimiter';
import type { AvailabilitySlot }              from '../../../../types';

const MAX_BODY        = 4096;   // bytes

// Per-token rate limit: 10 submissions / 10 min.
// Prevents LLM-call amplification on manual submissions with a valid token.
const _rlStore = (() => { try { return createRateLimiterStore(); } catch { return null; } })();
const TEN_MIN_MS = 10 * 60 * 1000;

async function checkTokenRateLimit(tokenHash: string): Promise<boolean> {
  if (!_rlStore) return true; // store unavailable — allow (dev fallback already warns)
  const key = `rl:avail:${tokenHash.slice(0, 16)}:10m`;
  const { count } = await _rlStore.increment(key, TEN_MIN_MS);
  return count <= 10;
}
const MAX_TEXT_CHARS  = 800;    // matches textarea maxLength
const MAX_URL_CHARS   = 300;

// ─── Prompt-safe sanitizer ────────────────────────────────────────────────────

function sanitizeForPrompt(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, max).trim();
}

// ─── LLM slot parser ──────────────────────────────────────────────────────────

async function parseAvailabilityWithLLM(text: string): Promise<AvailabilitySlot[]> {
  const prompt = `You are a scheduling assistant. Extract all availability windows from the text below and return them as a JSON array.

Each item must have these fields:
- startTime: string (e.g. "9:00 AM")
- endTime:   string (e.g. "10:00 AM")
- timezone:  string (e.g. "ET", "PT", "GMT")
- dayOfWeek: string (optional, e.g. "Monday")
- date:      string (optional, ISO format e.g. "2026-05-19")
- confidence: "high" | "medium" | "low"

Rules:
- If timezone is not mentioned, use "ET".
- If only a day range is given (e.g. "9–11 AM Monday–Wednesday"), emit one item per day.
- If no specific times are given, use "9:00 AM"/"5:00 PM" as placeholders with confidence "low".
- Return ONLY valid JSON — no explanation, no markdown, just the array.
- If nothing parseable, return [].

Text:
"""
${text}
"""`;

  try {
    const { text: raw } = await generateText({
      model:       'anthropic/claude-haiku-4.5',
      prompt,
      maxOutputTokens: 512,
      temperature: 0,
    });

    // Strip markdown code fences if present
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    const parsed  = JSON.parse(cleaned) as unknown;

    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
      .map(item => ({
        startTime:  String(item.startTime  ?? '9:00 AM'),
        endTime:    String(item.endTime    ?? '10:00 AM'),
        timezone:   String(item.timezone   ?? 'ET'),
        dayOfWeek:  item.dayOfWeek  ? String(item.dayOfWeek)  : undefined,
        date:       item.date       ? String(item.date)       : undefined,
        confidence: (['high', 'medium', 'low'] as const).includes(item.confidence as 'high' | 'medium' | 'low')
          ? item.confidence as AvailabilitySlot['confidence']
          : 'low',
      }))
      .slice(0, 20); // hard cap — prevents bloat
  } catch {
    // LLM or parse error — return empty; caller treats as manual with no slots
    return [];
  }
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function POST(
  request: NextRequest,
  { params }: { params: { token: string } },
): Promise<NextResponse> {

  // ── 1. Content-Type guard ─────────────────────────────────────────────────
  if (!request.headers.get('content-type')?.includes('application/json')) {
    return NextResponse.json({ error: 'content_type_required' }, { status: 415 });
  }

  // ── 2. Body size guard ────────────────────────────────────────────────────
  const cl = request.headers.get('content-length');
  if (cl && parseInt(cl, 10) > MAX_BODY) {
    return NextResponse.json({ error: 'request_too_large' }, { status: 413 });
  }

  let raw: string;
  try { raw = await request.text(); } catch {
    return NextResponse.json({ error: 'read_error' }, { status: 400 });
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY) {
    return NextResponse.json({ error: 'request_too_large' }, { status: 413 });
  }

  // ── 3. Parse body ─────────────────────────────────────────────────────────
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw) as Record<string, unknown>; } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const provider = body.provider;
  if (provider !== 'calendly' && provider !== 'manual') {
    return NextResponse.json({ error: 'invalid_provider' }, { status: 400 });
  }

  // ── 4. Token decode + signature verify ───────────────────────────────────
  const rawToken = decodeURIComponent(params.token);
  const verify   = verifyAvailabilityToken(rawToken);
  if (!verify.ok) {
    const status = verify.reason === 'expired' ? 410 : 400;
    return NextResponse.json({ error: verify.reason }, { status });
  }

  const { type: tokenType, projectId, expertId } = verify.data;

  // ── 4a. Per-token rate limit ─────────────────────────────────────────────
  // Guards against LLM-call amplification on manual submissions with a valid token.
  const allowed = await checkTokenRateLimit(hashToken(rawToken));
  if (!allowed) {
    return NextResponse.json({ error: 'rate_limited' }, {
      status: 429,
      headers: { 'Retry-After': '600' },
    });
  }

  // ── 5. Load project ───────────────────────────────────────────────────────
  const project = await getProject(projectId);
  if (!project) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  // ── 6. Branch: client vs expert token ────────────────────────────────────

  if (tokenType === 'client') {
    // ── Client token path ──

    // Revocation check: compare against project-level hash
    if (!project.clientAvailabilityTokenHash ||
        project.clientAvailabilityTokenHash !== hashToken(rawToken)) {
      return NextResponse.json({ error: 'expired' }, { status: 410 });
    }

    // Already submitted?
    if (project.clientAvailabilitySubmitted) {
      return NextResponse.json({ ok: true, alreadySubmitted: true }, { status: 409 });
    }

    // Process provider
    let clientSlots: AvailabilitySlot[] = [];
    let clientCalendarProvider: 'calendly' | 'manual';
    let clientCalendlyUrl: string | undefined;

    if (provider === 'calendly') {
      const url = sanitizeForPrompt(body.calendlyUrl, MAX_URL_CHARS);
      if (!url.startsWith('https://calendly.com/')) {
        return NextResponse.json({ error: 'invalid_calendly_url' }, { status: 400 });
      }
      clientCalendarProvider = 'calendly';
      clientCalendlyUrl      = url;
      clientSlots            = await fetchCalendlySlots(url);
    } else {
      const text = sanitizeForPrompt(body.manualText, MAX_TEXT_CHARS);
      if (text.length < 10) {
        return NextResponse.json({ error: 'text_too_short' }, { status: 400 });
      }
      clientCalendarProvider = 'manual';
      clientSlots            = await parseAvailabilityWithLLM(text);
    }

    await updateProjectFields(projectId, {
      clientAvailabilitySubmitted: true,
      clientAvailabilitySlots:     clientSlots,
      clientCalendarProvider,
      ...(clientCalendlyUrl ? { clientCalendlyUrl } : {}),
    });

    console.log('[availability-submit] client received', {
      provider:  clientCalendarProvider,
      slotCount: clientSlots.length,
      projectId,
    });

    // Trigger overlap check for all experts who have already submitted
    try {
      const { triggerOverlapCheck } = await import('../../../../lib/triggerOverlapCheck');
      const submitted = project.experts.filter(pe => pe.availabilitySubmitted === true);
      await Promise.all(submitted.map(pe => triggerOverlapCheck(projectId, pe.expert.id)));
    } catch (err) {
      console.error('[availability-submit] overlap trigger failed:', err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    }

    return NextResponse.json({ ok: true });
  }

  // ── Expert token path ──────────────────────────────────────────────────────

  // expertId is guaranteed non-null for expert tokens
  const safeExpertId = expertId!;

  const pe = project.experts.find(e => e.expert.id === safeExpertId);
  if (!pe)  return NextResponse.json({ error: 'expert_not_found' }, { status: 404 });

  // Revocation check
  if (!pe.availabilityTokenHash || pe.availabilityTokenHash !== hashToken(rawToken)) {
    return NextResponse.json({ error: 'expired' }, { status: 410 });
  }

  // Already submitted?
  if (pe.availabilitySubmitted) {
    return NextResponse.json({ ok: true, alreadySubmitted: true }, { status: 409 });
  }

  // Process by provider
  let slots: AvailabilitySlot[] = [];
  let availabilityRaw: string | undefined;
  let calendarProvider: 'calendly' | 'manual';

  if (provider === 'calendly') {
    const url = sanitizeForPrompt(body.calendlyUrl, MAX_URL_CHARS);
    if (!url.startsWith('https://calendly.com/')) {
      return NextResponse.json({ error: 'invalid_calendly_url' }, { status: 400 });
    }
    calendarProvider = 'calendly';
    slots = await fetchCalendlySlots(url);
  } else {
    const text = sanitizeForPrompt(body.manualText, MAX_TEXT_CHARS);
    if (text.length < 10) {
      return NextResponse.json({ error: 'text_too_short' }, { status: 400 });
    }
    availabilityRaw  = text;
    calendarProvider = 'manual';
    slots            = await parseAvailabilityWithLLM(text);
  }

  const calendlyUrl = provider === 'calendly'
    ? sanitizeForPrompt(body.calendlyUrl, MAX_URL_CHARS)
    : undefined;

  await updateExpertStatus(projectId, safeExpertId, {
    availabilitySubmitted: true,
    availabilitySlots:     slots,
    availabilityRaw,
    calendarProvider,
    ...(calendlyUrl ? { calendlyUrl } : {}),
  });

  console.log('[availability-submit] expert received', {
    provider:  calendarProvider,
    slotCount: slots.length,
    projectId,
  });

  // Trigger A: if client has already submitted, run overlap check now
  if (project.clientAvailabilitySubmitted === true) {
    try {
      const { triggerOverlapCheck } = await import('../../../../lib/triggerOverlapCheck');
      await triggerOverlapCheck(projectId, safeExpertId);
    } catch (err) {
      console.error('[availability-submit] overlap trigger failed:', err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    }
  }

  return NextResponse.json({ ok: true });
}
