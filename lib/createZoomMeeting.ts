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

import axios from 'axios';

export interface ZoomMeeting {
  meetingId: string;
  joinUrl:   string;
  startUrl:  string;
  password:  string;
  startTime: string;
}

async function getZoomAccessToken(): Promise<string> {
  const { ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET } = process.env;
  if (!ZOOM_ACCOUNT_ID || !ZOOM_CLIENT_ID || !ZOOM_CLIENT_SECRET) {
    throw new Error('[zoom] ZOOM_ACCOUNT_ID / ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET not set');
  }
  const credentials = Buffer.from(`${ZOOM_CLIENT_ID}:${ZOOM_CLIENT_SECRET}`).toString('base64');
  const res = await axios.post(
    `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${ZOOM_ACCOUNT_ID}`,
    null,
    { headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' } },
  );
  return res.data.access_token as string;
}

export async function createZoomMeeting(
  topic:        string,
  startTimeUtc: string,  // ISO 8601
  durationMin:  number,
  expertName:   string,
): Promise<ZoomMeeting | null> {
  try {
    const token = await getZoomAccessToken();
    const res = await axios.post(
      'https://api.zoom.us/v2/users/me/meetings',
      {
        topic:      `Expert Call: ${expertName}`,
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
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } },
    );
    const d = res.data;
    return {
      meetingId: String(d.id),
      joinUrl:   d.join_url,
      startUrl:  d.start_url,
      password:  d.password ?? '',
      startTime: d.start_time,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
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
    await axios.patch(
      `https://api.zoom.us/v2/meetings/${encodeURIComponent(meetingId)}`,
      {
        start_time: startTimeUtc,
        duration:   durationMin,
        timezone:   'UTC',
      },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } },
    );
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[zoom] meeting-update-failed', msg);
    return false;
  }
}

// ─── Remove a meeting ─────────────────────────────────────────────────────────

/**
 * Deletes a meeting. Nothing in the product calls this yet — cancelling a
 * booked call is out of scope for this phase (see lib/bookCall.ts) — but the
 * S2S plumbing belongs with its siblings rather than in whatever route first
 * needs it.
 */
export async function deleteZoomMeeting(meetingId: string): Promise<boolean> {
  if (!meetingId.trim()) return false;
  try {
    const token = await getZoomAccessToken();
    await axios.delete(
      `https://api.zoom.us/v2/meetings/${encodeURIComponent(meetingId)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[zoom] meeting-delete-failed', msg);
    return false;
  }
}
