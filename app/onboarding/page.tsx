'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';

const GOLD = '#C6A75E';
const NAVY = '#0B1F3B';

// ─── Step 1: Calendar ──────────────────────────────────────────────────────────

function CalendarStep({ onComplete }: { onComplete: () => void }) {
  const [connecting, setConnecting] = useState<'google' | 'outlook' | null>(null);
  const [connected,  setConnected]  = useState<'google' | 'outlook' | null>(null);
  const [error,      setError]      = useState<string | null>(null);

  // TODO(calendar-integration): Replace stub with real OAuth redirect flow.
  // Requirements:
  //   - GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI for Google
  //   - OUTLOOK_CLIENT_ID, OUTLOOK_CLIENT_SECRET, OUTLOOK_REDIRECT_URI for Microsoft
  // Real flow: redirect to /api/onboarding/calendar/connect?provider=google,
  //   handle callback at /api/onboarding/calendar/callback, store refresh token
  //   on user record, then mark this step complete.
  async function handleConnect(provider: 'google' | 'outlook') {
    setConnecting(provider);
    setError(null);
    try {
      const res  = await fetch('/api/onboarding/calendar', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ provider }),
      });
      const data = await res.json() as { ok?: boolean };
      if (res.ok && data.ok) {
        setConnected(provider);
      } else {
        setError('Could not connect. Please try again.');
      }
    } catch {
      setError('Connection error. Please try again.');
    } finally {
      setConnecting(null);
    }
  }

  return (
    <div>
      <h2 className="font-display mb-2" style={{ color: NAVY, fontSize: '1.25rem', fontWeight: 500 }}>
        Connect Your Calendar
      </h2>
      <p className="mb-8 leading-relaxed" style={{ color: '#5A6B7A', fontSize: '14px', fontWeight: 300 }}>
        So ExpertMatch can find your availability and schedule expert calls automatically.
      </p>

      {connected ? (
        <div className="flex items-center gap-3 p-4 border mb-6" style={{ borderColor: GOLD, background: 'rgba(198,167,94,0.06)' }}>
          <span style={{ color: GOLD }}>✓</span>
          <span className="text-sm font-medium text-navy capitalize">{connected} Calendar connected</span>
        </div>
      ) : (
        <div className="space-y-3 mb-6">
          <button
            onClick={() => handleConnect('google')}
            disabled={!!connecting}
            className="w-full px-5 py-3.5 text-[11px] uppercase font-medium transition-colors disabled:opacity-50"
            style={{ background: NAVY, color: '#FFFFFF', letterSpacing: '0.12em' }}
          >
            {connecting === 'google' ? 'Connecting…' : 'Connect Google Calendar'}
          </button>
          <button
            onClick={() => handleConnect('outlook')}
            disabled={!!connecting}
            className="w-full px-5 py-3.5 text-[11px] uppercase font-medium border transition-colors disabled:opacity-50"
            style={{ color: NAVY, borderColor: `${NAVY}30`, letterSpacing: '0.12em' }}
          >
            {connecting === 'outlook' ? 'Connecting…' : 'Connect Outlook'}
          </button>
        </div>
      )}

      {error && <p role="alert" className="text-xs text-red-600 mb-4">{error}</p>}

      <button
        onClick={onComplete}
        disabled={!connected}
        className="w-full py-3 text-[11px] uppercase font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        style={{ background: GOLD, color: NAVY, letterSpacing: '0.14em' }}
      >
        Continue
      </button>
    </div>
  );
}

// ─── Step 2: Billing ───────────────────────────────────────────────────────────

