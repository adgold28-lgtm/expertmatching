'use client';

// Step 3 of /onboarding — name and title. Functionally unchanged from the
// original stub, with two differences:
//   * the seed values arrive as props (the parent already fetched /api/auth/me
//     to compute the resume step, so this no longer fetches it a second time)
//   * a 409 onboarding_steps_incomplete from the profile route — the server's
//     own re-check of billing + calendar — bounces the user back to the step
//     that is actually outstanding rather than showing a dead error.

import { useState } from 'react';
import {
  GOLD, NAVY, MUTED,
  MICRO_LS, LABEL_CLASS, FIELD_CLASS, BUTTON_CLASS,
} from './shared';

export interface ProfileSeed {
  firstName: string;
  lastName:  string;
  title:     string;
  firmName:  string;
}

interface ProfileStepProps {
  seed:              ProfileSeed;
  onComplete:        () => void;
  onStepsIncomplete: () => void;
}

export default function ProfileStep({ seed, onComplete, onStepsIncomplete }: ProfileStepProps) {
  const [firstName, setFirstName] = useState(seed.firstName);
  const [lastName,  setLastName]  = useState(seed.lastName);
  const [title,     setTitle]     = useState(seed.title);
  const [saving,    setSaving]    = useState(false);
  const [error,     setError]     = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const first = firstName.trim();
    const last  = lastName.trim();
    if (!first || !last || saving) return;

    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/onboarding/profile', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ firstName: first, lastName: last, title: title.trim() }),
      });
      const data = await res.json().catch(() => ({})) as {
        ok?:      boolean;
        error?:   string;
        message?: string;
      };

      if (res.ok && data.ok) {
        onComplete();
        return;
      }

      if (res.status === 409 && data.error === 'onboarding_steps_incomplete') {
        setError('Your calendar or payment method still needs finishing. Taking you back to that step.');
        onStepsIncomplete();
        return;
      }

      setError(data.message ?? 'We could not save your profile. Please try again.');
    } catch {
      setError('We could not reach ExpertMatch. Check your connection and try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <h2 className="font-display mb-2" style={{ color: NAVY, fontSize: '1.25rem', fontWeight: 500 }}>
        Your Profile
      </h2>
      <p className="mb-8 leading-relaxed" style={{ color: MUTED, fontSize: '14px', fontWeight: 300 }}>
        So we can address you properly and speak to experts on your behalf.
      </p>

      <form onSubmit={e => void handleSubmit(e)} className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor="ob-first" className={LABEL_CLASS} style={MICRO_LS}>
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
              className={FIELD_CLASS}
              placeholder="Jane"
              disabled={saving}
            />
          </div>
          <div>
            <label htmlFor="ob-last" className={LABEL_CLASS} style={MICRO_LS}>
              Last name <span className="text-red-400">*</span>
            </label>
            <input
              id="ob-last"
              type="text"
              value={lastName}
              onChange={e => setLastName(e.target.value)}
              required
              maxLength={100}
              className={FIELD_CLASS}
              placeholder="Smith"
              disabled={saving}
            />
          </div>
        </div>

        <div>
          <label htmlFor="ob-title" className={LABEL_CLASS} style={MICRO_LS}>
            Role / Title <span className="text-[10px] normal-case text-muted/50">(optional)</span>
          </label>
          <input
            id="ob-title"
            type="text"
            value={title}
            onChange={e => setTitle(e.target.value)}
            maxLength={200}
            className={FIELD_CLASS}
            placeholder="Associate, VP Strategy, Partner…"
            disabled={saving}
          />
        </div>

        <div>
          <label className={LABEL_CLASS} style={MICRO_LS}>Firm</label>
          <div
            className="border border-frame px-3 py-2.5 text-sm text-navy/50"
            style={{ background: 'rgba(247,249,252,0.7)' }}
          >
            {/* Read-only: the firm comes from the invitation, not this form.
                "your firm" beats an em dash when the name has not loaded. */}
            {seed.firmName || 'your firm'}
          </div>
        </div>

        {error && <p role="alert" className="text-xs text-red-600 leading-relaxed">{error}</p>}

        <button
          type="submit"
          disabled={!firstName.trim() || !lastName.trim() || saving}
          className={BUTTON_CLASS}
          style={{ background: GOLD, color: NAVY, letterSpacing: '0.14em' }}
        >
          {saving ? 'Saving…' : 'Finish Setup'}
        </button>
      </form>
    </div>
  );
}
