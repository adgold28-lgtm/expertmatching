'use client';

import { useState, useRef } from 'react';
import { useRouter } from 'next/navigation';

export default function LoginPage() {
  const [password, setPassword] = useState('');
  const [error,    setError]    = useState<string | null>(null);
  const [loading,  setLoading]  = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const router   = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!password || loading) return;

    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/auth/login', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ password }),
      });

      if (res.ok) {
        const params = new URLSearchParams(window.location.search);
        const rawNext = params.get('next') ?? '/app';
        // Validate redirect target — only allow internal paths (start with '/' but not '//').
        // '//evil.com' and 'https://evil.com' are rejected; only '/dashboard' etc. are accepted.
        const next = rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/';
        router.push(next);
        router.refresh();
      } else {
        setError('Incorrect password. Please try again.');
        setPassword('');
        inputRef.current?.focus();
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
                ref={inputRef}
                id="password"
                type="password"
                autoComplete="current-password"
                required
                // eslint-disable-next-line jsx-a11y/no-autofocus
                autoFocus
                value={password}
                onChange={e => setPassword(e.target.value)}
                className="w-full border border-frame bg-cream px-3 py-2.5 text-sm text-ink placeholder:text-muted/50 focus:outline-none focus:border-navy transition-colors"
                placeholder="Enter your access password"
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
        </div>

      </div>
    </div>
  );
}
