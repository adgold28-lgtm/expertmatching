'use client';

import { useState } from 'react';
import Link from 'next/link';

const GOLD = '#C6A75E';
const NAVY = '#0B1F3B';

export default function RequestAccessPage() {
  const [name,    setName]    = useState('');
  const [firm,    setFirm]    = useState('');
  const [email,   setEmail]   = useState('');
  const [useCase, setUseCase] = useState('');
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');
  const [success, setSuccess] = useState(false);

  const firstName = name.trim().split(' ')[0] ?? name.trim();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/request-access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), firm: firm.trim(), email: email.trim(), useCase: useCase.trim() }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? 'Something went wrong. Please try again.');
      }
      setSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col font-body" style={{ background: '#F7F9FC' }}>

      {/* Nav */}
      <header style={{ background: NAVY, borderBottom: `2px solid ${GOLD}` }}>
        <div className="max-w-6xl mx-auto px-6 sm:px-10 py-4 flex items-center justify-between">
          <Link
            href="/"
            className="font-display text-cream font-semibold"
            style={{ letterSpacing: '0.15em', fontSize: '13px' }}
          >
            EXPERTMATCH
          </Link>
          <nav className="flex items-center gap-6">
            <Link
              href="/pricing"
              className="text-[11px] uppercase text-cream/60 hover:text-cream transition-colors hidden sm:block"
              style={{ letterSpacing: '0.14em' }}
            >
              Pricing
            </Link>
            <Link
              href="/login"
              className="text-[11px] uppercase border px-4 py-2 transition-colors"
              style={{ letterSpacing: '0.14em', color: GOLD, borderColor: `${GOLD}40` }}
            >
              Log In
            </Link>
          </nav>
        </div>
      </header>

      {/* Content */}
      <main className="flex-1 flex items-start justify-center pt-16 pb-24 px-6">
        <div className="w-full max-w-md">

          {success ? (
            /* ── Success state ── */
            <div className="text-center py-8">
              <div
                className="w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-6"
                style={{ background: `${GOLD}18`, border: `1px solid ${GOLD}40` }}
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} style={{ color: GOLD }}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <h1
                className="font-display text-navy mb-3"
                style={{ fontSize: 'clamp(1.6rem, 3vw, 2.2rem)', fontWeight: 500 }}
              >
                Thanks, {firstName}.
              </h1>
              <p className="text-muted text-sm leading-relaxed" style={{ fontWeight: 300 }}>
                We received your request and will be in touch within one business day.
              </p>
              <Link
                href="/"
                className="inline-block mt-8 text-[11px] uppercase text-muted hover:text-navy transition-colors"
                style={{ letterSpacing: '0.12em' }}
              >
                ← Back to home
              </Link>
            </div>
          ) : (
            /* ── Form ── */
            <>
              <div className="mb-8">
                <p
                  className="text-[10px] uppercase font-medium mb-3"
                  style={{ color: GOLD, letterSpacing: '0.22em' }}
                >
                  Early Access
                </p>
                <h1
                  className="font-display text-navy mb-3"
                  style={{ fontSize: 'clamp(1.6rem, 3.5vw, 2.2rem)', fontWeight: 500 }}
                >
                  Request Access
                </h1>
                <p className="text-muted text-sm leading-relaxed" style={{ fontWeight: 300 }}>
                  Tell us a bit about your team and we'll follow up within one business day.
                </p>
              </div>

              <form onSubmit={handleSubmit} className="space-y-4">

                <div>
                  <label
                    htmlFor="name"
                    className="block text-[10px] uppercase tracking-widest text-muted font-medium mb-1.5"
                    style={{ letterSpacing: '0.18em' }}
                  >
                    Your Name <span className="text-red-400">*</span>
                  </label>
                  <input
                    id="name"
                    type="text"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    required
                    placeholder="Jane Smith"
                    className="w-full px-3.5 py-2.5 text-sm text-ink border border-frame bg-cream focus:outline-none focus:border-navy transition-colors placeholder-[#9AABB8]"
                    style={{ fontFamily: 'var(--font-libre-franklin)', fontWeight: 300 }}
                  />
                </div>

                <div>
                  <label
                    htmlFor="firm"
                    className="block text-[10px] uppercase tracking-widest text-muted font-medium mb-1.5"
                    style={{ letterSpacing: '0.18em' }}
                  >
                    Firm Name <span className="text-red-400">*</span>
                  </label>
                  <input
                    id="firm"
                    type="text"
                    value={firm}
                    onChange={e => setFirm(e.target.value)}
                    required
                    placeholder="Acme Capital"
                    className="w-full px-3.5 py-2.5 text-sm text-ink border border-frame bg-cream focus:outline-none focus:border-navy transition-colors placeholder-[#9AABB8]"
                    style={{ fontFamily: 'var(--font-libre-franklin)', fontWeight: 300 }}
                  />
                </div>

                <div>
                  <label
                    htmlFor="email"
                    className="block text-[10px] uppercase tracking-widest text-muted font-medium mb-1.5"
                    style={{ letterSpacing: '0.18em' }}
                  >
                    Work Email <span className="text-red-400">*</span>
                  </label>
                  <input
                    id="email"
                    type="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    required
                    placeholder="jane@acmecapital.com"
                    className="w-full px-3.5 py-2.5 text-sm text-ink border border-frame bg-cream focus:outline-none focus:border-navy transition-colors placeholder-[#9AABB8]"
                    style={{ fontFamily: 'var(--font-libre-franklin)', fontWeight: 300 }}
                  />
                </div>

                <div>
                  <label
                    htmlFor="useCase"
                    className="block text-[10px] uppercase tracking-widest text-muted font-medium mb-1.5"
                    style={{ letterSpacing: '0.18em' }}
                  >
                    What are you researching? <span className="text-red-400">*</span>
                  </label>
                  <textarea
                    id="useCase"
                    value={useCase}
                    onChange={e => setUseCase(e.target.value)}
                    required
                    placeholder="e.g. Supply chain dynamics in industrial automation; competitive landscape for a potential portfolio company."
                    rows={4}
                    className="w-full px-3.5 py-2.5 text-sm text-ink border border-frame bg-cream resize-none focus:outline-none focus:border-navy transition-colors placeholder-[#9AABB8]"
                    style={{ fontFamily: 'var(--font-libre-franklin)', fontWeight: 300 }}
                  />
                </div>

                {error && (
                  <p className="text-xs text-red-600 border border-red-200 bg-red-50 px-3 py-2">
                    {error}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={loading || !name.trim() || !firm.trim() || !email.trim() || !useCase.trim()}
                  className="w-full py-3 text-[11px] font-medium uppercase transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{
                    background: NAVY,
                    color: GOLD,
                    letterSpacing: '0.14em',
                  }}
                >
                  {loading ? 'Submitting…' : 'Submit Request'}
                </button>

              </form>

              <p className="mt-5 text-center text-[11px] text-muted" style={{ fontWeight: 300 }}>
                Already have an account?{' '}
                <Link href="/login" className="text-navy hover:underline" style={{ fontWeight: 400 }}>
                  Log in
                </Link>
              </p>
            </>
          )}
        </div>
      </main>

    </div>
  );
}
