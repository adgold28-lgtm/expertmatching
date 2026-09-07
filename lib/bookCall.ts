// Booking a call, and moving one.
//
// The founder asked for two things this module owns: "there need to be emails
// back ... if a time has been found" and "there needs to be a way to move the
// call." Both are here, and both do the same four things in the same order:
//
//   1. Zoom      — created on a booking, PATCHED on a move so the join URL and
//                  the meeting id survive (lib/zoomLookup.ts resolves the Zoom
//                  webhook through that id, and the id is what charges the card
//                  when meeting.ended fires).
//   2. The state — `booking` (types.BookingState) plus the LEGACY zoom fields,
//                  written together. The Staff panel and the webhook still read
//                  `zoomMeetingId` / `zoomJoinUrl` / `scheduledTime`, so those
//                  keep step with `booking` rather than being superseded by it.
//   3. The thread— one Matchy line, two sentences at most, so the client sees
//                  what happened without opening a calendar.
//   4. The email — expert and client each get their own copy with the SAME .ics
//                  attached: same UID, SEQUENCE incremented on every move. That
//                  is what makes a reschedule land as a MOVE in Outlook, Apple
//                  Mail and Google Calendar rather than as a second event.
//
// IDENTITY REVEAL. Booking sets the status to 'scheduled', which is exactly the
// index at which lib/redactExpert.ts stops anonymizing the expert. So the
// client's copy and the ICS description may carry the expert's real name and
// the Zoom link. The expert's copy still never names the client or the project.
//
// WALKTHROUGH MODE. `sendBookingEmail` refuses an expert copy on a project that
// has not been switched live (it loads the project itself rather than trusting
// a caller), and every send here reads the returned outcome. The booking itself
// still happens: practising the flow has to leave the engagement in the state
// it really would be in, which is the same rule the rate decision follows.
//
// CANCELLING a booked call is deliberately NOT in scope for this phase — there
// is no cancelBooking() here, and lib/createZoomMeeting.deleteZoomMeeting is
// the primitive whoever adds it will want.
//
// Never throws. Never logs: names, addresses, project names, call times, the
// join URL.

import { randomBytes } from 'crypto';
import type {
  BookingMove,
  BookingState,
  Project,
  ProjectExpert,
} from '../types';
import type { IcsEvent } from './generateIcs';
import { getProject } from './projectStore';
import { getFirm, getUser } from './firmStore';
import { appendMessage } from './conversations';
import { emitEngagementEvent } from './engagementEvents';
import { createZoomMeeting, updateZoomMeeting } from './createZoomMeeting';
import { sendBookingEmail } from './sendAvailabilityRequest';
import { getFromAddress, bareAddress } from './mailFrom';
import { getCalendarConnection, normalizeTimezone } from './calendarConnections';
import {
  CALL_DURATION_MIN,
  DEFAULT_CLIENT_TIMEZONE,
  emptySchedulingState,
  writeExpert,
  type SchedulingPatch,
} from './matchyScheduling';
import {
  clientConfirmedEmail,
  confirmedEmail,
  formatSlotLine,
  movedEmail,
  threadSubject,
} from './schedulingTemplates';
import { resolveTimezone } from './computeOverlap';

// ─── Shapes ───────────────────────────────────────────────────────────────────

/** Who moved the world. Matches types.BookingMove['by']. */
export type BookedBy = 'client' | 'expert' | 'matchy';

export interface BookCallInput {
  projectId:   string;
  expertId:    string;
  startUtc:    string;
  durationMin?: number;
  by:          BookedBy;
}

export interface RebookCallInput {
  projectId: string;
  expertId:  string;
  startUtc:  string;
  by:        BookedBy;
}

export type BookCallResult =
  | { ok: true;  booking: BookingState; joinUrl: string | null; project: Project }
  | { ok: false; reason: 'not_found' | 'invalid_time' | 'nothing_booked' | 'write_failed' };

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** ISO 8601 in, epoch ms out. NaN for anything unparseable. */
function toMs(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : NaN;
}

/**
 * The address the client's copy goes to. `ownerEmail` is the signed-in project
 * owner; `clientEmail` is the legacy field a pre-Supabase project carried and
 * is only a fallback. Never a collaborator: they are read-only.
 */
function clientAddressOf(project: Project): string {
  return (project.ownerEmail?.trim() || project.clientEmail?.trim() || '');
}

