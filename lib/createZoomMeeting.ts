// lib/createZoomMeeting.ts
// Creates, moves and removes a Zoom meeting via Server-to-Server OAuth.
//
// Every function here returns null / false on any failure and NEVER throws: a
// call is booked in our own database first, and a Zoom outage must degrade to
// "no video link yet", not to a lost booking.
//
// Required env vars: ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET
//
// Never logs: meeting topics, expert names, join URLs, tokens. Meeting ids are
// safe (lib/zoomLookup.ts already treats them as such).
//
// Plain fetch since 2026-10-18: this was the only module that used axios, so
// the dependency left with the rewrite. zoomRequest() keeps the two axios
// behaviours the code relied on (a non-2xx status rejects; a JSON body is
// parsed) and, like the axios calls before it, sets no request timeout of its
// own: lib/bookCall.ts books first and treats a slow Zoom as "no link yet".

import { errorMessage } from './log';

export interface ZoomMeeting {
  meetingId: string;
  joinUrl:   string;
  startUrl:  string;
  password:  string;
  startTime: string;
}

type ZoomMethod = 'POST' | 'PATCH' | 'DELETE';

/**
 * One Zoom HTTP call. Rejects on a non-2xx status with the wording axios used
 * ("Request failed with status code 401"), so the three error lines below read
 * as they always did. Resolves to the parsed JSON body, or null when there is
 * none (Zoom answers PATCH and DELETE with 204 No Content).
 */
async function zoomRequest(
  method:  ZoomMethod,
  url:     string,
  headers: Record<string, string>,
  body?:   unknown,
): Promise<unknown> {
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Request failed with status code ${res.status}`);
  const text = await res.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text; // axios handed back the raw text when a body was not JSON
  }
}

/** One property of an untyped JSON body, or undefined when the body is not an object. */
function field(body: unknown, key: string): unknown {
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[key] : undefined;
}

async function getZoomAccessToken(): Promise<string> {
  const { ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET } = process.env;
  if (!ZOOM_ACCOUNT_ID || !ZOOM_CLIENT_ID || !ZOOM_CLIENT_SECRET) {
    throw new Error('[zoom] ZOOM_ACCOUNT_ID / ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET not set');
  }
  const credentials = Buffer.from(`${ZOOM_CLIENT_ID}:${ZOOM_CLIENT_SECRET}`).toString('base64');
  const data = await zoomRequest(
    'POST',
    `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${ZOOM_ACCOUNT_ID}`,
    { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' },
  );
  const token = field(data, 'access_token');
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('[zoom] token response carried no access_token');
  }
  return token;
}

/**
 * `topic` is what Zoom shows both participants and keeps in its own records.
 * lib/bookCall.ts passes a generic line on purpose: the expert's name has no
 * business in a third party's meeting list when our own booking email already
 * tells the client who the call is with. (This parameter used to be ignored in
 * favour of `Expert Call: <expert name>`.)
 */
export async function createZoomMeeting(
  topic:        string,
  startTimeUtc: string,  // ISO 8601
  durationMin:  number,
): Promise<ZoomMeeting | null> {
  try {
    const token = await getZoomAccessToken();
    const d = await zoomRequest(
      'POST',
      'https://api.zoom.us/v2/users/me/meetings',
      { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      {
        topic,
        type:       2,
        start_time: startTimeUtc,
        duration:   durationMin,
        timezone:   'UTC',
        settings: {
          host_video:        true,
          participant_video:  true,
          join_before_host:  false,
          waiting_room:      true,
          auto_recording:    'none',
        },
      },
    );
    const id        = field(d, 'id');
    const joinUrl   = field(d, 'join_url');
    const startUrl  = field(d, 'start_url');
    const password  = field(d, 'password');
    const startTime = field(d, 'start_time');
    if (id === undefined || id === null
      || typeof joinUrl !== 'string' || typeof startUrl !== 'string' || typeof startTime !== 'string') {
      throw new Error('[zoom] meeting response was missing id, join_url, start_url or start_time');
    }
    return {
      meetingId: String(id),
      joinUrl,
      startUrl,
      password:  typeof password === 'string' ? password : '',
      startTime,
    };
  } catch (err) {
    const msg = errorMessage(err);
    console.error('[zoom] meeting-creation-failed', msg);
    return null;
  }
}

// ─── Move an existing meeting ─────────────────────────────────────────────────

/**
 * Repoints a booked meeting at a new start time. PATCH, not delete-and-create:
 * the join URL and the meeting id stay the same, so the Zoom webhook
 * (app/api/webhooks/zoom) still resolves the engagement through
 * lib/zoomLookup.ts and the link already in someone's calendar keeps working.
 *
 * Returns false on any failure — the caller has already written the new time.
 */
export async function updateZoomMeeting(
  meetingId:    string,
  startTimeUtc: string,  // ISO 8601
  durationMin:  number,
): Promise<boolean> {
  if (!meetingId.trim()) return false;
  try {
    const token = await getZoomAccessToken();
    await zoomRequest(
      'PATCH',
      `https://api.zoom.us/v2/meetings/${encodeURIComponent(meetingId)}`,
      { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      {
        start_time: startTimeUtc,
        duration:   durationMin,
        timezone:   'UTC',
      },
    );
    return true;
  } catch (err) {
    const msg = errorMessage(err);
    console.error('[zoom] meeting-update-failed', msg);
    return false;
  }
}

// ─── Remove a meeting ─────────────────────────────────────────────────────────

/**
 * Deletes a meeting. lib/bookCall.cancelCall calls this for a booked call's
 * meeting; the S2S plumbing belongs with its siblings rather than in whatever
 * route first needed it.
 */
export async function deleteZoomMeeting(meetingId: string): Promise<boolean> {
  if (!meetingId.trim()) return false;
  try {
    const token = await getZoomAccessToken();
    await zoomRequest(
      'DELETE',
      `https://api.zoom.us/v2/meetings/${encodeURIComponent(meetingId)}`,
      { Authorization: `Bearer ${token}` },
    );
    return true;
  } catch (err) {
    const msg = errorMessage(err);
    console.error('[zoom] meeting-delete-failed', msg);
    return false;
  }
}
