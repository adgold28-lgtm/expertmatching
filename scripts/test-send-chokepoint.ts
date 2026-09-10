// scripts/test-send-chokepoint.ts — the outbound chokepoint's rules, as pure
// functions.
//
//   npx tsx scripts/test-send-chokepoint.ts
//
// No network, no database, no email. The two things under test are the whole
// decision layer of "may this email leave the building, and may it leave twice":
//
//   lib/emailSequence.resolveSendGate  — the four gates, in order, all of them
//                                        failing closed (DISABLE_EMAILS,
//                                        walkthrough, entitlements, and the
//                                        global do-not-contact list, H-3)
//   lib/outreachSteps.introAlreadySent — the send-once rule for a cold intro,
//                                        which is what stops two bookmarks or a
//                                        double-clicked approve mailing the
//                                        same stranger twice (H-2)
//
// The suppression reader and Resend are "injected" the only way a pure test
// needs them to be: their answers are the inputs. `suppression` is exactly what
// lib/outreachSuppressions.isSuppressed returns, including its fail-closed
// { ok: false } shape; `send: true` is the decision that reaches Resend at all.

import { readFileSync } from 'fs';
import { resolveSendGate, dispositionOf, type SendGateFacts } from '../lib/emailSequence';
import { introAlreadySent } from '../lib/outreachSteps';
import type { SuppressionCheck } from '../lib/outreachSuppressions';
import { check, eq, summary } from './testHarness';

function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

const CLEAR:      SuppressionCheck = { ok: true,  suppressed: false };
const SUPPRESSED: SuppressionCheck = { ok: true,  suppressed: true  };
const UNREADABLE: SuppressionCheck = { ok: false, reason: 'unavailable' };

/** A live, activated, unsuppressed send: the only combination that goes out. */
function live(patch: Partial<SendGateFacts> = {}): SendGateFacts {
  return {
    disableEmails: false,
    walkthrough:   false,
    canOutreach:   true,
    suppression:   CLEAR,
    ...patch,
  };
}

function heldReason(facts: SendGateFacts): string {
  const gate = resolveSendGate(facts);
  return gate.send ? 'SENT' : gate.held;
}

// ─── The one path that sends ──────────────────────────────────────────────────

section('a live, activated project with a clear address sends');

check('live → send', resolveSendGate(live()).send === true);

// ─── The do-not-contact list (H-3) ────────────────────────────────────────────

section('suppression is enforced INSIDE the chokepoint, not only at call sites');

eq('opted out → held',                       heldReason(live({ suppression: SUPPRESSED })), 'suppressed');
eq('list unreadable → held (fail closed)',   heldReason(live({ suppression: UNREADABLE })), 'suppressed');
eq('never checked → held (fail closed)',     heldReason(live({ suppression: null })),       'suppressed');
check('a suppressed address never sends',    resolveSendGate(live({ suppression: SUPPRESSED })).send === false);
check('an unreadable list never sends',      resolveSendGate(live({ suppression: UNREADABLE })).send === false);

// The reason a suppressed hold is not simply 'disabled' or 'trial': the client
// needs to be told the expert opted out, not that their account is unfunded.
check('the suppressed hold is its own reason',
  heldReason(live({ suppression: SUPPRESSED })) !== 'trial'
  && heldReason(live({ suppression: SUPPRESSED })) !== 'disabled'
  && heldReason(live({ suppression: SUPPRESSED })) !== 'walkthrough');

// ─── The other three gates, and their order ───────────────────────────────────

section('the four gates, cheapest first, each one short-circuiting the rest');

eq('walkthrough → held',        heldReason(live({ walkthrough: true })),  'walkthrough');
eq('no card on file → held',    heldReason(live({ canOutreach: false })), 'trial');
eq('entitlement unknown → held', heldReason(live({ canOutreach: null })), 'trial');
eq('DISABLE_EMAILS → held',     heldReason(live({ disableEmails: true })), 'disabled');

// Ordering: the kill switch is reported ahead of everything, walkthrough ahead
// of the account boundary, and the account boundary ahead of suppression. This
// is what lets sendSequenceEmail skip the entitlement read on a walkthrough
// project and the suppression read on an unfunded one.
eq('kill switch beats walkthrough',
  heldReason({ disableEmails: true, walkthrough: true, canOutreach: null, suppression: null }), 'disabled');
eq('walkthrough beats the account boundary',
  heldReason({ disableEmails: false, walkthrough: true, canOutreach: false, suppression: null }), 'walkthrough');
eq('the account boundary beats suppression',
  heldReason(live({ canOutreach: false, suppression: SUPPRESSED })), 'trial');

// Everything unknown at once must still hold, never send.
check('all facts missing → held', resolveSendGate({
  disableEmails: false, walkthrough: false, canOutreach: null, suppression: null,
}).send === false);

// ─── What the caller does with the answer (H-4) ───────────────────────────────

section('dispositionOf — a held send never advances the engagement');

const heldByChokepoint = dispositionOf({ kind: 'outcome', outcome: { sent: false, held: 'trial' } });
eq('chokepoint hold: the reason is stored', heldByChokepoint.held, 'trial');
check('chokepoint hold: nothing advances',  heldByChokepoint.advance === false);
check('chokepoint hold: not delivered',     heldByChokepoint.delivered === false);

