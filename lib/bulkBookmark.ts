// lib/bulkBookmark.ts — bookmarking several experts at once from Matches.
//
// THERE IS NO BULK ENDPOINT, ON PURPOSE. A bookmark is the client's consent for
// Matchy to write to a stranger, and every gate on that consent lives in ONE
// route: POST /api/projects/:id/experts/:expertId/bookmark (owner check,
// walkthrough, the card on file at the send chokepoint, the rate band, the
// do-not-contact lists). A second, bulk route would be a second copy of those
// gates to keep in step. So the browser calls the single route once per expert,
// two at a time, and this module decides what each answer means for the rest of
// the batch:
//
//   200            → bookmarked (whatever Matchy then did about the intro)
//   429            → wait (Retry-After when the server sends one, else 2s, 4s,
//                    8s, 16s) and try the same expert again; a wait longer
//                    than a minute, or a fifth 429, pauses the batch
//   503            → one more try after a short wait, then stop
//   401 / 403      → stop: this person cannot bookmark from here at all
//   account refusal → stop: the account cannot reach experts yet (no card,
//                    trial, walkthrough), so every next call would say the same
//   409 do_not_contact → skip this expert, carry on
//   409 already_engaged / 404 expert_not_found → skip, carry on
//   anything else  → skip as "didn't go through"; three in a row stops the batch
//
// Nothing here retries a 500 or a network failure on its own: a bookmark that
// half-ran on the server may already have queued an address search, and a
// silent second call would spend it twice. Those experts stay selected and the
// client presses Bookmark again.
//
// Pure apart from postBookmark (the one fetch) and the injectable sleep/now the
// runner defaults to. Tested by scripts/test-bulk-bookmark.ts.

import type { ExpertStatus, ProjectExpert } from '../types';

// ─── Limits ───────────────────────────────────────────────────────────────────

/** Two requests in flight. Each bookmark may send an intro inline, so more buys little and risks the limiter. */
export const BULK_BOOKMARK_CONCURRENCY = 2;
/** How many 429s one expert may get before the batch pauses. */
export const RATE_LIMIT_RETRIES = 4;
/** How many 503s one expert may get before the batch stops. */
export const UNAVAILABLE_RETRIES = 1;
/** First wait after a 429 with no Retry-After; doubles each time. */
export const BASE_BACKOFF_MS = 2_000;
/** The longest the bar will sit waiting. A longer Retry-After pauses the batch instead. */
export const MAX_BACKOFF_MS = 60_000;
/** "Didn't go through" this many times in a row means the server is struggling: stop. */
export const MAX_CONSECUTIVE_FAILURES = 3;
/** Sleep in slices this long so Stop is honoured during a wait. */
const SLEEP_SLICE_MS = 500;

/** The statuses a Matches card offers Bookmark on, and so the ones select mode offers a checkbox on. */
const BULK_BOOKMARKABLE: ReadonlySet<ExpertStatus> = new Set<ExpertStatus>(['discovered', 'shortlisted']);

export function isBulkBookmarkable(status: ExpertStatus): boolean {
  return BULK_BOOKMARKABLE.has(status);
}

// ─── One call ─────────────────────────────────────────────────────────────────

/** What one call to the bookmark route came back with. `status` 0 means it never got an answer. */
export interface BookmarkAttempt {
  status:         number;
  error?:         string | null;
  outcome?:       string | null;
  /** The route sets this when the project is in walkthrough and nothing was sent. */
  held?:          boolean;
  /** From Retry-After (or a body field), already in milliseconds. */
  retryAfterMs?:  number | null;
  projectExpert?: ProjectExpert | null;
}

export type SkipReason =
  | 'do_not_contact'
  | 'opted_out'
  | 'already_engaged'
  | 'not_found'
  | 'failed';

export type StopReason =
  | 'rate_limited'
  | 'account_inactive'
  | 'walkthrough'
  | 'not_allowed'
  | 'signed_out'
  | 'project_gone'
  | 'unavailable'
  | 'cancelled';

export type BookmarkDecision =
  | { kind: 'bookmarked' }
  | { kind: 'retry'; delayMs: number }
  | { kind: 'skip';  reason: SkipReason }
  | { kind: 'stop';  reason: StopReason };

/** Refusals that are about the ACCOUNT, not the expert: the next call would get the same answer. */
const ACCOUNT_REFUSALS: ReadonlySet<string> = new Set([
  'activation_required',
  'trial_account',
  'card_required',
  'billing_required',
  'billing_incomplete',
]);

