'use client';

// Link a calendar. Used twice:
//   • Step 1 of /onboarding (mode 'onboarding', the default) — required: the
//     stepper will not advance until GET /api/onboarding/calendar/status
//     reports connected:true.
//   • The Calendar panel of /settings (mode 'settings') — same three paths,
//     pre-filled with what is on file, and no Continue button.
//
// Three real paths, matching the backend exactly:
//   google   → browser redirect to /api/onboarding/calendar/google?tz=<IANA>,
//              which returns to /onboarding?calendar=connected|calendar_error=…
//              (the parent page owns those query params and the banner)
//   calendly → POST /api/onboarding/calendar { provider, calendlyUrl, timezone }
//              OFFERED ONLY when the server says so. GET /api/onboarding/calendar
//              answers { calendlyEnabled }, read once on mount; until it answers
//              (and whenever it says false, or the request fails) Calendly is
//              not in the chooser at all, because a saved Calendly link yields
//              no slots and the POST would answer 400 calendly_disabled. There
//              is no NEXT_PUBLIC copy of the flag — the server is the only
//              place it lives.
//   manual   → POST /api/onboarding/calendar { provider, timezone,
//                                              weeklyWindows, slots }
//
// MANUAL IS RECURRING FIRST. "Tuesdays and Thursdays, 9:00–11:30" is what a
// person's availability actually is; a list of specific dates is the exception,
// and it goes stale the moment those dates pass. So the manual path leads with
// weekly windows (day chips + one from/to per row) and keeps specific dates as
// a secondary option underneath. Both are sent on every save, and the server
// replaces both — see app/api/onboarding/calendar/route.ts.
//
// One row can cover several days (select Tue and Thu, type 9:00–11:30 once);
// it is expanded into one WeeklyWindow per selected day on submit, which is
// what MAX_WEEKLY_WINDOWS counts.
//
// Slots are emitted in the shape lib/computeOverlap.ts can parse: date as
// YYYY-MM-DD, times as "9:00 AM" — anything else is silently dropped by the
// scheduler later, so the conversion happens here rather than server-side.