const sent = dispositionOf({ kind: 'outcome', outcome: { sent: true } });
eq('a real send stores no hold',    sent.held, null);
check('a real send advances',       sent.advance === true);
check('a real send is delivered',   sent.delivered === true);

const walkthrough = dispositionOf({ kind: 'walkthrough' });
eq('walkthrough stores its reason',        walkthrough.held, 'walkthrough');
check('walkthrough still advances (the mode exists to show the real state)',
  walkthrough.advance === true);
check('walkthrough is not delivered',      walkthrough.delivered === false);

const noRecipient = dispositionOf({ kind: 'no_recipient' });
eq('no address: no hold to show',   noRecipient.held, null);
check('no address: still recorded', noRecipient.advance === true);
check('no address: not delivered',  noRecipient.delivered === false);

// ─── Send once (H-2) ──────────────────────────────────────────────────────────

section('introAlreadySent — one cold email per stranger, ever');

check('a fresh row may be sent to',
  introAlreadySent({}) === false);
check('email1SentAt set → refuse the second send',
  introAlreadySent({ email1SentAt: 1757000000000 }) === true);
check("outreachStep 'email1' set → refuse the second send",
  introAlreadySent({ outreachStep: 'email1' }) === true);
check('both markers → refuse',
  introAlreadySent({ email1SentAt: 1757000000000, outreachStep: 'email1' }) === true);
check('a released claim (email1SentAt back to 0) may be sent to again',
  introAlreadySent({ email1SentAt: 0 }) === false);
check('a drafted intro has no marker and may still be sent',
  introAlreadySent({ outreachStep: undefined, email1SentAt: undefined }) === false);
check('a queued email2 marker is not an intro marker',
  introAlreadySent({ outreachStep: 'email2' }) === false);

// The double-bookmark race, in the terms the row sees it: job A claims, job B
// reads the claimed row and must refuse.
const claimedByA = { email1SentAt: Date.now(), outreachStep: 'email1' as const };
check('the second concurrent job refuses to send', introAlreadySent(claimedByA) === true);

// ─── Matchy 2.0's new surfaces do not open a second door ─────────────────────
//
// A source-level check, deliberately: the gates above are only the chokepoint
// if EVERY path that can put words in front of an expert goes through
// sendSequenceEmail. Matchy 2.0 added a composer with two exits, a draft route
// and the modules behind them. None of them may construct a Resend client or
// call resend.emails.send: the composer's relay exit posts to
// .../messages (which does go through the chokepoint and reads the outcome),
// and the draft exit never sends at all — it hands text back to the client to
// edit. This fails the day someone wires a "just send it" button straight to
// Resend.

section('Matchy 2.0 send surfaces');

const MATCHY_2_MODULES = [
  'lib/matchyDraft.ts',
  'lib/matchyIntent.ts',
  'lib/matchyScreenContext.ts',
  'lib/introPersonalization.ts',
  'lib/rejectionReasons.ts',
  'components/MatchyAskCard.tsx',
  'app/api/projects/[projectId]/experts/[expertId]/messages/draft/route.ts',
];

for (const rel of MATCHY_2_MODULES) {
  const src = readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
  check(`${rel}: no Resend client`,      !/new\s+Resend\s*\(/.test(src), rel);
  check(`${rel}: no direct emails.send`, !/emails\s*\.\s*send\s*\(/.test(src), rel);
}

// The three client→expert routes read the SendOutcome rather than assuming a
// send happened, through the one shared helper (H-4). The intro's own step
// reads it too, and releases its claim when the answer is "held".
const OUTCOME_READERS = [
  'app/api/projects/[projectId]/experts/[expertId]/messages/route.ts',
  'app/api/projects/[projectId]/experts/[expertId]/messages/[messageId]/send/route.ts',
  'app/api/projects/[projectId]/experts/[expertId]/rate-decision/route.ts',
];
for (const rel of OUTCOME_READERS) {
  const src = readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
  check(`${rel}: sends through the chokepoint`, src.includes('sendSequenceEmail'), rel);
  check(`${rel}: reads the outcome`,            src.includes('dispositionOf'),    rel);
}

const introStep = readFileSync(new URL('../lib/outreachSteps.ts', import.meta.url), 'utf8');
check('the intro sends through the chokepoint', introStep.includes('sendSequenceEmail('));
check('a held intro releases the send claim',
  /if \(!introOutcome\.sent\)[\s\S]{0,240}releaseClaim\(/.test(introStep));
check('the intro passes the firm name to deriveTopic as a deny term',
  introStep.includes('clientDenyTermsFor(project, input.firmName)')
  && introStep.includes("denyTerms: input.firmName ? [input.firmName] : []"));

// The two session-authed intro senders hand the firm name down, so the
// review-first path is blinded exactly as carefully as the auto-sent one.
for (const rel of [
  'app/api/projects/[projectId]/experts/[expertId]/bookmark/route.ts',
  'app/api/projects/[projectId]/experts/[expertId]/outreach/approve/route.ts',
]) {
  const src = readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
  check(`${rel}: passes firmName to runSequenceStep`, /firmName:\s*firm\?\.name/.test(src), rel);
}

// ─── Result ───────────────────────────────────────────────────────────────────

summary();
