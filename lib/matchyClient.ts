// lib/matchyClient.ts — the browser's single door onto Matchy's endpoints.
//
// Every client-side call for the relay lives here: bookmark / unbookmark,
// approve a drafted intro, read a thread, send a message, release a pending
// follow-up, and the per-project settings PATCH. One module so the shapes are
// declared once and a change on the API side is a change in one file.
//
// Rules this file encodes:
//   • Nothing throws. Every wrapper returns a discriminated result so callers
//     render an error instead of catching one.
//   • The client-side number only. `clientRate` and `clientCounterRate` are the
//     two numbers a client may see; `expertRate` and `expertCounterRate` are
//     never read here and never rendered by anything that imports this module.
//   • Matchy's status lines are written here, not at the call sites, so the
//     voice stays identical wherever an outcome surfaces.

import type {
  BookingState,
  Project,
  ProjectExpert,
  ProposedSlot,
  SchedulingOutcome,
  SchedulingState,
} from '../types';

// ─── Wire shapes ──────────────────────────────────────────────────────────────

/** What the bookmark endpoint says happened. Drives the line Matchy shows. */
export type BookmarkOutcome =
  | 'intro_sent'
  | 'intro_drafted'
  /**
   * No address on file, so Matchy went looking. The provider chain runs as a
   * background job (/api/jobs/contact-discovery) which sends the intro itself
   * when it finds one — nothing more for the client to do.
   */
  | 'contact_discovery_started'
  | 'contact_not_found'
  | 'contact_suppressed'
  | 'contact_check_unavailable'
  | 'intro_failed'
  /**
   * Walkthrough mode and no address on file. Matchy did NOT go looking (that
   * spends a provider credit) and nothing was sent. See lib/walkthrough.ts.
   */
  | 'walkthrough_held'
  // Async results from the discovery job, read back off the record.
  | 'contact_found'
  | 'contact_discovery_unavailable';

/** One thing the compliance screen wants removed before a message can go. */
export interface ScreenFinding {
  kind:  string;
  match: string;
  /** Plain sentence from the server telling the sender what to do. */
  hint:  string;
}

export interface MessageScreenResult {
  blocked:  boolean;
  findings: ScreenFinding[];
  /** True while a review-first message is drafted and waiting to be sent. */
  pending?: boolean;
  /** Why the message was never sent. Mirrors ConversationMessage.held. */
  held?:    'walkthrough' | 'disabled' | null;
}

/**
 * What Matchy read a message as. The last three arrive once an engagement is
 * being scheduled or has been booked and are mirrored from types.ReplyIntent so
 * a thread payload carrying one still types here.
 */
export type MessageIntent =
  | 'interested' | 'declined' | 'counter_rate' | 'conflict' | 'unclear'
  | 'time_chosen' | 'time_unavailable' | 'reschedule';

export interface ConversationMessage {
  id:           string;
  /**
   * Set when this message was written but HELD: 'walkthrough' while the project
   * has not been switched live, 'trial' while the firm has no card on file,
   * 'disabled' behind the environment kill switch.
   * A held message can never be released from the thread, so it renders a tag
   * rather than a Send button. Mutually exclusive with `pendingApproval`.
   */
  held?:        'walkthrough' | 'disabled' | 'trial' | null;
  /**
   * True while Matchy has written this message and is holding it for the
   * client's approval (review-first). Mirrors `screenResult.pending`; both are
   * honored so the UI is right whichever the payload carries.
   */
  pendingApproval?: boolean;
  direction:    'inbound' | 'outbound';
  author:       'client' | 'expert' | 'matchy';
  body:         string;
  summary:      string | null;
  intent:       MessageIntent | null;
  screenResult: MessageScreenResult | null;
  /** ISO 8601. */
  createdAt:    string;
}

/**
 * The client-side counter rate Matchy derives when an expert asks for more:
 * clientRateFor(expertCounterRate), rounded up to the next $50. The API ships
 * it as `clientCounterRate` (types.ts); `counterClientRate` is accepted as an
 * alias so the UI works whichever name a payload carries. When neither is
 * present the thread renders the summary and no decision buttons — it never
 * derives the number from the expert-side one, which clients never receive.
 */
export interface ProjectExpertWithCounter extends ProjectExpert {
  counterClientRate?: number | null;
}

/** The client-side counter rate on an expert, or null when there isn't one. */
export function clientCounterRateOf(pe: ProjectExpertWithCounter): number | null {
  const value = pe.clientCounterRate ?? pe.counterClientRate;
  return typeof value === 'number' && value > 0 ? value : null;
}

