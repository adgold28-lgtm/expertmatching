// The expert's screening form, server side. Public — no session, no account,
// no cookie (docs/SCREENING_FLOW_PLAN.md, build step 4).
//
//   GET  /api/s/:token  → the questions to render
//   POST /api/s/:token  → the answers, once
//
// WHAT AN EXPERT MAY LEARN HERE, EXHAUSTIVELY:
//   • the research topic, as the client wrote it and the compliance screen
//     passed it at approval
//   • an EXPERT-SIDE hourly rate (lib/pricing.expertRateFor) — what we would
//     pay them, never what the client pays
//   • the call length in minutes
//   • the shape of the firm asking: "a mid-size PE firm", never its name
//   • the deadline the link dies on
//   • the questions themselves — each stem and its proof prompt
//   • whether this link has already been used
// AND NOTHING ELSE. Not the client's name, not the firm's name, not the client
// rate, not the targeting, not the request id, not the organization id, not the
// other candidates, not their own row id. lib/screeningPublic.buildScreeningPayload
// builds that list field by field and scripts/test-screening-form.ts asserts
// the whole key set, so a new column on `expert_requests` cannot arrive here by
// accident.
//
// ACCESS is the signed screening token and nothing else: HMAC signature,
// expiry at the request deadline (lib/screeningToken), a stored SHA-256 that
// finds the row, the row's own id and request id matching what the token
// claims, no `revoked_at`, no `submitted_at` on a write, and a request still
// `approved`. EVERY ONE OF THOSE FAILURES ANSWERS THE SAME 410 `expired` — a
// malformed token, a forged one, a revoked one, a link whose request was
// closed. A holder learns that the link is dead and never which kind of dead,
// and a prober learns nothing about which request ids exist.
//
// SINGLE USE is enforced by the store, not here: lib/requestStore.submitScreening
// writes conditionally on `submitted_at is null`, so two taps on a flaky phone
// connection are two requests and the loser writes nothing. The pre-check below
// is a courtesy that turns the common case into a clean 409.
//
// RATE LIMIT: 20 requests / 10 min per token hash, fail open — a limiter that
// cannot answer must not be what stops an expert from replying.
//
// Never logs: the token, the token hash, the topic, the questions, the answers,
// or a word the expert wrote. The product event carries two counts.

import { NextRequest, NextResponse } from 'next/server';
import {
  verifyScreeningToken,
  hashScreeningToken,
} from '../../../../lib/screeningToken';
import { getCandidateByTokenHash, submitScreening } from '../../../../lib/requestStore';
import { createRateLimiterStore } from '../../../../lib/rateLimiter';
import {
  buildScreeningPayload,
  matchesToken,
  type ScreeningPayload,
} from '../../../../lib/screeningPublic';
import { validateScreeningSubmission, isValid } from '../../../../lib/screeningValidation';
import { computeCoverage } from '../../../../lib/screeningCoverage';
import { getFirmById } from '../../../../lib/firmStore';
import { trackProductEvent } from '../../../../lib/productEvents';
import type { ScreeningCandidate, ScreeningRequest } from '../../../../types';

const MAX_BODY   = 64 * 1024;
const TEN_MIN_MS = 10 * 60 * 1000;
const MAX_HITS   = 20;

/** One 410 body for every dead reason. See the header. */
const EXPIRED = { error: 'expired' } as const;

const _rlStore = (() => { try { return createRateLimiterStore(); } catch { return null; } })();

async function withinRateLimit(tokenHash: string): Promise<boolean> {
  if (!_rlStore) return true; // store unavailable — allow, as the picker does
  // Fail open on a live error too: Upstash can refuse a call (quota, outage),
  // and an unhandled rejection here 500s the form at the moment an expert is
  // trying to answer.
  try {
    const { count } = await _rlStore.increment(`rl:screening:${tokenHash.slice(0, 16)}:10m`, TEN_MIN_MS);
    return count <= MAX_HITS;
  } catch {
    return true;
  }
}

// ─── Token resolution ─────────────────────────────────────────────────────────

type Resolved =
  | { ok: true;  candidate: ScreeningCandidate; request: ScreeningRequest; tokenHash: string }
  | { ok: false };

/**
 * Signature, expiry, the stored hash, the row's own ids, revocation, and the
 * request's status. Every failure is the same silent no — the caller answers
 * 410 `expired` and says nothing more.
 */
