// scripts/test-walkthrough.ts — unit tests for walkthrough mode.
//
// Pure functions only: no network, no database, no email. Everything under test
// here is the decision layer of the feature — the predicate that says whether a
// project may send, the jsonb round trip that remembers a message was held, the
// line Matchy shows, and the validator that lets a create request choose.
//
//   npx tsx scripts/test-walkthrough.ts
//
// What it proves:
//   - `undefined` and `true` are BOTH walkthrough; only an explicit `false` is
//     live. This is the whole safety property: every project that predates the
//     feature reads as walkthrough on deploy.
//   - a stored `held` flag survives the screen_result round trip, and a held
//     message is never also pending (nothing can release it)
//   - `bookmarkLine('walkthrough_held', …)` says nothing was sent
//   - `validateCreateProjectInput` accepts a boolean, rejects anything else with
//     `invalid_walkthrough`, and leaves the field ABSENT when it is absent
//   - `dispositionOf` (lib/emailSequence) tells the three client-facing routes —
//     the client reply, the approved follow-up and the rate decision — which
//     hold to store and whether the engagement may move. Walkthrough is the one
//     hold that still moves it; a chokepoint hold never does (H-4).

import { isWalkthrough, toHeldReason, WALKTHROUGH_HELD_SUMMARY } from '../lib/walkthrough';
import { dispositionOf } from '../lib/emailSequence';
import { redactMessageForViewer, type ViewerMessage } from '../lib/conversations';
import { bookmarkLine, isHeld, isPendingApproval, type ConversationMessage } from '../lib/matchyClient';
import { validateCreateProjectInput } from '../lib/projectValidation';
import type { ConversationMessageRow } from '../lib/supabase/database.types';

let failures = 0;
let checks   = 0;

