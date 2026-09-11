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
//   4. The email — expert and client each get their own copy, and their own
//                  .ics: same UID, SEQUENCE incremented on every move, but an
//                  ATTENDEE list naming only that one recipient. The shared UID
//                  and SEQUENCE are what make a reschedule land as a MOVE in
//                  Outlook, Apple Mail and Google Calendar rather than as a
//                  second event; the attendee list plays no part in that.
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
// CANCELLING a booked call is cancelCall(), added in Wave 5 (the policy is
// docs/CALL_POLICIES_DRAFT.md, the arithmetic is lib/callPolicies.ts). It is
// the one function here that must resolve to a single outcome before anything
// leaves the building, so it takes a Redis SET NX lock, decides and writes
// under projectStore.mutateExpert's compare-and-set, and only then deletes the
// Zoom meeting, withdraws both invites (METHOD:CANCEL, same UID, SEQUENCE + 1)
// and applies the money or the removal the policy calls for.
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
import { getProject, mutateExpert } from './projectStore';
import { getUpstashClient } from './upstashRedis';
import {
  cancelOutcome,
  cancelWindow,
  lateCancelFee,
  type CancelDecision,
  type CancelWindow,
  type CancelledBy,
  type LateCancelFee,
} from './callPolicies';
import { applyClientLateCancelMoney } from './lateCancelBilling';
import { removeExpertForFault } from './expertRemoval';
import { getFirm, getUser } from './firmStore';
import { appendMessage } from './conversations';
import { emitEngagementEvent } from './engagementEvents';
import { createZoomMeeting, deleteZoomMeeting, updateZoomMeeting } from './createZoomMeeting';
import { getEntitlementsForProject, recordRestrictedAttempt } from './entitlements';
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
  cancelledEmail,
  clientCancelledEmail,
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
  | { ok: false; reason: 'not_found' | 'invalid_time' | 'nothing_booked' | 'write_failed' | 'activation_required' };

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
 * The shared body of both parties' invites. Callers never build one directly:
 * they go through expertIcsEvent or clientIcsEvent, which is what decides the
 * ATTENDEE list.
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

/**
 * THE RULE, both here and in bookingIcsEvent below: each recipient's invite
 * lists only that recipient as an ATTENDEE, with the ExpertMatch sending
 * address as ORGANIZER. Neither side is ever told the other's email through an
 * attachment — lib/redactExpert.ts strips `contactEmail` from every
 * client-facing response, and an .ics must not be the hole in that.
 *
 * Both copies still share `uid` and `sequence`, which is all a calendar needs
 * to move an existing event instead of adding a second one (RFC 5545 keys an
 * update on UID + SEQUENCE, never on the attendee list).
 */

/** The expert's copy: ATTENDEE is the expert alone. */
export function expertIcsEvent(args: {
  pe:      ProjectExpert;
  booking: BookingState;
  joinUrl: string | null;
}): IcsEvent {
  return buildIcsEvent({
    expertName: args.pe.expert.name,
    startUtc:   args.booking.startUtc,
    endUtc:     args.booking.endUtc,
    joinUrl:    args.joinUrl ?? NO_LINK,
    uid:        args.booking.icsUid,
    sequence:   args.booking.icsSequence,
    attendees:  [args.pe.contactEmail ?? ''],
  });
}

/**
 * The client's copy: ATTENDEE is the client alone. The emailed copy and the
 * on-demand download (bookingIcsEvent) both come through here, so their
 * ATTENDEE lines are byte-identical.
 */
