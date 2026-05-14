// Google Calendar OAuth callback — public route (expert-facing).
//
// GET /api/availability/oauth/google/callback?code=...&state=...
//   1. Verify state HMAC + nonce against stored oauthState
//   2. Exchange code for tokens (access + refresh)
//   3. Encrypt tokens and store on ProjectExpert
//   4. Set calendarProvider: 'google', availabilitySubmitted: true, clear oauthState
//   5. Redirect to /availability/success?name=...
//
// Required env vars:
//   GOOGLE_CLIENT_ID
//   GOOGLE_CLIENT_SECRET
//   ENCRYPTION_KEY         — 64 hex chars (AES-256-GCM key)
//   NEXT_PUBLIC_APP_URL    — base URL for redirect URI construction

import { createHmac, timingSafeEqual } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getProject, updateExpertStatus } from '../../../../../../lib/projectStore';
import { encrypt } from '../../../../../../lib/encryption';

// ─── Constants ────────────────────────────────────────────────────────────────

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL     = 'https://www.googleapis.com/oauth2/v3/userinfo';
const STATE_SECRET_ENV = 'AVAILABILITY_TOKEN_SECRET';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function verifyState(
  stateB64: string,
  storedNonce: string,
): { ok: false } | { ok: true; projectId: string; expertId: string } {
  const secret = process.env[STATE_SECRET_ENV];
  if (!secret) return { ok: false };

  let decoded: string;
  try {
    decoded = Buffer.from(stateB64, 'base64url').toString('utf8');
  } catch {
    return { ok: false };
  }

  // Format: `${projectId}:${expertId}:${nonce}.${sig}`
  const lastDot = decoded.lastIndexOf('.');
  if (lastDot < 0) return { ok: false };

  const payload  = decoded.slice(0, lastDot);
  const sigActual = decoded.slice(lastDot + 1);

  const sigExpected = createHmac('sha256', secret).update(payload).digest('hex');

  // Timing-safe comparison
  const expBuf = Buffer.from(sigExpected, 'utf8');
  const actBuf = Buffer.from(sigActual,   'utf8');
  if (expBuf.length !== actBuf.length) return { ok: false };
  if (!timingSafeEqual(expBuf, actBuf))  return { ok: false };

  const parts = payload.split(':');
  if (parts.length !== 3) return { ok: false };

  const [projectId, expertId, nonce] = parts;

  // Nonce must match what we stored (prevents replay / state-swap)
  const nonceExpBuf = Buffer.from(storedNonce, 'utf8');
  const nonceActBuf = Buffer.from(nonce,       'utf8');
  if (nonceExpBuf.length !== nonceActBuf.length) return { ok: false };
  if (!timingSafeEqual(nonceExpBuf, nonceActBuf)) return { ok: false };

  return { ok: true, projectId, expertId };
}

interface TokenResponse {
  access_token:  string;
  refresh_token?: string;
  expires_in:    number;
  token_type:    string;
}

async function exchangeCode(
  code: string,
  redirectUri: string,
): Promise<TokenResponse> {
  const clientId     = process.env.GOOGLE_CLIENT_ID!;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET!;

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id:     clientId,
      client_secret: clientSecret,
      redirect_uri:  redirectUri,
      grant_type:    'authorization_code',
    }),
    signal: AbortSignal.timeout(8_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`[google-callback] token exchange failed: ${res.status} ${body.slice(0, 200)}`);
  }

  return res.json() as Promise<TokenResponse>;
}

