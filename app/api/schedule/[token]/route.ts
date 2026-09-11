// The expert's time picker, server side. Public — no session, no account.
//
//   GET  /api/schedule/:token  → what to render
//   POST /api/schedule/:token  → { action: 'pick' } books it
//                                { action: 'unavailable' } says none work
//                                { action: 'cancel' } cancels a booked call
//
// CANCELLING, added in Wave 5 (docs/CALL_POLICIES_DRAFT.md founder decisions 1
// and 3). More than 24 hours out it is free. Inside 24 hours it is a LATE
// cancel, which under the approved policy REMOVES the expert from the platform
// (lib/expertRemoval.ts), so the page says exactly that and the POST refuses
// with `409 late_not_confirmed` until the body carries `confirmLate: true`.
// The expert is never charged and never told a number.
//
// AFTER A CANCEL THE LINK IS DEAD. lib/bookCall.cancelCall clears
// `scheduling.pickTokenHash` in the same compare-and-set that writes the
// cancellation, so the very next request fails the revocation check and gets
// the ordinary `410 { error: 'expired' }` every revoked link gets. The
// `cancelled` flag on the GET payload and the `410 { error: 'booking_cancelled' }`
// on the actions cover the other way a booking can be cancelled under a live
// token (a staff cancel through the admin path, or a token minted again for a
// later round).
//
// ACCESS is the signed picker token and nothing else: HMAC signature, 7-day
// expiry (lib/availabilityToken.ts), and SHA-256(token) equal to the hash
// stored on `scheduling.pickTokenHash`. That last check is the revocation:
// every proposal round mints a fresh token and overwrites the hash, so an old
// link in an old email stops working the moment a new one is sent. A held
// walkthrough send stores no hash at all, so its preview link books nothing.
//
// WHAT AN EXPERT MAY LEARN HERE, exhaustively: their own first name, the
// generalized research topic, the proposed times, some further free windows,
// and whether a call is already booked. NOT the client's name, NOT the firm,
// NOT the project name, NOT any rate, NOT the client's email. The response
// shape below is the whole contract, and it is built field by field rather
// than by spreading a record.
//
// RATE LIMIT: 10 requests / 10 min per token, the same budget the retired
// availability route carried, because POST 'unavailable' can cost a model call.
//
// Never logs: the token, the expert's name or address, the project name, the
// reply text, or the chosen time.

import { NextRequest, NextResponse } from 'next/server';
import { verifyAvailabilityToken, hashToken } from '../../../../lib/availabilityToken';
import { getProject } from '../../../../lib/projectStore';
import { createRateLimiterStore } from '../../../../lib/rateLimiter';
import { deriveTopic, firstNameOf } from '../../../../lib/matchyTemplates';
import { normalizeTimezone } from '../../../../lib/calendarConnections';
import { screenMessage } from '../../../../lib/matchyScreen';
import { appendMessage } from '../../../../lib/conversations';
import { emitEngagementEvent } from '../../../../lib/engagementEvents';
import { getFirm } from '../../../../lib/firmStore';
import { bookCall, cancelCall, rebookCall } from '../../../../lib/bookCall';
import {
  CALL_DURATION_MIN,
  MAX_PROPOSAL_ROUNDS,
  clientFreeWindows,
  emptySchedulingState,
  expertHasConnectedCalendar,
  expertKnownWindows,
  intersectRanges,
  pickProposals,
  parseSchedulingReply,
  pickerUrlFor,
  proposeTimes,
  slotsToUtcRanges,
  writeExpert,
} from '../../../../lib/matchyScheduling';
import { noTimesLeftEmail, threadSubject } from '../../../../lib/schedulingTemplates';
import { sendSequenceEmail } from '../../../../lib/emailSequence';
import { isWalkthrough, WALKTHROUGH_HELD_SUMMARY } from '../../../../lib/walkthrough';
import { cleanEmailBody } from '../../../../lib/emailClean';
import { cancelWindow as windowFor, type CancelWindow } from '../../../../lib/callPolicies';
import type { AvailabilitySlot, Project, ProjectExpert, ProposedSlot } from '../../../../types';

const MAX_BODY       = 4096;
const MAX_TEXT_CHARS = 800;
const MAX_MORE_SLOTS = 8;
const TEN_MIN_MS     = 10 * 60 * 1000;