function check(name: string, ok: boolean, detail = ''): void {
  checks++;
  if (!ok) {
    failures++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

function section(title: string): void {
  console.log(`\n${title}`);
}

// ─── isWalkthrough ────────────────────────────────────────────────────────────

section('isWalkthrough — only an explicit false is live');

check('undefined is walkthrough (the safe default for every existing project)',
  isWalkthrough({}) === true);
check('undefined-valued key is walkthrough',
  isWalkthrough({ walkthrough: undefined }) === true);
check('true is walkthrough',
  isWalkthrough({ walkthrough: true }) === true);
check('false is LIVE',
  isWalkthrough({ walkthrough: false }) === false);

section('toHeldReason — narrows what came out of jsonb');

eq('walkthrough narrows',        toHeldReason('walkthrough'), 'walkthrough');
eq('disabled narrows',           toHeldReason('disabled'),    'disabled');
eq('unknown string is null',     toHeldReason('whatever'),    null);
eq('undefined is null',          toHeldReason(undefined),     null);
eq('non-string is null',         toHeldReason(true),          null);

// ─── screen_result round trip ─────────────────────────────────────────────────

section('held survives the screen_result round trip');

/** A conversation_messages row, only the fields redactMessageForViewer reads. */
function row(screenResult: unknown): ConversationMessageRow {
  return {
    id:                '11111111-2222-3333-4444-555555555555',
    project_id:        'p',
    expert_id:         'e',
    direction:         'outbound',
    author:            'matchy',
    body_raw:          null,
    body_clean:        'Sounds good. What rate works for you?',
    summary:           WALKTHROUGH_HELD_SUMMARY,
    intent:            null,
    screen_result:     screenResult,
    resend_message_id: null,
    created_at:        '2026-09-07T12:00:00.000Z',
  } as unknown as ConversationMessageRow;
}

const viewer = { role: 'user' as const, status: 'rate_negotiation' as const };

const heldView: ViewerMessage = redactMessageForViewer(
  row({ blocked: false, findings: [], held: 'walkthrough' }),
  viewer,
);
eq('held reads back off the stored row', heldView.held, 'walkthrough');
eq('held is mirrored on screenResult',   heldView.screenResult?.held, 'walkthrough');
check('a held message is NOT pending approval', heldView.pendingApproval === false);

const pendingView = redactMessageForViewer(
  row({ blocked: false, findings: [], pending: true }),
  viewer,
);
eq('a pending message has no held reason', pendingView.held, null);
check('a pending message IS pending approval', pendingView.pendingApproval === true);

// A row that somehow carries both (a client writing straight to the column
// could not — writes are service-role — but a future bug could): held wins, so
// nothing renders a send button for a project that cannot send.
const bothView = redactMessageForViewer(
  row({ blocked: false, findings: [], pending: true, held: 'walkthrough' }),
  viewer,
);
eq('held + pending: held survives',   bothView.held, 'walkthrough');
check('held + pending: not pending',  bothView.pendingApproval === false);

const plainView = redactMessageForViewer(row({ blocked: false, findings: [] }), viewer);
eq('an ordinary sent message has no held reason', plainView.held, null);
check('an ordinary sent message is not pending',  plainView.pendingApproval === false);

const garbageView = redactMessageForViewer(row({ blocked: false, findings: [], held: 'nonsense' }), viewer);
eq('an unrecognised held value is dropped', garbageView.held, null);

// ─── what the three routes do with a held send (H-4) ──────────────────────────

section('dispositionOf — the branch the three routes share');

// The client reply, the approved follow-up and the rate decision all call this
// with one of three attempts. Nothing else may decide "did it go out".

const wt = dispositionOf({ kind: 'walkthrough' });
eq('walkthrough: stored as walkthrough',   wt.held, 'walkthrough');
check('walkthrough: the engagement still moves — a practised decision has to '
  + 'leave the project where it really would be', wt.advance === true);
check('walkthrough: nothing was delivered', wt.delivered === false);

for (const reason of ['trial', 'disabled'] as const) {
  const d = dispositionOf({ kind: 'outcome', outcome: { sent: false, held: reason } });
  eq(`${reason}: the reason is stored on the message`, d.held, reason);
  check(`${reason}: the rate is NOT written, no event is emitted, no times are proposed`,
    d.advance === false);
  check(`${reason}: nothing was delivered`, d.delivered === false);
}

const delivered = dispositionOf({ kind: 'outcome', outcome: { sent: true } });
eq('sent: no hold on the message',   delivered.held, null);
check('sent: the engagement moves',  delivered.advance === true);
check('sent: delivered',             delivered.delivered === true);

const noAddress = dispositionOf({ kind: 'no_recipient' });
eq('no address yet: nothing to hold',  noAddress.held, null);
check('no address yet: the decision is still recorded', noAddress.advance === true);
check('no address yet: nothing was delivered', noAddress.delivered === false);

// The whole point: a walkthrough hold and a chokepoint hold look the same to
// the reader of the thread and different to the engagement.
check('both kinds of hold render a tag',
  wt.held !== null
  && dispositionOf({ kind: 'outcome', outcome: { sent: false, held: 'trial' } }).held !== null);
check('only the chokepoint hold freezes the engagement',
  wt.advance === true
  && dispositionOf({ kind: 'outcome', outcome: { sent: false, held: 'trial' } }).advance === false);

// The stored hold has to survive the jsonb round trip the routes write it
// through, or the thread renders a message that looks delivered.
const trialView = redactMessageForViewer(
  row({ blocked: false, findings: [], held: 'trial' }),
  viewer,
);
eq('a trial hold reads back off the stored row', trialView.held, 'trial');
check('a trial hold is not pending approval',    trialView.pendingApproval === false);

// The approved-follow-up route puts the pending flag BACK when the chokepoint
// held the draft, and records why. Held wins for rendering; the flag is what
// lets the owner release it once the account is live.
const restoredView = redactMessageForViewer(
  row({ blocked: false, findings: [], pending: true, held: 'trial' }),
  viewer,
);
eq('a restored draft still shows its hold',   restoredView.held, 'trial');
check('a restored draft shows no send button while the hold stands',
  restoredView.pendingApproval === false);

// ─── the browser's view of the same flags ─────────────────────────────────────

section('isHeld / isPendingApproval agree with the server');

function message(patch: Partial<ConversationMessage>): ConversationMessage {
  return {
    id:           'm1',
    direction:    'outbound',
    author:       'matchy',
    body:         'body',
    summary:      null,
    intent:       null,
    screenResult: null,
    createdAt:    '2026-09-07T12:00:00.000Z',
    ...patch,
  };
}

check('isHeld reads the top-level field',
  isHeld(message({ held: 'walkthrough' })) === true);
check('isHeld reads the screenResult mirror',
  isHeld(message({ screenResult: { blocked: false, findings: [], held: 'walkthrough' } })) === true);
check('isHeld is false on an ordinary message',
  isHeld(message({})) === false);
check('a held message never reads as pending, whatever the payload says',
  isPendingApproval(message({ held: 'walkthrough', pendingApproval: true })) === false);
check('a pending message still reads as pending',
  isPendingApproval(message({ pendingApproval: true })) === true);

// ─── Matchy's line ────────────────────────────────────────────────────────────

section("bookmarkLine('walkthrough_held')");

const line = bookmarkLine('walkthrough_held', 'Casey');
check('names the expert',            line.includes('Casey'), line);
check('says nothing was sent',       /nothing was sent/i.test(line), line);
check('names the mode',              /walkthrough/i.test(line), line);
check('carries no address or link',  !/@|http/i.test(line), line);

check('every other outcome still has a line',
  ['intro_sent', 'intro_drafted', 'contact_discovery_started', 'contact_not_found',
   'contact_suppressed', 'contact_check_unavailable', 'intro_failed', 'contact_found',
   'contact_discovery_unavailable']
    .every(o => bookmarkLine(o as Parameters<typeof bookmarkLine>[0], 'Casey').length > 0));

section('WALKTHROUGH_HELD_SUMMARY');
check('is one short sentence pair, no PII', WALKTHROUGH_HELD_SUMMARY.length < 60 && !/@/.test(WALKTHROUGH_HELD_SUMMARY),
  WALKTHROUGH_HELD_SUMMARY);

// ─── validateCreateProjectInput ───────────────────────────────────────────────

section('validateCreateProjectInput — walkthrough');

const base = { name: 'Cold chain logistics', industry: 'Logistics', function: 'Ops', geography: 'US', seniority: 'Senior' };

const absent = validateCreateProjectInput({ ...base });
check('absent: accepted', 'data' in absent);
if ('data' in absent) {
  check('absent: the field is left undefined, so the store writes nothing',
    absent.data.walkthrough === undefined, JSON.stringify(absent.data.walkthrough));
}

const trueBody = validateCreateProjectInput({ ...base, walkthrough: true });
check('true: accepted', 'data' in trueBody);
if ('data' in trueBody) eq('true: carried through', trueBody.data.walkthrough, true);

const falseBody = validateCreateProjectInput({ ...base, walkthrough: false });
check('false: accepted', 'data' in falseBody);
if ('data' in falseBody) eq('false: carried through (this is the live choice)', falseBody.data.walkthrough, false);

for (const bad of ['true', 1, 0, null, {}, []]) {
  const res = validateCreateProjectInput({ ...base, walkthrough: bad });
  check(`rejects ${JSON.stringify(bad)}`,
    'errors' in res && res.errors.some(e => e.field === 'walkthrough' && e.error === 'invalid_walkthrough'),
    JSON.stringify(res));
}

// A rejected walkthrough must not also be silently coerced to live.
const rejected = validateCreateProjectInput({ ...base, walkthrough: 'false' });
check('a rejected value never becomes a project', 'errors' in rejected);

// ─── Result ───────────────────────────────────────────────────────────────────

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log('ALL CHECKS PASSED');
