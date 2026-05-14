// Session cookie auth — uses Web Crypto API (globalThis.crypto.subtle).
// Safe to import from Edge Runtime (middleware) and Node.js API routes.
// Do NOT add Node.js-only imports (scryptSync, etc.) to this file.

import type { NextRequest } from 'next/server';

export const COOKIE_NAME    = 'expertmatch_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Always on in production — fail closed if APP_AUTH_ENABLED is not 'true'.
// In development, gated by APP_AUTH_ENABLED=true.
export function isAuthEnabled(): boolean {
  if (process.env.NODE_ENV === 'production') return true;
  return process.env.APP_AUTH_ENABLED === 'true';
}

async function importHmacKey(usage: 'sign' | 'verify'): Promise<CryptoKey> {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET not configured');
  return globalThis.crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage],
  );
}

// Returns a signed, base64url-encoded session token: <payload>.<sig>
export async function createSessionCookie(): Promise<string> {
  const key     = await importHmacKey('sign');
  const payload = JSON.stringify({ iat: Date.now(), exp: Date.now() + SESSION_TTL_MS });
  const b64     = Buffer.from(payload).toString('base64url');
  const sigBuf  = await globalThis.crypto.subtle.sign('HMAC', key, new TextEncoder().encode(b64));
  const sig     = Buffer.from(sigBuf).toString('base64url');
  return `${b64}.${sig}`;
}

// Route-level auth guard — supplements middleware (defense in depth).
// Returns null if the request is authenticated (or auth is disabled).
// Returns a 401 Response if authentication fails.
// Usage: const authErr = await routeAuthGuard(request); if (authErr) return authErr;
export async function routeAuthGuard(request: NextRequest): Promise<Response | null> {
  if (!isAuthEnabled()) return null;
  const cookie = request.cookies.get(COOKIE_NAME)?.value ?? '';
  if (cookie && await verifySessionCookie(cookie)) return null;
  return Response.json({ error: 'unauthorized' }, { status: 401 });
}

// Returns true only if the token has a valid HMAC signature and has not expired.
export async function verifySessionCookie(token: string): Promise<boolean> {
  try {
    const secret = process.env.SESSION_SECRET;
    if (!secret) return false;

    const dot = token.lastIndexOf('.');
    if (dot === -1) return false;

    const b64      = token.slice(0, dot);
    const sigBytes = Buffer.from(token.slice(dot + 1), 'base64url');

    const key     = await importHmacKey('verify');
    const isValid = await globalThis.crypto.subtle.verify(
      'HMAC', key,
      sigBytes,
      new TextEncoder().encode(b64),
    );
    if (!isValid) return false;

    const payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' && Date.now() <= payload.exp;
  } catch {
    return false;
  }
}
