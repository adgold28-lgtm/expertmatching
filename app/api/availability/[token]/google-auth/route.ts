// Initiate Google Calendar OAuth for an expert's SCHEDULING token.
// Public — no app auth required (expert-facing, protected by the signed token).
//
// GET /api/availability/[token]/google-auth
//   → Verifies the picker token, generates OAuth state, stores the nonce, then
//     redirects the expert to Google's consent screen.
//
// The path still says "availability" because the Google console's authorized
// redirect URI points at /api/availability/oauth/google/callback and changing
// it is an operations task, not a code one. Everything else moved: the token is
// the picker token from lib/matchyScheduling.ts (hash on
// `scheduling.pickTokenHash`), and every redirect now lands on /schedule/.
//
// The RAW TOKEN rides in the OAuth state as a fourth segment, inside the same
// HMAC, so the callback can send the expert back to their own picker page. The
// state was `projectId:expertId:nonce`; it is now
// `projectId:expertId:nonce:token`, and the callback still accepts the old
// three-segment form.
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

function buildState(projectId: string, expertId: string, nonce: string, token: string): string {
  const secret  = process.env[STATE_SECRET_ENV];
  if (!secret) throw new Error('[google-auth] AVAILABILITY_TOKEN_SECRET not set');
  // The token is base64url, so it can never contain the ':' separator.
  const payload = `${projectId}:${expertId}:${nonce}:${token}`;
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
  const origin    = appUrl ?? request.nextUrl.origin;

  // Every failure sends the expert back to their own picker page with a reason
  // it can render. A token we could not even decode has no page to go back to,
  // so it lands on the standing confirmation page instead.
  const backTo = (rawToken: string, query: string): NextResponse => NextResponse.redirect(
    new URL(rawToken
      ? `/schedule/${encodeURIComponent(rawToken)}${query}`
      : `/schedule/connected${query}`, origin),
  );

  const { token: rawToken } = await params;
  const decodedToken = decodeURIComponent(rawToken);

  if (!clientId || !process.env.GOOGLE_CLIENT_SECRET) {
    console.error('[google-auth] Google OAuth credentials not configured');
    return backTo(decodedToken, '?error=oauth_not_configured');
  }

  // ── Verify the picker token ───────────────────────────────────────────────
  const result = verifyAvailabilityToken(decodedToken);

  if (!result.ok) {
    return backTo('', '?error=token_invalid');
  }

  const { type: tokenType, projectId, expertId } = result.data;

  // This route only handles expert tokens — client tokens don't use Google Calendar OAuth here
  if (tokenType !== 'expert' || !expertId) {
    return backTo('', '?error=token_invalid');
  }

  // ── Check project + expert exist ─────────────────────────────────────────
  const project = await getProject(projectId);
  if (!project) {
    return backTo('', '?error=not_found');
  }

  const pe = project.experts.find(e => e.expert.id === expertId);
  if (!pe) {
    return backTo('', '?error=not_found');
  }

  // ── Revocation check ─────────────────────────────────────────────────────
  // The hash of the CURRENT picker link. Issuing a new round overwrites it
  // (lib/matchyScheduling.proposeTimes), so an older link fails here.
  const storedHash = pe.scheduling?.pickTokenHash;
  if (!storedHash || storedHash !== hashToken(decodedToken)) {
    return backTo('', '?error=token_revoked');
  }

  // ── Per-token rate limit ─────────────────────────────────────────────────
  // Prevents nonce write-contention on repeated hits with a valid token.
  const allowed = await checkTokenRateLimit(hashToken(decodedToken));
  if (!allowed) {
    return backTo(decodedToken, '?error=rate_limited');
  }

  // ── Generate OAuth state ─────────────────────────────────────────────────
  const nonce = randomBytes(16).toString('hex');
  const state = buildState(projectId, expertId, nonce, decodedToken);

  // Store nonce on ProjectExpert for callback verification
  try {
    await updateExpertStatus(projectId, expertId, { oauthState: nonce });
  } catch (err) {
    console.error('[google-auth] failed to store oauth state:', (err as Error).message);
    return backTo(decodedToken, '?error=server_error');
  }

  // ── Build Google OAuth URL ───────────────────────────────────────────────
  const redirectUri = `${origin}/api/availability/oauth/google/callback`;

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
