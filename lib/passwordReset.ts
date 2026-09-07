// lib/passwordReset.ts — self-service password recovery.
//
// An account is created by invitation and its password is set through the
// tokenized /auth/set-password page. Recovery reuses exactly that page: this
// module mints a signup token of kind 'reset', stores its hash in Redis for one
// hour and emails the link. app/api/auth/set-password then swaps the password
// via the Supabase admin API without touching status or org membership.
//
// Enumeration safety is the whole point of the shape here: the caller ALWAYS
// gets { ok: true }, whether the address has an account, has a disabled
// account, or has never been seen. Nothing about the outcome reaches the
// response — not the status code, not the timing budget we can control, not the
// copy. Never logs email addresses.

import { Resend } from 'resend';
import { createHmac } from 'crypto';
import { getUpstashClient } from './upstashRedis';
import { getUser } from './firmStore';
import { getFromAddress } from './mailFrom';
import { generateSignupToken, tokenRedisKey, tokenTtlSeconds } from './signupToken';

// ─── Rate limiting ────────────────────────────────────────────────────────────

const RATE_LIMIT_PER_EMAIL = 3;
const RATE_LIMIT_PER_IP    = 10;
const RATE_WINDOW_MS       = 60 * 60 * 1000; // 1 hour

/** HMAC-pseudonymised key — no IPs or emails in Redis key names. */
function rlKey(kind: 'ip' | 'email', value: string): string {
  const secret = process.env.LOG_HASH_SECRET ?? 'dev-insecure-fallback';
  const hash   = createHmac('sha256', secret).update(value).digest('hex').slice(0, 24);
  return `reset-rl:${kind}:${hash}`;
}

/**
 * True when the caller is over either limit. Fails open when Redis is
 * unavailable — a Redis outage must not lock everyone out of recovery.
 */
export async function isResetRateLimited(ip: string, email: string): Promise<boolean> {
  const redis = getUpstashClient();
  if (!redis) return false;
  try {
    const [byIp, byEmail] = await Promise.all([
      redis.incrWithWindow(rlKey('ip', ip), RATE_WINDOW_MS),
      redis.incrWithWindow(rlKey('email', email), RATE_WINDOW_MS),
    ]);
    return byIp.count > RATE_LIMIT_PER_IP || byEmail.count > RATE_LIMIT_PER_EMAIL;
  } catch {
    return false;
  }
}

// ─── Email ────────────────────────────────────────────────────────────────────

let _resend: Resend | null = null;

