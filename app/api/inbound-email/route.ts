// POST — public endpoint for Resend inbound email webhooks.
//
// Resend sends parsed inbound emails here. We extract the reply token from
// the "to" address (format: reply+[token]@expertmatch.fit), verify it,
// look up the ProjectExpert, classify the reply intent, and update status.
//
// Security:
//   - Verifies Resend webhook signature (HMAC-SHA256 of raw body, constant-time)
//   - Rate limited: 100 req/hr per IP
//   - Outreach token is HMAC-signed (see lib/outreachToken.ts)
//
// Never logs: email content, expert email, expert name, project name.

import { NextRequest, NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'crypto';
import { getProject, updateExpertStatus } from '../../../lib/projectStore';
import { verifyOutreachToken } from '../../../lib/outreachToken';
import { parseReply } from '../../../lib/replyDetection';
import { scheduleNextEmail } from '../../../lib/emailSequence';
import { createRateLimiterStore } from '../../../lib/rateLimiter';
import { getUpstashClient } from '../../../lib/upstashRedis';

// ─── Rate limiter ─────────────────────────────────────────────────────────────

let _rlStore: ReturnType<typeof createRateLimiterStore> | null = null;

function getRlStore() {
  if (!_rlStore) _rlStore = createRateLimiterStore();
  return _rlStore;
}

function getClientIp(request: NextRequest): string {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    'unknown'
  );
}

// ─── Resend webhook signature verification ────────────────────────────────────

function verifyResendSignature(rawBody: string, svixSignature: string): boolean {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) return false;

  // svix-signature header format: "v1,[base64]" or "v1,[base64] v1,[base64]"
  // Extract all v1 signatures and check if any match
  const sigs = svixSignature.split(' ').filter(s => s.startsWith('v1,'));

  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
  const expectedBuf = Buffer.from(expected, 'utf8');

  for (const sig of sigs) {
    const sigValue = sig.slice(3); // strip "v1,"
    try {
      const sigBuf = Buffer.from(sigValue, 'utf8');
      if (sigBuf.length === expectedBuf.length && timingSafeEqual(expectedBuf, sigBuf)) {
        return true;
      }
    } catch {
      // ignore malformed sigs
    }
  }

  return false;
}

// ─── Token index lookup ───────────────────────────────────────────────────────

async function lookupReplyToken(token: string): Promise<{ projectId: string; expertId: string } | null> {
  const redis = getUpstashClient();
  if (!redis) return null;

  const raw = await redis.get(`reply-token:${token}`);
  if (!raw) return null;

  try {
    return JSON.parse(raw) as { projectId: string; expertId: string };
  } catch {
    return null;
  }
}

// ─── Extract token from "to" address ─────────────────────────────────────────

