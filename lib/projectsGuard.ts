// Request-level guards for all Project Workspace API routes.
//
// Execution order for mutating requests (POST / PUT / PATCH):
//   1. kill switch (PROJECTS_ENABLED)
//   2. auth        (session cookie via global auth, or PROJECTS_ADMIN_TOKEN fallback)
//   3. origin      (NEXT_PUBLIC_APP_URL / APP_URL)
//   4. content-type
//   5. body size + JSON parse
//
// For read requests (GET — no body):
//   1–2 only.
//
// A DELETE is a mutation, so it goes through guardMutatingRequest too. The
// content-type check exempts a DELETE that carries no body at all; see
// checkContentType for why that is safe.
//
// NEVER log: project names, research questions, expert names, confidential
// notes, or the value of x-projects-token.

import { timingSafeEqual } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { isAuthEnabled } from './auth';
import type { Project } from '../types';

const MAX_BODY_BYTES = 250 * 1024; // 250 KB

// ─── Individual checks ────────────────────────────────────────────────────────

function guardLog(action: string, reason: string): void {
  // Log route-level guard rejections — no PII, no project names, no secrets.
  console.warn('[projectsGuard]', JSON.stringify({ action, reason }));
}

function checkKillSwitch(): Response | null {
  if (process.env.PROJECTS_ENABLED === 'false') {
    guardLog('kill_switch', 'projects_disabled');
    return Response.json(
      {
        error:   'service_unavailable',
        reason:  'projects_disabled',
        message: 'Projects are temporarily unavailable. Please try again shortly.',
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


/**
 * The JSON content-type requirement is a CSRF surrogate: a cross-origin form
 * post cannot set `application/json` without earning a preflight, so demanding
 * it on a body-carrying request means the browser has already asked us.
 *
 * A bodiless DELETE is exempt, and safely so: DELETE is never a "simple"
 * method, so a cross-origin one is preflighted whatever headers it carries.
 * The exemption is narrow on purpose — POST / PUT / PATCH, and any DELETE that
 * actually carries a body, still have to say application/json.
 */
function checkContentType(request: NextRequest): Response | null {
  const ct = request.headers.get('content-type') ?? '';
  if (ct.startsWith('application/json')) return null;

  const contentLength = request.headers.get('content-length');
  const bodiless = ct === '' && (contentLength === null || contentLength === '0');
  if (request.method === 'DELETE' && bodiless) return null;

  return Response.json({ error: 'unsupported_media_type' }, { status: 415 });
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
  // An empty body on a bodiless action (bookmark, approve, send) is fine.
  if (text.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return Response.json({ error: 'invalid_json' }, { status: 400 });
    }
    return parsed as Record<string, unknown>;
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

// GET — no body
export function guardReadRequest(request: NextRequest): Response | null {
  return (
    checkKillSwitch() ??
    checkAuth(request)
  );
}

/**
 * The owner check, in one place.
 *
 * Product rule (docs/MATCHY_SPEC.md, founder answer 5): a project is shared
 * read-only. Collaborators see everything on it; only the project OWNER — or
 * platform staff — may act on an expert: start outreach, write to them, move
 * their status, settle a rate, remove them, spend money on sourcing, or charge
 * the card. Anything that costs money or leaves the platform goes through here.
 *
 * ORDER MATTERS. Call this AFTER getProjectForUser, never before: an
 * inaccessible project must still 404, so this route never confirms that a
 * project someone cannot reach exists. By the time this runs, the caller has
 * already been proved a member.
 *
 * Returns null when the caller may proceed, or the 403 to return as-is.
 */
export function requireProjectOwner(
  project: Project,
  session: { email: string; role: 'admin' | 'user' },
): Response | null {
  if (session.role === 'admin') return null;
  if (project.ownerEmail === session.email) return null;

  guardLog('owner', 'not_project_owner');
  return NextResponse.json(
    { error: 'forbidden', message: 'Only the project owner can do this.' },
    { status: 403 },
  );
}

// POST / PUT / PATCH — returns parsed body or an error Response
export async function guardMutatingRequest(
  request: NextRequest,
): Promise<{ body: Record<string, unknown> } | { error: Response }> {
  const readErr =
    checkKillSwitch() ??
    checkAuth(request) ??
    checkContentType(request);

  if (readErr) return { error: readErr };

  const result = await readLimitedJson(request);
  if (result instanceof Response) return { error: result };
  return { body: result };
}