import { useState, useEffect, useRef } from 'react';
import type { AvailabilitySlot } from '../../types';
import {
  MAX_WEEKLY_WINDOWS,
  WEEKDAY_ORDER,
  weekdayShortLabel,
  weekdayLabel,
  toDisplayTime,
  type WeeklyWindow,
} from '../../lib/availabilityWindows';
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
    blurb: 'Paste your booking link. We’ll use it to find call times once an expert says yes.',
  },
  {
    id:    'manual',
    label: 'Set your weekly hours',
    blurb: 'Tell us the days and times you take calls. You can change these any time from Settings.',
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
function messageForSaveError(status: number, code: string, reason?: string): string {
  switch (code) {
    case 'calendly_disabled':
      return 'Calendly is not available on ExpertMatch right now. Connect Google Calendar or set your weekly hours instead.';
    case 'invalid_calendly_url':
      return 'That does not look like a Calendly link. It should start with https://calendly.com/ followed by your booking path.';
    case 'invalid_timezone':
      return 'That time zone was not recognised. Choose another one from the list.';
    case 'no_slots':
      return 'Add at least one weekly window, or one specific date, before saving.';
    case 'invalid_weekly_windows':
      // The UI validates the same rules before sending, so this is a
      // belt-and-braces path — still, say which rule was broken.
      if (reason === 'end_not_after_start') return 'Every window must end after it starts, on the same day.';
      if (reason === 'too_many_windows')    return `That is more than ${MAX_WEEKLY_WINDOWS} weekly windows. Remove a few and try again.`;
      if (reason === 'invalid_timezone')    return 'That time zone was not recognised. Choose another one from the list.';
      return 'One of the weekly windows could not be read. Check the days and times and try again.';
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

// ─── Row models ───────────────────────────────────────────────────────────────

/** One recurring row: the same from/to applied to every selected day. */
interface WeeklyRow {
  id:    number;
  days:  number[];   // 0 = Sunday … 6 = Saturday
  from:  string;     // HH:MM from <input type="time">
  to:    string;     // HH:MM
}

/** One specific date. */
interface SlotRow {
  id:    number;
  date:  string;     // yyyy-mm-dd from <input type="date">
  start: string;     // HH:MM
  end:   string;     // HH:MM
}

function emptyWeeklyRow(id: number): WeeklyRow {
  return { id, days: [], from: '09:00', to: '17:00' };
}

function emptySlotRow(id: number): SlotRow {
  return { id, date: '', start: '', end: '' };
}

/** Total weekly windows a set of rows would produce — one per selected day. */
function countWindows(rows: WeeklyRow[]): number {
  return rows.reduce((total, row) => total + row.days.length, 0);
}

/**
 * Groups saved windows back into editable rows: windows that share a from/to
 * become one row with several days selected, which is how they were entered.
 */
function rowsFromWindows(windows: WeeklyWindow[], startId: number): WeeklyRow[] {
  const byTime = new Map<string, WeeklyRow>();
  let nextId = startId;

  for (const window of windows) {
    const key = `${window.from}|${window.to}`;
    const existing = byTime.get(key);
    if (existing) {
      if (!existing.days.includes(window.dayOfWeek)) existing.days.push(window.dayOfWeek);
      continue;
    }
    byTime.set(key, { id: nextId++, days: [window.dayOfWeek], from: window.from, to: window.to });
  }

  // Array.from rather than a spread: the project's tsconfig has no explicit
  // `target`, so downlevel iteration of a Map iterator is not available.
  return Array.from(byTime.values());
}

/** "9:00 AM" → "09:00" for an <input type="time">. '' when unparseable. */
function toInputTime(display: string): string {
  const match = display.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return '';
  let hours = Number(match[1]) % 12;
  if (match[3].toUpperCase() === 'PM') hours += 12;
  return `${String(hours).padStart(2, '0')}:${match[2]}`;
}

/** Saved one-off slots back into editable rows. Undated slots are not editable here. */
function rowsFromSlots(slots: AvailabilitySlot[], startId: number): SlotRow[] {
  const rows: SlotRow[] = [];
  let nextId = startId;
  for (const slot of slots) {
    if (!slot.date) continue;
    const start = toInputTime(slot.startTime);
    const end   = toInputTime(slot.endTime);
    if (!start || !end) continue;
    rows.push({ id: nextId++, date: slot.date, start, end });
  }
  return rows;
}

// ─── Component ────────────────────────────────────────────────────────────────

interface CalendarStepProps {
  connected:   boolean;
  provider:    CalendarProvider | null;
  onConnected: (provider: CalendarProvider) => void;
  onContinue:  () => void;
  /**
   * 'onboarding' (default) shows the Continue button and the step heading;
   * 'settings' hides both — the Settings panel supplies its own frame — and
   * opens pre-filled with what is already on file.
   */
  mode?:                 'onboarding' | 'settings';
  /** Current state from GET /api/onboarding/calendar/status, for the editor. */
  initialTimezone?:      string | null;
  initialWeeklyWindows?: WeeklyWindow[];
  initialSlots?:         AvailabilitySlot[];
}

export default function CalendarStep({
  connected, provider, onConnected, onContinue,
  mode = 'onboarding',
  initialTimezone,
  initialWeeklyWindows,
  initialSlots,
}: CalendarStepProps) {
  const isSettings = mode === 'settings';

  const [choice,      setChoice]      = useState<CalendarProvider>(provider ?? 'google');
  const [timezone,    setTimezone]    = useState('');
  const [zones,       setZones]       = useState<string[]>([]);
  const [calendlyUrl, setCalendlyUrl] = useState('');
  // Server-owned feature flag, false until GET /api/onboarding/calendar says
  // otherwise. Starting false means a slow or failed request hides Calendly
  // rather than offering a path the POST would refuse.
  const [calendlyAllowed, setCalendlyAllowed] = useState(false);
  const [weeklyRows,  setWeeklyRows]  = useState<WeeklyRow[]>([emptyWeeklyRow(0)]);
  const [slotRows,    setSlotRows]    = useState<SlotRow[]>([]);
  const [showDates,   setShowDates]   = useState(false);
  const [minDate,     setMinDate]     = useState('');
  const [saving,      setSaving]      = useState(false);
  const [redirecting, setRedirecting] = useState(false);
  const [error,       setError]       = useState<string | null>(null);
  const [savedNote,   setSavedNote]   = useState(false);
  const [reconfiguring, setReconfiguring] = useState(false);

  const nextRowId = useRef(1);

  // Resolved after mount: the server renders in its own zone and on its own
  // clock, so seeding either of these during render risks a hydration mismatch.
  useEffect(() => {
    const detected  = detectTimezone();
    const available = listTimezones();
    const initial   = initialTimezone || detected;
    setZones(available.includes(initial) ? available : [initial, ...available]);
    setTimezone(initial);
    setMinDate(todayIso());
  }, [initialTimezone]);

  // Which providers this deployment offers. One read on mount; if Calendly is
  // off and it was the stored choice, fall back to Google so the chooser never
  // sits on an option that is not rendered.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/onboarding/calendar');
        if (!res.ok) return;
        const data = await res.json() as { calendlyEnabled?: boolean };
        if (!cancelled && data.calendlyEnabled === true) setCalendlyAllowed(true);
      } catch {
        // Leave Calendly hidden — see the initial state.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!calendlyAllowed) setChoice(current => (current === 'calendly' ? 'google' : current));
  }, [calendlyAllowed]);

  // Pre-fill the editor from whatever is on file. Runs when the parent finishes
  // loading the status response, so it must tolerate arriving after mount.
  const prefilled = useRef(false);
  useEffect(() => {
    if (prefilled.current) return;
    const windows = initialWeeklyWindows ?? [];
    const slots   = initialSlots ?? [];
    if (windows.length === 0 && slots.length === 0) return;

    prefilled.current = true;

    const weekly = rowsFromWindows(windows, nextRowId.current);
    nextRowId.current += weekly.length + 1;
    if (weekly.length > 0) setWeeklyRows(weekly);

    const dates = rowsFromSlots(slots, nextRowId.current);
    nextRowId.current += dates.length + 1;
    if (dates.length > 0) {
      setSlotRows(dates);
      setShowDates(true);
    }
  }, [initialWeeklyWindows, initialSlots]);

  const busy        = saving || redirecting;
  // In Settings the editor is always open — there is nothing else on the panel.
  const showChooser = isSettings || !connected || reconfiguring;
  const windowCount = countWindows(weeklyRows);

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
    setSavedNote(false);
    try {
      const res = await fetch('/api/onboarding/calendar', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({})) as {
        connected?: boolean; error?: string; reason?: string;
      };
      if (res.ok && data.connected) {
        setReconfiguring(false);
        setSavedNote(true);
        onConnected(saved);
      } else {
        setError(messageForSaveError(res.status, data.error ?? '', data.reason));
      }
    } catch {
      setError('We could not reach ExpertMatch. Check your connection and try again.');
    } finally {
      setSaving(false);
    }
  }

  function submitCalendly(): void {
    if (!calendlyAllowed) return;   // the button is not rendered; belt and braces
    const url = calendlyUrl.trim();
    if (!isValidCalendlyUrl(url)) {
      setError('Enter your full Calendly link — it should start with https://calendly.com/ followed by your booking path.');
      return;
    }
    void save({ provider: 'calendly', calendlyUrl: url, timezone }, 'calendly');
  }

  function submitManual(): void {
    // ── Weekly windows ──────────────────────────────────────────────────────
    const weeklyWindows: WeeklyWindow[] = [];

    for (const row of weeklyRows) {
      if (row.days.length === 0 && !row.from && !row.to) continue;   // untouched row
      if (row.days.length === 0) {
        setError('Pick at least one day for every weekly window, or remove the row.');
        return;
      }
      if (!row.from || !row.to) {
        setError('Each weekly window needs a start and an end time.');
        return;
      }
      if (row.to <= row.from) {
        // Same-day windows only — a window that runs past midnight is two
        // windows, and the scheduler resolves both times against one date.
        setError('Every window must end after it starts, on the same day. For late-night hours, add a second window on the next day.');
        return;
      }
      for (const day of row.days) {
        weeklyWindows.push({ dayOfWeek: day, from: row.from, to: row.to, timezone });
      }
    }

    if (weeklyWindows.length > MAX_WEEKLY_WINDOWS) {
      setError(`That is more than ${MAX_WEEKLY_WINDOWS} weekly windows. Remove a few and try again.`);
      return;
    }

    // ── Specific dates (optional) ───────────────────────────────────────────
    const slots: AvailabilitySlot[] = [];

    for (const row of slotRows) {
      const isBlank = !row.date && !row.start && !row.end;
      if (isBlank) continue;

      if (!row.date || !row.start || !row.end) {
        setError('Each specific date needs a date, a start time and an end time.');
        return;
      }
      if (row.end <= row.start) {
        setError('Every window must end after it starts.');
        return;
      }

      const startTime = toDisplayTime(row.start);
      const endTime   = toDisplayTime(row.end);
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

    if (weeklyWindows.length === 0 && slots.length === 0) {
      setError('Add at least one weekly window, or one specific date, before saving.');
      return;
    }

    void save({ provider: 'manual', weeklyWindows, slots, timezone }, 'manual');
  }

  // ── Row editing ────────────────────────────────────────────────────────────

  function toggleDay(rowId: number, day: number): void {
    setError(null);
    setWeeklyRows(current => current.map(row => {
      if (row.id !== rowId) return row;
      const has = row.days.includes(day);
      if (has) return { ...row, days: row.days.filter(d => d !== day) };
      // Adding this day would exceed the cap — refuse the toggle, say why.
      if (countWindows(current) >= MAX_WEEKLY_WINDOWS) return row;
      return { ...row, days: [...row.days, day] };
    }));
  }

  function updateWeeklyRow(id: number, patch: Partial<WeeklyRow>): void {
    setError(null);
    setWeeklyRows(current => current.map(row => (row.id === id ? { ...row, ...patch } : row)));
  }

  function addWeeklyRow(): void {
    if (windowCount >= MAX_WEEKLY_WINDOWS) return;
    setWeeklyRows(current => [...current, emptyWeeklyRow(nextRowId.current++)]);
  }

  function removeWeeklyRow(id: number): void {
    setWeeklyRows(current => (current.length === 1
      ? [emptyWeeklyRow(nextRowId.current++)]
      : current.filter(row => row.id !== id)));
  }

  function updateSlotRow(id: number, patch: Partial<SlotRow>): void {
    setError(null);
    setSlotRows(current => current.map(row => (row.id === id ? { ...row, ...patch } : row)));
  }

  function addSlotRow(): void {
    if (slotRows.length >= MAX_MANUAL_SLOTS) return;
    setShowDates(true);
    setSlotRows(current => [...current, emptySlotRow(nextRowId.current++)]);
  }

  function removeSlotRow(id: number): void {
    setSlotRows(current => current.filter(row => row.id !== id));
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const providerLabel =
    provider === 'google'     ? 'Google Calendar'
    : provider === 'calendly' ? 'Calendly'
    : provider === 'manual'   ? 'Your weekly hours'
    : 'Calendar';

  return (
    <div>
      {!isSettings && (
        <>
          <h2 className="font-display mb-2" style={{ color: NAVY, fontSize: '1.25rem', fontWeight: 500 }}>
            Connect Your Calendar
          </h2>
          <p className="mb-6 leading-relaxed" style={{ color: MUTED, fontSize: '14px', fontWeight: 300 }}>
            So we can propose call times that actually work for you. Required.
          </p>
        </>
      )}

      {connected && (
        <div
          className={`${NOTE_CLASS} mb-6`}
          style={{ borderColor: GOLD, background: 'rgba(198,167,94,0.06)' }}
        >
          <span aria-hidden="true" style={{ color: GOLD }}>✓</span>
          <div className="flex-1 min-w-0">
            <p className="font-medium text-navy">{providerLabel} connected</p>
            {timezone && (
              <p className="mt-0.5 text-xs break-words" style={{ color: MUTED }}>
                Times are in {timezone.replace(/_/g, ' ')}.
              </p>
            )}
            {!isSettings && !reconfiguring && (
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
              onChange={e => { setTimezone(e.target.value); setError(null); }}
              disabled={busy || !timezone}
              className={FIELD_CLASS}
            >
              {timezone
                ? zones.map(zone => <option key={zone} value={zone}>{zone}</option>)
                : <option value="">Detecting…</option>}
            </select>
            <p className="mt-1.5 text-[11px]" style={{ color: FAINT }}>
              {initialTimezone
                ? 'Every window below is read in this zone.'
                : 'Detected automatically. Change it if you work from somewhere else.'}
            </p>
          </div>

          {/* ── Option chooser ────────────────────────────────────────────── */}
          <div className="space-y-2 mb-6">
            {OPTIONS.filter(option => option.id !== 'calendly' || calendlyAllowed).map(option => {
              const selected = choice === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => { setChoice(option.id); setError(null); setSavedNote(false); }}
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
          {choice === 'calendly' && calendlyAllowed && (
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

          {/* ── Manual: weekly windows first, specific dates second ───────── */}
          {choice === 'manual' && (
            <div className="mb-4">
              <p className={LABEL_CLASS} style={MICRO_LS}>Weekly hours</p>
              <p className="-mt-1 mb-3 text-[11px] leading-relaxed" style={{ color: FAINT }}>
                These repeat every week. Pick the days, then the hours you take calls.
              </p>

              <div className="space-y-3">
                {weeklyRows.map((row, index) => (
                  <div key={row.id} className="border border-frame p-3">
                    <div className="flex items-center justify-between mb-2">
                      <span
                        className="text-[9px] uppercase"
                        style={{ color: FAINT, letterSpacing: '0.16em' }}
                      >
                        Window {index + 1}
                      </span>
                      {(weeklyRows.length > 1 || row.days.length > 0) && (
                        <button
                          type="button"
                          onClick={() => removeWeeklyRow(row.id)}
                          disabled={busy}
                          className="text-[10px] uppercase hover:opacity-70 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
                          style={{ color: MUTED, letterSpacing: '0.12em' }}
                        >
                          Remove
                        </button>
                      )}
                    </div>

                    {/* Day chips, Monday first. Wrap on narrow screens. */}
                    <div role="group" aria-label={`Days for window ${index + 1}`} className="flex flex-wrap gap-1.5 mb-3">
                      {WEEKDAY_ORDER.map(day => {
                        const selected = row.days.includes(day);
                        const atCap    = !selected && windowCount >= MAX_WEEKLY_WINDOWS;
                        return (
                          <button
                            key={day}
                            type="button"
                            onClick={() => toggleDay(row.id, day)}
                            disabled={busy || atCap}
                            aria-pressed={selected}
                            aria-label={weekdayLabel(day)}
                            className="min-w-[44px] px-2 py-2 text-[11px] uppercase border transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                            style={{
                              borderColor: selected ? NAVY : '#DDE2E8',
                              background:  selected ? NAVY : '#FFFFFF',
                              color:       selected ? '#FFFFFF' : MUTED,
                              letterSpacing: '0.1em',
                            }}
                          >
                            {weekdayShortLabel(day)}
                          </button>
                        );
                      })}
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label
                          htmlFor={`ob-wstart-${row.id}`}
                          className="block text-[9px] uppercase mb-1"
                          style={{ color: FAINT, letterSpacing: '0.14em' }}
                        >
                          From
                        </label>
                        <input
                          id={`ob-wstart-${row.id}`}
                          type="time"
                          value={row.from}
                          onChange={e => updateWeeklyRow(row.id, { from: e.target.value })}
                          disabled={busy}
                          className={FIELD_CLASS}
                        />
                      </div>
                      <div>
                        <label
                          htmlFor={`ob-wend-${row.id}`}
                          className="block text-[9px] uppercase mb-1"
                          style={{ color: FAINT, letterSpacing: '0.14em' }}
                        >
                          To
                        </label>
                        <input
                          id={`ob-wend-${row.id}`}
                          type="time"
                          value={row.to}
                          onChange={e => updateWeeklyRow(row.id, { to: e.target.value })}
                          disabled={busy}
                          className={FIELD_CLASS}
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <div className="flex items-center justify-between gap-3 mt-3">
                <button
                  type="button"
                  onClick={addWeeklyRow}
                  disabled={busy || windowCount >= MAX_WEEKLY_WINDOWS}
                  className="text-[10px] uppercase hover:opacity-70 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{ color: NAVY, letterSpacing: '0.14em' }}
                >
                  + Add hours
                </button>
                <span className="text-[10px] text-right" style={{ color: FAINT }}>
                  {windowCount} of {MAX_WEEKLY_WINDOWS} weekly windows
                </span>
              </div>

              {/* ── Specific dates (secondary) ─────────────────────────────── */}
              <div className="mt-6 pt-5 border-t border-frame">
                {!showDates && slotRows.length === 0 ? (
                  <>
                    <button
                      type="button"
                      onClick={addSlotRow}
                      disabled={busy}
                      className="text-[10px] uppercase hover:opacity-70 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
                      style={{ color: NAVY, letterSpacing: '0.14em' }}
                    >
                      + Add a specific date
                    </button>
                    <p className="mt-1.5 text-[11px] leading-relaxed" style={{ color: FAINT }}>
                      For a one-off window that is not part of your usual week.
                    </p>
                  </>
                ) : (
                  <>
                    <p className={LABEL_CLASS} style={MICRO_LS}>Specific dates</p>
                    <p className="-mt-1 mb-3 text-[11px] leading-relaxed" style={{ color: FAINT }}>
                      One-off windows, on top of your weekly hours. Past dates are ignored.
                    </p>

                    <div className="space-y-3">
                      {slotRows.map((row, index) => (
                        <div key={row.id} className="border border-frame p-3">
                          <div className="flex items-center justify-between mb-2">
                            <span
                              className="text-[9px] uppercase"
                              style={{ color: FAINT, letterSpacing: '0.16em' }}
                            >
                              Date {index + 1}
                            </span>
                            <button
                              type="button"
                              onClick={() => removeSlotRow(row.id)}
                              disabled={busy}
                              className="text-[10px] uppercase hover:opacity-70 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
                              style={{ color: MUTED, letterSpacing: '0.12em' }}
                            >
                              Remove
                            </button>
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
                                onChange={e => updateSlotRow(row.id, { date: e.target.value })}
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
                                  onChange={e => updateSlotRow(row.id, { start: e.target.value })}
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
                                  onChange={e => updateSlotRow(row.id, { end: e.target.value })}
                                  disabled={busy}
                                  className={FIELD_CLASS}
                                />
                              </div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>

                    <div className="flex items-center justify-between gap-3 mt-3">
                      <button
                        type="button"
                        onClick={addSlotRow}
                        disabled={busy || slotRows.length >= MAX_MANUAL_SLOTS}
                        className="text-[10px] uppercase hover:opacity-70 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
                        style={{ color: NAVY, letterSpacing: '0.14em' }}
                      >
                        + Add another date
                      </button>
                      <span className="text-[10px] text-right" style={{ color: FAINT }}>
                        {slotRows.length} of {MAX_MANUAL_SLOTS}
                      </span>
                    </div>
                  </>
                )}
              </div>

              <button
                type="button"
                onClick={submitManual}
                disabled={busy || !timezone}
                className={`${BUTTON_CLASS} mt-5`}
                style={{ background: NAVY, color: '#FFFFFF', letterSpacing: '0.14em' }}
              >
                {saving ? 'Saving…' : 'Save availability'}
              </button>
            </div>
          )}
        </>
      )}

      {error && <p role="alert" className="text-xs text-red-600 mb-4 leading-relaxed">{error}</p>}

      {savedNote && !error && (
        <p role="status" className="text-xs mb-4" style={{ color: NAVY }}>
          Saved.
        </p>
      )}

      {!isSettings && (
        <button
          type="button"
          onClick={onContinue}
          disabled={!connected || busy}
          className={BUTTON_CLASS}
          style={{ background: GOLD, color: NAVY, letterSpacing: '0.14em' }}
        >
          Continue
        </button>
      )}
    </div>
  );
}