export function clientIcsEvent(args: {
  project: Project;
  pe:      ProjectExpert;
  booking: BookingState;
  joinUrl: string | null;
}): IcsEvent {
  return buildIcsEvent({
    expertName: args.pe.expert.name,
    startUtc:   args.booking.startUtc,
    endUtc:     args.booking.endUtc,
    joinUrl:    args.joinUrl ?? NO_LINK,
    uid:        args.booking.icsUid,
    sequence:   args.booking.icsSequence,
    attendees:  [clientAddressOf(args.project)],
  });
}

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

  // Account boundary (lib/entitlements.ts): no card on file, no Zoom meeting,
  // no invite, no booking. Checked before the first third-party call.
  const entitlements = await getEntitlementsForProject(projectId);
  if (!entitlements.canScheduleCalls) {
    await recordRestrictedAttempt(entitlements, { action: 'book_call', projectId, expertId });
    return { ok: false, reason: 'activation_required' };
  }

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

  const entitlements = await getEntitlementsForProject(projectId);
  if (!entitlements.canScheduleCalls) {
    await recordRestrictedAttempt(entitlements, { action: 'rebook_call', projectId, expertId });
    return { ok: false, reason: 'activation_required' };
  }

  const durationMin = Math.max(15, previous.durationMin || CALL_DURATION_MIN);
  const startUtc = new Date(startMs).toISOString();
  const endUtc   = new Date(startMs + durationMin * 60_000).toISOString();

  // A move PATCHes the existing meeting and never creates one. When the
  // original booking has no meeting id — Zoom was down at bookCall time, so the
  // invite went out saying the link would follow — there is nothing to patch and
  // nothing is created here either, so the engagement stays permanently without
  // a join URL and without the id app/api/webhooks/zoom resolves through
  // lib/zoomLookup.ts. The return value of updateZoomMeeting is deliberately
  // ignored: the new time is already ours, and a failed PATCH leaves Zoom
  // showing the old slot while everything else has moved.
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

  // TWO INVITES, ONE EVENT. Each recipient's invite lists only that recipient;
  // the shared UID and SEQUENCE are what make a later move an update.
  const expertIcs = expertIcsEvent({ pe, booking, joinUrl });
  const clientIcs = clientIcsEvent({ project, pe, booking, joinUrl });

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
      pe.contactEmail, email.subject, email.text, email.html, expertIcs,
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
      clientEmail, email.subject, email.text, email.html, clientIcs,
      { recipient: 'client', projectId },
    );
  }
}

// ─── The invite, on demand ────────────────────────────────────────────────────

/**
 * The current booking as a downloadable calendar event, for
 * GET /api/projects/[projectId]/experts/[expertId]/booking/ics. Null when
 * nothing is booked.
 *
 * The same clientIcsEvent the confirmation email attaches, so the downloaded
 * copy and the mailed one carry identical ATTENDEE lines as well as the same
 * UID and SEQUENCE: importing both updates one event rather than making two.
 */
export function bookingIcsEvent(project: Project, pe: ProjectExpert): IcsEvent | null {
  if (!pe.booking) return null;

  return clientIcsEvent({
    project,
    pe,
    booking: pe.booking,
    joinUrl: pe.zoomJoinUrl ?? null,
  });
}

// ─── Cancel ───────────────────────────────────────────────────────────────────

/** How long one in-flight cancel/move/book holds the engagement's lock. */
const BOOKING_LOCK_TTL_S = 60;

export interface CancelCallInput {
  projectId: string;
  expertId:  string;
  by:        CancelledBy;
  /** The client's or expert's free-text reason. Stored, never logged. */
  reason?:   string;
  /** Server time. Injected so the policy is testable; defaults to the clock. */
  now?:      number;
  /**
   * The client has seen the fee and pressed confirm. Required for a LATE client
   * cancel and ignored otherwise; an expert or staff cancel never charges.
   */
  confirmLate?: boolean;
}

export type CancelCallError =
  /** Nothing is booked on this engagement. */
  | 'not_booked'
  /** The booking already carries a cancelledAt. */
  | 'already_cancelled'
  /** A late client cancel that has not been confirmed. `fee` says what it costs. */
  | 'late_not_confirmed'
  /** Another cancel / move / book is in flight for this engagement. */
  | 'locked'
  /** The row moved under us more times than the store will retry. */
  | 'conflict';

export type CancelCallResult =
  | {
      ok:       true;
      outcome:  CancelDecision;
      window:   CancelWindow;
      fee:      LateCancelFee;
      booking:  BookingState;
      project:  Project;
    }
  | { ok: false; error: CancelCallError; window?: CancelWindow; fee?: LateCancelFee };

/** Thrown from inside `mutateExpert` so the decision refuses without writing. */
class CancelRefused extends Error {
  constructor(public readonly error: CancelCallError) {
    super(error);
  }
}

