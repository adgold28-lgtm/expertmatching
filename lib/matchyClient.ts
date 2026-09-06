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

import type { Project, ProjectExpert } from '../types';

// ─── Wire shapes ──────────────────────────────────────────────────────────────

/** What the bookmark endpoint says happened. Drives the line Matchy shows. */
export type BookmarkOutcome =
  | 'intro_sent'
  | 'intro_drafted'
  | 'contact_not_found'
  | 'contact_suppressed'
  | 'contact_check_unavailable'
  | 'intro_failed';

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
}

export type MessageIntent = 'interested' | 'declined' | 'counter_rate' | 'conflict' | 'unclear';

export interface ConversationMessage {
  id:           string;
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
  return message.pendingApproval === true || message.screenResult?.pending === true;
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

// ─── Project settings ─────────────────────────────────────────────────────────

export interface MatchySettingsPatch {
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
    case 'contact_not_found':
      return `Couldn't find an address for ${firstName} yet.`;
    case 'contact_suppressed':
      return `${firstName} has asked not to be contacted.`;
    case 'contact_check_unavailable':
      return "Couldn't verify an address right now — I'll retry.";
    case 'intro_failed':
      return "The intro didn't send. Try again.";
  }
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