const _rlStore = (() => { try { return createRateLimiterStore(); } catch { return null; } })();

async function withinRateLimit(tokenHash: string): Promise<boolean> {
  if (!_rlStore) return true; // store unavailable — allow, as the old route did
  // Fail open on a store error too, not only on a store that would not build.
  // Upstash can reject a live call (quota, outage); an unhandled rejection here
  // 500s the expert's picker at the moment they are trying to book.
  try {
    const { count } = await _rlStore.increment(`rl:schedule:${tokenHash.slice(0, 16)}:10m`, TEN_MIN_MS);
    return count <= 10;
  } catch {
    return true;
  }
}

// ─── Token resolution ─────────────────────────────────────────────────────────

type Resolved =
  | { ok: true;  project: Project; pe: ProjectExpert; tokenHash: string }
  | { ok: false; status: number; error: string };

/**
 * Signature, expiry, and the stored hash. Every failure answers 410 `expired`
 * with the SAME body, so a probe cannot tell a revoked link from a wrong
 * project from an expert who is not on it.
 */
async function resolveToken(rawToken: string): Promise<Resolved> {
  const verified = verifyAvailabilityToken(rawToken);
  if (!verified.ok) {
    return { ok: false, status: verified.reason === 'expired' ? 410 : 400, error: verified.reason };
  }
  if (verified.data.type !== 'expert' || !verified.data.expertId) {
    return { ok: false, status: 400, error: 'malformed' };
  }

  const project = await getProject(verified.data.projectId).catch(() => null);
  if (!project) return { ok: false, status: 410, error: 'expired' };

  const pe = project.experts.find(e => e.expert.id === verified.data.expertId);
  if (!pe) return { ok: false, status: 410, error: 'expired' };

  const tokenHash = hashToken(rawToken);
  if (!pe.scheduling?.pickTokenHash || pe.scheduling.pickTokenHash !== tokenHash) {
    return { ok: false, status: 410, error: 'expired' };
  }
  const expiry = pe.scheduling.pickTokenExpiry;
  if (typeof expiry === 'number' && Date.now() > expiry) {
    return { ok: false, status: 410, error: 'expired' };
  }

  return { ok: true, project, pe, tokenHash };
}

// ─── The payload the page renders ─────────────────────────────────────────────

// NOT exported: Next rejects a non-handler export from a route file. The client
// component declares the same shape (components/SchedulePicker.tsx) — the two
// are kept in step by the one call site that crosses between them.
interface SchedulePayload {
  proposed:        ProposedSlot[];
  /** Further client-free windows, offered behind "None of these work". */
  more:            ProposedSlot[];
  durationMin:     number;
  expertFirstName: string;
  /** The generalized research clause. Never the project name. */
  topic:           string;
  /** True once a calendar provider is linked, so the page can say so. */
  calendarLinked:  boolean;
  /** Set when a call is already booked, so the page shows it instead. */
  booked:          { startUtc: string; endUtc: string } | null;
  /** True once that booking has been cancelled: nothing on this link acts. */
  cancelled:       boolean;
  /**
   * Whether cancelling RIGHT NOW would be late. The picker renders the removal
   * warning and demands a confirm when it is 'late' or 'started'.
   */
  cancelWindow:    CancelWindow | null;
}

/**
 * The extra windows behind "None of these work". Computed the same way the
 * proposals were, minus the ones already on screen, so a slot can never appear
 * in both lists.
 */
async function moreWindowsFor(
  project:  Project,
  pe:       ProjectExpert,
  proposed: readonly ProposedSlot[],
): Promise<ProposedSlot[]> {
  const client = await clientFreeWindows(project);
  if (client.ranges.length === 0) return [];

  let ranges = client.ranges;
  const expertSlots = await expertKnownWindows(project.id, pe);
  if (expertSlots.length > 0) {
    const overlap = intersectRanges(
      client.ranges,
      slotsToUtcRanges(expertSlots, pe.scheduling?.expertTimezone ?? client.timezone),
    );
    if (overlap.length > 0) ranges = overlap;
    else if (expertHasConnectedCalendar(pe)) return [];
  }

  return pickProposals(ranges, {
    timezone:    client.timezone,
    count:       MAX_MORE_SLOTS,
    durationMin: CALL_DURATION_MIN,
    preferences: pe.scheduling?.preferences ?? null,
    exclude:     proposed.map(slot => slot.startUtc),
  });
}

