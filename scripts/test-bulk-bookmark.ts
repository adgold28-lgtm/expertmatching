// scripts/test-bulk-bookmark.ts — unit tests for lib/bulkBookmark.ts.
//
// No network, no timers: the runner gets a fake bookmark call, a fake clock and
// a sleep that advances it, so every wait is measured rather than slept.
//
//   npx tsx scripts/test-bulk-bookmark.ts
//
// What it proves:
//   - each answer from the bookmark route means one thing: bookmarked, wait and
//     retry (429, 503), skip this expert (do-not-contact, already engaged,
//     gone, didn't go through) or stop the batch (account cannot reach
//     experts, not the owner, signed out, project gone)
//   - Retry-After is honoured, in seconds or as a date; without it the wait
//     doubles from 2s; a wait over a minute or a fifth 429 pauses the batch
//   - never more than two calls in flight, and a 429 pauses every worker
//   - three "didn't go through" in a row stop the batch; Stop is honoured
//   - the summary line is plain, short and free of em dashes, e.g.
//     "18 bookmarked. 2 skipped: on your firm's do-not-contact list."
//   - postBookmark reads the status, the error code and Retry-After, and never throws

import {
  BASE_BACKOFF_MS,
  BULK_BOOKMARK_CONCURRENCY,
  MAX_BACKOFF_MS,
  RATE_LIMIT_RETRIES,
  backoffDelayMs,
  decideBookmarkAttempt,
  isBulkBookmarkable,
  parseRetryAfter,
  postBookmark,
  retryableIds,
  runBulkBookmark,
  summarizeBulkBookmark,
  type BookmarkAttempt,
  type BulkBookmarkResult,
} from '../lib/bulkBookmark';
import { check, eq, summary } from './testHarness';

function section(title: string): void {
  console.log(`\n${title}`);
}

const EM_DASH_RE = /—|\s–\s|--/;

// ─── decideBookmarkAttempt ───────────────────────────────────────────────────

section('decideBookmarkAttempt — what one answer means');

const d = (a: BookmarkAttempt, retries = 0) => JSON.stringify(decideBookmarkAttempt(a, retries));

eq('200 → bookmarked', d({ status: 200, outcome: 'intro_sent' }), JSON.stringify({ kind: 'bookmarked' }));
eq('200 walkthrough_held → bookmarked', d({ status: 200, outcome: 'walkthrough_held' }), JSON.stringify({ kind: 'bookmarked' }));
eq('429 with Retry-After 3s → retry after 3s', d({ status: 429, retryAfterMs: 3000 }), JSON.stringify({ kind: 'retry', delayMs: 3000 }));
eq('429 without Retry-After → 2s first', d({ status: 429 }, 0), JSON.stringify({ kind: 'retry', delayMs: BASE_BACKOFF_MS }));
eq('429 without Retry-After → 4s second', d({ status: 429 }, 1), JSON.stringify({ kind: 'retry', delayMs: 4000 }));
eq('429 without Retry-After → 16s fourth', d({ status: 429 }, 3), JSON.stringify({ kind: 'retry', delayMs: 16000 }));
eq(`429 after ${RATE_LIMIT_RETRIES} retries → pause the batch`, d({ status: 429 }, RATE_LIMIT_RETRIES), JSON.stringify({ kind: 'stop', reason: 'rate_limited' }));
eq('429 asking for 10 minutes → pause now rather than sit there', d({ status: 429, retryAfterMs: 600_000 }), JSON.stringify({ kind: 'stop', reason: 'rate_limited' }));
eq('503 once → retry', d({ status: 503 }, 0), JSON.stringify({ kind: 'retry', delayMs: BASE_BACKOFF_MS }));
eq('503 twice → stop', d({ status: 503 }, 1), JSON.stringify({ kind: 'stop', reason: 'unavailable' }));
eq('401 → signed out', d({ status: 401, error: 'unauthorized' }), JSON.stringify({ kind: 'stop', reason: 'signed_out' }));
eq('403 forbidden → not the owner', d({ status: 403, error: 'forbidden' }), JSON.stringify({ kind: 'stop', reason: 'not_allowed' }));
eq('403 activation_required → account cannot reach experts', d({ status: 403, error: 'activation_required' }), JSON.stringify({ kind: 'stop', reason: 'account_inactive' }));
eq('409 activation_required → account cannot reach experts', d({ status: 409, error: 'activation_required' }), JSON.stringify({ kind: 'stop', reason: 'account_inactive' }));
eq('409 walkthrough_mode → stop', d({ status: 409, error: 'walkthrough_mode' }), JSON.stringify({ kind: 'stop', reason: 'walkthrough' }));
eq('409 do_not_contact → skip', d({ status: 409, error: 'do_not_contact' }), JSON.stringify({ kind: 'skip', reason: 'do_not_contact' }));
eq('409 contact_suppressed → skip as opted out', d({ status: 409, error: 'contact_suppressed' }), JSON.stringify({ kind: 'skip', reason: 'opted_out' }));
eq('409 already_engaged → skip', d({ status: 409, error: 'already_engaged' }), JSON.stringify({ kind: 'skip', reason: 'already_engaged' }));
eq('404 expert_not_found → skip', d({ status: 404, error: 'expert_not_found' }), JSON.stringify({ kind: 'skip', reason: 'not_found' }));
eq('404 project_not_found → stop', d({ status: 404, error: 'project_not_found' }), JSON.stringify({ kind: 'stop', reason: 'project_gone' }));
eq('500 → skip, never retried on its own', d({ status: 500, error: 'bookmark_failed' }), JSON.stringify({ kind: 'skip', reason: 'failed' }));
eq('network failure → skip, never retried on its own', d({ status: 0, error: 'network' }), JSON.stringify({ kind: 'skip', reason: 'failed' }));
eq('400 invalid id → skip', d({ status: 400, error: 'invalid_expert_id' }), JSON.stringify({ kind: 'skip', reason: 'failed' }));

