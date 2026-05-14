// Create a Google Calendar event invite for a scheduled expert call.
// Uses the app's own Google Calendar (GOOGLE_CALENDAR_REFRESH_TOKEN).
// Adds expert and client as attendees; Google sends invite emails automatically.
//
// Also creates a Zoom meeting (if ZOOM_ACCOUNT_ID is set) and embeds the join
// URL in the calendar event location and description.
//
// Never throws — returns null on any failure.
// Never logs: names, emails, project content, or tokens.

import { getProject, updateExpertStatus } from './projectStore';
import { createZoomMeeting } from './createZoomMeeting';
import type { OverlapSlot } from '../types';

// ─── App calendar token ───────────────────────────────────────────────────────

async function getAppCalendarToken(): Promise<string> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      client_id:     process.env.GOOGLE_CLIENT_ID              ?? '',
      client_secret: process.env.GOOGLE_CLIENT_SECRET          ?? '',
      refresh_token: process.env.GOOGLE_CALENDAR_REFRESH_TOKEN ?? '',
      grant_type:    'refresh_token',
    }),
    signal: AbortSignal.timeout(8_000),
  });

  const data = await res.json() as { access_token?: string; error?: string };
  if (!data.access_token) {
    throw new Error(`[createCalendarInvite] token exchange failed: ${data.error ?? 'no access_token'}`);
  }
  return data.access_token;
}

// ─── Google Calendar event types ─────────────────────────────────────────────

interface CalendarEventBody {
  summary:     string;
  description: string;
  start:       { dateTime: string; timeZone: string };
  end:         { dateTime: string; timeZone: string };
  attendees:   Array<{ email: string }>;
  location:    string;
}

interface CalendarEventResponse {
  id?:    string;
  error?: { message: string };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function createCalendarInvite(
  projectId: string,
  expertId:  string,
  slot:      OverlapSlot,
): Promise<{ eventId: string } | null> {
  try {
    // Guard: require GOOGLE_CALENDAR_REFRESH_TOKEN
    if (!process.env.GOOGLE_CALENDAR_REFRESH_TOKEN) {
      console.warn('[createCalendarInvite] GOOGLE_CALENDAR_REFRESH_TOKEN not set — skipping invite');
      return null;
    }

    // Load project + expert
    const project = await getProject(projectId);
    if (!project) {
      console.error('[createCalendarInvite] project not found');
      return null;
    }

    const pe = project.experts.find(e => e.expert.id === expertId);
    if (!pe) {
      console.error('[createCalendarInvite] expert not found in project');
      return null;
    }

    // Get app access token
    const accessToken = await getAppCalendarToken();

    // Attempt to create a Zoom meeting
    const durationMin  = slot.durationMin ?? 60;
    const zoomMeeting  = await createZoomMeeting(
      `Expert Call — ${project.name}`,
      slot.startUtc,
      durationMin,
      pe.expert.name,
    );

    // Build attendee list — filter empty emails
    const attendees: Array<{ email: string }> = [
      pe.contactEmail          ? { email: pe.contactEmail }          : null,
      project.clientEmail      ? { email: project.clientEmail }      : null,
    ].filter((a): a is { email: string } => a !== null && a.email.length > 0);

    const location = zoomMeeting
      ? zoomMeeting.joinUrl
      : 'Video call — link to follow';

    const description = zoomMeeting
      ? [
          `Research question: ${project.researchQuestion}`,
          '',
          `Expert: ${pe.expert.name}, ${pe.expert.title} at ${pe.expert.company}`,
          '',
          `Join Zoom meeting: ${zoomMeeting.joinUrl}`,
          `Meeting ID: ${zoomMeeting.meetingId}`,
        ].join('\n')
      : `Research question: ${project.researchQuestion}\n\nExpert: ${pe.expert.name}, ${pe.expert.title} at ${pe.expert.company}`;

    const eventBody: CalendarEventBody = {
      summary:     `Expert Call — ${project.name}`,
      description,
      start:       { dateTime: slot.startUtc, timeZone: 'UTC' },
      end:         { dateTime: slot.endUtc,   timeZone: 'UTC' },
      attendees,
      location,
    };

    const res = await fetch(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all',
      {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type':  'application/json',
        },
        body:   JSON.stringify(eventBody),
        signal: AbortSignal.timeout(10_000),
      },
    );

    const data = await res.json() as CalendarEventResponse;

    if (!res.ok || !data.id) {
      console.error('[createCalendarInvite] API error:', res.status);
      return null;
    }

    const eventId = data.id;

    // Update ProjectExpert with event ID + scheduled status + Zoom details (if created)
    await updateExpertStatus(projectId, expertId, {
      calendarEventId: eventId,
      status:          'scheduled',
      scheduledTime:   slot.startExpert,
      ...(zoomMeeting ? {
        zoomMeetingId: zoomMeeting.meetingId,
        zoomJoinUrl:   zoomMeeting.joinUrl,
        zoomStartUrl:  zoomMeeting.startUrl,
      } : {}),
    });

    console.log('[createCalendarInvite] event created', { projectId, status: 'ok' });
    return { eventId };

  } catch (err) {
    console.error('[createCalendarInvite] error:',
      err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return null;
  }
}