function BillingStep({ onComplete }: { onComplete: () => void }) {
  const [adding, setAdding] = useState(false);
  const [added,  setAdded]  = useState(false);
  const [error,  setError]  = useState<string | null>(null);

  // TODO(stripe-integration): Replace stub with real Stripe Elements.
  // Requirements:
  //   - STRIPE_SECRET_KEY (server), NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY (client)
  //   - Install @stripe/react-stripe-js and @stripe/stripe-js
  // Real flow:
  //   1. POST /api/onboarding/billing/setup-intent → returns clientSecret
  //   2. Render <CardElement> via Stripe Elements
  //   3. stripe.confirmCardSetup(clientSecret) → stores payment method on customer
  //   4. Mark step complete
  async function handleAddBilling() {
    setAdding(true);
    setError(null);
    try {
      const res  = await fetch('/api/onboarding/billing', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({}),
      });
      const data = await res.json() as { ok?: boolean };
      if (res.ok && data.ok) {
        setAdded(true);
      } else {
        setError('Could not add payment method. Please try again.');
      }
    } catch {
      setError('Connection error. Please try again.');
    } finally {
      setAdding(false);
    }
  }

  return (
    <div>
      <h2 className="font-display mb-2" style={{ color: NAVY, fontSize: '1.25rem', fontWeight: 500 }}>
        Add a Payment Method
      </h2>
      <p className="mb-8 leading-relaxed" style={{ color: '#5A6B7A', fontSize: '14px', fontWeight: 300 }}>
        Expert calls are billed by the minute. We only charge after each completed consultation. No call, no charge.
      </p>

      {added ? (
        <div className="flex items-center gap-3 p-4 border mb-6" style={{ borderColor: GOLD, background: 'rgba(198,167,94,0.06)' }}>
          <span style={{ color: GOLD }}>✓</span>
          <span className="text-sm font-medium text-navy">Payment method added</span>
        </div>
      ) : (
        <div className="space-y-3 mb-6">
          {/* TODO(stripe-integration): Replace placeholder inputs with <CardElement /> from @stripe/react-stripe-js */}
          <div>
            <label className="block text-[10px] uppercase tracking-widest text-muted mb-1.5" style={{ letterSpacing: '0.14em' }}>
              Card Number
            </label>
            <div className="border border-frame bg-cream px-3 py-2.5 text-sm" style={{ color: '#C0C8D2' }}>
              •••• •••• •••• ••••
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] uppercase tracking-widest text-muted mb-1.5" style={{ letterSpacing: '0.14em' }}>
                Expiry
              </label>
              <div className="border border-frame bg-cream px-3 py-2.5 text-sm" style={{ color: '#C0C8D2' }}>MM / YY</div>
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-widest text-muted mb-1.5" style={{ letterSpacing: '0.14em' }}>
                CVC
              </label>
              <div className="border border-frame bg-cream px-3 py-2.5 text-sm" style={{ color: '#C0C8D2' }}>•••</div>
            </div>
          </div>
        </div>
      )}

      {error && <p role="alert" className="text-xs text-red-600 mb-4">{error}</p>}

      {added ? (
        <button
          onClick={onComplete}
          className="w-full py-3 text-[11px] uppercase font-medium transition-colors"
          style={{ background: GOLD, color: NAVY, letterSpacing: '0.14em' }}
        >
          Continue
        </button>
      ) : (
        <button
          onClick={handleAddBilling}
          disabled={adding}
          className="w-full py-3 text-[11px] uppercase font-medium transition-colors disabled:opacity-50"
          style={{ background: NAVY, color: '#FFFFFF', letterSpacing: '0.14em' }}
        >
          {adding ? 'Adding…' : 'Add Payment Method'}
        </button>
      )}
    </div>
  );
}

// ─── Step 3: Profile ───────────────────────────────────────────────────────────

function ProfileStep({ onComplete }: { onComplete: () => void }) {
  const [firstName, setFirstName] = useState('');
  const [lastName,  setLastName]  = useState('');
  const [title,     setTitle]     = useState('');
  const [firmName,  setFirmName]  = useState('');
  const [saving,    setSaving]    = useState(false);
  const [error,     setError]     = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/auth/me')
      .then(r => r.json())
      .then((d: { firmName?: string; firstName?: string; lastName?: string }) => {
        if (d.firmName)  setFirmName(d.firmName);
        if (d.firstName) setFirstName(d.firstName);
        if (d.lastName)  setLastName(d.lastName);
      })
      .catch(() => {});
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const fn = firstName.trim();
    const ln = lastName.trim();
    if (!fn || !ln || saving) return;

    setSaving(true);
    setError(null);
    try {
      const res  = await fetch('/api/onboarding/profile', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ firstName: fn, lastName: ln, title: title.trim() }),
      });
      const data = await res.json() as { ok?: boolean; message?: string };
      if (res.ok && data.ok) {
        onComplete();
      } else {
        setError(data.message ?? 'Failed to save profile. Please try again.');
      }
    } catch {
      setError('Connection error. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <h2 className="font-display mb-2" style={{ color: NAVY, fontSize: '1.25rem', fontWeight: 500 }}>
        Your Profile
      </h2>
      <p className="mb-8 leading-relaxed" style={{ color: '#5A6B7A', fontSize: '14px', fontWeight: 300 }}>
        So we can personalize your experience and communicate with experts on your behalf.
      </p>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="ob-first" className="block text-[10px] uppercase tracking-widest text-muted mb-1.5" style={{ letterSpacing: '0.14em' }}>
              First name <span className="text-red-400">*</span>
            </label>
            <input
              id="ob-first"
              type="text"
              value={firstName}
              onChange={e => setFirstName(e.target.value)}
              required
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              maxLength={100}
              className="w-full border border-frame bg-cream px-3 py-2.5 text-sm text-ink placeholder:text-muted/50 focus:outline-none focus:border-navy transition-colors"
              placeholder="Jane"
              disabled={saving}
            />
          </div>
          <div>
            <label htmlFor="ob-last" className="block text-[10px] uppercase tracking-widest text-muted mb-1.5" style={{ letterSpacing: '0.14em' }}>
              Last name <span className="text-red-400">*</span>
            </label>
            <input
              id="ob-last"
              type="text"
              value={lastName}
              onChange={e => setLastName(e.target.value)}
              required
              maxLength={100}
              className="w-full border border-frame bg-cream px-3 py-2.5 text-sm text-ink placeholder:text-muted/50 focus:outline-none focus:border-navy transition-colors"
              placeholder="Smith"
              disabled={saving}
            />
          </div>
        </div>

        <div>
          <label htmlFor="ob-title" className="block text-[10px] uppercase tracking-widest text-muted mb-1.5" style={{ letterSpacing: '0.14em' }}>
            Role / Title <span className="text-[10px] normal-case text-muted/50">(optional)</span>
          </label>
          <input
            id="ob-title"
            type="text"
            value={title}
            onChange={e => setTitle(e.target.value)}
            maxLength={200}
            className="w-full border border-frame bg-cream px-3 py-2.5 text-sm text-ink placeholder:text-muted/50 focus:outline-none focus:border-navy transition-colors"
            placeholder="Associate, VP Strategy, Partner…"
            disabled={saving}
          />
        </div>

        <div>
          <label className="block text-[10px] uppercase tracking-widest text-muted mb-1.5" style={{ letterSpacing: '0.14em' }}>
            Firm
          </label>
          <div className="border border-frame px-3 py-2.5 text-sm text-navy/50" style={{ background: 'rgba(247,249,252,0.7)' }}>
            {firmName || '—'}
          </div>
        </div>

        {error && <p role="alert" className="text-xs text-red-600">{error}</p>}

        <button
          type="submit"
          disabled={!firstName.trim() || !lastName.trim() || saving}
          className="w-full py-3 text-[11px] uppercase font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ background: GOLD, color: NAVY, letterSpacing: '0.14em' }}
        >
          {saving ? 'Saving…' : 'Finish Setup'}
        </button>
      </form>
    </div>
  );
}

