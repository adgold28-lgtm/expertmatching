// POST /api/auth/reset — public: ask for a password reset link.
//
// MIDDLEWARE: this path is NOT in middleware's PUBLIC_PATHS, so anonymous
// callers currently get 401 here. Until '/api/auth/reset' is added to that set,
// the reset form posts to /api/auth/set-password/reset, which is covered by the
// existing '/api/auth/set-password' public prefix. Both mount the same handler.
//
// Always answers { ok: true } for a well-formed address, whether or not it has
// an account (see lib/passwordReset).

import { handlePasswordResetRequest } from '../../../../lib/passwordReset';

export async function POST(request: Request): Promise<Response> {
  return handlePasswordResetRequest(request);
}
