// /signup/[token] — backward-compatible redirect for invitation links mailed
// before the set-password page moved to /auth/set-password. Kept alive by the
// '/signup/' entry in middleware.ts PUBLIC_PREFIXES.
//
// It can only ever forward the `token` half. A modern link also carries `th`,
// the Supabase recovery token hash that makes it single-use (lib/authLinks.ts),
// so anything arriving here lands on /auth/set-password without one and is
// answered with "this invitation is from an older email — ask for a new one".
// That is the intended outcome: these old links were single-used through a
// Redis key that is no longer consulted, so none of them can be redeemed.

import { redirect } from 'next/navigation';

export default function SignupPage({ params }: { params: { token: string } }) {
  redirect(`/auth/set-password?token=${encodeURIComponent(params.token ?? '')}`);
}
