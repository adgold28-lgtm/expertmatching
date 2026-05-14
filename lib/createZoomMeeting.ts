// lib/createZoomMeeting.ts
// Creates a Zoom meeting via Server-to-Server OAuth.
// Returns null on any failure — never throws.
// Required env vars: ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET

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