function extractReplyToken(toAddress: string): string | null {
  // Matches: reply+TOKEN@expertmatch.fit or "Name <reply+TOKEN@expertmatch.fit>"
  const match = toAddress.match(/reply\+([A-Za-z0-9._~-]+)@expertmatch\.fit/i);
  return match?.[1] ?? null;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest): Promise<NextResponse> {
  // ── 1. Rate limit by IP ──────────────────────────────────────────────────
  const ip = getClientIp(request);
  try {
    const store = getRlStore();
    const { count } = await store.increment(`rl:inbound-email:${ip}:1h`, 60 * 60 * 1000);
    if (count > 100) {
      return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
    }
  } catch {
    // Non-fatal — continue without rate limiting if store fails
  }

  // ── 2. Read raw body ──────────────────────────────────────────────────────
  const rawBody = await request.text();

  // ── 3. Verify Resend webhook signature ───────────────────────────────────
  const svixSig = request.headers.get('svix-signature') ?? '';
  if (process.env.RESEND_WEBHOOK_SECRET) {
    if (!svixSig || !verifyResendSignature(rawBody, svixSig)) {
      console.warn('[inbound-email] invalid webhook signature');
      return NextResponse.json({ error: 'invalid_signature' }, { status: 400 });
    }
  }

  // ── 4. Parse payload ──────────────────────────────────────────────────────
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  // ── 5. Extract "to" address and reply token ───────────────────────────────
  // Resend inbound email payload: { to: [{email: string}], from: string, text: string, ... }
  const toField = payload.to;
  let toAddress = '';
  if (Array.isArray(toField) && toField.length > 0) {
    const first = toField[0] as Record<string, unknown>;
    toAddress = typeof first.email === 'string' ? first.email : '';
  } else if (typeof toField === 'string') {
    toAddress = toField;
  }

  const token = extractReplyToken(toAddress);
  if (!token) {
    console.warn('[inbound-email] no reply token found in to address');
    return NextResponse.json({ ok: true }); // Ack to avoid Resend retries
  }

  // ── 6. Verify HMAC-signed token ───────────────────────────────────────────
  const verifyResult = verifyOutreachToken(token);
  if (!verifyResult.ok) {
    console.warn('[inbound-email] invalid outreach token:', verifyResult.reason);
    return NextResponse.json({ ok: true }); // Ack — don't retry on invalid tokens
  }

  const { projectId, expertId } = verifyResult.data;

  // ── 7. Look up project+expert via Redis index ─────────────────────────────
  const indexed = await lookupReplyToken(token);
  if (!indexed) {
    // Fall back to token payload
    console.warn('[inbound-email] token not in index — using token payload');
  }

  const resolvedProjectId = indexed?.projectId ?? projectId;
  const resolvedExpertId  = indexed?.expertId  ?? expertId;

  const project = await getProject(resolvedProjectId);
  if (!project) {
    console.error('[inbound-email] project not found');
    return NextResponse.json({ ok: true });
  }

  const pe = project.experts.find(e => e.expert.id === resolvedExpertId);
  if (!pe) {
    console.error('[inbound-email] expert not found in project');
    return NextResponse.json({ ok: true });
  }

  // ── 8. Extract email body text ────────────────────────────────────────────
  const emailText = typeof payload.text === 'string' ? payload.text : '';
  if (!emailText.trim()) {
    console.warn('[inbound-email] empty email body');
    return NextResponse.json({ ok: true });
  }

  // ── 9. Parse reply intent ─────────────────────────────────────────────────
  const parsed = await parseReply(emailText);

  // ── 10. Update status based on intent ────────────────────────────────────
  const now = Date.now();

  try {
    if (parsed.intent === 'interested') {
      await updateExpertStatus(resolvedProjectId, resolvedExpertId, {
        status:           'replied',
        replyDetectedAt:  now,
        replyIntent:      'interested',
      });
      // Schedule email2
      await scheduleNextEmail({
        projectId: resolvedProjectId,
        expertId:  resolvedExpertId,
        step:      'email2',
        token,
      });

    } else if (parsed.intent === 'declined') {
      await updateExpertStatus(resolvedProjectId, resolvedExpertId, {
        status:          'rejected_after_outreach',
        replyDetectedAt: now,
        replyIntent:     'declined',
      });

    } else if (parsed.intent === 'counter_rate') {
      await updateExpertStatus(resolvedProjectId, resolvedExpertId, {
        status:              'rate_negotiation',
        replyDetectedAt:     now,
        replyIntent:         'counter_rate',
        counterRateProposed: parsed.counterRate,
      });

    } else if (parsed.intent === 'conflict') {
      await updateExpertStatus(resolvedProjectId, resolvedExpertId, {
        status:          'conflict_flagged',
        replyDetectedAt: now,
        replyIntent:     'conflict',
        conflictNote:    parsed.conflictNote,
      });

    } else {
      // unclear
      await updateExpertStatus(resolvedProjectId, resolvedExpertId, {
        status:          'replied',
        replyDetectedAt: now,
        replyIntent:     'unclear',
      });
      console.log('[inbound-email] unclear intent — logged without action', { projectId: resolvedProjectId });
    }
  } catch (err) {
    console.error('[inbound-email] update error:', err instanceof Error ? err.message.slice(0, 120) : 'unknown');
  }

  return NextResponse.json({ ok: true });
}