/** Whether a message is written but still waiting on the client to send it. */
export function isPendingApproval(message: ConversationMessage): boolean {
  if (isHeld(message)) return false;
  return message.pendingApproval === true || message.screenResult?.pending === true;
}

/** Whether a message was written but held — walkthrough mode, or the kill switch. */
export function isHeld(message: ConversationMessage): boolean {
  return !!(message.held ?? message.screenResult?.held);
}

export interface ThreadPayload {
  messages:      ConversationMessage[];
  projectExpert: ProjectExpertWithCounter;
}

// ─── Result type ──────────────────────────────────────────────────────────────

export interface MatchyFailure {
  ok:        false;
  /** Machine code from the API — 'read_only', 'message_blocked', … */
  error:     string;
  /** Something a person can read. Always present. */
  message:   string;
  status:    number;
  /** Present on a 422 message_blocked. */
  findings?: ScreenFinding[];
}

export type MatchyResult<T> = ({ ok: true } & T) | MatchyFailure;

const NETWORK_FAILURE: MatchyFailure = {
  ok:      false,
  error:   'network',
  message: "Couldn't reach the server. Try again.",
  status:  0,
};

/** Errors that get a written line rather than the raw code. */
const ERROR_LINES: Record<string, string> = {
  already_engaged:          'This expert has already moved past the shortlist.',
  outreach_already_started: "Matchy has already written to this expert — you can't undo that now.",
  read_only:                'Only the project owner can message experts.',
  activation_required:      'Going live needs a card on file for your firm. Add one in Settings → Payment method.',
  status_not_client_settable: 'That stage is set by Matchy as the engagement progresses.',
  forbidden:                'Only the project owner can do that.',
  message_blocked:          'This message needs an edit before it can go.',
  thread_not_started:       "I haven't written to this expert yet — nothing to reply to.",
  text_required:            'Write something first.',
  text_too_long:            'That message is too long. Trim it and send again.',
  not_pending:              'That one has already gone.',
  not_awaiting_approval:    'That intro has already gone.',
  contact_suppressed:       'This expert has asked not to be contacted.',
  invalid_review_first:     "Couldn't save that setting.",
  invalid_client_rate_min:  'Rates are whole dollars, at least $100, in $50 steps.',
  invalid_client_rate_max:  'Rates are whole dollars, at least $100, in $50 steps.',
  invalid_client_rate_band: 'The lowest rate has to be at or below the highest.',
  walkthrough_mode:         'Nothing is sent in walkthrough mode. Switch the project to live first.',
  invalid_walkthrough:      "Couldn't save that setting.",
  not_ready_to_schedule:    'Terms are not settled yet. I propose times once the rate is agreed.',
  nothing_booked:           'There is no call to move yet.',
};

interface ApiError {
  error?:    string;
  message?:  string;
  findings?: ScreenFinding[];
}

/**
 * One fetch, one shape. `body` is JSON-encoded when present; a missing or
 * unparseable body still yields a MatchyFailure rather than a throw.
 */
async function request<T>(
  url: string,
  init: { method: 'GET' | 'POST' | 'PATCH'; body?: unknown },
): Promise<MatchyResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method:  init.method,
      ...(init.body !== undefined && {
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(init.body),
      }),
    });
  } catch {
    return NETWORK_FAILURE;
  }

  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }

  if (!res.ok) {
    const err  = (payload ?? {}) as ApiError;
    const code = err.error ?? `http_${res.status}`;
    return {
      ok:      false,
      error:   code,
      message: err.message ?? ERROR_LINES[code] ?? 'Something went wrong. Try again.',
      status:  res.status,
      ...(Array.isArray(err.findings) && { findings: err.findings }),
    };
  }

  return { ok: true, ...((payload ?? {}) as T) };
}

// ─── Paths ────────────────────────────────────────────────────────────────────

const expertBase = (projectId: string, expertId: string) =>
  `/api/projects/${encodeURIComponent(projectId)}/experts/${encodeURIComponent(expertId)}`;

// ─── Engagement ───────────────────────────────────────────────────────────────

/** Saves the expert and starts the engagement. 409 when it already started. */
export function bookmarkExpert(
  projectId: string,
  expertId: string,
): Promise<MatchyResult<{ projectExpert: ProjectExpertWithCounter; outcome: BookmarkOutcome }>> {
  return request(`${expertBase(projectId, expertId)}/bookmark`, { method: 'POST', body: {} });
}

/** Undoes a bookmark. 409 once Matchy has written to the expert. */
export function unbookmarkExpert(
  projectId: string,
  expertId: string,
): Promise<MatchyResult<{ projectExpert: ProjectExpertWithCounter | null }>> {
  return request(`${expertBase(projectId, expertId)}/unbookmark`, { method: 'POST', body: {} });
}