/** The client's own zone, for the times in their copy of the email. */
async function clientZoneOf(project: Project): Promise<string> {
  const email = project.ownerEmail?.trim();
  if (!email) return DEFAULT_CLIENT_TIMEZONE;
  const connection = await getCalendarConnection(email).catch(() => null);
  return normalizeTimezone(connection?.timezone ?? null) ?? DEFAULT_CLIENT_TIMEZONE;
}

/** The client contact's first name, best effort. 'there' when we have none. */
async function clientFirstNameOf(project: Project): Promise<string> {
  const stated = project.clientName?.trim();
  if (stated) return stated;
  if (!project.ownerEmail) return 'there';
  const owner = await getUser(project.ownerEmail).catch(() => null);
  return owner?.firstName?.trim() || 'there';
}

/**
 * The ICS both parties receive.
 *
 * IDENTITY REVEAL BOUNDARY: this is built at or after 'scheduled', so the
 * expert's real name belongs in the description. The PROJECT NAME does not —
 * the expert reads this invite too, and they are never told who they are
 * speaking to. Hence the neutral title.
 */
function buildIcsEvent(args: {
  expertName:  string;
  startUtc:    string;
  endUtc:      string;
  joinUrl:     string;
  uid:         string;
  sequence:    number;
  attendees:   string[];
}): IcsEvent {
  const description = [
    `Expert call with ${args.expertName}.`,
    '',
    `Join Zoom: ${args.joinUrl}`,
  ].join('\n');

  return {
    title:       'Expert call',
    startUtc:    args.startUtc,
    endUtc:      args.endUtc,
    description,
    location:    args.joinUrl,
    organizer:   bareAddress(getFromAddress()),
    attendees:   args.attendees.filter(a => a.trim().length > 0),
    uid:         args.uid,
    sequence:    args.sequence,
    method:      'REQUEST',
  };
}

const NO_LINK = 'Video call, link to follow';

// ─── Book ─────────────────────────────────────────────────────────────────────

/**
 * Book the call.
 *
 * The Zoom meeting is created FIRST, because it is the only step that talks to
 * a third party and the only one that can be slow. It failing is survivable:
 * the booking is written either way and the invite says the link is to follow.
 * Losing the booking because Zoom was down is not survivable.
 */
