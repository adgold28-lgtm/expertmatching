import { NextRequest, NextResponse } from 'next/server';
import { isAuthEnabled, verifySessionCookie, COOKIE_NAME } from './lib/auth';

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
  '/signup/',                // invite-only account creation pages (now redirect to /auth/set-password)
  '/api/signup/',            // public signup POST endpoint (token-gated)
  '/api/inbound-email',      // Resend inbound email webhook — verified by payload signature
  '/api/email-sequence/',    // QStash-triggered email sequence — verified by QStash signature
  '/expert-onboarding/',     // expert Stripe Connect onboarding pages
  '/api/expert-onboarding/', // expert onboarding token exchange
  '/auth/',                  // set-password and other auth pages (token-gated at the route level)
  '/api/auth/set-password',  // set-password API — token-gated at the handler level
];

// Paths that bounce authenticated users to the app — they should never be
// stranded on a marketing or auth page when they're already signed in.
const APP_REDIRECT_PATHS = new Set(['/', '/login']);

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;

  // Webhooks, Stripe, expert-facing pages — always pass through without auth.
  if (PUBLIC_PREFIXES.some(p => pathname.startsWith(p))) return NextResponse.next();

  // In development, auth is optional — let everything through.
  if (!isAuthEnabled()) return NextResponse.next();

  const cookieValue = request.cookies.get(COOKIE_NAME)?.value ?? '';
  const valid       = cookieValue ? await verifySessionCookie(cookieValue) : false;

  // Authenticated users on the marketing site or login page go straight to the app.
  if (valid && APP_REDIRECT_PATHS.has(pathname)) {
    return NextResponse.redirect(new URL('/app', request.url));
  }

  // Public marketing and auth pages — unauthenticated users can view them.
  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next();

  if (valid) return NextResponse.next();

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
