// Request-level guards for all Project Workspace API routes.
//
// Execution order for mutating requests (POST / PUT / PATCH):
//   1. kill switch (PROJECTS_ENABLED)
//   2. auth        (session cookie via global auth, or PROJECTS_ADMIN_TOKEN fallback)
//   3. origin      (NEXT_PUBLIC_APP_URL / APP_URL)
//   4. content-type
//   5. body size + JSON parse
//
// For read requests (GET / DELETE — no body):
//   1–3 only.
//
// NEVER log: project names, research questions, expert names, confidential
// notes, or the value of x-projects-token.

import { timingSafeEqual } from 'crypto';
import { NextRequest } from 'next/server';
import { isAuthEnabled } from './auth';

const MAX_BODY_BYTES = 250 * 1024; // 250 KB

// ─── Individual checks ────────────────────────────────────────────────────────

function guardLog(action: string, reason: string): void {
  // Log route-level guard rejections — no PII, no project names, no secrets.
  console.warn('[projectsGuard]', JSON.stringify({ action, reason }));
}

function checkKillSwitch(): Response | null {
  if (process.env.PROJECTS_ENABLED !== 'true') {
    guardLog('kill_switch', 'projects_disabled');
    return Response.json(
      {
        error:   'service_unavailable',
        reason:  'projects_disabled',
        message: 'Projects are disabled. Set PROJECTS_ENABLED=true.',
      },
      { status: 503 },
    );
  }
  return null;
}

function checkAuth(request: NextRequest): Response | null {
  // When global session auth is active, middleware already verified the session
  // cookie before this route handler was reached. No separate per-route token needed.
  if (isAuthEnabled()) return null;

  // Global auth is off (dev only): fall back to PROJECTS_ADMIN_TOKEN for API access.
  const adminToken = process.env.PROJECTS_ADMIN_TOKEN;
  if (!adminToken) {
    // Dev without any token — allow (local convenience only).
    return null;
  }

  const provided = request.headers.get('x-projects-token') ?? '';
  const tokenBuf = Buffer.from(adminToken, 'utf8');
  const inputBuf = Buffer.from(provided,   'utf8');

  const lengthOk = tokenBuf.length === inputBuf.length;
  const safeRef  = Buffer.alloc(Math.max(tokenBuf.length, inputBuf.length));
  const safeCmp  = Buffer.alloc(Math.max(tokenBuf.length, inputBuf.length));
  tokenBuf.copy(safeRef);
  inputBuf.copy(safeCmp);
  const bytesOk = timingSafeEqual(safeRef, safeCmp);

  if (!lengthOk || !bytesOk) {
    guardLog('auth', 'token_mismatch');
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  return null;
}

function checkOrigin(request: NextRequest): Response | null {
  const origin = request.headers.get('origin');
  if (!origin) return null; // same-origin or non-browser (server-to-server)

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? process.env.APP_URL;
  if (!appUrl) return null; // not configured — skip (permissive fallback)

  try {
    const allowed = new URL(appUrl).origin;
    if (origin !== allowed) {
      return Response.json({ error: 'forbidden', reason: 'origin_mismatch' }, { status: 403 });
    }
  } catch {
    // Bad APP_URL config — skip check rather than hard-blocking all requests
  }
  return null;
}

function checkContentType(request: NextRequest): Response | null {
  const ct = request.headers.get('content-type') ?? '';
  if (!ct.startsWith('application/json')) {
    return Response.json({ error: 'unsupported_media_type' }, { status: 415 });
  }
  return null;
}

async function readLimitedJson(
  request: NextRequest,
): Promise<Record<string, unknown> | Response> {
  const clHeader = request.headers.get('content-length');
  if (clHeader !== null && parseInt(clHeader, 10) > MAX_BODY_BYTES) {
    return Response.json({ error: 'payload_too_large' }, { status: 413 });
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    return Response.json({ error: 'failed_to_read_body' }, { status: 400 });
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
    return Response.json({ error: 'payload_too_large' }, { status: 413 });
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

// GET / DELETE — no body
export function guardReadRequest(request: NextRequest): Response | null {
  return (
    checkKillSwitch() ??
    checkAuth(request) ??
    checkOrigin(request)
  );
}

// POST / PUT / PATCH — returns parsed body or an error Response
export async function guardMutatingRequest(
  request: NextRequest,
): Promise<{ body: Record<string, unknown> } | { error: Response }> {
  const readErr =
    checkKillSwitch() ??
    checkAuth(request) ??
    checkOrigin(request) ??
    checkContentType(request);

  if (readErr) return { error: readErr };

  const result = await readLimitedJson(request);
  if (result instanceof Response) return { error: result };
  return { body: result };
}