/** Sends an intro that was drafted because the project is on review-first. */
export function approveOutreach(
  projectId: string,
  expertId: string,
): Promise<MatchyResult<{ projectExpert: ProjectExpertWithCounter }>> {
  return request(`${expertBase(projectId, expertId)}/outreach/approve`, { method: 'POST', body: {} });
}

// ─── Thread ───────────────────────────────────────────────────────────────────

export function fetchThread(
  projectId: string,
  expertId: string,
): Promise<MatchyResult<ThreadPayload>> {
  return request(`${expertBase(projectId, expertId)}/messages`, { method: 'GET' });
}

/**
 * Sends a client message. A 422 comes back with `findings` — the caller shows
 * them inline and keeps the draft.
 */
export function sendMessage(
  projectId: string,
  expertId: string,
  text: string,
): Promise<MatchyResult<{ message: ConversationMessage }>> {
  return request(`${expertBase(projectId, expertId)}/messages`, { method: 'POST', body: { text } });
}

/** Releases a follow-up that Matchy drafted and held for review. */
export function sendPendingMessage(
  projectId: string,
  expertId: string,
  messageId: string,
): Promise<MatchyResult<{ message?: ConversationMessage }>> {
  return request(
    `${expertBase(projectId, expertId)}/messages/${encodeURIComponent(messageId)}/send`,
    { method: 'POST', body: {} },
  );
}

// ─── Scheduling ───────────────────────────────────────────────────────────────

export interface ProposeTimesBody {
  /** 'initial' offers times for the first call; 'reschedule' moves a booked one. */
  reason:       'initial' | 'reschedule';
  /** The client's stated preference, at most 200 characters. Screened server side. */
  preferences?: string;
}

/** The most a preference line may carry. Mirrors the API's own limit. */
export const PREFERENCES_MAX = 200;

export interface ProposeTimesResult {
  projectExpert: ProjectExpertWithCounter;
  outcome:       SchedulingOutcome;
  /** True in walkthrough mode: the proposal was written and nothing was sent. */
  held?:         boolean;
}

/**
 * Asks Matchy to propose call times, or to move a booked call.
 *
 * A 422 `message_blocked` comes back with `findings` for the preference line —
 * the caller renders them exactly as the composer does and keeps the text. A
 * 409 is a precondition (`not_ready_to_schedule`, `nothing_booked`); both have
 * written lines in ERROR_LINES so no code reaches the screen.
 */
export function proposeTimes(
  projectId: string,
  expertId:  string,
  body:      ProposeTimesBody,
): Promise<MatchyResult<ProposeTimesResult>> {
  return request(`${expertBase(projectId, expertId)}/propose-times`, { method: 'POST', body });
}

/** The calendar file for the booked call. Any project member may download it. */
export function bookingIcsUrl(projectId: string, expertId: string): string {
  return `${expertBase(projectId, expertId)}/booking/ics`;
}

// ─── Project settings ─────────────────────────────────────────────────────────

export interface MatchySettingsPatch {
  /**
   * `false` switches the project LIVE. Anything else (true, absent) is
   * walkthrough. Going live without also naming `reviewFirst` lands on
   * review-first — the API does that, not the caller.
   */
  walkthrough?:   boolean;
  reviewFirst?:   boolean;
  clientRateMin?: number | null;
  clientRateMax?: number | null;
}

export function updateMatchySettings(
  projectId: string,
  patch: MatchySettingsPatch,
): Promise<MatchyResult<{ project: Project }>> {
  return request(`/api/projects/${encodeURIComponent(projectId)}`, { method: 'PATCH', body: patch });
}

// ─── Matchy's voice ───────────────────────────────────────────────────────────

/**
 * The first name a client is allowed to see. Anonymized experts arrive as
 * "Scott S.", so the first token is the whole of it.
 */
export function firstNameOf(name: string | undefined | null): string {
  const first = (name ?? '').trim().split(/\s+/)[0];
  return first || 'them';
}

