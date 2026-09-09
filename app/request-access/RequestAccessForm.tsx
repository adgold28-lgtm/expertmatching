'use client';

// The public "Request Access" form. It creates NO account and grants nothing:
// it posts to /api/request-access, which files an access_requests row
// (kind='access') and emails the platform admins. A human approves from
// /admin/requests, and only that approval calls provisionAccountInvite.
//
// Auto-approval by email domain used to exist and was removed — see the comment
// in app/api/request-access/route.ts. Do not reintroduce a client-side hint
// about whether a firm is known: the API answers identically for every address
// precisely so this form cannot be used to enumerate customers.
//
// firmType / firmSize feed the anonymized phrase Matchy uses to describe the
// client to an expert ("a mid-size PE firm"), so they are optional here rather
// than required — an unanswered question falls back to generic wording instead
// of blocking the request.

import { useState } from 'react';
import Link from 'next/link';

const GOLD = '#C6A75E';
const NAVY = '#0B1F3B';

export default function RequestAccessForm() {
  const [name,    setName]    = useState('');
  const [firm,    setFirm]    = useState('');
  const [email,   setEmail]   = useState('');
  const [useCase, setUseCase] = useState('');
  const [firmType, setFirmType] = useState('');
  const [firmSize, setFirmSize] = useState('');
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
        body: JSON.stringify({
          name:    name.trim(),
          firm:    firm.trim(),
          email:   email.trim(),
          useCase: useCase.trim(),
          firmType,
          firmSize,
        }),
      });
      const data = (await res.json()) as { ok?: boolean; message?: string };
      if (!res.ok || !data.ok) {
        // The API returns { error: <machine code>, message: <human copy> }.
        // Only `message` is ever shown — never the raw code.
        throw new Error(data.message ?? 'Something went wrong. Please try again.');
      }
      setSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex-1 flex items-start justify-center pt-16 pb-24 px-6">
      <div className="w-full max-w-md">

        {success ? (
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

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label
                    htmlFor="firmType"
                    className="block text-[10px] uppercase tracking-widest text-muted font-medium mb-1.5"
                    style={{ letterSpacing: '0.18em' }}
                  >
                    Firm Type
                  </label>
                  <select
                    id="firmType"
                    value={firmType}
                    onChange={e => setFirmType(e.target.value)}
                    className="w-full px-3.5 py-2.5 text-sm text-ink border border-frame bg-cream focus:outline-none focus:border-navy transition-colors"
                    style={{ fontFamily: 'var(--font-libre-franklin)', fontWeight: 300 }}
                  >
                    <option value="">Select</option>
                    <option value="family_office">Family office</option>
                    <option value="pe_firm">PE firm</option>
                    <option value="consulting_firm">Consulting firm</option>
                    <option value="law_firm">Law firm</option>
                    <option value="hedge_fund">Hedge fund</option>
                    <option value="corporate">Corporate</option>
                    <option value="other">Other</option>
                  </select>
                </div>

                <div>
                  <label
                    htmlFor="firmSize"
                    className="block text-[10px] uppercase tracking-widest text-muted font-medium mb-1.5"
                    style={{ letterSpacing: '0.18em' }}
                  >
                    Firm Size
                  </label>
                  <select
                    id="firmSize"
                    value={firmSize}
                    onChange={e => setFirmSize(e.target.value)}
                    className="w-full px-3.5 py-2.5 text-sm text-ink border border-frame bg-cream focus:outline-none focus:border-navy transition-colors"
                    style={{ fontFamily: 'var(--font-libre-franklin)', fontWeight: 300 }}
                  >
                    <option value="">Select</option>
                    <option value="boutique">Boutique</option>
                    <option value="mid_size">Mid-size</option>
                    <option value="large">Large</option>
                  </select>
                </div>
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
                style={{ background: NAVY, color: GOLD, letterSpacing: '0.14em' }}
              >
                {loading ? 'Submitting…' : 'Submit Request'}
              </button>

            </form>

            <p className="mt-4 text-center text-[11px] text-muted leading-relaxed" style={{ fontWeight: 300 }}>
              We&apos;ll only use this to contact you about access. See our{' '}
              <Link href="/privacy" className="text-navy hover:underline" style={{ fontWeight: 400 }}>
                Privacy Policy
              </Link>
              .
            </p>

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
  );
}
