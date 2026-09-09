// lib/authLinks.ts — the one way a set-password link is minted and redeemed.
//
// A link has two halves and each does one job:
//
//   token  — lib/signupToken: our own HMAC-signed, self-describing payload
//            (email, organization, kind, expiry). Stateless. It lets the page
//            greet the invitee, know whether this is an invitation or a reset,
//            and refuse a tampered or expired link WITHOUT a storage read.
//   th     — a Supabase recovery `hashed_token` from auth.admin.generateLink.
//            Supabase keeps it, expires it (Auth → "Email OTP expiration") and
//            burns it on first use. Redeeming it is supabase.auth.verifyOtp.
//
// Single-use enforcement used to be a Redis key in Upstash. Upstash is on a
// plan that gets rate-limited, and when it is, an invitee could not set a
// password and an admin could not send an invite — the most important path in
// the product had a soft dependency on a cache. Supabase already keeps
// single-use recovery tokens for every account; using them removes the
// dependency instead of retrying around it.
//
// Never logs: addresses, tokens, links.

import { createServerClient } from '@supabase/ssr';
import type { NextRequest } from 'next/server';
import { getSupabaseAdminClient } from './supabase/admin';
import { generateSignupToken, type SignupTokenKind } from './signupToken';

export interface MintedSetPasswordLink {
  url:         string;
  /** Our HMAC token (for tests and for the page's pre-validation). */
  token:       string;
  /** Supabase's single-use recovery token hash. */
  hashedToken: string;
  expiry:      number;
  kind:        SignupTokenKind;
}

function appUrl(): string | null {
  const url = (process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/$/, '');
  return url || null;
}

/** Builds the /auth/set-password URL for a token pair. */
export function setPasswordUrl(token: string, hashedToken: string): string | null {
  const base = appUrl();
  if (!base) return null;
  return `${base}/auth/set-password?token=${encodeURIComponent(token)}&th=${encodeURIComponent(hashedToken)}`;
}

/**
 * Mints a link for an EXISTING auth user (invitees are pre-created with an
 * unguessable password, so a recovery token is right for both kinds).
 * Returns null when the link cannot be produced — callers treat that as a
 * delivery failure, never as "already used".
 */
export async function mintSetPasswordLink(
  email:    string,
  firmName: string,
  opts:     { kind: SignupTokenKind; orgId?: string | null },
): Promise<MintedSetPasswordLink | null> {
  const admin = getSupabaseAdminClient();
  if (!admin) return null;

  const normalized = email.trim().toLowerCase();

  let hashedToken: string | undefined;
  try {
    const { data, error } = await admin.auth.admin.generateLink({ type: 'recovery', email: normalized });
    if (error) {
      console.error('[authLinks] generateLink failed:', error.message.slice(0, 120));
      return null;
    }
    hashedToken = data.properties?.hashed_token;
  } catch (err) {
    console.error('[authLinks] generateLink threw:', err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return null;
  }
  if (!hashedToken) return null;

  const { token, expiry, kind } = generateSignupToken(normalized, firmName, {
    kind: opts.kind,
    ...(opts.orgId ? { orgId: opts.orgId } : {}),
  });

  const url = setPasswordUrl(token, hashedToken);
  if (!url) {
    console.error('[authLinks] NEXT_PUBLIC_APP_URL is not configured');
    return null;
  }

  return { url, token, hashedToken, expiry, kind };
}

export type RedeemOutcome =
  | { ok: true;  userId: string }
  | { ok: false; reason: 'expired' | 'invalid' | 'unavailable' };

/**
 * Redeems the Supabase half of a link. Consumes it: a second call with the
 * same hash answers `invalid`. The session verifyOtp mints is thrown away —
 * the caller signs the user in afresh AFTER it has written the new password
 * and (for an invitation) activated the account, so the JWT carries the
 * finished claims rather than the pending ones.
 *
 * `expectedEmail` is the address from our own signed token; a hash that
 * redeems to a different account is refused as invalid.
 */
export async function redeemSetPasswordLink(
  request:       NextRequest,
  hashedToken:   string,
  expectedEmail: string,
): Promise<RedeemOutcome> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key || !hashedToken) return { ok: false, reason: 'unavailable' };

  try {
    // A client that reads no cookies and writes none: this session must not
    // leak onto the response.
    const supabase = createServerClient(url, key, {
      cookies: { getAll() { return []; }, setAll() {} },
    });
    void request;

    const { data, error } = await supabase.auth.verifyOtp({ type: 'recovery', token_hash: hashedToken });

    if (error) {
      const msg = (error.message ?? '').toLowerCase();
      const code = (error as { code?: string }).code ?? '';
      if (code === 'otp_expired' || /expired/.test(msg)) return { ok: false, reason: 'expired' };
      if (/invalid|not found|already/.test(msg) || code === 'otp_disabled' || (error.status ?? 0) < 500) {
        return { ok: false, reason: 'invalid' };
      }
      return { ok: false, reason: 'unavailable' };
    }

    const user = data.user;
    if (!user?.id || (user.email ?? '').toLowerCase() !== expectedEmail.toLowerCase()) {
      return { ok: false, reason: 'invalid' };
    }

    // Discard the recovery session server-side (best effort).
    await supabase.auth.signOut({ scope: 'local' }).catch(() => {});
    return { ok: true, userId: user.id };
  } catch (err) {
    console.error('[authLinks] verifyOtp threw:', err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return { ok: false, reason: 'unavailable' };
  }
}