// ─── GET ──────────────────────────────────────────────────────────────────────

export async function GET(
  request: NextRequest,
  { params }: { params: { token: string } },
): Promise<NextResponse> {
  const rawToken = decodeURIComponent(params.token);

  const resolved = await resolveToken(rawToken);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }

  if (!(await withinRateLimit(resolved.tokenHash))) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429, headers: { 'Retry-After': '600' } });
  }

  const { project, pe } = resolved;
  const firm = await getFirm(project.firmDomain).catch(() => null);
  const proposed = pe.scheduling?.proposed ?? [];

  const payload: SchedulePayload = {
    proposed,
    // `more` is the fallback list behind "None of these work" and is computed
    // from live calendar data. If that lookup fails the expert must still see
    // the times already proposed, so it degrades to empty rather than throwing.
    more:            pe.booking ? [] : await moreWindowsFor(project, pe, proposed).catch(() => []),
    durationMin:     pe.booking?.durationMin ?? CALL_DURATION_MIN,
    expertFirstName: firstNameOf(pe.expert.name),
    topic:           deriveTopic(project, { denyTerms: firm?.name ? [firm.name] : [] }),
    calendarLinked:  expertHasConnectedCalendar(pe),
    booked:          pe.booking ? { startUtc: pe.booking.startUtc, endUtc: pe.booking.endUtc } : null,
    cancelled:       Boolean(pe.booking?.cancelledAt),
    cancelWindow:    pe.booking ? windowFor(Date.now(), pe.booking.startUtc) : null,
  };

  return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store' } });
}

// ─── POST ─────────────────────────────────────────────────────────────────────

export async function POST(
  request: NextRequest,
  { params }: { params: { token: string } },
): Promise<NextResponse> {
  if (!request.headers.get('content-type')?.includes('application/json')) {
    return NextResponse.json({ error: 'content_type_required' }, { status: 415 });
  }

  const contentLength = request.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > MAX_BODY) {
    return NextResponse.json({ error: 'request_too_large' }, { status: 413 });
  }

  let raw: string;
  try { raw = await request.text(); } catch {
    return NextResponse.json({ error: 'read_error' }, { status: 400 });
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY) {
    return NextResponse.json({ error: 'request_too_large' }, { status: 413 });
  }

  let body: Record<string, unknown>;
  try { body = JSON.parse(raw) as Record<string, unknown>; } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const action = body.action;
  if (action !== 'pick' && action !== 'unavailable' && action !== 'cancel') {
    return NextResponse.json({ error: 'invalid_action' }, { status: 400 });
  }

  const rawToken = decodeURIComponent(params.token);
  const resolved = await resolveToken(rawToken);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }

  if (!(await withinRateLimit(resolved.tokenHash))) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429, headers: { 'Retry-After': '600' } });
  }

  const { project, pe } = resolved;

  // A cancelled booking is the end of this link's usefulness. The token itself
  // is normally already revoked (cancelCall clears the hash), so this only
  // catches a cancel that happened some other way.
  if (pe.booking?.cancelledAt) {
    return NextResponse.json({ error: 'booking_cancelled' }, { status: 410 });
  }

  // The zone the expert's own browser reported. Validated against the runtime's
  // zone database before it can be stored (lib/calendarConnections).
  const timezone = normalizeTimezone(body.timezone);
  if (timezone && pe.scheduling && pe.scheduling.expertTimezone !== timezone) {
    await writeExpert(project.id, pe.expert.id, {
      scheduling: { ...pe.scheduling, expertTimezone: timezone },
    }).catch(() => undefined);
  }

  try {
    if (action === 'pick')   return await handlePick(project, pe, body);
    if (action === 'cancel') return await handleCancel(project, pe, body);
    return await handleUnavailable(project, pe, body, rawToken);
  } catch (err) {
    console.error('[schedule] action failed:',
      err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return NextResponse.json({ error: 'schedule_failed' }, { status: 500 });
  }
}

// ─── pick ─────────────────────────────────────────────────────────────────────

/**
 * The expert chose a time.
 *
 * The chosen start must be one WE offered — a proposal or one of the extra
 * windows — so a crafted body cannot book 3am on a Sunday or a slot the client
 * is busy for. A reschedule request in flight rebooks the existing call rather
 * than creating a second one.
 */
