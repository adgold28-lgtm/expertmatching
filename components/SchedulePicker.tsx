'use client';

// The expert's time picker. The only screen an expert ever sees on the
// platform, so it has to explain itself in four seconds on a phone.
//
// Times are rendered in the EXPERT'S OWN browser zone, read from
// Intl.DateTimeFormat().resolvedOptions().timeZone, and that zone is named
// under the title so nobody has to guess. The same value is posted back with
// the pick, which is how `scheduling.expertTimezone` gets filled in and how
// every later email reaches them in their own hours.
//
// PROGRESSIVE DISCLOSURE. Up to three big tappable buttons, then a "None of
// these work" disclosure holding the extra windows, a free-text box, and the
// Google Calendar link. A first-time reader sees three buttons and nothing
// else.
//
// WHAT THIS COMPONENT NEVER RECEIVES: the client's name, the firm, the project
// name, any rate, any address. GET /api/schedule/[token] builds its payload
// field by field for exactly that reason.
//
// Every state is real: loading on mount, a disabled+busy button while a request
// is in flight, an inline error with a retry, and a terminal success panel.

import { useCallback, useEffect, useMemo, useState } from 'react';

// ─── Shapes (mirrors the payload in app/api/schedule/[token]/route.ts) ────────

interface Slot { startUtc: string; endUtc: string; durationMin: number }

interface Payload {
  proposed:        Slot[];
  more:            Slot[];
  durationMin:     number;
  expertFirstName: string;
  topic:           string;
  calendarLinked:  boolean;
  booked:          { startUtc: string; endUtc: string } | null;
}

interface Booked { startUtc: string; endUtc: string; joinUrl: string | null }

interface Props {
  token: string;
  /** ?connected=1 came back from the Google round-trip. */
  connected?: boolean;
  /** ?error=... came back from the Google round-trip. */
  oauthError?: string;
}

// ─── Copy ─────────────────────────────────────────────────────────────────────

const OAUTH_ERRORS: Record<string, string> = {
  access_denied:         'You did not grant calendar access. You can still pick a time below.',
  token_invalid:         'That link is no longer valid. Reply to the email and we will send a new one.',
  token_revoked:         'A newer link was sent. Please use the most recent email.',
  not_found:             'We could not find that request. Reply to the email and we will resend it.',
  oauth_not_configured:  'Calendar linking is unavailable right now. Please pick a time below.',
  token_exchange_failed: 'We could not finish linking your calendar. Please pick a time below.',
  rate_limited:          'Too many attempts. Please wait a few minutes and try again.',
  invalid_state:         'That link expired mid-way. Please pick a time below.',
  invalid_callback:      'That link expired mid-way. Please pick a time below.',
  server_error:          'Something went wrong linking your calendar. Please pick a time below.',
};

const MAX_TEXT = 800;

// ─── Formatting ───────────────────────────────────────────────────────────────

