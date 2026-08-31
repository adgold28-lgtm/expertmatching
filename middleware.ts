import { NextRequest, NextResponse } from 'next/server';
import { isAuthEnabled } from './lib/auth';
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

  // Refresh the Supabase session cookie and read the verified user.
  // Authorization metadata rides in app_metadata (service-role-written only).
  const { response, user } = await updateSession(request);

  // In development, auth is optional — let everything through.
  if (!isAuthEnabled()) return response;

  if (user) {
    const meta = user.app_metadata as {
      status?:              string;
      onboarding_complete?: boolean;
    };

    // Disabled accounts are kicked to login.
    if (meta.status === 'disabled') {
      return NextResponse.redirect(new URL('/login', request.url));
    }

    // Onboarding gate — new users must finish onboarding before the app.
    if (meta.onboarding_complete === false) {
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
      return response;
    }

    // Fully authenticated — bounce off marketing/login, pass through elsewhere.
    if (APP_REDIRECT_PATHS.has(pathname)) {
      return NextResponse.redirect(new URL('/app', request.url));
    }
    return response;
  }

  // No session — public pages pass, everything else goes to login.
  if (PUBLIC_PATHS.has(pathname)) return response;

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