async function handlePick(
  project: Project,
  pe:      ProjectExpert,
  body:    Record<string, unknown>,
): Promise<NextResponse> {
  const startUtc = typeof body.startUtc === 'string' ? body.startUtc.trim() : '';
  if (!startUtc || !Number.isFinite(Date.parse(startUtc))) {
    return NextResponse.json({ error: 'invalid_time' }, { status: 400 });
  }

  const proposed = pe.scheduling?.proposed ?? [];
  const offered  = new Set<string>([
    ...proposed.map(slot => new Date(slot.startUtc).toISOString()),
    ...(await moreWindowsFor(project, pe, proposed)).map(slot => slot.startUtc),
  ]);

  const normalized = new Date(startUtc).toISOString();
  if (!offered.has(normalized)) {
    return NextResponse.json({ error: 'slot_unavailable' }, { status: 409 });
  }

  // A BOOKING ALREADY EXISTS means this is a MOVE, full stop. Keying off
  // `scheduling.outcome` instead would let an edge case (a reschedule ask that
  // found no overlap, so the outcome read differently) call bookCall on a
  // booked engagement, which would create a SECOND Zoom meeting and reset the
  // ICS sequence to 0 — two events in everyone's calendar.
  const moving = Boolean(pe.booking);

  const result = moving
    ? await rebookCall({ projectId: project.id, expertId: pe.expert.id, startUtc: normalized, by: 'expert' })
    : await bookCall({
      projectId: project.id, expertId: pe.expert.id,
      startUtc: normalized, durationMin: CALL_DURATION_MIN, by: 'expert',
    });

  if (!result.ok) {
    const status = result.reason === 'invalid_time' ? 400 : 500;
    return NextResponse.json({ error: result.reason }, { status });
  }

  return NextResponse.json({
    ok: true,
    booked: {
      startUtc: result.booking.startUtc,
      endUtc:   result.booking.endUtc,
      joinUrl:  result.joinUrl,
    },
  });
}

// ─── cancel ───────────────────────────────────────────────────────────────────

/**
 * The expert is cancelling a booked call.
 *
 * lib/bookCall.cancelCall owns every consequence: the state, the Zoom meeting,
 * the two METHOD:CANCEL withdrawals, the thread line and, for a LATE cancel,
 * the removal from the platform. This handler is the token-gated door in front
 * of it, and the one thing it adds is the confirm: a late cancel comes back
 * `409 { error: 'late_not_confirmed' }` until the body says `confirmLate: true`,
 * which is what makes the picker's warning unskippable.
 *
 * No money is ever mentioned to an expert. `fee` is deliberately not echoed.
 */
async function handleCancel(
  project: Project,
  pe:      ProjectExpert,
  body:    Record<string, unknown>,
): Promise<NextResponse> {
  if (!pe.booking) {
    return NextResponse.json({ error: 'not_booked' }, { status: 409 });
  }

  const window = windowFor(Date.now(), pe.booking.startUtc);
  if (window !== 'free' && body.confirmLate !== true) {
    return NextResponse.json({ error: 'late_not_confirmed', window }, { status: 409 });
  }

  const result = await cancelCall({
    projectId: project.id,
    expertId:  pe.expert.id,
    by:        'expert',
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 409 });
  }

  return NextResponse.json({ ok: true, cancelled: true, window: result.window });
}

// ─── unavailable ──────────────────────────────────────────────────────────────

/**
 * None of the offered times work.
 *
 * The free text is SCREENED expert→client before it is stored, the same way an
 * inbound email is, and the windows the expert typed are recorded on
 * `availabilitySlots` so the next round can intersect against them. Then:
 *
 *   round < MAX_PROPOSAL_ROUNDS → propose again (proposeTimes does the whole
 *                                 job, including a fresh token and the email)
 *   otherwise                   → stop guessing, send `noTimesLeftEmail`, and
 *                                 record 'expert_declined_times' so the client
 *                                 sees that Matchy has run out of overlap
 */