// ─── Main Page ─────────────────────────────────────────────────────────────────

type Step = 1 | 2 | 3;

const STEP_LABELS: Record<Step, string> = {
  1: 'Connect Calendar',
  2: 'Add Billing',
  3: 'Your Profile',
};

export default function OnboardingPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>(1);

  function advance() {
    setStep(prev => (prev < 3 ? (prev + 1) as Step : prev));
  }

  function handleComplete() {
    router.push('/app?welcome=1');
    router.refresh();
  }

  return (
    <div className="min-h-screen flex flex-col font-body" style={{ background: '#F7F9FC' }}>

      {/* Header */}
      <header style={{ background: NAVY, borderBottom: `2px solid ${GOLD}` }}>
        <div className="max-w-6xl mx-auto px-6 sm:px-10 py-4 flex items-center justify-between">
          <span className="font-display text-cream font-semibold" style={{ letterSpacing: '0.15em', fontSize: '13px' }}>
            EXPERTMATCH
          </span>
          <span className="text-[10px] uppercase" style={{ color: GOLD, letterSpacing: '0.18em' }}>
            Account Setup
          </span>
        </div>
      </header>

      {/* Content */}
      <main className="flex-1 flex items-start justify-center px-4 py-14">
        <div className="w-full max-w-md">

          {/* Step indicator */}
          <div className="mb-8">
            <p className="text-[10px] uppercase text-muted text-center mb-3" style={{ letterSpacing: '0.2em' }}>
              Step {step} of 3
            </p>
            <div className="flex gap-1.5 mb-2">
              {([1, 2, 3] as Step[]).map(s => (
                <div
                  key={s}
                  className="flex-1 h-1 rounded-full transition-colors duration-300"
                  style={{ background: s <= step ? GOLD : 'rgba(11,31,59,0.12)' }}
                />
              ))}
            </div>
            <div className="flex justify-between">
              {([1, 2, 3] as Step[]).map(s => (
                <span
                  key={s}
                  className="text-[9px] uppercase"
                  style={{
                    color:        s <= step ? NAVY : '#8A9BAD',
                    letterSpacing: '0.1em',
                    fontWeight:   s === step ? 600 : 400,
                  }}
                >
                  {STEP_LABELS[s]}
                </span>
              ))}
            </div>
          </div>

          {/* Card */}
          <div className="bg-white border border-frame p-8 shadow-sm">
            {step === 1 && <CalendarStep onComplete={advance} />}
            {step === 2 && <BillingStep  onComplete={advance} />}
            {step === 3 && <ProfileStep  onComplete={handleComplete} />}
          </div>

        </div>
      </main>
    </div>
  );
}
