// Pure .ics (iCalendar) generation — no external dependencies.
// Produces standard VCALENDAR/VEVENT format compatible with Outlook, Apple Mail, Google Calendar.
//
// ICS content safety:
//   Commas → \,   Semicolons → \;   Backslashes → \\   Newlines → \n
//   Outlook breaks on unescaped characters.

export interface IcsEvent {
  title:       string;
  startUtc:    string;   // ISO 8601, e.g. "2026-05-14T18:00:00Z"
  endUtc:      string;   // ISO 8601
  description: string;
  location:    string;   // Zoom join URL
  organizer:   string;   // asher@expertmatch.fit
  attendees:   string[]; // email addresses
  uid:         string;   // unique event ID
  /**
   * ICS SEQUENCE. Every reschedule of the same UID increments it, which is
   * what tells Outlook, Apple Mail and Google Calendar to MOVE the existing
   * event rather than create a second one. Defaults to 0.
   */
  sequence?:   number;
  /**
   * ICS METHOD. 'REQUEST' invites or updates; 'CANCEL' withdraws. Defaults to
   * 'REQUEST'. The MIME type on the attachment must carry the same value —
   * see lib/sendAvailabilityRequest.sendBookingEmail.
   */
  method?:     'REQUEST' | 'CANCEL';
}

// ─── Escaping ─────────────────────────────────────────────────────────────────

function escapeIcsText(s: string): string {
  return s
    .replace(/\\/g,  '\\\\')  // backslash first
    .replace(/;/g,   '\\;')
    .replace(/,/g,   '\\,')
    .replace(/\r?\n/g, '\\n');
}

// ─── Date formatting ──────────────────────────────────────────────────────────

function toIcsDate(iso: string): string {
  // Convert ISO 8601 → YYYYMMDDTHHMMSSZ
  // Accepts: "2026-05-14T18:00:00Z" or "2026-05-14T18:00:00.000Z"
  const d = new Date(iso);
  if (isNaN(d.getTime())) {
    throw new Error(`[generateIcs] invalid date: ${iso}`);
  }
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return (
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    'T' +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    'Z'
  );
}

// ─── ICS generation ───────────────────────────────────────────────────────────

export function generateIcs(event: IcsEvent): string {
  const now        = toIcsDate(new Date().toISOString());
  const dtstart    = toIcsDate(event.startUtc);
  const dtend      = toIcsDate(event.endUtc);
  const title      = escapeIcsText(event.title);
  const description = escapeIcsText(event.description);
  const location   = escapeIcsText(event.location);
  const uid        = escapeIcsText(event.uid);
  const method     = event.method === 'CANCEL' ? 'CANCEL' : 'REQUEST';
  const sequence   = Number.isFinite(event.sequence) && (event.sequence as number) >= 0
    ? Math.floor(event.sequence as number)
    : 0;

  const attendeeLines = event.attendees
    .filter(e => e.trim().length > 0)
    .map(email => `ATTENDEE;RSVP=TRUE:mailto:${email}`)
    .join('\r\n');

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ExpertMatch//EN',
    `METHOD:${method}`,
    'BEGIN:VEVENT',
    `UID:${uid}@expertmatch.fit`,
    `DTSTAMP:${now}`,
    `DTSTART:${dtstart}`,
    `DTEND:${dtend}`,
    `SUMMARY:${title}`,
    `DESCRIPTION:${description}`,
    `LOCATION:${location}`,
    `ORGANIZER;CN=ExpertMatch:mailto:${event.organizer}`,
    attendeeLines,
    method === 'CANCEL' ? 'STATUS:CANCELLED' : 'STATUS:CONFIRMED',
    `SEQUENCE:${sequence}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(l => l.length > 0);

  return lines.join('\r\n');
}

export function generateIcsBuffer(event: IcsEvent): Buffer {
  return Buffer.from(generateIcs(event), 'utf8');
}
