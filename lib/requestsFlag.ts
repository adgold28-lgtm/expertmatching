// lib/requestsFlag.ts — the switch that hides the structured-request flow.
//
// Decision D4 (2026-10-18): the Requests flow — the /requests pages, the
// /api/requests routes and the "Requests" link on /app — is hidden until it is
// folded into the main Brief → Matches → Conversations workflow. The code
// stays, builds and is tested; it is simply unreachable unless
// NEXT_PUBLIC_REQUESTS_FLOW_ENABLED is exactly 'true'.
//
// What the flag does NOT touch: the expert-facing screening form (/s/[token]
// and /api/s/*). A link already in an expert's inbox keeps working whatever
// the flag says; those routes are public, gated by their signed token, and
// the flag is about what clients and admins can start, not what experts can
// finish.
//
// NEXT_PUBLIC_ because the /app header is a client component: Next inlines
// the value at build time, which is also why it is read here as the literal
// `process.env.NEXT_PUBLIC_REQUESTS_FLOW_ENABLED` and never through a variable.

/** True only when the operator has switched the flow on. */
export function isRequestsFlowEnabled(): boolean {
  return process.env.NEXT_PUBLIC_REQUESTS_FLOW_ENABLED === 'true';
}

/**
 * The answer every /api/requests handler gives while the flow is hidden: a
 * plain 404, so the hidden surface is indistinguishable from a route that
 * does not exist. Null when the flow is on and the handler should proceed.
 */
export function requestsFlowGuard(): Response | null {
  if (isRequestsFlowEnabled()) return null;
  return Response.json({ error: 'not_found' }, { status: 404 });
}
