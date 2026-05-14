import { NextRequest, NextResponse } from 'next/server';
import { isAuthEnabled, verifySessionCookie, COOKIE_NAME } from './lib/auth';

// Paths that bypass auth entirely — keep this list minimal.
const PUBLIC_PATHS = new Set([
  '/login',
  '/api/auth/login',
  '/api/auth/logout',
]);

// Path prefixes that bypass auth (public pages — no session required).
const PUBLIC_PREFIXES = [
  '/availability/',      // expert-facing availability submission page
  '/api/availability/',  // public POST endpoint for availability submissions
  '/api/webhooks/',      // Stripe and other provider webhooks — verified by payload signature
  '/payment/',           // public payment success/cancel pages
];

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next();
  if (PUBLIC_PREFIXES.some(p => pathname.startsWith(p))) return NextResponse.next();

  // Production is always auth-gated (isAuthEnabled() returns true there).
  // In development, allow through if APP_AUTH_ENABLED !== 'true'.
  if (!isAuthEnabled()) return NextResponse.next();

  const cookieValue = request.cookies.get(COOKIE_NAME)?.value ?? '';
  const valid       = cookieValue ? await verifySessionCookie(cookieValue) : false;

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
