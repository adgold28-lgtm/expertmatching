import { NextRequest, NextResponse } from 'next/server';
import { isAuthEnabled, getSessionPayload, COOKIE_NAME } from './lib/auth';
import { updateSession } from './lib/supabase/middleware';

// Paths that bypass auth entirely — keep this list minimal.
const PUBLIC_PATHS = new Set([
  '/login',
  '/api/auth/login',
  '/api/auth/logout',
  '/',
  '/pricing',
  '/request-access',
  '/api/request-access',
]);

// Path prefixes that bypass auth (public pages — no session required).
const PUBLIC_PREFIXES = [
  '/availability/',          // expert-facing availability submission page
  '/api/availability/',      // public POST endpoint for availability submissions
  '/api/webhooks/',          // Stripe and other provider webhooks — verified by payload signature
  '/payment/',               // public payment success/cancel pages
  '/signup/',                // legacy invite links redirect to /auth/set-password — kept for backward compat
  '/api/inbound-email',      // Resend inbound email webhook — verified by payload signature
  '/api/email-sequence/',    // QStash-triggered email sequence — verified by QStash signature
  '/expert-onboarding/',     // expert Stripe Connect onboarding pages
  '/api/expert-onboarding/', // expert onboarding token exchange
  '/auth/',                  // set-password and other auth pages (token-gated at the route level)
  '/api/auth/set-password',  // set-password API — token-gated at the handler level
];

// Paths where authenticated + fully-onboarded users get bounced to the app.
const APP_REDIRECT_PATHS = new Set(['/', '/login']);

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;

  // Webhooks, Stripe, expert-facing pages — always pass through without auth.
  // Skip Supabase refresh here too — these paths don't need session cookies.
  if (PUBLIC_PREFIXES.some(p => pathname.startsWith(p))) return NextResponse.next();

  // --- Stage 2: Supabase session refresh -----------------------------------
  // Runs on every non-public request.  For all current users (pre-migration),
  // user is null and this is effectively a no-op — the HMAC path below handles
  // all access control.  When login is migrated (Stage 3+), user will be
  // non-null for accounts that have signed in via Supabase Auth, and the HMAC
  // check will be skipped for them.
  //
  // Fails open: if Supabase env vars are missing or the network is down,
  // updateSession() returns { user: null } and we fall through to HMAC auth.
  const { response: supabaseResponse, user: supabaseUser, redisUser: supabaseRedisUser } =
    await updateSession(request);
  // -------------------------------------------------------------------------

  // In development, auth is optional — let everything through.
  if (!isAuthEnabled()) return supabaseResponse;

  // If the request carries a valid Supabase session, apply full gating.
  // redisUser carries role / status / onboardingComplete from Redis so we
  // don't need a separate lookup here.
  if (supabaseUser) {
    // If we couldn't read the Redis record (Redis down, user deleted), send
    // to login — we can't determine authorization without the metadata.
    if (!supabaseRedisUser) {
      const loginUrl = new URL('/login', request.url);
      loginUrl.searchParams.set('next', pathname);
      return NextResponse.redirect(loginUrl);
    }

    // Disabled accounts are kicked to login.
    if (supabaseRedisUser.status === 'disabled') {
      return NextResponse.redirect(new URL('/login', request.url));
    }

    // Onboarding gate — mirrors the HMAC path exactly.
    if (supabaseRedisUser.onboardingComplete === false) {
      const onboardingAllowed =
        pathname.startsWith('/onboarding') ||
        pathname.startsWith('/api/onboarding') ||
        pathname === '/api/auth/logout';
      if (!onboardingAllowed) {
        if (pathname.startsWith('/api/')) {
          return NextResponse.json({ error: 'onboarding_incomplete' }, { status: 403 });
        }
        return NextResponse.redirect(new URL('/onboarding', request.url));
      }
      return supabaseResponse;
    }

    // Fully authenticated — bounce off marketing/login, pass through elsewhere.
    if (APP_REDIRECT_PATHS.has(pathname)) {
      return NextResponse.redirect(new URL('/app', request.url));
    }
    return supabaseResponse;
  }

  // No Supabase session — fall through to existing HMAC cookie auth.
  const cookieValue = request.cookies.get(COOKIE_NAME)?.value ?? '';
  const payload     = cookieValue ? await getSessionPayload(cookieValue) : null;

  // New users (onboardingComplete explicitly false) are gated to /onboarding.
  // We check === false, not just falsy, so old sessions (no field) pass through.
  if (payload && payload.onboardingComplete === false) {
    const onboardingAllowed =
      pathname.startsWith('/onboarding') ||
      pathname.startsWith('/api/onboarding') ||
      pathname === '/api/auth/logout';
    if (!onboardingAllowed) {
      if (pathname.startsWith('/api/')) {
        return NextResponse.json({ error: 'onboarding_incomplete' }, { status: 403 });
      }
      return NextResponse.redirect(new URL('/onboarding', request.url));
    }
    return supabaseResponse;
  }

  // Authenticated users on the marketing site or login page go straight to the app.
  if (payload && APP_REDIRECT_PATHS.has(pathname)) {
    return NextResponse.redirect(new URL('/app', request.url));
  }

  // Public marketing and auth pages — unauthenticated users can view them.
  if (PUBLIC_PATHS.has(pathname)) return supabaseResponse;

  if (payload) return supabaseResponse;

  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const loginUrl = new URL('/login', request.url);
  loginUrl.searchParams.set('next', pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico).*)'],
};