function getResend(): Resend | null {
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  if (!_resend) _resend = new Resend(key);
  return _resend;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Sends the "choose a new password" email. Exported because an admin
 * re-inviting an ALREADY ACTIVE member is really sending them a reset link —
 * the invitation copy ("your access has been approved") would be wrong for
 * someone whose account already works.
 */
export async function sendPasswordResetEmail(email: string, resetUrl: string, firstName: string): Promise<void> {
  if (process.env.DISABLE_EMAILS === 'true') return;

  const resend = getResend();
  if (!resend) return;

  const greeting = firstName.trim() || 'there';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Reset your ExpertMatch password</title>
</head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:40px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e2e8f0;max-width:600px;">
        <tr>
          <td style="background:#0f172a;padding:24px 32px;">
            <span style="color:#ffffff;font-size:11px;font-weight:bold;letter-spacing:3px;">EXPERTMATCH</span>
          </td>
        </tr>
        <tr>
          <td style="padding:32px;color:#1e293b;font-size:14px;line-height:1.7;">
            <p style="margin:0 0 16px;">Hi ${escapeHtml(greeting)},</p>
            <p style="margin:0 0 24px;">
              Choose a new password here — the link expires in one hour and can be used once:
            </p>
            <table cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
              <tr>
                <td style="background:#0B1F3B;padding:0;">
                  <a href="${escapeHtml(resetUrl)}"
                     style="display:inline-block;padding:12px 28px;color:#C6A75E;font-size:13px;font-weight:bold;text-decoration:none;letter-spacing:0.5px;">
                    Reset Password →
                  </a>
                </td>
              </tr>
            </table>
            <p style="margin:0 0 16px;font-size:12px;color:#94a3b8;word-break:break-all;">
              ${escapeHtml(resetUrl)}
            </p>
            <p style="margin:0;font-size:12px;color:#94a3b8;">
              If you did not ask for this, ignore this email — your password stays as it is.
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 32px;border-top:1px solid #e2e8f0;">
            <p style="margin:0;font-size:11px;color:#94a3b8;">Sent via ExpertMatch</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = [
    `Hi ${greeting},`,
    '',
    'Choose a new password here — the link expires in one hour and can be used once:',
    resetUrl,
    '',
    'If you did not ask for this, ignore this email — your password stays as it is.',
    '',
    'Sent via ExpertMatch',
  ].join('\n');

  const { error } = await resend.emails.send({
    from:    getFromAddress(),
    to:      email,
    subject: 'Reset your ExpertMatch password',
    html,
    text,
  });
  if (error) throw new Error('[passwordReset] Resend rejected the message');
}

// ─── Request a reset ──────────────────────────────────────────────────────────

export interface PasswordResetResult {
  ok: true;
}

const OK: PasswordResetResult = { ok: true };

/**
 * Mints and emails a reset link when `email` belongs to an ACTIVE account.
 * Silent no-op for unknown, pending or disabled addresses.
 *
 * ALWAYS resolves to { ok: true } — including on storage or delivery failure —
 * so nothing observable distinguishes an address with an account from one
 * without. Failures are logged without the address.
 */
export async function requestPasswordReset(email: string): Promise<PasswordResetResult> {
  const normalized = email.trim().toLowerCase().slice(0, 254);
  if (!normalized || !normalized.includes('@')) return OK;

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/$/, '');
  if (!appUrl) {
    console.error('[passwordReset] NEXT_PUBLIC_APP_URL is not configured');
    return OK;
  }

  const redis = getUpstashClient();
  if (!redis) {
    console.error('[passwordReset] token storage unavailable');
    return OK;
  }

  try {
    const user = await getUser(normalized);
    // Pending accounts still hold an unused invite; disabled accounts must go
    // through an admin. Neither gets a reset link, and neither is revealed.
    if (!user || user.status !== 'active') return OK;

    const { token, hash, expiry, kind } = generateSignupToken(
      normalized,
      user.firmName || 'ExpertMatch',
      { kind: 'reset', ...(user.orgId ? { orgId: user.orgId } : {}) },
    );

    await redis.set(tokenRedisKey(kind, hash), normalized, { ex: tokenTtlSeconds(kind, expiry) });

    const resetUrl = `${appUrl}/auth/set-password?token=${encodeURIComponent(token)}`;
    await sendPasswordResetEmail(normalized, resetUrl, user.firstName ?? '');
  } catch {
    // Storage or delivery failed. The caller still gets { ok: true }: telling
    // them otherwise would confirm the address exists.
    console.error('[passwordReset] could not issue a reset link');
  }

  return OK;
}

// ─── Route handler (shared by every public path this is mounted on) ───────────

function clientIp(request: Request): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
      ?? request.headers.get('x-real-ip')
      ?? 'unknown';
}

/**
 * POST { email } — always answers { ok: true } except when rate limited, which
 * is keyed on the submitted address and so reveals nothing about it.
 */
export async function handlePasswordResetRequest(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: 'invalid_json', message: 'We could not read that request. Please try again.' },
      { status: 400 },
    );
  }

  const b     = (body ?? {}) as Record<string, unknown>;
  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase().slice(0, 254) : '';

  // An unusable address is answered exactly like a usable one.
  if (!email || !email.includes('@')) return Response.json({ ok: true });

  if (await isResetRateLimited(clientIp(request), email)) {
    return Response.json(
      { error: 'rate_limited', message: 'That is a few too many attempts. Please try again a little later.' },
      { status: 429, headers: { 'Retry-After': String(RATE_WINDOW_MS / 1000) } },
    );
  }

  await requestPasswordReset(email);
  return Response.json({ ok: true });
}
