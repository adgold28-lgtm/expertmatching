'use client';

// /settings → Calendar. Shows what is linked and lets the user change it.
//
// The editor IS the onboarding step (components/onboarding/CalendarStep.tsx in
// mode 'settings'), not a copy of it: same three providers, same validation,
// same POST /api/onboarding/calendar. A second implementation would drift, and
// the two would disagree about what a valid week looks like.
//
// State comes from GET /api/onboarding/calendar/status, which returns the
// caller's own provider, timezone, weekly windows and one-off dates so the
// editor opens pre-filled rather than blank.

import { useCallback, useEffect, useState } from 'react';
import CalendarStep, { type CalendarProvider } from '../onboarding/CalendarStep';
import SettingsPanel, { PanelSkeleton, PanelError } from './SettingsPanel';
import type { WeeklyWindow } from '../../lib/availabilityWindows';
import type { AvailabilitySlot } from '../../types';

interface CalendarStatus {
  connected:     boolean;
  provider:      CalendarProvider | null;
  timezone:      string | null;
  hasWeekly:     boolean;
  weeklyWindows: WeeklyWindow[];
  slots:         AvailabilitySlot[];
}

type LoadState = 'loading' | 'ready' | 'failed';

const EMPTY: CalendarStatus = {
  connected: false, provider: null, timezone: null,
  hasWeekly: false, weeklyWindows: [], slots: [],
};

export default function CalendarPanel() {
  const [state,  setState]  = useState<LoadState>('loading');
  const [status, setStatus] = useState<CalendarStatus>(EMPTY);

  const load = useCallback(async (): Promise<void> => {
    setState('loading');
    try {
      const res = await fetch('/api/onboarding/calendar/status');
      if (!res.ok) { setState('failed'); return; }
      const data = await res.json() as Partial<CalendarStatus>;
      setStatus({
        connected:     data.connected === true,
        provider:      data.provider ?? null,
        timezone:      data.timezone ?? null,
        hasWeekly:     data.hasWeekly === true,
        weeklyWindows: Array.isArray(data.weeklyWindows) ? data.weeklyWindows : [],
        slots:         Array.isArray(data.slots) ? data.slots : [],
      });
      setState('ready');
    } catch {
      setState('failed');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Re-read after a save so the summary line and the pre-fill agree with what
  // the server now holds, rather than with what the form happened to send.
  const handleConnected = useCallback((): void => { void load(); }, [load]);

  const summary =
    state !== 'ready'      ? undefined
    : !status.connected    ? 'No calendar linked yet. We cannot propose call times until there is one.'
    : status.hasWeekly     ? 'Your weekly hours repeat every week. Specific dates sit on top of them.'
    : status.provider === 'google'   ? 'We read free/busy times only — never event titles or guests.'
    : status.provider === 'calendly' ? 'We read your booking link when an expert says yes.'
    : 'Specific dates only. Add weekly hours so you do not have to keep topping them up.';

  return (
    <SettingsPanel title="Calendar" description={summary}>
      {state === 'loading' && <PanelSkeleton lines={4} />}

      {state === 'failed' && (
        <PanelError
          message="We could not load your calendar settings."
          onRetry={() => { void load(); }}
        />
      )}

      {state === 'ready' && (
        <CalendarStep
          mode="settings"
          connected={status.connected}
          provider={status.provider}
          initialTimezone={status.timezone}
          initialWeeklyWindows={status.weeklyWindows}
          initialSlots={status.slots}
          onConnected={handleConnected}
          // Settings has no stepper to advance — the prop is required by the
          // shared component and does nothing here.
          onContinue={() => {}}
        />
      )}
    </SettingsPanel>
  );
}
