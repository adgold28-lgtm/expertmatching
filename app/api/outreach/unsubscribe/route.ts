// GET /api/outreach/unsubscribe?token=...
//
// Public one-click opt-out, linked from the footer of every expert-facing
// email. The token is an HMAC of the recipient's address (lib/optOutToken.ts),
// so the address never appears in the URL and nobody can unsubscribe a third
// party by editing a query string.
//
// On success the address lands on the global do-not-contact list
// (public.outreach_suppressions, reason 'opt_out') and the browser is
// redirected to /outreach/unsubscribed.
//
// Rate limited 60/hr per IP, fail-open like its public siblings — a limiter
// outage must not strand someone trying to opt out.
//
// Never logs: the email address or the token.

import { NextRequest, NextResponse } from 'next/server';
import { verifyOptOutToken } from '../../../../lib/optOutToken';
import { suppress } from '../../../../lib/outreachSuppressions';
import { createRateLimiterStore } from '../../../../lib/rateLimiter';

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

function landingUrl(request: NextRequest, status?: 'invalid' | 'error'): URL {
  const url = new URL('/outreach/unsubscribed', request.nextUrl.origin);
  if (status) url.searchParams.set('status', status);
  return url;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  // ── 1. Rate limit by IP (fail-open) ──────────────────────────────────────
  const ip = getClientIp(request);
  try {
    const store = getRlStore();
    const { count } = await store.increment(`rl:outreach-unsub:${ip}:1h`, 60 * 60 * 1000);
    if (count > 60) {
      return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
    }
  } catch {
    // Non-fatal — continue without rate limiting if the store fails.
  }

  // ── 2. Verify the token ──────────────────────────────────────────────────
  const token = request.nextUrl.searchParams.get('token') ?? '';
  if (!token) {
    return NextResponse.redirect(landingUrl(request, 'invalid'));
  }

  const verified = verifyOptOutToken(token);
  if (!verified.ok) {
    console.warn('[outreach/unsubscribe] token rejected:', verified.reason);
    return NextResponse.redirect(landingUrl(request, 'invalid'));
  }

  // ── 3. Record the opt-out ────────────────────────────────────────────────
  const stored = await suppress(verified.email, 'opt_out');
  if (!stored) {
    console.error('[outreach/unsubscribe] failed to record opt-out');
    return NextResponse.redirect(landingUrl(request, 'error'));
  }

  console.log('[outreach/unsubscribe] opt-out recorded');
  return NextResponse.redirect(landingUrl(request));
}
