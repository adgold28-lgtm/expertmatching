// Initiate Google Calendar OAuth for an expert availability token.
// Public — no app auth required (expert-facing, protected by the signed token).
//
// GET /api/availability/[token]/google-auth
//   → Verifies the availability token, generates OAuth state, stores nonce,
//     then redirects the expert to Google's consent screen.
//
// Required env vars:
//   GOOGLE_CLIENT_ID      — OAuth 2.0 client ID
//   GOOGLE_CLIENT_SECRET  — OAuth 2.0 client secret (not used here, but validated)
//   NEXT_PUBLIC_APP_URL   — base URL for constructing the redirect URI

import { createHmac, randomBytes } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { verifyAvailabilityToken, hashToken } from '../../../../../lib/availabilityToken';
import { getProject, updateExpertStatus } from '../../../../../lib/projectStore';
import { createRateLimiterStore } from '../../../../../lib/rateLimiter';

// Per-token rate limit: 5 OAuth initiations / 10 min.
// Prevents nonce write-contention on repeated hits with a valid token.
const _rlStore = (() => { try { return createRateLimiterStore(); } catch { return null; } })();
const TEN_MIN_MS = 10 * 60 * 1000;

async function checkTokenRateLimit(tokenHash: string): Promise<boolean> {
  if (!_rlStore) return true;
  const key = `rl:avail-gauth:${tokenHash.slice(0, 16)}:10m`;
  const { count } = await _rlStore.increment(key, TEN_MIN_MS);
  return count <= 5;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const GOOGLE_AUTH_URL  = 'https://accounts.google.com/o/oauth2/v2/auth';
const CALENDAR_SCOPE   = 'https://www.googleapis.com/auth/calendar.freebusy';

const STATE_SECRET_ENV = 'AVAILABILITY_TOKEN_SECRET'; // reuse existing secret for state HMAC

// ─── State HMAC ───────────────────────────────────────────────────────────────

function buildState(projectId: string, expertId: string, nonce: string): string {
  const secret  = process.env[STATE_SECRET_ENV];
  if (!secret) throw new Error('[google-auth] AVAILABILITY_TOKEN_SECRET not set');
  const payload = `${projectId}:${expertId}:${nonce}`;
  const sig     = createHmac('sha256', secret).update(payload).digest('hex');
  const stateRaw = `${payload}.${sig}`;
  return Buffer.from(stateRaw).toString('base64url');
}

// ─── Handler ─────────────────────────────────────────────────────────────────

interface RouteParams { params: Promise<{ token: string }> }

export async function GET(request: NextRequest, { params }: RouteParams) {
  // ── Env guard ────────────────────────────────────────────────────────────────
  const clientId  = process.env.GOOGLE_CLIENT_ID;
  const appUrl    = process.env.NEXT_PUBLIC_APP_URL;

  if (!clientId || !process.env.GOOGLE_CLIENT_SECRET) {
    console.error('[google-auth] Google OAuth credentials not configured');
    return NextResponse.redirect(
      new URL('/availability/error?reason=oauth_not_configured', appUrl ?? request.nextUrl.origin),
    );
  }

  // ── Verify availability token ─────────────────────────────────────────────
  const { token: rawToken } = await params;
  const decodedToken = decodeURIComponent(rawToken);
  const result       = verifyAvailabilityToken(decodedToken);

  if (!result.ok) {
    return NextResponse.redirect(
      new URL('/availability/error?reason=token_invalid', appUrl ?? request.nextUrl.origin),
    );
  }

  const { type: tokenType, projectId, expertId } = result.data;

  // This route only handles expert tokens — client tokens don't use Google Calendar OAuth here
  if (tokenType !== 'expert' || !expertId) {
    return NextResponse.redirect(
      new URL('/availability/error?reason=token_invalid', appUrl ?? request.nextUrl.origin),
    );
  }

  // ── Check project + expert exist ─────────────────────────────────────────
  const project = await getProject(projectId);
  if (!project) {
    return NextResponse.redirect(
      new URL('/availability/error?reason=not_found', appUrl ?? request.nextUrl.origin),
    );
  }

  const pe = project.experts.find(e => e.expert.id === expertId);
  if (!pe) {
    return NextResponse.redirect(
      new URL('/availability/error?reason=not_found', appUrl ?? request.nextUrl.origin),
    );
  }

  // ── Revocation check ─────────────────────────────────────────────────────
  // Token revoked if hash no longer matches (new token was sent, overwriting old one)
  if (!pe.availabilityTokenHash || pe.availabilityTokenHash !== hashToken(decodedToken)) {
    return NextResponse.redirect(
      new URL('/availability/error?reason=token_revoked', appUrl ?? request.nextUrl.origin),
    );
  }

  // ── Already submitted ───────────────────────────────────────────────────
  if (pe.availabilitySubmitted) {
    const name = pe.expert.name.split(' ')[0] ?? '';
    return NextResponse.redirect(
      new URL(`/availability/success?name=${encodeURIComponent(name)}`, appUrl ?? request.nextUrl.origin),
    );
  }

  // ── Per-token rate limit ─────────────────────────────────────────────────
  // Prevents nonce write-contention on repeated hits with a valid token.
  const allowed = await checkTokenRateLimit(hashToken(decodedToken));
  if (!allowed) {
    return NextResponse.redirect(
      new URL('/availability/error?reason=rate_limited', appUrl ?? request.nextUrl.origin),
    );
  }

  // ── Generate OAuth state ─────────────────────────────────────────────────
  const nonce = randomBytes(16).toString('hex');
  const state = buildState(projectId, expertId, nonce);

  // Store nonce on ProjectExpert for callback verification
  try {
    await updateExpertStatus(projectId, expertId, { oauthState: nonce });
  } catch (err) {
    console.error('[google-auth] failed to store oauth state:', (err as Error).message);
    return NextResponse.redirect(
      new URL('/availability/error?reason=server_error', appUrl ?? request.nextUrl.origin),
    );
  }

  // ── Build Google OAuth URL ───────────────────────────────────────────────
  const redirectUri = `${appUrl ?? request.nextUrl.origin}/api/availability/oauth/google/callback`;

  const googleUrl = new URL(GOOGLE_AUTH_URL);
  googleUrl.searchParams.set('client_id',     clientId);
  googleUrl.searchParams.set('redirect_uri',  redirectUri);
  googleUrl.searchParams.set('response_type', 'code');
  googleUrl.searchParams.set('scope',         CALENDAR_SCOPE);
  googleUrl.searchParams.set('access_type',   'offline');
  googleUrl.searchParams.set('prompt',        'consent');
  googleUrl.searchParams.set('state',         state);

  return NextResponse.redirect(googleUrl.toString());
}