/** The firm's own do-not-contact list (another builder adds the check to the route). */
const DO_NOT_CONTACT_CODES: ReadonlySet<string> = new Set([
  'do_not_contact',
  'firm_do_not_contact',
  'on_do_not_contact_list',
]);

/**
 * Seconds or an HTTP date → milliseconds from now. Null when absent or
 * unreadable, so the caller falls back to its own backoff.
 */
export function parseRetryAfter(value: string | null | undefined, nowMs: number): number | null {
  const text = (value ?? '').trim();
  if (!text) return null;
  if (/^\d+(?:\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
  const at = Date.parse(text);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, at - nowMs);
}

/** How long to wait before the next try: the server's word when it gave one, else doubling from 2s. */
export function backoffDelayMs(retriesSoFar: number, retryAfterMs: number | null | undefined): number {
  if (typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    return Math.min(Math.max(retryAfterMs, 250), MAX_BACKOFF_MS);
  }
  return Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, retriesSoFar), MAX_BACKOFF_MS);
}

/**
 * What one answer means for this expert and for the batch. `retriesSoFar` is
 * how many times THIS expert has already been retried.
 */
export function decideBookmarkAttempt(attempt: BookmarkAttempt, retriesSoFar: number): BookmarkDecision {
  const code = attempt.error ?? '';

  if (attempt.status >= 200 && attempt.status < 300) return { kind: 'bookmarked' };

  // Account-level refusals first: they can arrive on a 403 or a 409.
  if (ACCOUNT_REFUSALS.has(code))  return { kind: 'stop', reason: 'account_inactive' };
  if (code === 'walkthrough_mode') return { kind: 'stop', reason: 'walkthrough' };

  if (attempt.status === 429) {
    const wait = attempt.retryAfterMs;
    if (typeof wait === 'number' && wait > MAX_BACKOFF_MS) return { kind: 'stop', reason: 'rate_limited' };
    if (retriesSoFar >= RATE_LIMIT_RETRIES)                 return { kind: 'stop', reason: 'rate_limited' };
    return { kind: 'retry', delayMs: backoffDelayMs(retriesSoFar, wait) };
  }

  if (attempt.status === 503) {
    if (retriesSoFar >= UNAVAILABLE_RETRIES) return { kind: 'stop', reason: 'unavailable' };
    return { kind: 'retry', delayMs: backoffDelayMs(retriesSoFar, attempt.retryAfterMs) };
  }

  if (attempt.status === 401) return { kind: 'stop', reason: 'signed_out' };
  if (attempt.status === 403) return { kind: 'stop', reason: 'not_allowed' };

  if (DO_NOT_CONTACT_CODES.has(code))  return { kind: 'skip', reason: 'do_not_contact' };
  if (code === 'contact_suppressed')   return { kind: 'skip', reason: 'opted_out' };
  if (code === 'already_engaged')      return { kind: 'skip', reason: 'already_engaged' };

  if (attempt.status === 404) {
    return code === 'expert_not_found'
      ? { kind: 'skip', reason: 'not_found' }
      : { kind: 'stop', reason: 'project_gone' };
  }

  return { kind: 'skip', reason: 'failed' };
}

// ─── The batch ────────────────────────────────────────────────────────────────

export interface BulkItemResult {
  expertId:       string;
  kind:           'bookmarked' | 'skipped';
  reason?:        SkipReason;
  outcome?:       string | null;
  held?:          boolean;
  projectExpert?: ProjectExpert | null;
}

export interface BulkBookmarkResult {
  total:        number;
  /** In the order they finished. */
  results:      BulkItemResult[];
  stopReason:   StopReason | null;
  /** Never answered for (the batch stopped first), in the order given. */
  notAttempted: string[];
}

export interface BulkBookmarkDeps {
  bookmarkOne:   (expertId: string) => Promise<BookmarkAttempt>;
  concurrency?:  number;
  sleep?:        (ms: number) => Promise<void>;
  now?:          () => number;
  /** Polled between calls and during waits. True stops the batch after what is in flight. */
  shouldCancel?: () => boolean;
  /** One expert finished. `done` counts finished experts, `total` the batch. */
  onResult?:     (result: BulkItemResult, done: number, total: number) => void;
  /** True while the batch is waiting out a 429 or 503. */
  onWaiting?:    (waiting: boolean) => void;
}

const realSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Bookmarks each expert through `bookmarkOne`, at most `concurrency` at a time.
 *
 * A 429 or 503 pauses EVERY worker until the wait is over (one shared
 * `pausedUntil`), so two workers never both hammer a limiter that has just
 * said no. A stop lets the calls already in flight finish and record; what
 * never started lands in `notAttempted`.
 */
export async function runBulkBookmark(
  expertIds: readonly string[],
  deps: BulkBookmarkDeps,
): Promise<BulkBookmarkResult> {
  const ids         = Array.from(new Set(expertIds));
  const sleep       = deps.sleep ?? realSleep;
  const now         = deps.now ?? Date.now;
  const concurrency = Math.max(1, Math.min(deps.concurrency ?? BULK_BOOKMARK_CONCURRENCY, ids.length || 1));

  const results: BulkItemResult[] = [];
  const finished = new Set<string>();
  let cursor              = 0;
  let stop: StopReason | null = null;
  let pausedUntil         = 0;
  let consecutiveFailures = 0;

  const cancelled = (): boolean => {
    if (!stop && deps.shouldCancel?.()) stop = 'cancelled';
    return stop !== null;
  };

  const record = (result: BulkItemResult): void => {
    results.push(result);
    finished.add(result.expertId);
    deps.onResult?.(result, results.length, ids.length);
  };

  const waitOutPause = async (): Promise<void> => {
    let waited = false;
    for (let wait = pausedUntil - now(); wait > 0 && !cancelled(); wait = pausedUntil - now()) {
      if (!waited) deps.onWaiting?.(true);
      waited = true;
      await sleep(Math.min(wait, SLEEP_SLICE_MS));
    }
    if (waited) deps.onWaiting?.(false);
  };

  const worker = async (): Promise<void> => {
    while (!cancelled() && cursor < ids.length) {
      const expertId = ids[cursor++];

      for (let retries = 0; ;) {
        await waitOutPause();
        if (cancelled()) break;

        let attempt: BookmarkAttempt;
        try {
          attempt = await deps.bookmarkOne(expertId);
        } catch {
          attempt = { status: 0, error: 'network' };
        }

        const decision = decideBookmarkAttempt(attempt, retries);

        if (decision.kind === 'retry') {
          retries++;
          pausedUntil = Math.max(pausedUntil, now() + decision.delayMs);
          continue;
        }
        if (decision.kind === 'stop') {
          stop = stop ?? decision.reason;
          break;
        }
        if (decision.kind === 'bookmarked') {
          consecutiveFailures = 0;
          record({
            expertId,
            kind:          'bookmarked',
            outcome:       attempt.outcome ?? null,
            ...(attempt.held ? { held: true } : {}),
            projectExpert: attempt.projectExpert ?? null,
          });
          break;
        }

        consecutiveFailures = decision.reason === 'failed' ? consecutiveFailures + 1 : 0;
        record({ expertId, kind: 'skipped', reason: decision.reason });
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) stop = stop ?? 'unavailable';
        break;
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  return {
    total:        ids.length,
    results,
    stopReason:   stop,
    notAttempted: ids.filter(id => !finished.has(id)),
  };
}

// ─── After the batch ──────────────────────────────────────────────────────────

/** Stops after which trying again from this screen cannot work. */
const FINAL_STOPS: ReadonlySet<StopReason> = new Set<StopReason>(['not_allowed', 'project_gone']);

/**
 * The experts worth keeping selected: the ones never reached and the ones that
 * did not go through. Empty after a stop that a retry cannot fix.
 */
export function retryableIds(result: BulkBookmarkResult): string[] {
  if (result.stopReason && FINAL_STOPS.has(result.stopReason)) return [];
  const failed = new Set(result.results.filter(r => r.reason === 'failed').map(r => r.expertId));
  return [...result.notAttempted, ...Array.from(failed)];
}

/** Read after a count: "2 skipped: on your firm's do-not-contact list". */
const SKIP_LABELS: Record<SkipReason, string> = {
  do_not_contact:  "on your firm's do-not-contact list",
  opted_out:       'asked not to be contacted',
  already_engaged: 'already in Conversations',
  not_found:       'no longer in this project',
  failed:          "didn't go through",
};
const SKIP_ORDER: readonly SkipReason[] = ['do_not_contact', 'opted_out', 'already_engaged', 'not_found', 'failed'];

function stopLine(reason: StopReason, left: number): string | null {
  switch (reason) {
    case 'rate_limited':     return `Paused with ${left} left. Too many at once, so try the rest in a minute.`;
    case 'account_inactive': return `Stopped with ${left} left. Matchy can't reach experts until your firm adds a card in Settings.`;
    case 'walkthrough':      return `Stopped with ${left} left. This project is in walkthrough mode.`;
    case 'not_allowed':      return 'Stopped. Only the project owner can bookmark experts.';
    case 'signed_out':       return `Stopped with ${left} left. Sign in again, then try the rest.`;
    case 'project_gone':     return 'Stopped. This project is no longer available.';
    case 'unavailable':      return `Stopped with ${left} left. ExpertMatch isn't responding, so try the rest in a minute.`;
    case 'cancelled':        return left > 0 ? `Stopped with ${left} left.` : null;
  }
}

/**
 * The one line the bar shows when a batch ends, e.g.
 * "18 bookmarked. 2 skipped: on your firm's do-not-contact list."
 * Plain words only: no codes, no provider names, no em dashes.
 */
export function summarizeBulkBookmark(result: BulkBookmarkResult): string {
  const bookmarked = result.results.filter(r => r.kind === 'bookmarked');
  const skipped    = result.results.filter(r => r.kind === 'skipped');
  const parts: string[] = [bookmarked.length === 0 ? 'None bookmarked.' : `${bookmarked.length} bookmarked.`];

  if (skipped.length > 0) {
    const counts = SKIP_ORDER
      .map(reason => ({ reason, count: skipped.filter(r => r.reason === reason).length }))
      .filter(c => c.count > 0);
    parts.push(counts.length === 1
      ? `${skipped.length} skipped: ${SKIP_LABELS[counts[0].reason]}.`
      : `${skipped.length} skipped: ${counts.map(c => `${c.count} ${SKIP_LABELS[c.reason]}`).join(', ')}.`);
  }

  // Bookmarked, but Matchy will not write: the global opt-out list.
  const optedOut = bookmarked.filter(r => r.outcome === 'contact_suppressed').length;
  if (optedOut > 0) parts.push(`${optedOut} asked not to be contacted, so Matchy won't write to them.`);

  if (bookmarked.some(r => r.held || r.outcome === 'walkthrough_held')) {
    parts.push('Walkthrough mode, so nothing was sent.');
  }

  const line = result.stopReason ? stopLine(result.stopReason, result.notAttempted.length) : null;
  if (line) parts.push(line);

  return parts.join(' ');
}

// ─── The fetch ────────────────────────────────────────────────────────────────

interface BookmarkPayload {
  error?:         string;
  outcome?:       string;
  held?:          boolean;
  retryAfterMs?:  number;
  retryAfter?:    number;
  projectExpert?: ProjectExpert;
}

/**
 * One POST to the existing bookmark route, read into a BookmarkAttempt. Never
 * throws. Kept here rather than in lib/matchyClient.bookmarkExpert because the
 * batch needs the status code and Retry-After header, which that wrapper does
 * not surface.
 */
export async function postBookmark(
  projectId: string,
  expertId:  string,
  fetchFn:   typeof fetch = fetch,
): Promise<BookmarkAttempt> {
  let res: Response;
  try {
    res = await fetchFn(
      `/api/projects/${encodeURIComponent(projectId)}/experts/${encodeURIComponent(expertId)}/bookmark`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    );
  } catch {
    return { status: 0, error: 'network' };
  }

  let payload: BookmarkPayload = {};
  try {
    const parsed: unknown = await res.json();
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed as BookmarkPayload;
  } catch {
    // An empty or HTML body still has a status code worth reading.
  }

  const fromHeader = parseRetryAfter(res.headers.get('Retry-After'), Date.now());
  const fromBody   = typeof payload.retryAfterMs === 'number' ? payload.retryAfterMs
    : typeof payload.retryAfter === 'number' ? payload.retryAfter * 1000
    : null;

  return {
    status:        res.status,
    error:         typeof payload.error === 'string' ? payload.error : null,
    outcome:       typeof payload.outcome === 'string' ? payload.outcome : null,
    ...(payload.held === true ? { held: true } : {}),
    retryAfterMs:  fromHeader ?? fromBody,
    projectExpert: payload.projectExpert ?? null,
  };
}
