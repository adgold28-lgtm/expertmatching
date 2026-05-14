'use client';

// Expert-facing availability submission form.
// Three options:
//   1. Google Calendar — navigates to OAuth flow
//   2. Calendly URL — paste a link, then "Use This Link"
//   3. Manual — free-text textarea
//
// `calendarProvider` prop shows a connected-state banner when the expert has
// already linked a calendar (e.g. after returning from OAuth).
//
// Submits to POST /api/availability/[token] for Calendly and Manual.
// Google redirects the browser to GET /api/availability/[token]/google-auth.

import { useState } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

type Option = 'google' | 'calendly' | 'manual';

interface Props {
  token:            string;
  expertId:         string | null;   // null for client tokens
  projectId:        string;
  calendarProvider?: 'google' | 'calendly' | 'manual';  // already connected?
}

// ─── Validation helpers ───────────────────────────────────────────────────────

const CALENDLY_RE = /^https:\/\/calendly\.com\//i;

function isValidCalendlyUrl(url: string): boolean {
  if (!CALENDLY_RE.test(url.trim())) return false;
  try {
    const u = new URL(url.trim());
    return u.hostname === 'calendly.com' && u.pathname.length > 1;
  } catch {
    return false;
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function AvailabilityForm({
  token,
  calendarProvider,
}: Props) {
  const [option,      setOption]      = useState<Option>('manual');
  const [calendlyUrl, setCalendlyUrl] = useState('');
  const [manualText,  setManualText]  = useState('');
  const [submitting,  setSubmitting]  = useState(false);
  const [submitted,   setSubmitted]   = useState(false);
  const [error,       setError]       = useState('');

  // ── Already connected via Google ───────────────────────────────────────────

  if (calendarProvider === 'google') {
    return (
      <div className="text-center py-4">
        <div className="w-10 h-10 rounded-full bg-green-50 border border-green-200 flex items-center justify-center mx-auto mb-4">
          <span className="text-green-700 text-lg">✓</span>
        </div>
        <h2 className="text-base font-semibold text-[#0f172a] mb-2">Google Calendar connected</h2>
        <p className="text-sm text-[#64748b]">
          Your availability has been submitted. Our team will be in touch shortly.
        </p>
      </div>
    );
  }

  // ── Calendly submit handler ────────────────────────────────────────────────

  async function handleCalendlySubmit() {
    if (!isValidCalendlyUrl(calendlyUrl)) {
      setError('Please enter a valid Calendly link (https://calendly.com/...)');
      return;
    }
    setError('');
    setSubmitting(true);
    try {
      const res  = await fetch(`/api/availability/${encodeURIComponent(token)}`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ provider: 'calendly', calendlyUrl: calendlyUrl.trim() }),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok) {
        if (res.status === 410) {
          setError('This link has expired. Please ask for a new one.');
        } else if (res.status === 409) {
          setSubmitted(true);
        } else {
          setError(data.error ?? 'Something went wrong. Please try again.');
        }
        return;
      }
      setSubmitted(true);
    } catch {
      setError('Network error. Please check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  }

  // ── Manual submit handler ──────────────────────────────────────────────────

  async function handleManualSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (manualText.trim().length < 10) {
      setError('Please describe at least one available window.');
      return;
    }
    setError('');
    setSubmitting(true);
    try {
      const res  = await fetch(`/api/availability/${encodeURIComponent(token)}`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ provider: 'manual', manualText: manualText.trim() }),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok) {
        if (res.status === 410) {
          setError('This link has expired. Please ask for a new one.');
        } else if (res.status === 409) {
          setSubmitted(true);
        } else {
          setError(data.error ?? 'Something went wrong. Please try again.');
        }
        return;
      }
      setSubmitted(true);
    } catch {
      setError('Network error. Please check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  }

  // ── Google OAuth redirect ──────────────────────────────────────────────────

  function handleGoogleConnect() {
    window.location.href = `/api/availability/${encodeURIComponent(token)}/google-auth`;
  }

  // ── Success state ──────────────────────────────────────────────────────────

  if (submitted) {
    return (
      <div className="text-center py-4">
        <div className="w-10 h-10 rounded-full bg-green-50 border border-green-200 flex items-center justify-center mx-auto mb-4">
          <span className="text-green-700 text-lg">✓</span>
        </div>
        <h2 className="text-base font-semibold text-[#0f172a] mb-2">Got it — thank you!</h2>
        <p className="text-sm text-[#64748b]">
          Our team will review your availability and send a calendar invite shortly.
        </p>
      </div>
    );
  }

  // ── Form ───────────────────────────────────────────────────────────────────

  const isGoogle   = option === 'google';
  const isCalendly = option === 'calendly';
  const isManual   = option === 'manual';

  return (
    <div className="space-y-6">

      {/* ── Option selector ── */}
      <div>
        <p className="text-[9px] uppercase tracking-widest text-[#94a3b8] font-medium mb-3"
           style={{ letterSpacing: '0.18em' }}>
          How would you like to share your availability?
        </p>
        <div className="flex flex-col gap-2">

          {/* Google Calendar */}
          <label className={`flex items-center gap-3 px-4 py-3 border cursor-pointer transition-colors ${
            isGoogle
              ? 'border-[#0d9488] bg-[#f0fdfa]'
              : 'border-[#e2e8f0] bg-white hover:border-[#0f172a]'
          }`}>
            <input
              type="radio"
              name="avail-option"
              value="google"
              checked={isGoogle}
              onChange={() => setOption('google')}
              className="accent-[#0d9488]"
            />
            <div>
              <span className="text-sm text-[#1e293b] font-medium">Google Calendar</span>
              <span className="ml-2 text-[11px] text-[#64748b]">Connect and share free/busy</span>
            </div>
          </label>

          {/* Calendly */}
          <label className={`flex items-center gap-3 px-4 py-3 border cursor-pointer transition-colors ${
            isCalendly
              ? 'border-[#0d9488] bg-[#f0fdfa]'
              : 'border-[#e2e8f0] bg-white hover:border-[#0f172a]'
          }`}>
            <input
              type="radio"
              name="avail-option"
              value="calendly"
              checked={isCalendly}
              onChange={() => setOption('calendly')}
              className="accent-[#0d9488]"
            />
            <div>
              <span className="text-sm text-[#1e293b] font-medium">Calendly</span>
              <span className="ml-2 text-[11px] text-[#64748b]">Paste your scheduling link</span>
            </div>
          </label>

          {/* Manual */}
          <label className={`flex items-center gap-3 px-4 py-3 border cursor-pointer transition-colors ${
            isManual
              ? 'border-[#0d9488] bg-[#f0fdfa]'
              : 'border-[#e2e8f0] bg-white hover:border-[#0f172a]'
          }`}>
            <input
              type="radio"
              name="avail-option"
              value="manual"
              checked={isManual}
              onChange={() => setOption('manual')}
              className="accent-[#0d9488]"
            />
            <div>
              <span className="text-sm text-[#1e293b] font-medium">Describe your availability</span>
              <span className="ml-2 text-[11px] text-[#64748b]">Type a few times that work</span>
            </div>
          </label>

        </div>
      </div>

      {/* ── Google Calendar panel ── */}
      {isGoogle && (
        <div className="space-y-3">
          <p className="text-[11px] text-[#64748b] leading-relaxed">
            We&apos;ll use Google Calendar to check your free/busy times. No events or details
            will be shared — only whether you&apos;re available.
          </p>
          <button
            type="button"
            onClick={handleGoogleConnect}
            className="w-full py-3 text-[11px] uppercase tracking-widest font-medium bg-[#0f172a] text-white hover:bg-[#1e293b] transition-colors"
            style={{ letterSpacing: '0.12em' }}
          >
            Connect Google Calendar
          </button>
        </div>
      )}

      {/* ── Calendly panel ── */}
      {isCalendly && (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <label htmlFor="calendly-url"
                   className="text-[10px] uppercase tracking-widest text-[#64748b]"
                   style={{ letterSpacing: '0.14em' }}>
              Your Calendly link
            </label>
            <input
              id="calendly-url"
              type="url"
              value={calendlyUrl}
              onChange={e => { setCalendlyUrl(e.target.value); setError(''); }}
              placeholder="https://calendly.com/your-name/30min"
              autoFocus
              className="w-full px-3 py-2 text-sm border border-[#e2e8f0] bg-white focus:outline-none focus:border-[#0f172a] text-[#1e293b] placeholder:text-[#cbd5e1]"
            />
            {calendlyUrl && !isValidCalendlyUrl(calendlyUrl) && (
              <p className="text-[10px] text-red-600">Must start with https://calendly.com/</p>
            )}
          </div>
          {error && <p className="text-[11px] text-red-600 leading-snug">{error}</p>}
          <button
            type="button"
            onClick={handleCalendlySubmit}
            disabled={submitting || !isValidCalendlyUrl(calendlyUrl)}
            className="w-full py-3 text-[11px] uppercase tracking-widest font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed bg-[#0f172a] text-white hover:bg-[#1e293b]"
            style={{ letterSpacing: '0.12em' }}
          >
            {submitting ? 'Submitting…' : 'Use This Link'}
          </button>
        </div>
      )}

      {/* ── Manual panel ── */}
      {isManual && (
        <form onSubmit={handleManualSubmit} className="space-y-3">
          <div className="space-y-1.5">
            <label htmlFor="manual-text"
                   className="text-[10px] uppercase tracking-widest text-[#64748b]"
                   style={{ letterSpacing: '0.14em' }}>
              Your availability
            </label>
            <textarea
              id="manual-text"
              value={manualText}
              onChange={e => { setManualText(e.target.value); setError(''); }}
              placeholder={`Example:\nMonday–Wednesday, 9–11 AM ET\nFriday after 2 PM ET\nAny time Thursday`}
              rows={5}
              autoFocus
              maxLength={800}
              className="w-full px-3 py-2 text-sm border border-[#e2e8f0] bg-white focus:outline-none focus:border-[#0f172a] text-[#1e293b] placeholder:text-[#cbd5e1] resize-none leading-relaxed"
            />
            <p className="text-[10px] text-[#94a3b8] text-right">{manualText.length}/800</p>
          </div>
          {error && <p className="text-[11px] text-red-600 leading-snug">{error}</p>}
          <button
            type="submit"
            disabled={submitting || manualText.trim().length < 10}
            className="w-full py-3 text-[11px] uppercase tracking-widest font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed bg-[#0f172a] text-white hover:bg-[#1e293b]"
            style={{ letterSpacing: '0.12em' }}
          >
            {submitting ? 'Submitting…' : 'Submit Availability'}
          </button>
        </form>
      )}

      {/* ── Privacy note ── */}
      <p className="text-[10px] text-[#94a3b8] leading-relaxed border-t border-[#e2e8f0] pt-4">
        Your availability is shared only with the research team coordinating this call.
        It will not be stored beyond scheduling purposes.
      </p>

    </div>
  );
}