async function fetchCalendarEmail(accessToken: string): Promise<string | null> {
  try {
    const res = await fetch(USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { email?: string };
    return data.email ?? null;
  } catch {
    return null;
  }
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? request.nextUrl.origin;

  function errorRedirect(reason: string) {
    return NextResponse.redirect(new URL(`/availability/error?reason=${reason}`, appUrl));
  }

  // ── Env guard ────────────────────────────────────────────────────────────
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    console.error('[google-callback] Google OAuth credentials not configured');
    return errorRedirect('oauth_not_configured');
  }

  // ── Parse query params ───────────────────────────────────────────────────
  const { searchParams } = request.nextUrl;
  const code  = searchParams.get('code');
  const state = searchParams.get('state');
  const error = searchParams.get('error');

  if (error) {
    // User denied access or other Google error
    console.log('[google-callback] OAuth error from Google:', error);
    return errorRedirect('access_denied');
  }

  if (!code || !state) {
    return errorRedirect('invalid_callback');
  }

  // ── Decode state to get projectId + expertId (for nonce lookup) ──────────
  // We need the stored nonce to verify state, so decode without verifying first
  let projectId: string;
  let expertId:  string;

  try {
    const decoded  = Buffer.from(state, 'base64url').toString('utf8');
    const lastDot  = decoded.lastIndexOf('.');
    const payload  = lastDot >= 0 ? decoded.slice(0, lastDot) : decoded;
    const parts    = payload.split(':');
    if (parts.length < 2) throw new Error('malformed state');
    projectId = parts[0];
    expertId  = parts[1];
  } catch {
    return errorRedirect('invalid_state');
  }

  // ── Load stored nonce ────────────────────────────────────────────────────
  const project = await getProject(projectId).catch(() => null);
  if (!project) return errorRedirect('not_found');

  const pe = project.experts.find(e => e.expert.id === expertId);
  if (!pe) return errorRedirect('not_found');

  const storedNonce = pe.oauthState;
  if (!storedNonce) return errorRedirect('invalid_state');

  // ── Verify state HMAC ────────────────────────────────────────────────────
  const stateResult = verifyState(state, storedNonce);
  if (!stateResult.ok) {
    console.warn('[google-callback] state verification failed');
    return errorRedirect('invalid_state');
  }

  // ── Already submitted guard ──────────────────────────────────────────────
  if (pe.availabilitySubmitted) {
    const firstName = pe.expert.name.split(' ')[0] ?? '';
    return NextResponse.redirect(
      new URL(`/availability/success?name=${encodeURIComponent(firstName)}`, appUrl),
    );
  }

  // ── Exchange code for tokens ─────────────────────────────────────────────
  const redirectUri = `${appUrl}/api/availability/oauth/google/callback`;

  let tokens: TokenResponse;
  try {
    tokens = await exchangeCode(code, redirectUri);
  } catch (err) {
    console.error('[google-callback] token exchange error:', (err as Error).message);
    return errorRedirect('token_exchange_failed');
  }

  // ── Fetch calendar account email ─────────────────────────────────────────
  const calendarEmail = await fetchCalendarEmail(tokens.access_token);

  // ── Encrypt tokens ───────────────────────────────────────────────────────
  let encryptedAccess:  string;
  let encryptedRefresh: string | undefined;

  try {
    encryptedAccess  = encrypt(tokens.access_token);
    encryptedRefresh = tokens.refresh_token ? encrypt(tokens.refresh_token) : undefined;
  } catch (err) {
    console.error('[google-callback] encryption failed:', (err as Error).message);
    return errorRedirect('server_error');
  }

  // ── Persist to ProjectExpert ─────────────────────────────────────────────
  try {
    await updateExpertStatus(projectId, expertId, {
      calendarProvider:     'google',
      calendarAccessToken:  encryptedAccess,
      calendarRefreshToken: encryptedRefresh,
      calendarTokenExpiry:  Date.now() + tokens.expires_in * 1000,
      calendarEmail:        calendarEmail ?? undefined,
      availabilitySubmitted: true,
      oauthState:           null,  // clear nonce — one-time use
    });
  } catch (err) {
    console.error('[google-callback] failed to store tokens:', (err as Error).message);
    return errorRedirect('server_error');
  }

  console.log('[google-callback] calendar connected', { status: 'ok' });

  // ── Redirect to success ──────────────────────────────────────────────────
  const firstName = pe.expert.name.split(' ')[0] ?? '';
  return NextResponse.redirect(
    new URL(`/availability/success?name=${encodeURIComponent(firstName)}`, appUrl),
  );
}
