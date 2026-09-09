'use client';

// /login — the only sign-in surface. Public; middleware.ts bounces an already
// authenticated, fully-onboarded visitor straight to /app, so this page is only
// ever rendered for someone without a usable session.
//
// Posts to /api/auth/login, which sets the Supabase session cookies on the
// response. On success the router push is followed by router.refresh() so the
// Server Components re-render with the new cookies rather than the signed-out
// cache. Password recovery lives at /auth/reset; there is no self-registration
// (access is invite-only — see /request-access).
//
// Copy discipline: the failure branch never distinguishes "no such account"
// from "wrong password"; only 429 and 403 messages are surfaced verbatim.

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

export default function LoginPage() {
  const [email,    setEmail]    = useState('');
  const [password, setPassword] = useState('');
  const [error,    setError]    = useState<string | null>(null);
  const [loading,  setLoading]  = useState(false);
  const [ready,    setReady]    = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const router   = useRouter();

  // ?ready=1 is set by the set-password flow when the password was saved but the
  // automatic sign-in did not take. Read on mount rather than during render so
  // the server and client markup match; only the exact value '1' counts.
  useEffect(() => {
    const value = new URLSearchParams(window.location.search).get('ready');
    setReady(value === '1');
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!password || loading) return;

    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/auth/login', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email: email.trim(), password }),
      });

      if (res.ok) {
        const params = new URLSearchParams(window.location.search);
        const rawNext = params.get('next') ?? '/app';
        // Only allow internal paths — reject '//evil.com' and absolute URLs.
        const next = rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/app';
        router.push(next);
        router.refresh();
      } else {
        // 401 always shows the generic line so the form never confirms whether
        // an address has an account. 429 and 403 are safe to surface verbatim
        // and are useless without them — a rate-limited user would otherwise be
        // told their password is wrong (COPY_AUDIT 4.10 / 4.11).
        let message = 'Incorrect credentials. Please try again.';
        if (res.status === 429 || res.status === 403) {
          const data = (await res.json().catch(() => null)) as { message?: string } | null;
          if (typeof data?.message === 'string' && data.message) message = data.message;
        }
        setError(message);
        setPassword('');
        emailRef.current?.focus();
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
            Private Access
          </p>

          {ready && (
            <p
              role="status"
              className="mb-5 border border-frame bg-cream px-3 py-2.5 text-[11px] text-navy leading-relaxed"
            >
              Your account is ready — sign in.
            </p>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label
                htmlFor="email"
                className="block text-[10px] uppercase tracking-widest text-muted mb-1.5"
                style={{ letterSpacing: '0.14em' }}
              >
                Email
              </label>
              <input
                ref={emailRef}
                id="email"
                type="email"
                autoComplete="email"
                // eslint-disable-next-line jsx-a11y/no-autofocus
                autoFocus
                value={email}
                onChange={e => setEmail(e.target.value)}
                className="w-full border border-frame bg-cream px-3 py-2.5 text-sm text-ink placeholder:text-muted/50 focus:outline-none focus:border-navy transition-colors"
                placeholder="you@firm.com"
                disabled={loading}
              />
            </div>

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
                autoComplete="current-password"
                required
                value={password}
                onChange={e => setPassword(e.target.value)}
                className="w-full border border-frame bg-cream px-3 py-2.5 text-sm text-ink placeholder:text-muted/50 focus:outline-none focus:border-navy transition-colors"
                placeholder="Enter your password"
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
              disabled={!password || loading}
              className="w-full bg-navy text-cream text-[11px] uppercase tracking-widest py-2.5 hover:bg-navy/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ letterSpacing: '0.16em' }}
            >
              {loading ? 'Signing in…' : 'Sign In'}
            </button>
          </form>

          <p className="mt-5 text-center text-[11px] text-muted leading-relaxed">
            <Link href="/auth/reset" className="text-navy hover:underline">
              Forgot your password?
            </Link>
          </p>
        </div>

      </div>
    </div>
  );
}