/**
 * Cancel a booked call, from either side.
 *
 * THE ORDER IS THE POINT (docs/HANDOFF_WAVE5_CALL_POLICIES.md: "cancel, move
 * and book on the same engagement must resolve to one outcome before any
 * Zoom/email/Stripe side effect"):
 *
 *   1. Read, price the cancel (lib/callPolicies.ts), and refuse an unconfirmed
 *      late CLIENT cancel BEFORE anything is locked or written. The refusal
 *      carries the fee, which is what the confirm dialog renders.
 *   2. Take the Redis SET NX lock. Fail OPEN when Redis is unavailable, exactly
 *      as lib/outreachSteps.ts does: the compare-and-set below is the durable
 *      guard, and Upstash being down must not make a call uncancellable.
 *   3. Decide and write in ONE compare-and-set (projectStore.mutateExpert). The
 *      decision is re-run against the freshly read row on every retry, so a
 *      booking that was cancelled or removed in the meantime refuses here
 *      rather than in step 4 with half the side effects already done.
 *   4. Only then the side effects: the Zoom meeting, the two withdrawals, the
 *      thread line, the event, and the money or the removal the policy asks
 *      for. Each one is independently survivable; the state is already right.
 *
 * The picker token is invalidated in the same write (`pickTokenHash: null`), so
 * the expert's live link stops booking anything the moment the call is off, and
 * nudges are cleared because a terminal engagement has nothing to wait for.
 *
 * Never throws. Never logs the reason text, either address, or the time.
 */
export async function cancelCall(input: CancelCallInput): Promise<CancelCallResult> {
  const { projectId, expertId, by } = input;
  const now = Number.isFinite(input.now) ? (input.now as number) : Date.now();

  const project = await getProject(projectId).catch(() => null);
  const pe = project?.experts.find(e => e.expert.id === expertId) ?? null;
  if (!project || !pe) return { ok: false, error: 'not_booked' };

  if (!pe.booking) return { ok: false, error: 'not_booked' };
  if (pe.booking.cancelledAt) return { ok: false, error: 'already_cancelled' };

  const window  = cancelWindow(now, pe.booking.startUtc);
  const fee     = lateCancelFee(pe.expertRate ?? 0);
  const outcome = cancelOutcome(by, window);

  // The one refusal that happens before the lock: a client cancelling late has
  // to have been shown the number first.
  if (by === 'client' && outcome.late && input.confirmLate !== true) {
    return { ok: false, error: 'late_not_confirmed', window, fee };
  }

  const lock = await claimBookingLock(projectId, expertId);
  if (lock === 'held_by_other') return { ok: false, error: 'locked' };

  const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 500) : '';

  let updated:  Project;
  let cancelled: BookingState;
  try {
    let written: BookingState | null = null;

    updated = await mutateExpert(projectId, expertId, current => {
      const booking = current.booking;
      if (!booking) throw new CancelRefused('not_booked');
      if (booking.cancelledAt) throw new CancelRefused('already_cancelled');

      written = {
        ...booking,
        // SEQUENCE + 1 on the same UID is what makes the attached METHOD:CANCEL
        // withdraw the event already sitting in both calendars.
        icsSequence:  booking.icsSequence + 1,
        cancelledAt:  now,
        cancelledBy:  by,
        cancelReason: reason || null,
        lateCancel:   outcome.late,
      };

      return {
        ...current,
        booking:   written,
        status:    outcome.status,
        // Nudges stop because the engagement is terminal: lib/nudges.shouldSchedule
        // answers 'no_stage' for a status that is not in NUDGE_STATUSES, and the
        // worker re-reads this state before sending, so a job already queued
        // finds nothing to match and sends nothing.
        nudges:    null,
        scheduling: current.scheduling
          ? { ...current.scheduling, pickTokenHash: null, pickTokenExpiry: null }
          : current.scheduling,
        updatedAt: Date.now(),
      };
    });

    cancelled = written ?? { ...pe.booking, icsSequence: pe.booking.icsSequence + 1 };
  } catch (err) {
    await releaseBookingLock(projectId, expertId);
    if (err instanceof CancelRefused) return { ok: false, error: err.error };
    console.error('[bookCall] cancel write failed:',
      err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return { ok: false, error: 'conflict' };
  }

  try {
    const fresh = updated.experts.find(e => e.expert.id === expertId) ?? pe;

    // ── Zoom. A failure here leaves an empty meeting nobody will join. ──
    if (cancelled.zoomMeetingId) await deleteZoomMeeting(cancelled.zoomMeetingId);

    // ── The two withdrawals ────────────────────────────────────────────
    const clientZone = await clientZoneOf(project);
    await sendCancellations({
      project,
      pe:      fresh,
      booking: cancelled,
      clientZone,
      feeDollars: outcome.clientCharged ? fee.clientCharge : null,
    });

    // ── The thread, and the event ──────────────────────────────────────
    const whenClient = formatSlotLine(cancelled.startUtc, clientZone);
    await appendMessage({
      projectId, expertId,
      direction: 'outbound',
      author:    'matchy',
      bodyClean: `The call on ${whenClient} is cancelled.`,
      summary:   `Cancelled ${whenClient}.`,
    });

    const firm = await getFirm(project.firmDomain).catch(() => null);
    await emitEngagementEvent({
      projectId, expertId, orgId: firm?.id ?? null,
      type:    'call_cancelled',
      payload: { by, late: outcome.late },
    });

    // ── The money, or the removal ──────────────────────────────────────
    if (outcome.clientCharged) await applyClientLateCancelMoney(project, fresh);
    if (outcome.expertRemoved) await removeExpertForFault(project, fresh, 'late_cancel');
  } catch (err) {
    // The cancel itself has already landed. A side effect that throws is worth
    // a count-only line and nothing more: re-running the whole thing would
    // double-charge.
    console.error('[bookCall] cancel side effect failed:',
      err instanceof Error ? err.message.slice(0, 120) : 'unknown');
  } finally {
    await releaseBookingLock(projectId, expertId);
  }

  return { ok: true, outcome, window, fee, booking: cancelled, project: updated };
}