section('parseRetryAfter / backoffDelayMs');

eq('seconds', parseRetryAfter('5', 0), 5000);
eq('fractional seconds', parseRetryAfter('1.5', 0), 1500);
eq('HTTP date', parseRetryAfter(new Date(10_000).toUTCString(), 4_000), 6000);
eq('a date in the past → 0', parseRetryAfter(new Date(1_000).toUTCString(), 60_000), 0);
eq('garbage → null', parseRetryAfter('soon', 0), null);
eq('absent → null', parseRetryAfter(null, 0), null);
eq('blank → null', parseRetryAfter('  ', 0), null);
eq('server wait is used', backoffDelayMs(0, 7000), 7000);
eq('a tiny server wait is floored', backoffDelayMs(0, 10), 250);
eq('server wait is capped', backoffDelayMs(0, 120_000), MAX_BACKOFF_MS);
eq('doubling is capped', backoffDelayMs(10, null), MAX_BACKOFF_MS);
eq('zero is ignored for the doubling', backoffDelayMs(2, 0), 8000);

section('isBulkBookmarkable — the statuses a card offers Bookmark on');

check('discovered and shortlisted are bookmarkable', isBulkBookmarkable('discovered') && isBulkBookmarkable('shortlisted'));
check('bookmarked is not (a second bookmark re-runs outreach)', !isBulkBookmarkable('bookmarked'));
check('contacted and rejected are not', !isBulkBookmarkable('contacted') && !isBulkBookmarkable('rejected'));

// ─── runBulkBookmark ─────────────────────────────────────────────────────────

function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void>; slept: () => number } {
  let t = 0;
  let total = 0;
  return {
    now:   () => t,
    sleep: async (ms: number) => { t += ms; total += ms; await Promise.resolve(); },
    slept: () => total,
  };
}

/** A few microtask hops, so two workers genuinely overlap. */
async function latency(): Promise<void> {
  for (let i = 0; i < 3; i++) await Promise.resolve();
}

const ids = (n: number, prefix = 'e'): string[] => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

