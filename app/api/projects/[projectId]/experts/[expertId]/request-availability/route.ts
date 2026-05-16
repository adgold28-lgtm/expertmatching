// POST /api/projects/:projectId/experts/:expertId/request-availability
//
// Auth-gated. Generates a signed availability token, stores its hash on the
// ProjectExpert, and sends an email to the expert's stored contactEmail.
//
// Never logs: expert name, email, project name, token.

import { NextRequest, NextResponse } from 'next/server';
import { routeAuthGuard }            from '../../../../../../../lib/auth';
import { getProject, updateExpertStatus } from '../../../../../../../lib/projectStore';
import { generateAvailabilityToken }  from '../../../../../../../lib/availabilityToken';
import { sendAvailabilityRequest }    from '../../../../../../../lib/sendAvailabilityRequest';

// ─── Rate limiting ────────────────────────────────────────────────────────────
// Re-use the existing rate limiter infrastructure from contactCache.
// 5 requests per expert per hour (to prevent spamming the expert).

import { createHmac } from 'crypto';
import { createRateLimiterStore, type RateLimiterStore } from '../../../../../../../lib/rateLimiter';

let _rl: RateLimiterStore | null = null;
function getRl(): RateLimiterStore {
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
  { params }: { params: { projectId: string; expertId: string } },
): Promise<NextResponse> {

  // ── 1. Auth ──────────────────────────────────────────────────────────────
  const authDenied = await routeAuthGuard(request);
  if (authDenied) return authDenied as NextResponse;

  const { projectId, expertId } = params;

  // ── 2. Basic ID validation ────────────────────────────────────────────────
  if (!/^[a-f0-9]{24}$/.test(projectId) || !/^[a-zA-Z0-9_-]{1,64}$/.test(expertId)) {
    return NextResponse.json({ error: 'invalid_params' }, { status: 400 });
  }

  // ── 3. Rate limit: 5 sends / expert / hour ────────────────────────────────
  const rlKey   = `rl:avail-req:${pseudonymize(`${projectId}:${expertId}`)}:1h`;
  const rlCheck = await getRl().increment(rlKey, 60 * 60 * 1000);
  if (rlCheck.count > 5) {
    const retryAfterS = Math.ceil(rlCheck.ttlMs / 1000);
    return NextResponse.json(
      { error: 'rate_limited', retryAfterMs: rlCheck.ttlMs },
      { status: 429, headers: { 'Retry-After': String(retryAfterS) } },
    );
  }

  // ── 4. Load project + expert ──────────────────────────────────────────────
  const project = await getProject(projectId);
  if (!project) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const pe = project.experts.find(e => e.expert.id === expertId);
  if (!pe)  return NextResponse.json({ error: 'expert_not_found' }, { status: 404 });

  if (!pe.contactEmail) {
    return NextResponse.json({ error: 'no_contact_email' }, { status: 422 });
  }

  // ── 5. Generate token ─────────────────────────────────────────────────────
  const { token, tokenHash, expiry } = generateAvailabilityToken(projectId, expertId);

  // ── 6. Persist token hash (overwrites any previous token — old one is revoked) ──
  await updateExpertStatus(projectId, expertId, {
    availabilityTokenHash:   tokenHash,
    availabilityTokenExpiry: expiry,
    availabilityRequestedAt: Date.now(),
    availabilitySubmitted:   false,   // reset on re-send
  });

  // ── 7. Build link + send email ────────────────────────────────────────────
  const appUrl  = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  const link    = `${appUrl}/availability/${encodeURIComponent(token)}`;

  try {
    await sendAvailabilityRequest({
      toEmail:          pe.contactEmail,
      expertName:       pe.expert.name,
      projectName:      project.name,
      availabilityLink: link,
    });
  } catch (err) {
    // Log the error class/message but nothing that could contain PII
    const msg = err instanceof Error ? err.message : 'unknown';
    console.error('[request-availability] email send failed:', msg.slice(0, 120));
    return NextResponse.json({ error: 'email_send_failed' }, { status: 502 });
  }

  // ── 8. Audit log (no PII, no token) ──────────────────────────────────────
  console.log('[request-availability] sent', {
    keyHash:   pseudonymize(`${projectId}:${expertId}`),
    expiresAt: expiry,
  });

  return NextResponse.json({ ok: true, expiresAt: expiry });
}
