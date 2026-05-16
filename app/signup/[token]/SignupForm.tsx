'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function SignupForm({
  token,
  email,
  firmName,
}: {
  token:    string;
  email:    string;
  firmName: string;
}) {
  const [password,  setPassword]  = useState('');
  const [confirm,   setConfirm]   = useState('');
  const [error,     setError]     = useState<string | null>(null);
  const [loading,   setLoading]   = useState(false);
  const router = useRouter();

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
      const res = await fetch(`/api/signup/${token}`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ password }),
      });

      const data = await res.json();

      if (res.ok) {
        router.push('/app');
        router.refresh();
        return;
      }

      // Seat limit hit after form submission
      if (data.error === 'seat_limit_reached') {
        setError("Your firm's account is full. Reach out to your account admin to add more seats.");
      } else if (data.error === 'invite_used') {
        setError('This invite link has already been used.');
      } else if (data.error === 'invite_expired') {
        setError('This invite link has expired.');
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
            Create Your Account
          </p>
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
                placeholder="Min. 8 chars, at least one number"
                disabled={loading}
              />
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
              {loading ? 'Creating account…' : 'Create Account'}
            </button>
          </form>
        </div>

      </div>
    </div>
  );
}