async function runTests(): Promise<void> {
  section('runBulkBookmark — two at a time, every one answered');
  {
    let inFlight = 0;
    let maxInFlight = 0;
    const calls: string[] = [];
    const progress: number[] = [];
    const clock = fakeClock();
    const result = await runBulkBookmark(ids(20), {
      ...clock,
      bookmarkOne: async id => {
        calls.push(id);
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await latency();
        inFlight--;
        return { status: 200, outcome: 'intro_sent' };
      },
      onResult: (_r, done) => { progress.push(done); },
    });
    eq('default concurrency is 2', BULK_BOOKMARK_CONCURRENCY, 2);
    eq('never more than 2 in flight', maxInFlight, 2);
    eq('every expert called once', calls.length, 20);
    eq('in the order given', calls.slice(0, 4).join(','), 'e1,e2,e3,e4');
    eq('20 bookmarked', result.results.filter(r => r.kind === 'bookmarked').length, 20);
    eq('no stop', result.stopReason, null);
    eq('nothing left', result.notAttempted.length, 0);
    eq('progress counts up to 20', progress.join(','), Array.from({ length: 20 }, (_, i) => i + 1).join(','));
    eq('no waiting without a 429', clock.slept(), 0);
    eq('summary', summarizeBulkBookmark(result), '20 bookmarked.');
  }

  {
    let calls = 0;
    const result = await runBulkBookmark(['a', 'b', 'a', 'b'], {
      bookmarkOne: async () => { calls++; return { status: 200 }; },
    });
    eq('duplicate ids are called once', calls, 2);
    eq('total counts unique ids', result.total, 2);
  }

  {
    const result = await runBulkBookmark([], { bookmarkOne: async () => ({ status: 200 }) });
    eq('an empty batch is fine', result.total, 0);
    eq('an empty batch summary', summarizeBulkBookmark(result), 'None bookmarked.');
  }

  section('runBulkBookmark — 429 waits for every worker, then retries the same expert');
  {
    const clock = fakeClock();
    const starts: Array<{ id: string; at: number }> = [];
    let limitedAt = -1;
    let startsBeforeLimit = 0;
    let bRefusals = 0;
    const waiting: boolean[] = [];
    const result = await runBulkBookmark(ids(6), {
      ...clock,
      bookmarkOne: async id => {
        starts.push({ id, at: clock.now() });
        await latency();
        if (id === 'e2' && bRefusals < 2) {
          bRefusals++;
          limitedAt = clock.now();
          startsBeforeLimit = starts.length;
          return { status: 429, error: 'rate_limited', retryAfterMs: 3000 };
        }
        return { status: 200, outcome: 'intro_sent' };
      },
      onWaiting: w => { waiting.push(w); },
    });
    eq('all 6 bookmarked in the end', result.results.filter(r => r.kind === 'bookmarked').length, 6);
    eq('e2 was called three times', starts.filter(s => s.id === 'e2').length, 3);
    check('waited at least the two Retry-After windows', clock.slept() >= 6000, `slept ${clock.slept()}`);
    // Calls already in flight when the 429 came back may finish; nothing new
    // may START until the Retry-After window is over, on either worker.
    const startedDuringPause = starts.slice(startsBeforeLimit).filter(s => s.at < limitedAt + 3000);
    check('no call started inside the last pause window', startedDuringPause.length === 0, JSON.stringify(startedDuringPause));
    check('something did start after it', starts.length > startsBeforeLimit);
    check('the bar was told it is waiting, then that it is not', waiting.includes(true) && waiting[waiting.length - 1] === false);
    eq('no stop', result.stopReason, null);
  }

  {
    const clock = fakeClock();
    const result = await runBulkBookmark(ids(5), {
      ...clock,
      bookmarkOne: async () => ({ status: 429, error: 'rate_limited' }),
    });
    eq('a limiter that never relents pauses the batch', result.stopReason, 'rate_limited');
    eq('nothing recorded as bookmarked', result.results.length, 0);
    eq('everything is left', result.notAttempted.length, 5);
    check('backoff doubled before pausing (2+4+8+16s for the first expert)', clock.slept() >= 30_000, `slept ${clock.slept()}`);
    eq('pause summary', summarizeBulkBookmark(result),
      'None bookmarked. Paused with 5 left. Too many at once, so try the rest in a minute.');
    eq('all 5 stay selected', retryableIds(result).length, 5);
  }

  section('runBulkBookmark — skip one expert, stop for the account');
  {
    const dnc = new Set(['e4', 'e17']);
    const result = await runBulkBookmark(ids(20), {
      bookmarkOne: async id => {
        await latency();
        return dnc.has(id)
          ? { status: 409, error: 'do_not_contact', message: 'On the do-not-contact list.' } as BookmarkAttempt
          : { status: 200, outcome: 'intro_sent' };
      },
    });
    eq('the founder\'s example line', summarizeBulkBookmark(result), "18 bookmarked. 2 skipped: on your firm's do-not-contact list.");
    eq('skips do not stop the batch', result.stopReason, null);
    eq('do-not-contact experts are not kept selected', retryableIds(result).length, 0);
  }

  {
    let calls = 0;
    const result = await runBulkBookmark(ids(10), {
      bookmarkOne: async id => {
        calls++;
        await latency();
        return id === 'e3' ? { status: 403, error: 'activation_required' } : { status: 200 };
      },
    });
    eq('an account refusal stops the batch', result.stopReason, 'account_inactive');
    check('no new call starts after the stop', calls <= 4, `calls ${calls}`);
    check('the refused expert is left, not skipped', result.notAttempted.includes('e3'));
    eq('left = everything not answered', result.notAttempted.length, 10 - result.results.length);
    check('account summary names Settings, no em dash',
      /Matchy can't reach experts until your firm adds a card in Settings\.$/.test(summarizeBulkBookmark(result))
      && !EM_DASH_RE.test(summarizeBulkBookmark(result)));
    eq('the rest stay selected for after the card is added', retryableIds(result).length, result.notAttempted.length);
  }

  {
    const result = await runBulkBookmark(ids(4), {
      bookmarkOne: async () => ({ status: 403, error: 'forbidden' }),
    });
    eq('a collaborator is stopped at once', result.stopReason, 'not_allowed');
    eq('not-allowed summary', summarizeBulkBookmark(result), 'None bookmarked. Stopped. Only the project owner can bookmark experts.');
    eq('nothing stays selected after a stop a retry cannot fix', retryableIds(result).length, 0);
  }

  section('runBulkBookmark — failures');
  {
    const result = await runBulkBookmark(ids(10), {
      concurrency: 1,
      bookmarkOne: async id => (['e2', 'e3', 'e4'].includes(id) ? { status: 500, error: 'bookmark_failed' } : { status: 200 }),
    });
    eq('three failures in a row stop the batch', result.stopReason, 'unavailable');
    eq('1 bookmarked before', result.results.filter(r => r.kind === 'bookmarked').length, 1);
    eq('6 never tried', result.notAttempted.length, 6);
    eq('failed + never tried stay selected', retryableIds(result).length, 9);
    eq('failure summary', summarizeBulkBookmark(result),
      "1 bookmarked. 3 skipped: didn't go through. Stopped with 6 left. ExpertMatch isn't responding, so try the rest in a minute.");
  }

  {
    const result = await runBulkBookmark(ids(6), {
      concurrency: 1,
      bookmarkOne: async id => {
        if (id === 'e2') throw new Error('boom');
        if (id === 'e4') return { status: 500 };
        return { status: 200 };
      },
    });
    eq('scattered failures do not stop the batch', result.stopReason, null);
    eq('a thrown call counts as a failure, not a crash', result.results.filter(r => r.reason === 'failed').length, 2);
  }

  section('runBulkBookmark — Stop');
  {
    let done = 0;
    const result = await runBulkBookmark(ids(10), {
      bookmarkOne: async () => { await latency(); return { status: 200 }; },
      onResult: () => { done++; },
      shouldCancel: () => done >= 3,
    });
    eq('Stop ends the batch', result.stopReason, 'cancelled');
    check('in-flight calls still record', result.results.length >= 3 && result.results.length <= 4, `recorded ${result.results.length}`);
    check('cancel summary says how many are left',
      summarizeBulkBookmark(result).endsWith(`Stopped with ${result.notAttempted.length} left.`));
  }

  {
    const clock = fakeClock();
    let cancel = false;
    let calls = 0;
    const result = await runBulkBookmark(ids(3), {
      ...clock,
      concurrency: 1,
      bookmarkOne: async () => {
        calls++;
        if (calls === 1) { setTimeout(() => { cancel = true; }, 0); return { status: 429, retryAfterMs: 50_000 }; }
        return { status: 200 };
      },
      sleep: async ms => { await clock.sleep(ms); await new Promise(r => setTimeout(r, 1)); },
      shouldCancel: () => cancel,
    });
    eq('Stop is honoured during a long wait', result.stopReason, 'cancelled');
    eq('nothing called after Stop', calls, 1);
  }

  section('summarizeBulkBookmark — mixed results');
  {
    const mixed: BulkBookmarkResult = {
      total: 7,
      results: [
        { expertId: 'a', kind: 'bookmarked', outcome: 'intro_sent' },
        { expertId: 'b', kind: 'bookmarked', outcome: 'contact_suppressed' },
        { expertId: 'c', kind: 'skipped', reason: 'do_not_contact' },
        { expertId: 'd', kind: 'skipped', reason: 'failed' },
        { expertId: 'e', kind: 'skipped', reason: 'already_engaged' },
      ],
      stopReason: null,
      notAttempted: [],
    };
    eq('several skip reasons are counted', summarizeBulkBookmark(mixed),
      "2 bookmarked. 3 skipped: 1 on your firm's do-not-contact list, 1 already in Conversations, 1 didn't go through. "
      + "1 asked not to be contacted, so Matchy won't write to them.");
    eq('only the failed one stays selected', retryableIds(mixed).join(','), 'd');

    const walk: BulkBookmarkResult = {
      total: 2,
      results: [
        { expertId: 'a', kind: 'bookmarked', outcome: 'walkthrough_held' },
        { expertId: 'b', kind: 'bookmarked', outcome: 'intro_drafted', held: true },
      ],
      stopReason: null,
      notAttempted: [],
    };
    eq('walkthrough says nothing was sent', summarizeBulkBookmark(walk), '2 bookmarked. Walkthrough mode, so nothing was sent.');

    const stops: Array<BulkBookmarkResult['stopReason']> = [
      'rate_limited', 'account_inactive', 'walkthrough', 'not_allowed', 'signed_out', 'project_gone', 'unavailable', 'cancelled',
    ];
    for (const stopReason of stops) {
      const line = summarizeBulkBookmark({ total: 3, results: [], stopReason, notAttempted: ['x', 'y', 'z'] });
      check(`stop line for ${stopReason}: no em dash, no code`, !EM_DASH_RE.test(line) && !/_/.test(line), line);
      check(`stop line for ${stopReason}: short`, line.split(/\s+/).length <= 25, line);
    }
  }

  section('postBookmark — reads the answer, never throws');
  {
    const seen: string[] = [];
    const okFetch = (async (url: string, init?: RequestInit) => {
      seen.push(`${init?.method} ${url} ${String(init?.body)}`);
      return new Response(JSON.stringify({ ok: true, outcome: 'intro_sent', projectExpert: { status: 'contacted' } }), { status: 200 });
    }) as unknown as typeof fetch;
    const ok = await postBookmark('p1', 'e 1', okFetch);
    eq('status', ok.status, 200);
    eq('outcome', ok.outcome, 'intro_sent');
    check('projectExpert carried through', ok.projectExpert?.status === 'contacted');
    eq('POSTs the existing route with an empty JSON body', seen[0], 'POST /api/projects/p1/experts/e%201/bookmark {}');

    const limited = await postBookmark('p1', 'e1', (async () =>
      new Response(JSON.stringify({ error: 'rate_limited' }), { status: 429, headers: { 'Retry-After': '12' } })) as unknown as typeof fetch);
    eq('429 status', limited.status, 429);
    eq('Retry-After read in ms', limited.retryAfterMs, 12_000);
    eq('error code read', limited.error, 'rate_limited');

    const bodyWait = await postBookmark('p1', 'e1', (async () =>
      new Response(JSON.stringify({ error: 'rate_limited', retryAfterMs: 1500 }), { status: 429 })) as unknown as typeof fetch);
    eq('a body retryAfterMs is used when there is no header', bodyWait.retryAfterMs, 1500);

    const dnc = await postBookmark('p1', 'e1', (async () =>
      new Response(JSON.stringify({ error: 'do_not_contact' }), { status: 409 })) as unknown as typeof fetch);
    eq('409 do_not_contact read', `${dnc.status} ${dnc.error}`, '409 do_not_contact');

    const html = await postBookmark('p1', 'e1', (async () =>
      new Response('<html>oops</html>', { status: 502 })) as unknown as typeof fetch);
    eq('an HTML error page keeps its status', html.status, 502);
    eq('and has no code', html.error, null);

    const offline = await postBookmark('p1', 'e1', (async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch);
    eq('a network failure is status 0', offline.status, 0);
    eq('and code network', offline.error, 'network');
  }
}

runTests().then(() => summary()).catch(err => {
  console.error('test-bulk-bookmark crashed:', err);
  process.exit(1);
});
