// GET — public, token-gated.
// Verifies availability token, creates/retrieves Stripe Connect account,
// generates onboarding link, and issues a 302 redirect.
//
// Rate limit: 10 req/hr per token (prevents link-generation abuse).
// Token must belong to a 'scheduled' expert — prevents reuse.
//
// The token IS the authentication: it is an HMAC-signed, payout-specific
// (projectId, expertId) pair from lib/payoutToken.ts, minted by
// lib/expertPayout.ts when a payout goes pending. There is no session here —
// an expert has no account. A picker ("pick a time") link does not verify
// here, so an old availability link in the same inbox cannot open the Stripe
// Connect onboarding; see lib/payoutToken.ts for why that mattered.
//
// Side effect worth knowing: the Connect account created here is recorded ONLY
// in Redis (lib/stripeConnect.setConnectAccountId, keyed by HMAC of the email).
// It is not written back onto the project_experts row; lib/expertPayout.ts
// looks it up by email when the account.updated webhook sweeps pending payouts,
// so a Redis outage at that moment strands the payout in 'pending'.

import { NextRequest, NextResponse } from 'next/server';
import { keyHash } from '../../../../lib/keyHash';
import { verifyPayoutToken } from '../../../../lib/payoutToken';
import { getProject } from '../../../../lib/projectStore';
import {
  getConnectAccountId,
  setConnectAccountId,
  createConnectAccount,
  createOnboardingLink,
} from '../../../../lib/stripeConnect';
import { createRateLimiterStore, type RateLimiterStore } from '../../../../lib/rateLimiter';

// ─── Rate limiter ─────────────────────────────────────────────────────────────

let _rl: RateLimiterStore | null = null;
function getRl(): RateLimiterStore {
  if (!_rl) _rl = createRateLimiterStore();
  return _rl;
}

function rlKeyForToken(token: string): string {
  return `rl:expert-onboarding:${keyHash(token, 16)}`;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function GET(
  request: NextRequest,
  { params }: { params: { token: string } },
): Promise<NextResponse> {
  const { token } = params;

  if (!token) {
    return NextResponse.redirect(new URL('/expert-onboarding/refresh', request.url));
  }

  // ── 1. Rate limit per token ──────────────────────────────────────────────
  try {
    const rl = getRl();
    const { count } = await rl.increment(rlKeyForToken(token), 60 * 60 * 1000);
    if (count > 10) {
      return NextResponse.redirect(new URL('/expert-onboarding/refresh', request.url));
    }
  } catch {
    // Non-fatal — continue without rate limiting
  }

  // ── 2. Verify token ───────────────────────────────────────────────────────
  const verifyResult = verifyPayoutToken(token);
  if (!verifyResult.ok) {
    return NextResponse.redirect(new URL('/expert-onboarding/refresh', request.url));
  }

  const { projectId, expertId } = verifyResult.data;

  // ── 3. Load project + expert ─────────────────────────────────────────────
  const project = await getProject(projectId);
  if (!project) {
    return NextResponse.redirect(new URL('/expert-onboarding/refresh', request.url));
  }

  const pe = project.experts.find(e => e.expert.id === expertId);
  if (!pe) {
    return NextResponse.redirect(new URL('/expert-onboarding/refresh', request.url));
  }

  // ── 4. Guard: only scheduled experts may onboard ─────────────────────────
  if (pe.status !== 'scheduled' && pe.status !== 'completed') {
    return NextResponse.redirect(new URL('/expert-onboarding/refresh', request.url));
  }

  const expertEmail = pe.contactEmail;
  if (!expertEmail) {
    return NextResponse.redirect(new URL('/expert-onboarding/refresh', request.url));
  }

  // ── 5. Create or retrieve Connect account ────────────────────────────────
  let accountId: string | null = null;
  try {
    accountId = await getConnectAccountId(expertEmail);
    if (!accountId) {
      accountId = await createConnectAccount(expertEmail);
      await setConnectAccountId(expertEmail, accountId);
    }
  } catch (err) {
    console.error('[expert-onboarding/api] account error:',
      err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return NextResponse.redirect(new URL('/expert-onboarding/refresh', request.url));
  }

  // ── 6. Generate onboarding link ──────────────────────────────────────────
  const baseUrl    = process.env.NEXT_PUBLIC_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? 'https://expertmatch.fit';
  const returnUrl  = `${baseUrl}/expert-onboarding/return`;
  const refreshUrl = `${baseUrl}/expert-onboarding/refresh`;

  let onboardingUrl: string;
  try {
    onboardingUrl = await createOnboardingLink(accountId, returnUrl, refreshUrl);
  } catch (err) {
    console.error('[expert-onboarding/api] link error:',
      err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return NextResponse.redirect(new URL('/expert-onboarding/refresh', request.url));
  }

  return NextResponse.redirect(onboardingUrl, { status: 302 });
}