/** Matchy's one line for a bookmark outcome. First person, no filler. */
export function bookmarkLine(outcome: BookmarkOutcome, firstName: string): string {
  switch (outcome) {
    case 'intro_sent':
      return `Sent ${firstName} the intro. I'll let you know when they reply.`;
    case 'intro_drafted':
      return 'Intro drafted — review and send.';
    // The search is running in the background and will send the intro itself
    // if it lands — this is the one line that promises something happening.
    case 'contact_discovery_started':
      return `Looking for an address for ${firstName}. This usually takes a minute.`;
    // Nothing else retries on its own, so these lines say what the client has
    // to do. Re-bookmarking now re-runs discovery, which is why the
    // contact_not_found line still points at bookmarking again.
    case 'contact_not_found':
      return `No address on file for ${firstName} yet. Bookmark again to retry, or pass.`;
    case 'contact_suppressed':
      return `${firstName} has asked not to be contacted.`;
    case 'contact_check_unavailable':
      return "Couldn't check for an address just now. Bookmark again in a minute.";
    case 'intro_failed':
      return "The intro didn't send. Bookmark again to retry.";
    case 'contact_found':
      return `Found an address for ${firstName}. Sending the intro now.`;
    case 'contact_discovery_unavailable':
      return "Address lookup isn't available right now. Bookmark again later.";
    // Walkthrough: say what would happen, and that it did not.
    case 'walkthrough_held':
      return `Walkthrough mode. I would look up an address and send ${firstName} the intro here. Nothing was sent.`;
  }
}

/**
 * Matchy's line for an expert as loaded from the server (after a poll or a
 * page load), derived from the client-safe `matchyOutcome` the API sets.
 * Null when there is nothing to say yet.
 */
export function matchyLineFor(
  pe: { status: string; matchyOutcome?: string },
  firstName: string,
): { text: string; tone: 'default' | 'quiet' } | null {
  const outcome = pe.matchyOutcome;
  if (!outcome || !isBookmarkOutcome(outcome)) return null;
  // These three only describe an engagement that never got off the ground. Once
  // the expert has moved on, a stale one would contradict the pipeline.
  if (pe.status !== 'bookmarked'
    && (outcome === 'contact_not_found' || outcome === 'contact_check_unavailable' || outcome === 'walkthrough_held')) {
    return null;
  }
  return {
    text: bookmarkLine(outcome, firstName),
    tone: outcome === 'intro_sent' || outcome === 'intro_drafted' || outcome === 'contact_found' ? 'default' : 'quiet',
  };
}

const BOOKMARK_OUTCOMES: ReadonlySet<string> = new Set<BookmarkOutcome>([
  'intro_sent', 'intro_drafted', 'contact_discovery_started', 'contact_not_found',
  'contact_suppressed', 'contact_check_unavailable', 'intro_failed',
  'contact_found', 'contact_discovery_unavailable', 'walkthrough_held',
]);
function isBookmarkOutcome(value: string): value is BookmarkOutcome {
  return BOOKMARK_OUTCOMES.has(value);
}

/** The rate band's step and floor, mirrored from the API's validator. */
export const RATE_STEP  = 50;
export const RATE_FLOOR = 100;

/** True when a number is a rate the API will accept. */
export function isValidClientRate(value: number): boolean {
  return Number.isInteger(value) && value >= RATE_FLOOR && value % RATE_STEP === 0;
}

/** "$1,300" — whole dollars, the only money format the client UI uses. */
export function formatRate(dollars: number): string {
  return `$${Math.round(dollars).toLocaleString('en-US')}`;
}

// ─── Times ────────────────────────────────────────────────────────────────────
//
// Every instant Matchy stores is UTC. Every instant a client reads is in THEIR
// browser's zone, with the zone named next to it so a proposal is never
// ambiguous. `timeZone` is a parameter rather than a lookup so these two are
// testable against a fixed zone instead of the machine's.

const TIME_ZONE_UNSET = '';

function resolveZone(timeZone?: string): string {
  if (timeZone) return timeZone;
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || TIME_ZONE_UNSET;
  } catch {
    return TIME_ZONE_UNSET;
  }
}

interface ClockParts { clock: string; period: string; zone: string }

function clockParts(date: Date, timeZone: string): ClockParts | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      ...(timeZone && { timeZone }),
      hour:         'numeric',
      minute:       '2-digit',
      hour12:       true,
      timeZoneName: 'short',
    }).formatToParts(date);

    const at = (type: string) => parts.find(p => p.type === type)?.value ?? '';
    const hour   = at('hour');
    const minute = at('minute');
    if (!hour || !minute) return null;
    return { clock: `${hour}:${minute}`, period: at('dayPeriod'), zone: at('timeZoneName') };
  } catch {
    return null;
  }
}

/**
 * "Tue, Sep 15 · 2:00–3:00 PM EDT" — one slot, written the way a person reads
 * a calendar. The end is optional; the shared AM/PM is printed once when both
 * ends sit in the same half of the day. Returns '' for anything unparseable so
 * a bad instant renders as nothing rather than "Invalid Date".
 */
