'use client';

// /settings → Profile. First name, last name, title.
//
// Reads GET /api/auth/me and writes POST /api/onboarding/profile — the same
// route the last onboarding step uses. That route decides which mode it is in
// from the caller's stored record, not from anything sent here: because this
// user is already onboarded, it saves the three fields and touches nothing
// else — no prerequisite re-check, no re-write of onboarding_complete.
//
// The title is sent even when empty, so clearing it actually clears it.

import { useCallback, useEffect, useState } from 'react';
import SettingsPanel, { PanelSkeleton, PanelError } from './SettingsPanel';

const NAVY  = '#0B1F3B';
const FAINT = '#8A9BAD';

const LABEL_CLASS = 'block text-[10px] uppercase tracking-widest text-muted mb-1.5';
const FIELD_CLASS =
  'w-full border border-frame bg-cream px-3 py-2.5 text-sm text-ink ' +
  'placeholder:text-muted/50 focus:outline-none focus:border-navy ' +
  'transition-colors disabled:opacity-40 disabled:cursor-not-allowed';

type LoadState = 'loading' | 'ready' | 'failed';

interface MeResponse {
  email?:     string;
  firstName?: string;
  lastName?:  string;
  title?:     string;
  orgName?:   string;
}

export default function ProfilePanel({ onNameSaved }: { onNameSaved?: (firstName: string) => void }) {
  const [state,     setState]     = useState<LoadState>('loading');
  const [email,     setEmail]     = useState('');
  const [orgName,   setOrgName]   = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName,  setLastName]  = useState('');
  const [title,     setTitle]     = useState('');
  const [saving,    setSaving]    = useState(false);
  const [saved,     setSaved]     = useState(false);
  const [error,     setError]     = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setState('loading');
    try {
      const res = await fetch('/api/auth/me');
      if (!res.ok) { setState('failed'); return; }
      const data = await res.json() as MeResponse;
      setEmail(data.email ?? '');
      setOrgName(data.orgName ?? '');
      setFirstName(data.firstName ?? '');
      setLastName(data.lastName ?? '');
      setTitle(data.title ?? '');
      setState('ready');
    } catch {
      setState('failed');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function save(): Promise<void> {
    const first = firstName.trim();
    const last  = lastName.trim();

    if (!first) { setError('First name is required.'); return; }
    if (!last)  { setError('Last name is required.');  return; }

    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch('/api/onboarding/profile', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        // `title` always goes, empty string included — that is how it is cleared.
        body:    JSON.stringify({ firstName: first, lastName: last, title: title.trim() }),
      });
      const data = await res.json().catch(() => ({})) as { message?: string; error?: string };

      if (res.ok) {
        setSaved(true);
        onNameSaved?.(first);
        return;
      }
      if (res.status === 401) {
        setError('Your session expired. Sign in again and try once more.');
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
    <SettingsPanel
      title="Profile"
      description="How you appear to your colleagues on this account."
    >
      {state === 'loading' && <PanelSkeleton lines={3} />}

      {state === 'failed' && (
        <PanelError message="We could not load your profile." onRetry={() => { void load(); }} />
      )}

      {state === 'ready' && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="settings-first" className={LABEL_CLASS} style={{ letterSpacing: '0.14em' }}>
                First name
              </label>
              <input
                id="settings-first"
                type="text"
                value={firstName}
                onChange={e => { setFirstName(e.target.value); setError(null); setSaved(false); }}
                maxLength={100}
                autoComplete="given-name"
                disabled={saving}
                className={FIELD_CLASS}
              />
            </div>
            <div>
              <label htmlFor="settings-last" className={LABEL_CLASS} style={{ letterSpacing: '0.14em' }}>
                Last name
              </label>
              <input
                id="settings-last"
                type="text"
                value={lastName}
                onChange={e => { setLastName(e.target.value); setError(null); setSaved(false); }}
                maxLength={100}
                autoComplete="family-name"
                disabled={saving}
                className={FIELD_CLASS}
              />
            </div>
          </div>

          <div className="mt-4">
            <label htmlFor="settings-title" className={LABEL_CLASS} style={{ letterSpacing: '0.14em' }}>
              Title <span className="normal-case tracking-normal" style={{ color: FAINT }}>(optional)</span>
            </label>
            <input
              id="settings-title"
              type="text"
              value={title}
              onChange={e => { setTitle(e.target.value); setError(null); setSaved(false); }}
              placeholder="Principal, Consumer &amp; Retail"
              maxLength={200}
              autoComplete="organization-title"
              disabled={saving}
              className={FIELD_CLASS}
            />
          </div>

          {(email || orgName) && (
            <p className="mt-4 text-[11px] leading-relaxed" style={{ color: FAINT }}>
              {email && <>Signed in as {email}. </>}
              {orgName && <>Firm: {orgName}. </>}
              Contact us to change either.
            </p>
          )}

          {error && (
            <p role="alert" className="mt-3 text-xs leading-relaxed text-red-600">{error}</p>
          )}
          {saved && !error && (
            <p role="status" className="mt-3 text-xs" style={{ color: NAVY }}>Saved.</p>
          )}

          <button
            type="button"
            onClick={() => { void save(); }}
            disabled={saving}
            className="mt-4 w-full sm:w-auto px-6 py-2.5 text-[10px] uppercase font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ background: NAVY, color: '#FFFFFF', letterSpacing: '0.14em' }}
          >
            {saving ? 'Saving…' : 'Save profile'}
          </button>
        </>
      )}
    </SettingsPanel>
  );
}
