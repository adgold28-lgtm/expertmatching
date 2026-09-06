// POST — public endpoint for Resend inbound email webhooks.
//
// Resend sends parsed inbound emails here. We extract the reply token from
// the "to" address (format: reply+[token]@expertmatch.fit), verify it,
// look up the ProjectExpert, classify the reply intent, and update status.
//
// Security:
//   - Verifies the Svix webhook signature (Resend signs with Svix: svix-id,
//     svix-timestamp and svix-signature over "id.timestamp.body", using the
//     base64-decoded whsec_ secret, with a 5-minute timestamp tolerance).
//     Verification is delegated to the svix library.
//   - Rate limited: 100 req/hr per IP
//   - Outreach token is HMAC-signed (see lib/outreachToken.ts)
//   - Only acts when the reply's From address matches the address we mailed
//   - Never schedules email2 twice for the same expert
//
// After a verified signature the handler always answers 200 so Resend does not
// retry replies we deliberately ignore.
//
// Never logs: email content, expert email, expert name, project name.

import { NextRequest, NextResponse } from 'next/server';
import { createHmac } from 'crypto';
import { Webhook } from 'svix';
import { getProject, updateExpertStatus } from '../../../lib/projectStore';
import { verifyOutreachToken } from '../../../lib/outreachToken';
import { parseReply } from '../../../lib/replyDetection';
import { scheduleNextEmail } from '../../../lib/emailSequence';
import { suppress } from '../../../lib/outreachSuppressions';
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

function pseudonymize(value: string): string {
  const secret = process.env.LOG_HASH_SECRET ?? 'dev-fallback-secret';
  return createHmac('sha256', secret).update(value).digest('hex').slice(0, 16);
}

// ─── Resend (Svix) webhook signature verification ─────────────────────────────

// Svix signs `${svix-id}.${svix-timestamp}.${body}` with the base64-decoded
// whsec_ secret and enforces a 5-minute timestamp tolerance. verify() throws on
// any failure — a bad signature, a missing header, or a stale timestamp.
function verifyResendSignature(rawBody: string, request: NextRequest): boolean {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) return false;

  const headers = {
    'svix-id':        request.headers.get('svix-id')        ?? '',
    'svix-timestamp': request.headers.get('svix-timestamp') ?? '',
    'svix-signature': request.headers.get('svix-signature') ?? '',
  };

  try {
    new Webhook(secret).verify(rawBody, headers);
    return true;
  } catch {
    return false;
  }
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

// ─── Extract the sender address ───────────────────────────────────────────────

// Resend's inbound payload carries `from` either as a bare address, as a
// display-name form ("Jane Doe <jane@acme.com>"), or as an object.
function extractFromAddress(fromField: unknown): string {
  let candidate = '';
  if (typeof fromField === 'string') {
    candidate = fromField;
  } else if (Array.isArray(fromField) && fromField.length > 0) {
    const first = fromField[0] as Record<string, unknown>;
    candidate = typeof first?.email === 'string' ? first.email : '';
  } else if (fromField && typeof fromField === 'object') {
    const obj = fromField as Record<string, unknown>;
    candidate = typeof obj.email === 'string' ? obj.email : '';
  }

  const angled = candidate.match(/<([^>]+)>/);
  return (angled?.[1] ?? candidate).trim().toLowerCase();
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

  // ── 3. Verify Resend (Svix) webhook signature ────────────────────────────
  if (process.env.RESEND_WEBHOOK_SECRET) {
    if (!verifyResendSignature(rawBody, request)) {
      console.warn('[inbound-email] invalid webhook signature');
      return NextResponse.json({ error: 'invalid_signature' }, { status: 400 });
    }
  } else if (process.env.NODE_ENV === 'production') {
    console.error('[inbound-email] RESEND_WEBHOOK_SECRET missing — rejecting');
    return NextResponse.json({ error: 'invalid_signature' }, { status: 400 });
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

  // ── 8. Sender check — only the address we mailed can move the sequence ────
  // A forwarded thread, an assistant, or a colleague must not be able to
  // decline, counter-rate, or advance outreach on the expert's behalf.
  const fromAddress    = extractFromAddress(payload.from);
  const expectedSender = pe.contactEmail?.trim().toLowerCase() ?? '';
  if (!expectedSender || fromAddress !== expectedSender) {
    const keyHash = pseudonymize(`${resolvedProjectId}:${resolvedExpertId}`);
    try {
      const store = getRlStore();
      // 30-day counter, incremented for observability only — never gates.
      await store.increment(`rl:inbound-from-mismatch:${keyHash}`, 30 * 24 * 60 * 60 * 1000);
    } catch {
      // Non-fatal — the counter is diagnostic, not a control.
    }
    console.warn('[inbound-email] sender does not match contact email — ignored', { keyHash });
    return NextResponse.json({ ok: true });
  }

  // ── 9. Extract email body text ────────────────────────────────────────────
  const emailText = typeof payload.text === 'string' ? payload.text : '';
  if (!emailText.trim()) {
    console.warn('[inbound-email] empty email body');
    return NextResponse.json({ ok: true });
  }

  // ── 10. Parse reply intent ────────────────────────────────────────────────
  const parsed = await parseReply(emailText);

  // ── 11. Update status based on intent ────────────────────────────────────
  const now = Date.now();

  try {
    if (parsed.intent === 'interested') {
      await updateExpertStatus(resolvedProjectId, resolvedExpertId, {
        status:           'replied',
        replyDetectedAt:  now,
        replyIntent:      'interested',
      });

      // Schedule email2 at most once. A second reply on the same thread must
      // not produce a second "confirm your rate" email, and a reply arriving
      // after the sequence moved on must not restart it.
      if (!pe.email2SentAt && pe.status === 'contacted') {
        await scheduleNextEmail({
          projectId: resolvedProjectId,
          expertId:  resolvedExpertId,
          step:      'email2',
          token,
        });
      } else {
        console.log('[inbound-email] email2 already sent or status advanced — not scheduling', {
          projectId: resolvedProjectId,
        });
      }

    } else if (parsed.intent === 'declined') {
      await updateExpertStatus(resolvedProjectId, resolvedExpertId, {
        status:          'rejected_after_outreach',
        replyDetectedAt: now,
        replyIntent:     'declined',
      });
      // "No" is a fact about the person, not about this project — add them to
      // the global do-not-contact list so the next project does not cold-email
      // them again.
      if (pe.contactEmail) {
        await suppress(pe.contactEmail, 'declined', resolvedProjectId);
      }

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
