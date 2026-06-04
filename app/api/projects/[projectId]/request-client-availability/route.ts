// POST /api/projects/:projectId/request-client-availability
//
// Auth-gated. Generates a signed client availability token, stores its hash on
// the Project, and sends an email to the client's email address.
//
// Body: { clientEmail: string, clientName: string }
//
// Never logs: client name, email, project name, token.

import { NextRequest, NextResponse } from 'next/server';
import { createHmac }                from 'crypto';
import { routeAuthGuard, getSessionUser } from '../../../../../lib/auth';
import { getProjectForUser, updateProjectFields } from '../../../../../lib/projectStore';
import { generateClientAvailabilityToken } from '../../../../../lib/availabilityToken';
import { sendAvailabilityRequest }         from '../../../../../lib/sendAvailabilityRequest';
import { createRateLimiterStore }          from '../../../../../lib/rateLimiter';

const ID_RE        = /^[a-f0-9]{24}$/;
const EMAIL_RE     = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Allows letters, digits, spaces, and punctuation common in real names and firm names
// (periods in initials, ampersands, commas, hyphens, apostrophes, parentheses).
// Blocks control characters, angle brackets, quotes, and semicolons.
const NAME_RE      = /^[A-Za-z0-9\s'\-.,&+()]{1,80}$/;

// ─── Rate limiting ────────────────────────────────────────────────────────────
// 3 sends per project per hour

let _rl: ReturnType<typeof createRateLimiterStore> | null = null;
function getRl() {
  if (!_rl) _rl = createRateLimiterStore();
  return _rl;
}

function pseudonymize(value: string): string {
  const secret = process.env.LOG_HASH_SECRET ?? 'dev-fallback-secret';
  return createHmac('sha256', secret).update(value).digest('hex').slice(0, 16);
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
): Promise<NextResponse> {

  // ── 1. Auth ──────────────────────────────────────────────────────────────
  const authDenied = await routeAuthGuard(request);
  if (authDenied) return authDenied as NextResponse;

  const { projectId } = await params;

  // ── 2. Basic ID validation ────────────────────────────────────────────────
  if (!ID_RE.test(projectId)) {
    return NextResponse.json({ error: 'invalid_project_id' }, { status: 400 });
  }

  // ── 3. Parse + validate body ──────────────────────────────────────────────
  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const clientEmail = typeof body.clientEmail === 'string' ? body.clientEmail.trim() : '';
  const clientName  = typeof body.clientName  === 'string' ? body.clientName.trim()  : '';

  if (!EMAIL_RE.test(clientEmail)) {
    return NextResponse.json({ error: 'invalid_client_email' }, { status: 400 });
  }
  if (!NAME_RE.test(clientName)) {
    return NextResponse.json({ error: 'invalid_client_name' }, { status: 400 });
  }

  // ── 4. Rate limit: 3 sends / project / hour ───────────────────────────────
  const rlKey   = `rl:client-avail-req:${pseudonymize(projectId)}:1h`;
  const rlCheck = await getRl().increment(rlKey, 60 * 60 * 1000);
  if (rlCheck.count > 3) {
    const retryAfterS = Math.ceil(rlCheck.ttlMs / 1000);
    return NextResponse.json(
      { error: 'rate_limited', retryAfterMs: rlCheck.ttlMs },
      { status: 429, headers: { 'Retry-After': String(retryAfterS) } },
    );
  }

  // ── 5. Load project (ownership / collaborator / admin scoped) ─────────────
  //    404 on inaccessible/nonexistent so we do not leak project existence.
  const { email, role } = await getSessionUser(request);
  const project = await getProjectForUser(projectId, email, role);
  if (!project) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  // ── 6. Generate token + persist ──────────────────────────────────────────
  // Both steps are wrapped together: if either throws (missing secret, DB error)
  // we return a clean 500 instead of leaking an HTML error page to the client.
  let tokenResult: { token: string; tokenHash: string; expiry: number };
  try {
    tokenResult = generateClientAvailabilityToken(projectId);
    await updateProjectFields(projectId, {
      clientEmail,
      clientName,
      clientAvailabilityToken:       null,   // never store raw token
      clientAvailabilityTokenHash:   tokenResult.tokenHash,
      clientAvailabilityTokenExpiry: tokenResult.expiry,
      clientAvailabilitySubmitted:   false,   // reset on re-send
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    console.error('[request-client-availability] token/persist failed:', msg.slice(0, 120));
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }

  // ── 7. Build link + send email ────────────────────────────────────────────
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  const link   = `${appUrl}/availability/${encodeURIComponent(tokenResult.token)}`;

  try {
    await sendAvailabilityRequest({
      toEmail:          clientEmail,
      expertName:       clientName,   // reused for greeting
      projectName:      project.name,
      availabilityLink: link,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    console.error('[request-client-availability] email send failed:', msg.slice(0, 120));
    return NextResponse.json({ error: 'email_send_failed' }, { status: 502 });
  }

  // ── 8. Audit log (no PII, no token) ──────────────────────────────────────
  console.log('[request-client-availability] sent', {
    projectHash: pseudonymize(projectId),
    expiresAt:   tokenResult.expiry,
  });

  return NextResponse.json({ ok: true, expiresAt: tokenResult.expiry });
}
