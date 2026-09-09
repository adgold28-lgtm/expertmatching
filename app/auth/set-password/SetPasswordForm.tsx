'use client';

// The password form for BOTH halves of account entry: accepting an invitation
// ('invite' — creates the account and then starts onboarding) and recovering a
// forgotten password ('reset' — changes nothing but the password). The parent
// server component (page.tsx) has already verified the HMAC token's signature
// and expiry; this component holds the two token halves and posts them back.
//
// Submitting SPENDS the link: /api/auth/set-password redeems the Supabase
// recovery token, which Supabase burns. That is why every failure branch below
// tells the user to request a NEW link rather than to retry this one — and why
// the form must not be resubmitted after a success.
//
// `signedIn: false` means the password was saved but the automatic sign-in did
// not take. The hard redirect to /login?ready=1 (not router.push) is
// deliberate: without session cookies, pushing to a guarded route would bounce
// the user straight back out.

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function SetPasswordForm({
  token,
  hashedToken,
  email,
  firmName,
  firstName,
  kind = 'invite',
}: {
  token:      string;
  /** Supabase's single-use recovery token hash — redeemed on submit. */
  hashedToken: string;
  email:      string;
  firmName:   string;
  firstName?: string;
  /** 'invite' creates the account; 'reset' only replaces the password. */
  kind?:      'invite' | 'reset';
}) {
  const [password,  setPassword]  = useState('');
  const [confirm,   setConfirm]   = useState('');
  const [error,     setError]     = useState<string | null>(null);
  const [loading,   setLoading]   = useState(false);
  const router = useRouter();

  const isReset = kind === 'reset';

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;

    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await fetch(
        `/api/auth/set-password?token=${encodeURIComponent(token)}&th=${encodeURIComponent(hashedToken)}`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ password, confirmPassword: confirm }),
      });

      const data = await res.json() as { ok?: boolean; signedIn?: boolean; error?: string; message?: string };

      if (res.ok) {
        // The password is set either way. When the automatic sign-in did not
        // take, send them to /login rather than into a guarded page they would
        // just be bounced out of.
        if (data.signedIn === false) {
          window.location.href = '/login?ready=1';
          return;
        }
        router.push(isReset ? '/app' : '/onboarding');
        router.refresh();
        return;
      }

      if (data.error === 'seat_limit_reached') {
        setError("Your firm has no free seat right now. Ask your account admin to add one — seats are billed monthly and can be added at any time. Your link stays valid.");
      } else if (data.error === 'temporarily_unavailable') {
        setError('We couldn’t check your invitation just now — try again in a minute.');
      } else if (data.error === 'reset_used' || data.error === 'reset_invalid') {
        setError('This reset link is no longer valid. Request a new one from the sign-in page.');
      } else if (data.error === 'invite_used') {
        setError('This invite link has already been used.');
      } else if (data.error === 'invite_expired' || data.error === 'reset_expired') {
        setError('This link has expired. Request a new one to continue.');
      } else if (data.error === 'invite_invalid') {
        setError('This link is invalid or has already been used.');
      } else {
        setError(data.message ?? 'Something went wrong. Please try again.');
      }
    } catch {
      setError('Connection error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-cream flex items-center justify-center px-4">
      <div className="w-full max-w-sm">

        <div className="text-center mb-10">
          <p
            className="text-[11px] uppercase tracking-widest text-navy font-medium mb-2"
            style={{ letterSpacing: '0.22em' }}
          >
            ExpertMatch
          </p>
          <div className="w-8 h-px bg-gold mx-auto" />
        </div>

        <div className="bg-white border border-frame p-8 shadow-sm">
          <p
            className="text-[10px] uppercase tracking-widest text-muted mb-1 text-center"
            style={{ letterSpacing: '0.18em' }}
          >
            {isReset ? 'Choose a New Password' : 'Create Your Account'}
          </p>
          {firstName && (
            <p className="text-sm font-semibold text-navy text-center mb-1">
              {isReset ? `Hi, ${firstName}` : `Welcome, ${firstName}`}
            </p>
          )}
          <p className="text-xs text-muted text-center mb-6" style={{ fontWeight: 300 }}>
            {firmName}
          </p>

          <div className="mb-5 px-3 py-2.5 bg-cream border border-frame">
            <p className="text-[10px] uppercase tracking-widest text-muted mb-0.5" style={{ letterSpacing: '0.12em' }}>
              Email
            </p>
            <p className="text-xs text-navy">{email}</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label
                htmlFor="password"
                className="block text-[10px] uppercase tracking-widest text-muted mb-1.5"
                style={{ letterSpacing: '0.14em' }}
              >
                Password
              </label>
              <input
                id="password"
                type="password"
                autoComplete="new-password"
                required
                // eslint-disable-next-line jsx-a11y/no-autofocus
                autoFocus
                value={password}
                onChange={e => setPassword(e.target.value)}
                className="w-full border border-frame bg-cream px-3 py-2.5 text-sm text-ink placeholder:text-muted/50 focus:outline-none focus:border-navy transition-colors"
                placeholder={isReset ? 'Choose a new password' : 'Choose a password'}
                aria-describedby="password-rule"
                disabled={loading}
              />
              <p id="password-rule" className="mt-1.5 text-[11px] text-muted leading-snug">
                At least 8 characters, including one number.
              </p>
            </div>

            <div>
              <label
                htmlFor="confirm"
                className="block text-[10px] uppercase tracking-widest text-muted mb-1.5"
                style={{ letterSpacing: '0.14em' }}
              >
                Confirm Password
              </label>
              <input
                id="confirm"
                type="password"
                autoComplete="new-password"
                required
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
                className="w-full border border-frame bg-cream px-3 py-2.5 text-sm text-ink placeholder:text-muted/50 focus:outline-none focus:border-navy transition-colors"
                placeholder="Repeat password"
                disabled={loading}
              />
            </div>

            {error && (
              <p role="alert" className="text-[11px] text-red-600 leading-snug">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={!password || !confirm || loading}
              className="w-full bg-navy text-cream text-[11px] uppercase tracking-widest py-2.5 hover:bg-navy/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ letterSpacing: '0.16em' }}
            >
              {loading
                ? (isReset ? 'Saving…' : 'Creating account…')
                : (isReset ? 'Save Password' : 'Create Account')}
            </button>
          </form>
        </div>

      </div>
    </div>
  );
}