async function resolveToken(rawToken: string): Promise<Resolved> {
  const verified = verifyScreeningToken(rawToken);
  if (!verified.ok) return { ok: false };

  const tokenHash = hashScreeningToken(rawToken);
  const found     = await getCandidateByTokenHash(tokenHash).catch(() => null);
  if (!found) return { ok: false };

  const { candidate, request } = found;

  // The row has to be the row this token was signed for. The hash already
  // found it; this refuses a token replayed against a row that has moved.
  if (!matchesToken(candidate, verified.data)) return { ok: false };

  if (candidate.revokedAt) return { ok: false };
  if (Date.parse(candidate.expiresAt) <= Date.now()) return { ok: false };

  // A draft request has no approved questions to ask, and a closed one has
  // stopped asking.
  if (request.status !== 'approved') return { ok: false };

  return { ok: true, candidate, request, tokenHash };
}

// ─── GET ──────────────────────────────────────────────────────────────────────

export async function GET(
  request: NextRequest,
  { params }: { params: { token: string } },
): Promise<NextResponse> {
  const rawToken = decodeURIComponent(params.token);

  const resolved = await resolveToken(rawToken);
  if (!resolved.ok) return NextResponse.json(EXPIRED, { status: 410 });

  if (!(await withinRateLimit(resolved.tokenHash))) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429, headers: { 'Retry-After': '600' } });
  }

  // Null without a service-role client (development) or for an organization
  // that has gone — the phrase falls back to "an investment firm" rather than
  // naming anyone.
  const firm = await getFirmById(resolved.request.organizationId).catch(() => null);

  const payload: ScreeningPayload = buildScreeningPayload(resolved.request, resolved.candidate, firm);

  return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store' } });
}

// ─── POST ─────────────────────────────────────────────────────────────────────

export async function POST(
  request: NextRequest,
  { params }: { params: { token: string } },
): Promise<NextResponse> {
  if (!request.headers.get('content-type')?.includes('application/json')) {
    return NextResponse.json({ error: 'content_type_required' }, { status: 415 });
  }

  const contentLength = request.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > MAX_BODY) {
    return NextResponse.json({ error: 'request_too_large' }, { status: 413 });
  }

  let raw: string;
  try { raw = await request.text(); } catch {
    return NextResponse.json({ error: 'read_error' }, { status: 400 });
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY) {
    return NextResponse.json({ error: 'request_too_large' }, { status: 413 });
  }

  let body: Record<string, unknown>;
  try { body = JSON.parse(raw) as Record<string, unknown>; } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const rawToken = decodeURIComponent(params.token);
  const resolved = await resolveToken(rawToken);
  if (!resolved.ok) return NextResponse.json(EXPIRED, { status: 410 });

  if (!(await withinRateLimit(resolved.tokenHash))) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429, headers: { 'Retry-After': '600' } });
  }

  const { candidate, request: screeningRequest } = resolved;

  if (candidate.submittedAt) {
    return NextResponse.json({ error: 'already_submitted' }, { status: 409 });
  }

  // Position order, because that is the order the form showed them in and the
  // order the stored answers follow.
  const objectiveIds = [...screeningRequest.objectives]
    .sort((a, b) => a.position - b.position)
    .map(objective => objective.id);

  const validated = validateScreeningSubmission(body, objectiveIds);
  if (!isValid(validated)) {
    return NextResponse.json({ error: 'invalid_input', errors: validated.errors }, { status: 400 });
  }
  const data = validated.data;

  // The store throws when the answers could not be written, having first
  // undone its claim on the link so the expert can send again. That is a
  // retryable failure, not a dead link, so it does NOT answer 410.
  let result: Awaited<ReturnType<typeof submitScreening>>;
  try {
    result = await submitScreening(candidate.id, data);
  } catch {
    return NextResponse.json(
      { error: 'submit_failed', message: 'We could not save your answers. Please try again.' },
      { status: 500 },
    );
  }

  if (result === 'already_submitted') {
    return NextResponse.json({ error: 'already_submitted' }, { status: 409 });
  }
  if (result === 'not_found') {
    return NextResponse.json(EXPIRED, { status: 410 });
  }

  const coverage = computeCoverage(data.answers);

  // No actor: there is no session here, and the expert is not a platform user.
  void trackProductEvent({
    type:           'screening_submitted',
    organizationId: screeningRequest.organizationId,
    payload: { yes: coverage.yes, total: coverage.total },
  });

  return NextResponse.json({ coverage });
}
