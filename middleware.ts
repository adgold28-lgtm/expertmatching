import { NextRequest, NextResponse } from 'next/server';
import { isAuthEnabled, statusMayUseProduct } from './lib/auth';
import { updateSession } from './lib/supabase/middleware';

// Paths that bypass auth entirely — keep this list minimal.
// Exported so the status gate's escape hatches can be asserted directly
// (scripts/test-webhook-recovery.ts). Next.js reads only the default export
// and `config` from this file; the extra named export is inert.
export const PUBLIC_PATHS = new Set([
  '/login',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/reset',
  '/',
  '/pricing',
  '/request-access',
  '/api/request-access',
  '/terms',
  '/privacy',
  '/contact',
]);

// Path prefixes that bypass auth (public pages — no session required).
const PUBLIC_PREFIXES = [
  '/schedule/',              // expert-facing time picker — gated by the signed picker token
  '/api/schedule/',          // the picker's read/book endpoint — same token gate
  // The Google Calendar OAuth round-trip an expert can start from the picker.
  // The PAGES under /availability/ are gone (the picker replaced them); these
  // two API routes keep the path only because the Google console's authorized
  // redirect URI points at it.
  '/api/availability/',      // GET .../[token]/google-auth and the OAuth callback
  '/api/webhooks/',          // Stripe and other provider webhooks — verified by payload signature
  '/payment/',               // public payment success/cancel pages
  '/signup/',                // legacy invite links redirect to /auth/set-password — kept for backward compat
  '/api/inbound-email',      // Resend inbound email webhook — verified by payload signature
  '/api/email-sequence/',    // QStash-triggered email sequence — verified by QStash signature
  '/api/outreach/unsubscribe', // public email opt-out — gated by a signed opt-out token
  '/outreach/unsubscribed',  // opt-out confirmation page shown to the recipient
  '/api/jobs/',              // QStash-triggered background jobs — verified by QStash signature
  '/expert-onboarding/',     // expert Stripe Connect onboarding pages
  '/api/expert-onboarding/', // expert onboarding token exchange
  '/auth/',                  // set-password and other auth pages (token-gated at the route level)
  '/api/auth/set-password',  // set-password API — token-gated at the handler level
];

// Paths where authenticated + fully-onboarded users get bounced to the app.
const APP_REDIRECT_PATHS = new Set(['/', '/login']);

// Internal tools: platform admins only. Non-admins get a 404 (not a 403) so the
// routes' existence is not confirmed, and every response is marked noindex.
// The whole admin console sits behind this too. The API routes under
// /api/admin already run adminGuard themselves; this is defence in depth, and
// it turns a 403 into a 404 so the console's existence is never confirmed.
const ADMIN_ONLY_PREFIXES = [
  '/admin',
  '/api/admin',
];
const isAdminOnly = (pathname: string): boolean =>
  ADMIN_ONLY_PREFIXES.some(p => pathname === p || pathname.startsWith(p + '/'));

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
      role?:                string;
    };

    // Accounts that may not use the product (disabled, or invited but never
    // finished set-password) stop here. This uses the SAME policy as the route
    // guards — middleware used to reject only 'disabled' while the guards were
    // the only thing looking at status at all, and the project guards lean on
    // middleware for exactly this check. API callers get a JSON 403 rather than
    // an HTML redirect they cannot read.
    // PUBLIC_PATHS come through first, exactly as the onboarding gate below
    // allows its own escape hatches. Without this the gate traps the person it
    // blocks: '/login' redirects to '/login' forever, and '/api/auth/logout'
    // answers 403 — so they cannot clear the cookie that is blocking them.
    if (!statusMayUseProduct(meta.status) && !PUBLIC_PATHS.has(pathname)) {
      return pathname.startsWith('/api/')
        ? NextResponse.json({ error: 'forbidden' }, { status: 403 })
        : NextResponse.redirect(new URL('/login', request.url));
    }

    // Internal tools are admin-only and never indexed.
    if (isAdminOnly(pathname)) {
      if (meta.role !== 'admin') {
        return pathname.startsWith('/api/')
          ? NextResponse.json({ error: 'not_found' }, { status: 404 })
          : new NextResponse(null, { status: 404 });
      }
      response.headers.set('X-Robots-Tag', 'noindex, nofollow');
      return response;
    }

    // Onboarding gate — new users must finish onboarding before the app.
    if (meta.onboarding_complete === false) {
      const onboardingAllowed =
        pathname.startsWith('/onboarding') ||
        pathname.startsWith('/api/onboarding') ||
        pathname === '/api/auth/me' ||       // stepper reads it for resume state
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

  // Internal tools never reveal themselves to anonymous traffic.
  if (isAdminOnly(pathname)) {
    return pathname.startsWith('/api/')
      ? NextResponse.json({ error: 'not_found' }, { status: 404 })
      : new NextResponse(null, { status: 404 });
  }

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