/**
 * The engagement's SET NX lock, shared by every action that resolves a booking.
 * 'no_lock' means Redis is not configured or did not answer, and the caller
 * proceeds on the compare-and-set alone — the same fail-open rule
 * lib/outreachSteps.ts applies to the intro.
 */
async function claimBookingLock(
  projectId: string,
  expertId:  string,
): Promise<'claimed' | 'held_by_other' | 'no_lock'> {
  const redis = getUpstashClient();
  if (!redis) return 'no_lock';
  try {
    const result = await redis.set(`booking-lock:${projectId}:${expertId}`, '1', {
      ex: BOOKING_LOCK_TTL_S,
      nx: true,
    });
    return result ? 'claimed' : 'held_by_other';
  } catch (err) {
    console.warn('[bookCall] booking lock unavailable',
      JSON.stringify({ reason: err instanceof Error ? err.message.slice(0, 80) : 'unknown' }));
    return 'no_lock';
  }
}

/** Give the lock back on every exit. A failure costs at most the TTL. */
async function releaseBookingLock(projectId: string, expertId: string): Promise<void> {
  const redis = getUpstashClient();
  if (!redis) return;
  try {
    await redis.del(`booking-lock:${projectId}:${expertId}`);
  } catch {
    // The TTL cleans up.
  }
}

interface CancellationInput {
  project:    Project;
  pe:         ProjectExpert;
  booking:    BookingState;
  clientZone: string;
  /** Whole dollars charged, when the policy charged anything. */
  feeDollars: number | null;
}

/**
 * Both withdrawals, built the same way the confirmations are: one ICS per
 * recipient, each naming only that recipient, both carrying the SAME UID and
 * the SAME incremented SEQUENCE with METHOD:CANCEL, which is what removes the
 * event from a calendar instead of adding a third copy of it.
 *
 * The expert's copy never names the client, the project or any money. The
 * client's copy may name the expert (the booking revealed them) and is the only
 * one that may name the fee.
 */
async function sendCancellations(input: CancellationInput): Promise<void> {
  const { project, pe, booking, clientZone, feeDollars } = input;
  const projectId = project.id;
  const subject   = threadSubject(pe.outreachSubject);

  const expertZone = pe.scheduling?.expertTimezone
    ? resolveTimezone(pe.scheduling.expertTimezone)
    : clientZone;

  const clientEmail = clientAddressOf(project);
  const joinUrl     = pe.zoomJoinUrl ?? null;

  const expertIcs: IcsEvent = { ...expertIcsEvent({ pe, booking, joinUrl }), method: 'CANCEL' };
  const clientIcs: IcsEvent = { ...clientIcsEvent({ project, pe, booking, joinUrl }), method: 'CANCEL' };

  if (pe.contactEmail) {
    const email = cancelledEmail({
      expertFirstName: pe.expert.name,
      whenLabel:       formatSlotLine(booking.startUtc, expertZone),
      recipientEmail:  pe.contactEmail,
      subject,
    });
    await sendBookingEmail(
      pe.contactEmail, email.subject, email.text, email.html, expertIcs,
      { recipient: 'expert', projectId },
    );
  }

  if (clientEmail) {
    const whenClient = formatSlotLine(booking.startUtc, clientZone);
    const email = clientCancelledEmail({
      clientFirstName: await clientFirstNameOf(project),
      whenLabel:       whenClient,
      expertName:      pe.expert.name,
      feeDollars,
      recipientEmail:  clientEmail,
      subject:         `Call cancelled: ${whenClient}`,
    });
    await sendBookingEmail(
      clientEmail, email.subject, email.text, email.html, clientIcs,
      { recipient: 'client', projectId },
    );
  }
}