export async function bookCall(input: BookCallInput): Promise<BookCallResult> {
  const { projectId, expertId, by } = input;
  const durationMin = Math.max(15, Math.round(input.durationMin ?? CALL_DURATION_MIN));

  const startMs = toMs(input.startUtc);
  if (!Number.isFinite(startMs)) return { ok: false, reason: 'invalid_time' };

  const project = await getProject(projectId).catch(() => null);
  if (!project) return { ok: false, reason: 'not_found' };

  const pe = project.experts.find(e => e.expert.id === expertId);
  if (!pe) return { ok: false, reason: 'not_found' };

  // ONE CALL, EVER. Callers decide book-vs-move from the ProjectExpert they
  // loaded, which can be stale: the expert can answer the email with a pick
  // and tap the picker in the same minute. Whatever the caller thought, a
  // booking that already exists on the fresh row is MOVED, never duplicated —
  // a second createZoomMeeting here would be a second meeting on the calendar.
  if (pe.booking) {
    if (toMs(pe.booking.startUtc) === startMs) {
      return { ok: true, booking: pe.booking, joinUrl: pe.zoomJoinUrl ?? null, project };
    }
    return rebookCall({ projectId, expertId, startUtc: input.startUtc, by });
  }

  const startUtc = new Date(startMs).toISOString();
  const endUtc   = new Date(startMs + durationMin * 60_000).toISOString();

  // ── 1. Zoom ────────────────────────────────────────────────────────────
  const meeting = await createZoomMeeting('Expert call', startUtc, durationMin, pe.expert.name)
    .catch(() => null);

  // ── 2. State ───────────────────────────────────────────────────────────
  const booking: BookingState = {
    startUtc,
    endUtc,
    durationMin,
    zoomMeetingId:    meeting?.meetingId ?? null,
    icsUid:           randomBytes(16).toString('hex'),
    icsSequence:      0,
    bookedAt:         Date.now(),
    rescheduledCount: 0,
    history:          [],
  };

  const scheduling = { ...(pe.scheduling ?? emptySchedulingState()), outcome: 'booked' as const };

  const patch: SchedulingPatch = {
    status:        'scheduled',
    booking,
    scheduling,
    // The legacy fields the Zoom webhook and the Staff panel still read. Kept
    // in step with `booking` rather than replaced by it.
    scheduledTime: startUtc,
    ...(meeting ? {
      zoomMeetingId: meeting.meetingId,
      zoomJoinUrl:   meeting.joinUrl,
      zoomStartUrl:  meeting.startUrl,
    } : {}),
  };

  let updated: Project;
  try {
    updated = await writeExpert(projectId, expertId, patch);
  } catch (err) {
    console.error('[bookCall] write failed:',
      err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return { ok: false, reason: 'write_failed' };
  }

  const joinUrl = meeting?.joinUrl ?? null;

  // ── 3. Thread + event ──────────────────────────────────────────────────
  const clientZone = await clientZoneOf(project);
  const whenClient = formatSlotLine(startUtc, clientZone);

  await appendMessage({
    projectId, expertId,
    direction: 'outbound',
    author:    'matchy',
    bodyClean: `Booked ${whenClient}. The Zoom link is on the card.`,
    summary:   `Booked ${whenClient}.`,
  });

  const firm = await getFirm(project.firmDomain).catch(() => null);
  await emitEngagementEvent({
    projectId, expertId, orgId: firm?.id ?? null,
    type:    'scheduled',
    payload: {
      durationMin,
      leadHours: Math.max(0, Math.round((startMs - Date.now()) / 3_600_000)),
      round:     pe.scheduling?.round ?? 0,
      by,
      zoom:      meeting !== null,
    },
  });

  // ── 4. The two confirmations ───────────────────────────────────────────
  await sendConfirmations({
    project, pe, booking, joinUrl, clientZone, moved: false,
  });

  return { ok: true, booking, joinUrl, project: updated };
}

// ─── Rebook ───────────────────────────────────────────────────────────────────

/**
 * Move a booked call.
 *
 * The old time is pushed onto `booking.history`, SEQUENCE goes up by one, and
 * the SAME `icsUid` is reused — that triple is what a calendar client needs to
 * update the event in place instead of adding a second one. The Zoom meeting is
 * PATCHed for the same reason: the id the webhook resolves and the link already
 * in someone's calendar both survive.
 */
export async function rebookCall(input: RebookCallInput): Promise<BookCallResult> {
  const { projectId, expertId, by } = input;

  const startMs = toMs(input.startUtc);
  if (!Number.isFinite(startMs)) return { ok: false, reason: 'invalid_time' };

  const project = await getProject(projectId).catch(() => null);
  if (!project) return { ok: false, reason: 'not_found' };

  const pe = project.experts.find(e => e.expert.id === expertId);
  if (!pe) return { ok: false, reason: 'not_found' };

  const previous = pe.booking;
  if (!previous) return { ok: false, reason: 'nothing_booked' };

  const durationMin = Math.max(15, previous.durationMin || CALL_DURATION_MIN);
  const startUtc = new Date(startMs).toISOString();
  const endUtc   = new Date(startMs + durationMin * 60_000).toISOString();

  if (previous.zoomMeetingId) {
    await updateZoomMeeting(previous.zoomMeetingId, startUtc, durationMin);
  }

  const move: BookingMove = {
    startUtc: previous.startUtc,
    endUtc:   previous.endUtc,
    movedAt:  Date.now(),
    by,
  };

  const booking: BookingState = {
    ...previous,
    startUtc,
    endUtc,
    durationMin,
    icsSequence:      previous.icsSequence + 1,
    rescheduledCount: previous.rescheduledCount + 1,
    history:          [...previous.history, move],
  };

  const patch: SchedulingPatch = {
    status:        'scheduled',
    booking,
    scheduling:    { ...(pe.scheduling ?? emptySchedulingState()), outcome: 'booked' },
    scheduledTime: startUtc,
  };

  let updated: Project;
  try {
    updated = await writeExpert(projectId, expertId, patch);
  } catch (err) {
    console.error('[bookCall] rebook write failed:',
      err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return { ok: false, reason: 'write_failed' };
  }

  const clientZone = await clientZoneOf(project);
  const whenClient = formatSlotLine(startUtc, clientZone);

  await appendMessage({
    projectId, expertId,
    direction: 'outbound',
    author:    'matchy',
    bodyClean: `Moved to ${whenClient}.`,
    summary:   `Moved to ${whenClient}.`,
  });

  const firm = await getFirm(project.firmDomain).catch(() => null);
  await emitEngagementEvent({
    projectId, expertId, orgId: firm?.id ?? null,
    type:    'rescheduled',
    payload: { by, count: booking.rescheduledCount },
  });

  await sendConfirmations({
    project, pe, booking,
    joinUrl:    pe.zoomJoinUrl ?? null,
    clientZone,
    moved:      true,
  });

  return { ok: true, booking, joinUrl: pe.zoomJoinUrl ?? null, project: updated };
}

// ─── The two copies ───────────────────────────────────────────────────────────

interface ConfirmationInput {
  project:    Project;
  pe:         ProjectExpert;
  booking:    BookingState;
  joinUrl:    string | null;
  clientZone: string;
  moved:      boolean;
}

/**
 * One invite, two audiences.
 *
 * Each copy renders the time in ITS OWN reader's zone (the expert's when we
 * learned it from the picker page or a reply, the client's from their calendar
 * connection) and carries the identical ICS, so the two calendars agree even
 * though the two emails read differently.
 *
 * Failures are logged and swallowed: the call is already booked, and the client
 * can always download the invite from the booking ICS route.
 */
async function sendConfirmations(input: ConfirmationInput): Promise<void> {
  const { project, pe, booking, joinUrl, clientZone, moved } = input;
  const projectId = project.id;
  const subject   = threadSubject(pe.outreachSubject);

  const expertZone = pe.scheduling?.expertTimezone
    ? resolveTimezone(pe.scheduling.expertTimezone)
    : clientZone;

  const clientEmail = clientAddressOf(project);
  const attendees   = [pe.contactEmail ?? '', clientEmail].filter(a => a.trim().length > 0);

  const ics = buildIcsEvent({
    expertName: pe.expert.name,
    startUtc:   booking.startUtc,
    endUtc:     booking.endUtc,
    joinUrl:    joinUrl ?? NO_LINK,
    uid:        booking.icsUid,
    sequence:   booking.icsSequence,
    attendees,
  });

  // ── The expert's copy. Never names the client or the project. ──────────
  if (pe.contactEmail) {
    const whenExpert = formatSlotLine(booking.startUtc, expertZone);
    const email = moved
      ? movedEmail({
        firstName:      pe.expert.name,
        whenLabel:      whenExpert,
        recipientEmail: pe.contactEmail,
        subject,
      })
      : confirmedEmail({
        expertFirstName: pe.expert.name,
        whenLabel:       whenExpert,
        recipientEmail:  pe.contactEmail,
        subject,
      });

    await sendBookingEmail(
      pe.contactEmail, email.subject, email.text, email.html, ics,
      { recipient: 'expert', projectId },
    );
  }

  // ── The client's copy. May name the expert: the identity is revealed. ──
  if (clientEmail) {
    const whenClient = formatSlotLine(booking.startUtc, clientZone);
    const firstName  = await clientFirstNameOf(project);
    const email = moved
      ? movedEmail({
        firstName,
        whenLabel:      whenClient,
        recipientEmail: clientEmail,
        subject:        `Call moved: ${whenClient}`,
      })
      : clientConfirmedEmail({
        clientFirstName: firstName,
        whenLabel:       whenClient,
        expertName:      pe.expert.name,
        recipientEmail:  clientEmail,
        subject:         `Call booked: ${whenClient}`,
      });

    await sendBookingEmail(
      clientEmail, email.subject, email.text, email.html, ics,
      { recipient: 'client', projectId },
    );
  }
}

// ─── The invite, on demand ────────────────────────────────────────────────────

/**
 * The current booking as a downloadable calendar event, for
 * GET /api/projects/[projectId]/experts/[expertId]/booking/ics. Null when
 * nothing is booked.
 */
export function bookingIcsEvent(project: Project, pe: ProjectExpert): IcsEvent | null {
  if (!pe.booking) return null;

  return buildIcsEvent({
    expertName: pe.expert.name,
    startUtc:   pe.booking.startUtc,
    endUtc:     pe.booking.endUtc,
    joinUrl:    pe.zoomJoinUrl ?? NO_LINK,
    uid:        pe.booking.icsUid,
    sequence:   pe.booking.icsSequence,
    attendees:  [clientAddressOf(project)].filter(a => a.length > 0),
  });
}