async function handleUnavailable(
  project:  Project,
  pe:       ProjectExpert,
  body:     Record<string, unknown>,
  rawToken: string,
): Promise<NextResponse> {
  const text = typeof body.text === 'string'
    ? body.text.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, MAX_TEXT_CHARS).trim()
    : '';

  const state = pe.scheduling ?? emptySchedulingState();
  const firm  = await getFirm(project.firmDomain).catch(() => null);
  const orgId = firm?.id ?? null;

  let windows: AvailabilitySlot[] = [];

  if (text) {
    const screened = screenMessage({
      text,
      direction:        'expert_to_client',
      identityRevealed: false,
      expertFullName:   pe.expert.name,
      clientFullName:   project.clientName ?? undefined,
    });

    await appendMessage({
      projectId: project.id,
      expertId:  pe.expert.id,
      direction: 'inbound',
      author:    'expert',
      bodyClean: text,
      summary:   'None of those times work. They said when they are free.',
      intent:    'time_unavailable',
      screenResult: screened,
    });

    // The same one-call parser the inbound path uses, so a window typed here
    // and a window emailed back are read identically.
    const read = await parseSchedulingReply({
      text,
      proposed:     state.proposed,
      timezoneHint: state.expertTimezone,
    });
    if (read.kind === 'unavailable') windows = read.windows;

    // Windows the expert TYPED become their availability, but they never
    // DEMOTE a connected calendar: `calendarProvider` is only set to 'manual'
    // when there is no provider yet or it is already 'manual'. An expert who
    // linked Google and then writes "none of these work, try Tuesday" stays a
    // connected calendar as far as
    // lib/matchyScheduling.expertHasConnectedCalendar is concerned, so later
    // rounds keep reading their real free/busy — the most informative signal we
    // have — instead of one sentence (M-33). The typed windows are still stored
    // and are what expertKnownWindows falls back to when no provider is linked.
    const keepsProvider = pe.calendarProvider && pe.calendarProvider !== 'manual';
    await writeExpert(project.id, pe.expert.id, {
      availabilityRaw:   text,
      replyIntent:       'time_unavailable',
      ...(windows.length > 0 ? {
        availabilitySlots:     windows,
        availabilitySubmitted: true,
        ...(keepsProvider ? {} : { calendarProvider: 'manual' as const }),
      } : {}),
    });
  }

  await emitEngagementEvent({
    projectId: project.id, expertId: pe.expert.id, orgId,
    type:    'time_declined',
    payload: { round: state.round, viaPicker: true, hasText: text.length > 0 },
  });

  // Another round, if we have one left.
  if (state.round < MAX_PROPOSAL_ROUNDS) {
    const fresh = await getProject(project.id).catch(() => null);
    const freshPe = fresh?.experts.find(e => e.expert.id === pe.expert.id);
    if (fresh && freshPe) {
      const result = await proposeTimes({
        project: fresh, pe: freshPe, reason: 'initial', trigger: 'matchy',
      });
      if (result.outcome) return NextResponse.json({ ok: true, outcome: result.outcome });
    }
  }

  // Out of rounds. Say so once, and let a person take it from here.
  await sendNoTimesLeft(project, pe, rawToken);

  await writeExpert(project.id, pe.expert.id, {
    scheduling: { ...state, outcome: 'expert_declined_times' },
  });

  return NextResponse.json({ ok: true, outcome: 'expert_declined_times' });
}

/** The "I could not find an overlap" line, walkthrough-aware. */
async function sendNoTimesLeft(project: Project, pe: ProjectExpert, rawToken: string): Promise<void> {
  if (!pe.contactEmail || !pe.outreachToken) return;

  const subject = threadSubject(pe.outreachSubject);
  const email   = noTimesLeftEmail({
    expertFirstName: pe.expert.name,
    // The link they are already on. No NEW token is minted: this round is
    // over, and reusing the live one keeps exactly one working link per
    // engagement, which is what the revocation check depends on.
    pickUrl:         pickerUrlFor(rawToken),
    recipientEmail:  pe.contactEmail,
    subject,
  });

  const held = isWalkthrough(project);
  const outcome = held
    ? { sent: false as const }
    : await sendSequenceEmail(pe.contactEmail, subject, email.text, pe.outreachToken, 'no_times_left', {
      footerIncluded: true, html: email.html,
    }).catch(() => ({ sent: false as const }));

  await appendMessage({
    projectId: project.id,
    expertId:  pe.expert.id,
    direction: 'outbound',
    author:    'matchy',
    bodyClean: cleanEmailBody(email.text),
    summary:   outcome.sent
      ? 'No overlap left. Asked them to send windows that work.'
      : WALKTHROUGH_HELD_SUMMARY,
    ...(outcome.sent ? {} : { held: 'walkthrough' as const }),
  });
}
