// POST /api/auth/reset — public: ask for a password reset link.
//
// MIDDLEWARE: '/api/auth/reset' IS in middleware.ts PUBLIC_PATHS, so an
// anonymous caller reaches this handler. (An earlier comment here claimed the
// opposite and pointed the form at a /api/auth/set-password/reset alias; that
// alias does not exist and app/auth/reset/ResetRequestForm.tsx posts here.)
//
// Note PUBLIC_PATHS is only consulted on the no-session branch: a SIGNED-IN
// caller falls through the authenticated branch and also reaches this handler,
// which is harmless — the body's email decides who gets the link, and the
// handler answers { ok: true } regardless.
//
// Always answers { ok: true } for a well-formed address, whether or not it has
// an account (see lib/passwordReset).

import { handlePasswordResetRequest } from '../../../../lib/passwordReset';

export async function POST(request: Request): Promise<Response> {
  return handlePasswordResetRequest(request);
}