function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** "Tuesday, September 15" and "2:00 PM to 3:00 PM", in the reader's own zone. */
function formatSlot(slot: { startUtc: string; endUtc: string }, zone: string): { day: string; time: string } {
  const start = new Date(slot.startUtc);
  const end   = new Date(slot.endUtc);

  const day = new Intl.DateTimeFormat(undefined, {
    timeZone: zone, weekday: 'long', month: 'long', day: 'numeric',
  }).format(start);

  const timeFmt = new Intl.DateTimeFormat(undefined, {
    timeZone: zone, hour: 'numeric', minute: '2-digit',
  });

  return { day, time: `${timeFmt.format(start)} to ${timeFmt.format(end)}` };
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function SchedulePicker({ token, connected, oauthError }: Props) {
  const [payload,   setPayload]   = useState<Payload | null>(null);
  const [loading,   setLoading]   = useState(true);
  const [loadError, setLoadError] = useState('');

  const [busy,      setBusy]      = useState<string | null>(null);
  const [actionErr, setActionErr] = useState('');

  const [booked,    setBooked]    = useState<Booked | null>(null);
  const [declined,  setDeclined]  = useState(false);

  const [showMore,  setShowMore]  = useState(false);
  const [note,      setNote]      = useState('');

  const zone = useMemo(browserZone, []);
  const base = `/api/schedule/${encodeURIComponent(token)}`;

  // ── Load ────────────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const res = await fetch(base, { cache: 'no-store' });
      if (res.status === 410 || res.status === 400) {
        setLoadError('expired');
        return;
      }
      if (!res.ok) {
        setLoadError('We could not load your times. Please try again.');
        return;
      }
      const data = await res.json() as Payload;
      setPayload(data);
      if (data.booked) setBooked({ ...data.booked, joinUrl: null });
    } catch {
      setLoadError('We could not load your times. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [base]);

  useEffect(() => { void load(); }, [load]);

  // ── Actions ─────────────────────────────────────────────────────────────
  async function pick(startUtc: string): Promise<void> {
    setBusy(startUtc);
    setActionErr('');
    try {
      const res = await fetch(base, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ action: 'pick', startUtc, timezone: zone }),
      });
      const data = await res.json().catch(() => null) as { booked?: Booked; error?: string } | null;

      if (res.status === 409) {
        setActionErr('That time has just been taken. Please pick another.');
        await load();
        return;
      }
      if (!res.ok || !data?.booked) {
        setActionErr('We could not book that time. Please try again.');
        return;
      }
      setBooked(data.booked);
    } catch {
      setActionErr('We could not book that time. Please try again.');
    } finally {
      setBusy(null);
    }
  }

  async function sendUnavailable(): Promise<void> {
    setBusy('unavailable');
    setActionErr('');
    try {
      const res = await fetch(base, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ action: 'unavailable', text: note.trim(), timezone: zone }),
      });
      if (!res.ok) {
        setActionErr('We could not send that. Please try again.');
        return;
      }
      setDeclined(true);
    } catch {
      setActionErr('We could not send that. Please try again.');
    } finally {
      setBusy(null);
    }
  }

  // ── Terminal states ─────────────────────────────────────────────────────

  if (loadError === 'expired') {
    return (
      <Shell>
        <h1 className="font-display text-2xl text-navy mb-3">This link has expired</h1>
        <p className="text-sm text-muted leading-relaxed">
          Reply to the email and I will send a new one.
        </p>
      </Shell>
    );
  }

  if (booked) {
    const { day, time } = formatSlot(booked, zone);
    return (
      <Shell>
        <div className="w-12 h-12 rounded-full bg-gold-pale border border-gold flex items-center justify-center mb-6"
             aria-hidden="true">
          <span className="text-navy text-xl">✓</span>
        </div>
        <h1 className="font-display text-2xl text-navy mb-3">Booked.</h1>
        <p className="text-sm text-ink leading-relaxed mb-1">{day}</p>
        <p className="text-sm text-ink leading-relaxed mb-4">{time}</p>
        <p className="text-sm text-muted leading-relaxed">
          Check your inbox for the invite. Times shown in {zone}.
        </p>
        {booked.joinUrl && (
          <a href={booked.joinUrl}
             className="mt-6 inline-block bg-navy text-gold px-6 py-3 text-sm font-semibold tracking-wide">
            Join link
          </a>
        )}
      </Shell>
    );
  }

  if (declined) {
    return (
      <Shell>
        <h1 className="font-display text-2xl text-navy mb-3">Thanks.</h1>
        <p className="text-sm text-muted leading-relaxed">
          I will come back with times that work better, or with a question if I cannot find any.
        </p>
      </Shell>
    );
  }

  // ── Loading ─────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <Shell>
        <div className="animate-pulse space-y-3 w-full" aria-busy="true" aria-live="polite">
          <div className="h-5 w-2/3 bg-cream-dark" />
          <div className="h-16 w-full bg-cream-dark" />
          <div className="h-16 w-full bg-cream-dark" />
          <div className="h-16 w-full bg-cream-dark" />
        </div>
        <span className="sr-only">Loading your times</span>
      </Shell>
    );
  }

  if (loadError || !payload) {
    return (
      <Shell>
        <h1 className="font-display text-2xl text-navy mb-3">Something went wrong</h1>
        <p className="text-sm text-muted leading-relaxed mb-6">{loadError || 'Please try again.'}</p>
        <button type="button" onClick={() => void load()}
                className="bg-navy text-gold px-6 py-3 text-sm font-semibold tracking-wide">
          Try again
        </button>
      </Shell>
    );
  }

  const oauthMessage = oauthError ? (OAUTH_ERRORS[oauthError] ?? OAUTH_ERRORS.server_error) : '';
  const noProposals  = payload.proposed.length === 0;

  return (
    <Shell>
      <h1 className="font-display text-2xl sm:text-3xl text-navy mb-2">
        Hi {payload.expertFirstName}, let us find a time.
      </h1>
      <p className="text-sm text-muted leading-relaxed mb-1">
        {payload.durationMin} minute paid call about {payload.topic}.
      </p>
      <p className="text-xs text-muted mb-8">Times shown in {zone}.</p>

      {connected && (
        <p role="status"
           className="mb-6 border border-status-success/40 bg-status-success/5 text-status-success text-sm px-4 py-3">
          Calendar linked. These times are ones you are actually free for.
        </p>
      )}

      {oauthMessage && (
        <p role="alert"
           className="mb-6 border border-status-warning/40 bg-status-warning/5 text-status-warning text-sm px-4 py-3">
          {oauthMessage}
        </p>
      )}

      {actionErr && (
        <p role="alert"
           className="mb-6 border border-status-danger/40 bg-status-danger/5 text-status-danger text-sm px-4 py-3">
          {actionErr}
        </p>
      )}

      {noProposals ? (
        <p className="text-sm text-ink leading-relaxed mb-8">
          Pick any time below, or tell me when you are free.
        </p>
      ) : (
        <ul className="space-y-3 mb-8 list-none p-0">
          {payload.proposed.map(slot => (
            <SlotButton key={slot.startUtc} slot={slot} zone={zone}
                        busy={busy !== null} pending={busy === slot.startUtc}
                        onPick={() => void pick(slot.startUtc)} />
          ))}
        </ul>
      )}

      {/* None of these work */}
      <div className="border-t border-frame pt-6">
        {!showMore ? (
          <button type="button" onClick={() => setShowMore(true)}
                  aria-expanded="false"
                  className="text-sm text-navy underline underline-offset-4">
            {noProposals ? 'Show me some times' : 'None of these work'}
          </button>
        ) : (
          <div>
            {payload.more.length > 0 && (
              <>
                <p className="text-sm text-ink mb-3">Any of these?</p>
                <ul className="space-y-3 mb-8 list-none p-0">
                  {payload.more.map(slot => (
                    <SlotButton key={slot.startUtc} slot={slot} zone={zone}
                                busy={busy !== null} pending={busy === slot.startUtc}
                                onPick={() => void pick(slot.startUtc)} />
                  ))}
                </ul>
              </>
            )}

            <label htmlFor="when-free" className="block text-sm text-ink mb-2">
              Tell me when you are free
            </label>
            <textarea
              id="when-free"
              value={note}
              onChange={e => setNote(e.target.value.slice(0, MAX_TEXT))}
              maxLength={MAX_TEXT}
              rows={4}
              placeholder="Tuesday or Thursday after 2, or most mornings next week."
              className="w-full border border-frame bg-surface px-4 py-3 text-sm text-ink
                         focus:outline-none focus:border-navy"
            />
            <p className="text-xs text-muted mt-1 mb-4">{note.length} of {MAX_TEXT}</p>

            <button
              type="button"
              onClick={() => void sendUnavailable()}
              disabled={busy !== null}
              className="w-full sm:w-auto bg-navy text-gold px-6 py-3 text-sm font-semibold
                         tracking-wide disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busy === 'unavailable' ? 'Sending…' : 'Send'}
            </button>

            {!payload.calendarLinked && (
              <p className="mt-8 text-sm text-muted leading-relaxed">
                Or link your calendar and I will only ever offer times you are free for.{' '}
                <a href={`/api/availability/${encodeURIComponent(token)}/google-auth`}
                   className="text-navy underline underline-offset-4">
                  Connect Google Calendar
                </a>
              </p>
            )}
          </div>
        )}
      </div>
    </Shell>
  );
}

// ─── Pieces ───────────────────────────────────────────────────────────────────

function SlotButton({ slot, zone, busy, pending, onPick }: {
  slot:    Slot;
  zone:    string;
  busy:    boolean;
  pending: boolean;
  onPick:  () => void;
}) {
  const { day, time } = formatSlot(slot, zone);
  return (
    <li>
      <button
        type="button"
        onClick={onPick}
        disabled={busy}
        className="w-full text-left border border-frame bg-surface px-5 py-4
                   hover:border-navy focus:outline-none focus:border-navy
                   disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        <span className="block text-base text-navy font-semibold">{day}</span>
        <span className="block text-sm text-muted mt-0.5">
          {pending ? 'Booking…' : time}
        </span>
      </button>
    </li>
  );
}

/** The one frame every state renders inside. Mobile first, 375px safe. */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-cream flex flex-col items-center px-4 py-12 sm:py-16">
      <div className="w-full max-w-lg">
        <p className="text-[10px] font-bold tracking-widest-3 text-navy uppercase mb-8">
          EXPERTMATCH
        </p>
        {children}
      </div>
    </main>
  );
}
