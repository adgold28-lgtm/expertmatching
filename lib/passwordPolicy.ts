// lib/passwordPolicy.ts — the ONE statement of what a password must contain.
//
// Supabase Auth enforces its own policy on every password write, including
// admin.updateUserById: at least 8 characters with a lowercase letter, an
// uppercase letter, a digit and a symbol (Dashboard → Authentication →
// Providers → Email → "Password requirements"). The set-password route used to
// check only "8 characters and a digit", so a password Supabase would refuse
// sailed through OUR check, the single-use recovery link was redeemed, and
// only THEN did Supabase answer 422 weak_password — leaving the invitee with a
// generic error and a link that now reads "already used" (Iris, 2026-09-10).
//
// The rule below mirrors Supabase's exactly so a password that passes here
// passes there. If the Supabase setting is ever relaxed, relax this too — a
// stricter app rule is harmless, a looser one burns links.

export const PASSWORD_MIN_LENGTH = 8;

/** Supabase's symbol set, verbatim from its weak_password message. */
const SYMBOLS = '!@#$%^&*()_+-=[]{};\'\\:"|<>?,./`~';

/** Human-readable rule, shown under the password field. */
export const PASSWORD_RULE =
  'At least 8 characters, with an uppercase letter, a lowercase letter, a number and a symbol.';

/** Returns null when the password satisfies the policy, else a user-facing message. */
export function passwordError(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  if (!/[a-z]/.test(password))               return 'Password must contain a lowercase letter.';
  if (!/[A-Z]/.test(password))               return 'Password must contain an uppercase letter.';
  if (!/\d/.test(password))                  return 'Password must contain a number.';
  if (!password.split('').some(c => SYMBOLS.includes(c))) {
    return 'Password must contain a symbol (for example ! @ # $ % or -).';
  }
  return null;
}

/**
 * True when a Supabase auth error is its password-strength refusal. Kept here
 * so callers can answer 400 invalid_password instead of a bare 500 if the two
 * policies ever drift apart.
 */
export function isWeakPasswordError(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  return error.code === 'weak_password' || /password should contain|weak password/i.test(error.message ?? '');
}
