// Expert payout onboarding — thin forwarder.
//
// The whole flow (token verification, 'scheduled'/'completed' guard, Connect
// account create-or-retrieve, hosted onboarding link) lives in
// app/api/expert-onboarding/[token]/route.ts, which also rate-limits to 10
// requests per hour per token. This page used to duplicate all of it WITHOUT
// the rate limit, so the emailed link (built in lib/expertPayout.ts, which
// still points here — deliberately) is forwarded to the route instead.
//
// Public route — the token is the auth mechanism, and the route verifies it.

import { redirect, notFound } from 'next/navigation';

/**
 * Token shape from lib/availabilityToken.ts:
 *   base64url(payload) "." base64url(HMAC-SHA256)
 * The API route has no regex of its own (it checks for a non-empty token and
 * then verifies the signature), so this is a cheap structural filter: garbage
 * in the URL 404s here instead of costing the route a rate-limit slot. Anything
 * that passes is still fully verified downstream.
 */
const TOKEN_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const MAX_TOKEN_LENGTH = 512;

interface Props {
  params: { token: string };
}

export default function ExpertOnboardingPage({ params }: Props) {
  const { token } = params;

  if (!token || token.length > MAX_TOKEN_LENGTH || !TOKEN_RE.test(token)) {
    notFound();
  }

  redirect(`/api/expert-onboarding/${token}`);
}
