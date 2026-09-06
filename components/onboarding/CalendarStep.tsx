'use client';

// Step 1 of /onboarding — link a calendar. Required: the stepper will not
// advance until GET /api/onboarding/calendar/status reports connected:true.
//
// Three real paths, matching the backend exactly:
//   google   → browser redirect to /api/onboarding/calendar/google?tz=<IANA>,
//              which returns to /onboarding?calendar=connected|calendar_error=…
//              (the parent page owns those query params and the banner)
//   calendly → POST /api/onboarding/calendar { provider, calendlyUrl, timezone }
//   manual   → POST /api/onboarding/calendar { provider, slots, timezone }
//
// Manual slots are emitted in the shape lib/computeOverlap.ts can parse:
// date as YYYY-MM-DD, times as "9:00 AM" — anything else is silently dropped
// by the scheduler later, so the conversion happens here rather than server-side.

import { useState, useEffect, useRef } from 'react';
import type { AvailabilitySlot } from '../../types';
import {
  GOLD, NAVY, MUTED, FAINT,
  MICRO_LS, LABEL_CLASS, FIELD_CLASS, BUTTON_CLASS, NOTE_CLASS,
} from './shared';

export type CalendarProvider = 'google' | 'calendly' | 'manual';

/** Mirrors MAX_SLOTS in app/api/onboarding/calendar/route.ts. */
const MAX_MANUAL_SLOTS = 60;

/** Used when the runtime cannot enumerate the IANA database itself. */
const FALLBACK_TIMEZONES = [
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/Toronto', 'America/Sao_Paulo', 'Europe/London', 'Europe/Dublin',
  'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid', 'Europe/Zurich',
  'Europe/Stockholm', 'Europe/Moscow', 'Asia/Dubai', 'Asia/Mumbai',
  'Asia/Kolkata', 'Asia/Singapore', 'Asia/Hong_Kong', 'Asia/Shanghai',
  'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Auckland', 'UTC',
];