export function formatSlot(
  startUtc: string,
  endUtc?:  string | null,
  options?: { timeZone?: string },
): string {
  const start = new Date(startUtc);
  if (Number.isNaN(start.getTime())) return '';
  const zone = resolveZone(options?.timeZone);

  let day: string;
  try {
    day = new Intl.DateTimeFormat('en-US', {
      ...(zone && { timeZone: zone }),
      weekday: 'short',
      month:   'short',
      day:     'numeric',
    }).format(start);
  } catch {
    return '';
  }

  const from = clockParts(start, zone);
  if (!from) return day;

  const end = endUtc ? new Date(endUtc) : null;
  const to  = end && !Number.isNaN(end.getTime()) ? clockParts(end, zone) : null;

  const time = !to
    ? `${from.clock}${from.period ? ` ${from.period}` : ''}`
    : from.period === to.period
      ? `${from.clock}–${to.clock}${to.period ? ` ${to.period}` : ''}`
      : `${from.clock}${from.period ? ` ${from.period}` : ''}–${to.clock}${to.period ? ` ${to.period}` : ''}`;

  const zoneName = (to ?? from).zone;
  return `${day} · ${time}${zoneName ? ` ${zoneName}` : ''}`;
}

/** "EDT" — the short name of the zone the times above are written in. */
export function viewerZoneLabel(timeZone?: string): string {
  const zone = resolveZone(timeZone);
  const parts = clockParts(new Date(), zone);
  return parts?.zone || zone;
}

// ─── Matchy's scheduling voice ────────────────────────────────────────────────

export interface MatchyStatusLine {
  text: string;
  tone: 'default' | 'quiet' | 'alert';
  /** Where the client has to go to unblock this, when there is such a place. */
  href?: string;
}

/** The shape schedulingLine reads. Anything with a status and the two states. */
export interface SchedulableExpert {
  status:      string;
  scheduling?: SchedulingState | null;
  booking?:    BookingState | null;
}

/** Statuses where a scheduling line would only be stale. */
const SCHEDULING_LINE_SILENT: ReadonlySet<string> = new Set([
  'completed', 'rejected', 'rejected_after_outreach',
]);

/**
 * Matchy's one line about where this call stands. Null when there is nothing to
 * say yet, and null once the call is done — a finished engagement gets its
 * wrap-up, not "waiting on their pick".
 *
 * A booked call outranks whatever proposal line came before it, so a payload
 * whose `scheduling.outcome` lags behind `status` still reads correctly.
 */
export function schedulingLine(
  pe:        SchedulableExpert,
  firstName: string,
  options?:  { timeZone?: string },
): MatchyStatusLine | null {
  if (SCHEDULING_LINE_SILENT.has(pe.status)) return null;

  const booking = pe.booking ?? null;
  const outcome = pe.scheduling?.outcome ?? null;

  const bookedLine = (): MatchyStatusLine => {
    const when = booking ? formatSlot(booking.startUtc, booking.endUtc, options) : '';
    return {
      text: when
        ? `Booked ${when}. The Zoom link is on this card.`
        : `Booked a time with ${firstName}. The Zoom link is on this card.`,
      tone: 'default',
    };
  };

  // The call is on the calendar and nobody has asked to move it.
  if (pe.status === 'scheduled' && booking && outcome !== 'reschedule_requested') return bookedLine();

  if (!outcome) return null;

  switch (outcome) {
    case 'times_proposed': {
      const n = pe.scheduling?.proposed.length ?? 0;
      if (n === 0) return { text: `Sent ${firstName} a link to pick a time.`, tone: 'default' };
      return {
        text: `Proposed ${n} time${n === 1 ? '' : 's'} to ${firstName}. Waiting on their pick.`,
        tone: 'default',
      };
    }
    case 'link_sent':
      return { text: `Sent ${firstName} a link to pick a time.`, tone: 'default' };
    case 'expert_declined_times':
      return {
        text: `${firstName} could not make any of the times. Add more hours in Settings, or propose different ones.`,
        tone: 'alert',
        href: '/settings',
      };
    case 'booked':
      return bookedLine();
    case 'reschedule_requested':
      return { text: `Finding a new time with ${firstName}.`, tone: 'default' };
    case 'no_client_availability':
      return {
        text: 'I need your hours first. Connect a calendar or add weekly hours in Settings.',
        tone: 'alert',
        href: '/settings',
      };
  }
}

/** The proposals currently on the table, oldest first. Never more than three. */
export function proposedSlotsOf(pe: SchedulableExpert): ProposedSlot[] {
  const slots = pe.scheduling?.proposed;
  return Array.isArray(slots) ? slots : [];
}
