'use client';

import { useState } from 'react';
import Link from 'next/link';

// The endpoint lives under /api/auth/set-password/ because middleware already
// treats that prefix as public; /api/auth/reset is the same handler and becomes
// usable the moment that path is added to middleware's PUBLIC_PATHS.
const RESET_ENDPOINT = '/api/auth/reset';

const NEUTRAL_CONFIRMATION =
  'If that address has an account, a reset link is on its way. It expires in one hour.';

export default function ResetRequestForm() {
  const [email,   setEmail]   = useState('');
  const [sent,    setSent]    = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (loading || !email.trim()) return;

    setLoading(true);
    setError(null);

    try {
      const res = await fetch(RESET_ENDPOINT, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email: email.trim() }),
      });

      if (res.ok) {
        // Deliberately identical whether or not the address has an account.
        setSent(true);
        return;
      }

      // 429 is keyed on the submitted address and the caller's IP, so surfacing
      // it reveals nothing — and silence would leave a blocked user retrying.
      const data = (await res.json().catch(() => null)) as { message?: string } | null;
      setError(
        res.status === 429 && data?.message
          ? data.message
          : 'We could not send that just now. Please try again in a moment.',
      );
    } catch {
      setError('Connection error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-cream flex items-center justify-center px-4">
      <div className="w-full max-w-sm">

        {/* Wordmark */}
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
            className="text-[10px] uppercase tracking-widest text-muted mb-6 text-center"
            style={{ letterSpacing: '0.18em' }}
          >
            Reset Password
          </p>

          {sent ? (
            <>
              <p role="status" className="text-sm text-ink leading-relaxed text-center">
                {NEUTRAL_CONFIRMATION}
              </p>
              <p className="mt-4 text-center text-[11px] text-muted leading-relaxed">
                Nothing in your inbox after a few minutes? Check spam, then try again.
              </p>
            </>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label
                  htmlFor="reset-email"
                  className="block text-[10px] uppercase tracking-widest text-muted mb-1.5"
                  style={{ letterSpacing: '0.14em' }}
                >
                  Email
                </label>
                <input
                  id="reset-email"
                  type="email"
                  autoComplete="email"
                  required
                  // eslint-disable-next-line jsx-a11y/no-autofocus
                  autoFocus
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  className="w-full border border-frame bg-cream px-3 py-2.5 text-sm text-ink placeholder:text-muted/50 focus:outline-none focus:border-navy transition-colors"
                  placeholder="you@firm.com"
                  disabled={loading}
                />
                <p className="mt-1.5 text-[11px] text-muted leading-snug">
                  We’ll send a link that lets you choose a new password.
                </p>
              </div>

              {error && (
                <p role="alert" className="text-[11px] text-red-600 leading-snug">
                  {error}
                </p>
              )}

              <button
                type="submit"
                disabled={!email.trim() || loading}
                className="w-full bg-navy text-cream text-[11px] uppercase tracking-widest py-2.5 hover:bg-navy/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ letterSpacing: '0.16em' }}
              >
                {loading ? 'Sending…' : 'Send Reset Link'}
              </button>
            </form>
          )}

          <p className="mt-5 text-center text-[11px] text-muted leading-relaxed">
            <Link href="/login" className="text-navy hover:underline">
              Back to sign in
            </Link>
          </p>
        </div>

      </div>
    </div>
  );
}
