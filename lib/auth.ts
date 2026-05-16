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

export interface SessionPayload {
  iat:      number;
  exp:      number;
  role:     'admin' | 'user';
  email:    string;
  firmName?: string;
}

// Returns a signed, base64url-encoded session token: <payload>.<sig>
export async function createSessionCookie(
  role: 'admin' | 'user',
  email: string,
  firmName?: string,
): Promise<string> {
  const key     = await importHmacKey('sign');
  const payload: SessionPayload = {
    iat: Date.now(),
    exp: Date.now() + SESSION_TTL_MS,
    role,
    email,
    ...(firmName ? { firmName } : {}),
  };
  const b64    = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sigBuf = await globalThis.crypto.subtle.sign('HMAC', key, new TextEncoder().encode(b64));
  const sig    = Buffer.from(sigBuf).toString('base64url');
  return `${b64}.${sig}`;
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

// Decodes and verifies the session cookie, returning the full payload.
// Returns null if invalid or expired.
export async function getSessionPayload(token: string): Promise<SessionPayload | null> {
  try {
    const dot = token.lastIndexOf('.');
    if (dot === -1) return null;

    const b64      = token.slice(0, dot);
    const sigBytes = Buffer.from(token.slice(dot + 1), 'base64url');

    const key     = await importHmacKey('verify');
    const isValid = await globalThis.crypto.subtle.verify(
      'HMAC', key, sigBytes, new TextEncoder().encode(b64),
    );
    if (!isValid) return null;

    const payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')) as SessionPayload;
    if (typeof payload.exp !== 'number' || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

// Route-level auth guard — supplements middleware (defense in depth).
// Returns null if authenticated (or auth is disabled). Returns 401 if not.
export async function routeAuthGuard(request: NextRequest): Promise<Response | null> {
  if (!isAuthEnabled()) return null;
  const cookie = request.cookies.get(COOKIE_NAME)?.value ?? '';
  if (cookie && await verifySessionCookie(cookie)) return null;
  return Response.json({ error: 'unauthorized' }, { status: 401 });
}

// Resolved session user — used by project store for access control.
export interface SessionUser {
  role:       'admin' | 'user';
  email:      string;
  firmDomain: string; // '*' for admin, else email.split('@')[1]
}

// Returns the current session user, or a default admin user when auth is disabled.
export async function getSessionUser(request: NextRequest): Promise<SessionUser> {
  if (!isAuthEnabled()) {
    return { role: 'admin', email: 'admin', firmDomain: '*' };
  }
  const cookie = request.cookies.get(COOKIE_NAME)?.value ?? '';
  const payload = cookie ? await getSessionPayload(cookie) : null;
  if (!payload) {
    // Should not happen if routeAuthGuard ran first; return a safe default.
    return { role: 'user', email: '', firmDomain: '' };
  }
  const role = payload.role ?? 'admin';
  if (role === 'admin') {
    return { role: 'admin', email: payload.email, firmDomain: '*' };
  }
  const firmDomain = payload.email.includes('@') ? payload.email.split('@')[1] : '';
  return { role: 'user', email: payload.email, firmDomain };
}

// Admin-only guard — checks both auth validity and role === 'admin'.
// Legacy sessions (no role field) are treated as admin for backward compatibility.
export async function adminGuard(request: NextRequest): Promise<Response | null> {
  if (!isAuthEnabled()) return null;
  const cookie = request.cookies.get(COOKIE_NAME)?.value ?? '';
  if (!cookie) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const payload = await getSessionPayload(cookie);
  if (!payload) return Response.json({ error: 'unauthorized' }, { status: 401 });
  // Treat missing role as admin (backward compat for pre-multi-user sessions)
  if (payload.role && payload.role !== 'admin') {
    return Response.json({ error: 'forbidden' }, { status: 403 });
  }
  return null;
}
