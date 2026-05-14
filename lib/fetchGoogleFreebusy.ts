// Fetch free slots from a Google Calendar via the freebusy API.
// Decrypts access/refresh tokens, handles 401 token refresh, inverts busy → free.
// Returns [] on any failure — never throws.
//
// Never logs: tokens, email addresses, calendar IDs, or slot times.

import { decrypt, encrypt } from './encryption';
import type { AvailabilitySlot } from '../types';

const DEFAULT_WINDOW_DAYS = 14;

// ─── Google API types ─────────────────────────────────────────────────────────

interface FreebusyRequest {
  timeMin:  string;
  timeMax:  string;
  items:    Array<{ id: string }>;
}

interface FreebusyResponse {
  calendars?: Record<string, { busy?: Array<{ start: string; end: string }> }>;
  error?:     { message: string };
}

interface TokenRefreshResponse {
  access_token?: string;
  expires_in?:   number;
  error?:        string;
}

// ─── Token refresh ────────────────────────────────────────────────────────────

async function refreshAccessToken(
  encryptedRefreshToken: string,
): Promise<{ newEncryptedAccessToken: string; newExpiry: number } | null> {
  try {
    const refreshToken = decrypt(encryptedRefreshToken);
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({
        client_id:     process.env.GOOGLE_CLIENT_ID     ?? '',
        client_secret: process.env.GOOGLE_CLIENT_SECRET ?? '',
        refresh_token: refreshToken,
        grant_type:    'refresh_token',
      }),
      signal: AbortSignal.timeout(8_000),
    });

    const data = await res.json() as TokenRefreshResponse;
    if (!data.access_token) {
      console.error('[freebusy] token refresh failed — no access_token in response');
      return null;
    }

    const newEncryptedAccessToken = encrypt(data.access_token);
    const newExpiry = Date.now() + (data.expires_in ?? 3600) * 1000;
    return { newEncryptedAccessToken, newExpiry };
  } catch (err) {
    console.error('[freebusy] token refresh error:', err instanceof Error ? err.message.slice(0, 80) : 'unknown');
    return null;
  }
}

// ─── Freebusy query ───────────────────────────────────────────────────────────

async function queryFreebusy(
  accessToken: string,
  calendarEmail: string,
  timeMin: string,
  timeMax: string,
): Promise<Array<{ start: string; end: string }>> {
  const body: FreebusyRequest = {
    timeMin,
    timeMax,
    items: [{ id: calendarEmail }],
  };

  const res = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type':  'application/json',
    },
    body:   JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });

  if (res.status === 401) throw new Error('UNAUTHENTICATED');

  if (!res.ok) {
    console.error('[freebusy] API error status:', res.status);
    return [];
  }

  const data = await res.json() as FreebusyResponse;
  return data.calendars?.[calendarEmail]?.busy ?? [];
}

// ─── Busy → free inversion ────────────────────────────────────────────────────

const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

function invertBusyToFree(
  busyBlocks: Array<{ start: string; end: string }>,
  windowStart: Date,
  windowEnd:   Date,
): AvailabilitySlot[] {
  const freeSlots: AvailabilitySlot[] = [];

  // Sort busy blocks ascending
  const sorted = [...busyBlocks].sort(
    (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime(),
  );

  // Process each day in the window with broad UTC business hours (8am–7pm)
  const msPerDay = 24 * 60 * 60_000;
  const startDay = new Date(
    Date.UTC(windowStart.getUTCFullYear(), windowStart.getUTCMonth(), windowStart.getUTCDate()),
  );

  for (let d = new Date(startDay); d < windowEnd; d = new Date(d.getTime() + msPerDay)) {
    const dayStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 8,  0, 0));
    const dayEnd   = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 19, 0, 0));

    // Collect busy blocks that overlap with this day's business hours
    const dayBusy = sorted.filter(b => {
      const bs = new Date(b.start).getTime();
      const be = new Date(b.end).getTime();
      return be > dayStart.getTime() && bs < dayEnd.getTime();
    });

    // Invert within the business-hours window
    let cursor = dayStart;

    for (const busy of dayBusy) {
      const bStart = new Date(Math.max(new Date(busy.start).getTime(), dayStart.getTime()));
      const bEnd   = new Date(Math.min(new Date(busy.end).getTime(),   dayEnd.getTime()));

      if (bStart > cursor) {
        // There's a free gap before this busy block
        freeSlots.push(buildSlot(cursor, bStart));
      }
      if (bEnd > cursor) cursor = bEnd;
    }

    // Free time after last busy block
    if (cursor < dayEnd) {
      freeSlots.push(buildSlot(cursor, dayEnd));
    }
  }

  return freeSlots;
}

function buildSlot(start: Date, end: Date): AvailabilitySlot {
  const pad   = (n: number) => String(n).padStart(2, '0');
  const fmtT  = (d: Date) => {
    const h    = d.getUTCHours();
    const m    = pad(d.getUTCMinutes());
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12  = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${m} ${ampm}`;
  };
  const dateStr = `${start.getUTCFullYear()}-${pad(start.getUTCMonth() + 1)}-${pad(start.getUTCDate())}`;

  return {
    dayOfWeek:  DAY_NAMES[start.getUTCDay()],
    date:       dateStr,
    startTime:  fmtT(start),
    endTime:    fmtT(end),
    timezone:   'UTC',
    confidence: 'high',
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function fetchGoogleFreebusy(
  encryptedAccessToken:  string,
  encryptedRefreshToken: string,
  calendarEmail:         string,
  windowDays:            number = DEFAULT_WINDOW_DAYS,
  onTokenRefreshed?:     (newEncryptedAccessToken: string, newExpiry: number) => Promise<void>,
): Promise<AvailabilitySlot[]> {
  try {
    const now        = new Date();
    const windowEnd  = new Date(now.getTime() + windowDays * 24 * 60 * 60_000);
    const timeMin    = now.toISOString();
    const timeMax    = windowEnd.toISOString();

    let accessToken: string;
    try {
      accessToken = decrypt(encryptedAccessToken);
    } catch {
      console.error('[freebusy] failed to decrypt access token');
      return [];
    }

    let busyBlocks: Array<{ start: string; end: string }>;

    try {
      busyBlocks = await queryFreebusy(accessToken, calendarEmail, timeMin, timeMax);
    } catch (err) {
      if (err instanceof Error && err.message === 'UNAUTHENTICATED') {
        // Try refreshing the token
        console.log('[freebusy] access token expired, attempting refresh');
        const refreshed = await refreshAccessToken(encryptedRefreshToken);
        if (!refreshed) return [];

        try {
          accessToken = decrypt(refreshed.newEncryptedAccessToken);
          busyBlocks  = await queryFreebusy(accessToken, calendarEmail, timeMin, timeMax);
        } catch {
          console.error('[freebusy] still unauthorized after token refresh');
          return [];
        }

        if (onTokenRefreshed) {
          await onTokenRefreshed(refreshed.newEncryptedAccessToken, refreshed.newExpiry).catch(() => {});
        }
      } else {
        throw err;
      }
    }

    return invertBusyToFree(busyBlocks, now, windowEnd);
  } catch (err) {
    console.error('[freebusy] error:', err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return [];
  }
}