const OPTIONS: { id: CalendarProvider; label: string; blurb: string }[] = [
  {
    id:    'google',
    label: 'Connect Google Calendar',
    blurb: 'Recommended. We read free/busy times only — never event titles or guests.',
  },
  {
    id:    'calendly',
    label: 'Use Calendly',
    blurb: 'Paste your booking link. We check it for openings when a call is being scheduled.',
  },
  {
    id:    'manual',
    label: 'Enter availability manually',
    blurb: 'Add the windows that work for you. You can update these any time.',
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** The browser's IANA zone, or UTC when the runtime will not say. */
function detectTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * Full IANA list when the runtime exposes it (feature-detected — the typing is
 * newer than some of the browsers this ships to), otherwise a curated list.
 */
function listTimezones(): string[] {
  const holder = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  try {
    const zones = holder.supportedValuesOf?.('timeZone');
    if (Array.isArray(zones) && zones.length > 0) return zones;
  } catch {
    // Fall through to the curated list.
  }
  return FALLBACK_TIMEZONES;
}

/** "14:30" → "2:30 PM". Returns '' for anything unparseable. */
function to12Hour(value: string): string {
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return '';
  const hours   = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return '';
  const suffix = hours >= 12 ? 'PM' : 'AM';
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${hour12}:${match[2]} ${suffix}`;
}

/** "2026-09-14" → "Monday". Returns '' for anything unparseable. */
function weekdayFromDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return '';
  const parsed = new Date(`${value}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toLocaleDateString('en-US', { weekday: 'long' });
}

/** Today in the browser's own zone, for the date inputs' `min`. */
function todayIso(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day   = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

function isValidCalendlyUrl(url: string): boolean {
  if (!url.startsWith('https://calendly.com/')) return false;
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'calendly.com' && parsed.pathname.length > 1;
  } catch {
    return false;
  }
}

/** Human copy for the POST /api/onboarding/calendar error codes. */
function messageForSaveError(status: number, code: string): string {
  switch (code) {
    case 'invalid_calendly_url':
      return 'That does not look like a Calendly link. It should start with https://calendly.com/ followed by your booking path.';
    case 'invalid_timezone':
      return 'That time zone was not recognised. Choose another one from the list.';
    case 'no_slots':
      return 'Add at least one availability window with both a start and an end time.';
    case 'invalid_provider':
    case 'use_oauth_redirect':
      return 'That calendar option could not be used. Pick one of the options above and try again.';
    case 'request_too_large':
      return 'That is more availability than we can save at once. Remove a few windows and try again.';
    default:
      if (status === 401) return 'Your session expired. Sign in again to finish setup.';
      return 'We could not save your calendar. Please try again.';
  }
}

// ─── Manual slot rows ─────────────────────────────────────────────────────────

interface SlotRow {
  id:    number;
  date:  string;  // yyyy-mm-dd from <input type="date">
  start: string;  // HH:MM from <input type="time">
  end:   string;  // HH:MM
}

function emptyRow(id: number): SlotRow {
  return { id, date: '', start: '', end: '' };
}

// ─── Component ────────────────────────────────────────────────────────────────

interface CalendarStepProps {
  connected:    boolean;
  provider:     CalendarProvider | null;
  onConnected:  (provider: CalendarProvider) => void;
  onContinue:   () => void;
}

export default function CalendarStep({
  connected, provider, onConnected, onContinue,
}: CalendarStepProps) {
  const [choice,        setChoice]        = useState<CalendarProvider>('google');
  const [timezone,      setTimezone]      = useState('');
  const [zones,         setZones]         = useState<string[]>([]);
  const [calendlyUrl,   setCalendlyUrl]   = useState('');
  const [rows,          setRows]          = useState<SlotRow[]>([emptyRow(0)]);
  const [minDate,       setMinDate]       = useState('');
  const [saving,        setSaving]        = useState(false);
  const [redirecting,   setRedirecting]   = useState(false);
  const [error,         setError]         = useState<string | null>(null);
  const [reconfiguring, setReconfiguring] = useState(false);

  const nextRowId = useRef(1);

  // Resolved after mount: the server renders in its own zone and on its own
  // clock, so seeding either of these during render risks a hydration mismatch.
  useEffect(() => {
    const detected  = detectTimezone();
    const available = listTimezones();
    setZones(available.includes(detected) ? available : [detected, ...available]);
    setTimezone(detected);
    setMinDate(todayIso());
  }, []);

  const busy       = saving || redirecting;
  const showChooser = !connected || reconfiguring;

  // ── Actions ────────────────────────────────────────────────────────────────

  function connectGoogle(): void {
    if (busy || !timezone) return;
    setError(null);
    setRedirecting(true);
    // Full navigation on purpose: the route 302s to Google's consent screen.
    window.location.assign(`/api/onboarding/calendar/google?tz=${encodeURIComponent(timezone)}`);
  }

  async function save(body: Record<string, unknown>, saved: CalendarProvider): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/onboarding/calendar', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({})) as { connected?: boolean; error?: string };
      if (res.ok && data.connected) {
        setReconfiguring(false);
        onConnected(saved);
      } else {
        setError(messageForSaveError(res.status, data.error ?? ''));
      }
    } catch {
      setError('We could not reach ExpertMatch. Check your connection and try again.');
    } finally {
      setSaving(false);
    }
  }

  function submitCalendly(): void {
    const url = calendlyUrl.trim();
    if (!isValidCalendlyUrl(url)) {
      setError('Enter your full Calendly link — it should start with https://calendly.com/ followed by your booking path.');
      return;
    }
    void save({ provider: 'calendly', calendlyUrl: url, timezone }, 'calendly');
  }

  function submitManual(): void {
    const slots: AvailabilitySlot[] = [];

    for (const row of rows) {
      const isBlank = !row.date && !row.start && !row.end;
      if (isBlank) continue;

      if (!row.date || !row.start || !row.end) {
        setError('Each availability window needs a date, a start time and an end time.');
        return;
      }
      if (row.end <= row.start) {
        setError('Every window must end after it starts.');
        return;
      }

      const startTime = to12Hour(row.start);
      const endTime   = to12Hour(row.end);
      if (!startTime || !endTime) {
        setError('One of the times could not be read. Re-enter it and try again.');
        return;
      }

      const dayOfWeek = weekdayFromDate(row.date);
      slots.push({
        startTime,
        endTime,
        timezone,
        date: row.date,
        ...(dayOfWeek ? { dayOfWeek } : {}),
        confidence: 'high',
      });
    }

    if (slots.length === 0) {
      setError('Add at least one availability window before continuing.');
      return;
    }

    void save({ provider: 'manual', slots, timezone }, 'manual');
  }

  function updateRow(id: number, patch: Partial<SlotRow>): void {
    setRows(current => current.map(row => (row.id === id ? { ...row, ...patch } : row)));
  }

  function addRow(): void {
    if (rows.length >= MAX_MANUAL_SLOTS) return;
    setRows(current => [...current, emptyRow(nextRowId.current++)]);
  }

  function removeRow(id: number): void {
    setRows(current => (current.length === 1 ? current : current.filter(row => row.id !== id)));
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const providerLabel =
    provider === 'google'   ? 'Google Calendar'
    : provider === 'calendly' ? 'Calendly'
    : provider === 'manual'   ? 'Manual availability'
    : 'Calendar';

  return (
    <div>
      <h2 className="font-display mb-2" style={{ color: NAVY, fontSize: '1.25rem', fontWeight: 500 }}>
        Connect Your Calendar
      </h2>
      <p className="mb-6 leading-relaxed" style={{ color: MUTED, fontSize: '14px', fontWeight: 300 }}>
        So we can propose call times that actually work for you. Required.
      </p>

      {connected && (
        <div
          className={`${NOTE_CLASS} mb-6`}
          style={{ borderColor: GOLD, background: 'rgba(198,167,94,0.06)' }}
        >
          <span aria-hidden="true" style={{ color: GOLD }}>✓</span>
          <div className="flex-1">
            <p className="font-medium text-navy">{providerLabel} connected</p>
            {!reconfiguring && (
              <button
                type="button"
                onClick={() => { setReconfiguring(true); setError(null); }}
                className="mt-1 text-[11px] underline underline-offset-2 hover:opacity-70 transition-opacity"
                style={{ color: MUTED }}
              >
                Use a different calendar
              </button>
            )}
          </div>
        </div>
      )}

      {showChooser && (
        <>
          {/* ── Time zone ─────────────────────────────────────────────────── */}
          <div className="mb-6">
            <label htmlFor="ob-tz" className={LABEL_CLASS} style={MICRO_LS}>
              Your time zone
            </label>
            <select
              id="ob-tz"
              value={timezone}
              onChange={e => setTimezone(e.target.value)}
              disabled={busy || !timezone}
              className={FIELD_CLASS}
            >
              {timezone
                ? zones.map(zone => <option key={zone} value={zone}>{zone}</option>)
                : <option value="">Detecting…</option>}
            </select>
            <p className="mt-1.5 text-[11px]" style={{ color: FAINT }}>
              Detected automatically. Change it if you work from somewhere else.
            </p>
          </div>

          {/* ── Option chooser ────────────────────────────────────────────── */}
          <div className="space-y-2 mb-6">
            {OPTIONS.map(option => {
              const selected = choice === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => { setChoice(option.id); setError(null); }}
                  disabled={busy}
                  aria-pressed={selected}
                  className="w-full text-left border p-3.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{
                    borderColor: selected ? NAVY : '#DDE2E8',
                    background:  selected ? 'rgba(11,31,59,0.03)' : '#FFFFFF',
                  }}
                >
                  <span
                    className="block text-[11px] uppercase font-medium"
                    style={{ color: NAVY, letterSpacing: '0.12em' }}
                  >
                    {option.label}
                  </span>
                  <span className="block mt-1 text-xs leading-relaxed" style={{ color: MUTED }}>
                    {option.blurb}
                  </span>
                </button>
              );
            })}
          </div>

          {/* ── Google ────────────────────────────────────────────────────── */}
          {choice === 'google' && (
            <button
              type="button"
              onClick={connectGoogle}
              disabled={busy || !timezone}
              className={`${BUTTON_CLASS} mb-4`}
              style={{ background: NAVY, color: '#FFFFFF', letterSpacing: '0.14em' }}
            >
              {redirecting ? 'Redirecting to Google…' : 'Continue with Google'}
            </button>
          )}

          {/* ── Calendly ──────────────────────────────────────────────────── */}
          {choice === 'calendly' && (
            <div className="mb-4">
              <label htmlFor="ob-calendly" className={LABEL_CLASS} style={MICRO_LS}>
                Calendly link
              </label>
              <input
                id="ob-calendly"
                type="url"
                inputMode="url"
                value={calendlyUrl}
                onChange={e => { setCalendlyUrl(e.target.value); setError(null); }}
                placeholder="https://calendly.com/your-name/30min"
                maxLength={300}
                disabled={busy}
                className={FIELD_CLASS}
              />
              <button
                type="button"
                onClick={submitCalendly}
                disabled={busy || !calendlyUrl.trim()}
                className={`${BUTTON_CLASS} mt-3`}
                style={{ background: NAVY, color: '#FFFFFF', letterSpacing: '0.14em' }}
              >
                {saving ? 'Saving…' : 'Save Calendly link'}
              </button>
            </div>
          )}

          {/* ── Manual ────────────────────────────────────────────────────── */}
          {choice === 'manual' && (
            <div className="mb-4">
              <p className={LABEL_CLASS} style={MICRO_LS}>Availability windows</p>

              <div className="space-y-3">
                {rows.map((row, index) => (
                  <div key={row.id} className="border border-frame p-3">
                    <div className="flex items-center justify-between mb-2">
                      <span
                        className="text-[9px] uppercase"
                        style={{ color: FAINT, letterSpacing: '0.16em' }}
                      >
                        Window {index + 1}
                      </span>
                      {rows.length > 1 && (
                        <button
                          type="button"
                          onClick={() => removeRow(row.id)}
                          disabled={busy}
                          className="text-[10px] uppercase hover:opacity-70 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
                          style={{ color: MUTED, letterSpacing: '0.12em' }}
                        >
                          Remove
                        </button>
                      )}
                    </div>

                    <div className="space-y-2">
                      <div>
                        <label
                          htmlFor={`ob-date-${row.id}`}
                          className="block text-[9px] uppercase mb-1"
                          style={{ color: FAINT, letterSpacing: '0.14em' }}
                        >
                          Date
                        </label>
                        <input
                          id={`ob-date-${row.id}`}
                          type="date"
                          value={row.date}
                          min={minDate || undefined}
                          onChange={e => { updateRow(row.id, { date: e.target.value }); setError(null); }}
                          disabled={busy}
                          className={FIELD_CLASS}
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label
                            htmlFor={`ob-start-${row.id}`}
                            className="block text-[9px] uppercase mb-1"
                            style={{ color: FAINT, letterSpacing: '0.14em' }}
                          >
                            From
                          </label>
                          <input
                            id={`ob-start-${row.id}`}
                            type="time"
                            value={row.start}
                            onChange={e => { updateRow(row.id, { start: e.target.value }); setError(null); }}
                            disabled={busy}
                            className={FIELD_CLASS}
                          />
                        </div>
                        <div>
                          <label
                            htmlFor={`ob-end-${row.id}`}
                            className="block text-[9px] uppercase mb-1"
                            style={{ color: FAINT, letterSpacing: '0.14em' }}
                          >
                            To
                          </label>
                          <input
                            id={`ob-end-${row.id}`}
                            type="time"
                            value={row.end}
                            onChange={e => { updateRow(row.id, { end: e.target.value }); setError(null); }}
                            disabled={busy}
                            className={FIELD_CLASS}
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <div className="flex items-center justify-between mt-3">
                <button
                  type="button"
                  onClick={addRow}
                  disabled={busy || rows.length >= MAX_MANUAL_SLOTS}
                  className="text-[10px] uppercase hover:opacity-70 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{ color: NAVY, letterSpacing: '0.14em' }}
                >
                  + Add window
                </button>
                <span className="text-[10px]" style={{ color: FAINT }}>
                  {rows.length} of {MAX_MANUAL_SLOTS}
                </span>
              </div>

              <button
                type="button"
                onClick={submitManual}
                disabled={busy}
                className={`${BUTTON_CLASS} mt-3`}
                style={{ background: NAVY, color: '#FFFFFF', letterSpacing: '0.14em' }}
              >
                {saving ? 'Saving…' : 'Save availability'}
              </button>
            </div>
          )}
        </>
      )}

      {error && <p role="alert" className="text-xs text-red-600 mb-4 leading-relaxed">{error}</p>}

      <button
        type="button"
        onClick={onContinue}
        disabled={!connected || busy}
        className={BUTTON_CLASS}
        style={{ background: GOLD, color: NAVY, letterSpacing: '0.14em' }}
      >
        Continue
      </button>
    </div>
  );
}
