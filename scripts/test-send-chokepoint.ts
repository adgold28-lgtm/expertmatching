// scripts/test-send-chokepoint.ts — the outbound chokepoint's rules, as pure
// functions.
//
//   npx tsx scripts/test-send-chokepoint.ts
//
// No network, no database, no email. The two things under test are the whole
// decision layer of "may this email leave the building, and may it leave twice":
//
//   lib/emailSequence.resolveSendGate  — the five gates, in order, all of them
//                                        failing closed (DISABLE_EMAILS,
//                                        walkthrough, entitlements, the
//                                        global do-not-contact list, H-3, and
//                                        the client firm's own list, which
//                                        scripts/test-do-not-contact.ts covers
//                                        in depth)
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
import { resolveSendGate, dispositionOf, type SendGateFacts, type SendOutcome, withFromDisplayName } from '../lib/emailSequence';
import { introAlreadySent, runSequenceStep, type SequenceStepDeps } from '../lib/outreachSteps';
import type { UpdateExpertInput } from '../lib/projectStore';
import type { Project, ProjectExpert } from '../types';
import type { SuppressionCheck } from '../lib/outreachSuppressions';
import type { DoNotContactCheck } from '../lib/doNotContact';
import { check, eq, summary } from './testHarness';

function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

const CLEAR:      SuppressionCheck = { ok: true,  suppressed: false };
const SUPPRESSED: SuppressionCheck = { ok: true,  suppressed: true  };
const UNREADABLE: SuppressionCheck = { ok: false, reason: 'unavailable' };

const FIRM_CLEAR:  DoNotContactCheck = { ok: true,  match: null };
const FIRM_LISTED: DoNotContactCheck = { ok: true,  match: { kind: 'company', normalized: 'globex' } };
const FIRM_DOWN:   DoNotContactCheck = { ok: false, reason: 'unavailable' };

/** A live, activated, unsuppressed send: the only combination that goes out. */
function live(patch: Partial<SendGateFacts> = {}): SendGateFacts {
  return {
    disableEmails: false,
    walkthrough:   false,
    canOutreach:   true,
    suppression:   CLEAR,
    doNotContact:  FIRM_CLEAR,
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

// ─── The firm's own list ──────────────────────────────────────────────────────

section("the firm's own do-not-contact list is the fifth gate, and fails closed");

eq('on the firm list → held',                 heldReason(live({ doNotContact: FIRM_LISTED })), 'do_not_contact');
eq('firm list unreadable → held',             heldReason(live({ doNotContact: FIRM_DOWN })),   'do_not_contact');
eq('firm list never checked → held',          heldReason(live({ doNotContact: null })),        'do_not_contact');
eq('a global opt-out is reported before it',  heldReason(live({ suppression: SUPPRESSED, doNotContact: FIRM_LISTED })), 'suppressed');

section('the five gates, cheapest first, each one short-circuiting the rest');

eq('walkthrough → held',        heldReason(live({ walkthrough: true })),  'walkthrough');
eq('no card on file → held',    heldReason(live({ canOutreach: false })), 'trial');
eq('entitlement unknown → held', heldReason(live({ canOutreach: null })), 'trial');
eq('DISABLE_EMAILS → held',     heldReason(live({ disableEmails: true })), 'disabled');

// Ordering: the kill switch is reported ahead of everything, walkthrough ahead
// of the account boundary, and the account boundary ahead of suppression. This
// is what lets sendSequenceEmail skip the entitlement read on a walkthrough
// project and the suppression read on an unfunded one.
eq('kill switch beats walkthrough',
  heldReason({ disableEmails: true, walkthrough: true, canOutreach: null, suppression: null, doNotContact: null }), 'disabled');
eq('walkthrough beats the account boundary',
  heldReason({ disableEmails: false, walkthrough: true, canOutreach: false, suppression: null, doNotContact: null }), 'walkthrough');
eq('the account boundary beats suppression',
  heldReason(live({ canOutreach: false, suppression: SUPPRESSED })), 'trial');

// Everything unknown at once must still hold, never send.
check('all facts missing → held', resolveSendGate({
  disableEmails: false, walkthrough: false, canOutreach: null, suppression: null, doNotContact: null,
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

// A HARD BOUNCE (lib/deliveryEvents.ts): the bounced intro reached nobody, so
// exactly one intro may go to a DIFFERENT address found afterwards. The full
// story is in scripts/test-delivery-events.ts; these pin the rule here too.
const bouncedRow = {
  email1SentAt:     1757000000000,
  outreachStep:     'email1' as const,
  bouncedEmails:    ['old@acmecoatings.example'],
  contactBouncedAt: 1757000060000,
};
check('after a bounce, a new address may get one intro',
  introAlreadySent({ ...bouncedRow, contactEmail: 'new@acmecoatings.example' }) === false);
check('after a bounce, the bounced address may not',
  introAlreadySent({ ...bouncedRow, contactEmail: 'OLD@acmecoatings.example' }) === true);
check('after a bounce, with no address on file, the claim stands',
  introAlreadySent(bouncedRow) === true);
check('once the new intro is claimed, a second one is refused',
  introAlreadySent({ ...bouncedRow, contactEmail: 'new@acmecoatings.example', email1SentAt: 1757000120000 }) === true);

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

// ── Reply-To display name (the coded address must not be what an expert sees) ──
check('reply-to takes the From display name',
  withFromDisplayName('Asher Goldstein <asher@expertmatch.fit>', 'reply+abc@reply.expertmatch.fit') === '"Asher Goldstein" <reply+abc@reply.expertmatch.fit>');
check('quoted From name is unwrapped',
  withFromDisplayName('"ExpertMatch" <notifications@expertmatch.fit>', 'reply+x@reply.expertmatch.fit') === '"ExpertMatch" <reply+x@reply.expertmatch.fit>');
check('bare From keeps a bare reply-to',
  withFromDisplayName('asher@expertmatch.fit', 'reply+x@reply.expertmatch.fit') === 'reply+x@reply.expertmatch.fit');

// ─── A held intro leaves the row exactly where it was ────────────────────────
//
// runSequenceStep for real, through its deps seam: an in-memory row whose
// writes merge the way lib/projectStore.applyExpertInput merges them (a key
// present with `undefined` overwrites), a stub sender, no Redis. The claim
// writes outreachStep 'email1' BEFORE the send; when the chokepoint holds the
// send, releaseClaim must put back what was there, INCLUDING NOTHING.
// Otherwise the row keeps 'email1', introAlreadySent reads it as sent, and the
// next approve answers "sent" having sent nothing.

async function heldIntroChecks(): Promise<void> {
  section('runSequenceStep — a held intro does not read as sent');

  // buildIntroEmail signs an opt-out link; a throwaway secret, invented here.
  process.env.AVAILABILITY_TOKEN_SECRET ??= 'test-only-secret-0123456789abcdef0123456789';

  const PROJECT = 'a'.repeat(24);
  const EXPERT  = 'exp_held';
  let row: ProjectExpert = {
    expert: {
      id: EXPERT, name: 'Dana Reyes', title: 'VP Operations', company: 'Acme Coatings', location: 'Ohio',
      category: 'Operator', justification: 'Ran coatings operations.', relevance_score: 90,
      source_url: 'https://acmecoatings.example/team', source_label: 'Company site', source_links: [],
    } as ProjectExpert['expert'],
    status:        'bookmarked',
    contactEmail:  'dana.reyes@acmecoatings.example',
    expertRate:    650,
    clientRate:    1300,
    whyThem:       'You ran coatings operations at Acme for six years',
    introDomain:   'industrial coatings',
    outreachToken: 'tok_held',
    addedAt:       1,
    updatedAt:     1,
  };
  const project = (): Project => ({
    id: PROJECT, name: 'Coatings', researchQuestion: 'Coatings margins', industry: 'Chemicals',
    function: 'Operations', geography: 'US', seniority: 'Senior', createdAt: 1, updatedAt: 1,
    experts: [row], ownerEmail: 'owner@pe.example', collaborators: [], firmDomain: 'pe.example', walkthrough: false,
  } as Project);

  let outcome: SendOutcome = { sent: false, held: 'suppressed' };
  const sent: string[] = [];
  const deps: Partial<SequenceStepDeps> = {
    getProject: async () => structuredClone(project()),
    updateExpertStatus: async (_p, _e, input: UpdateExpertInput) => {
      const { expertPatch: _patch, ...fields } = input;
      row = { ...row, ...fields, updatedAt: row.updatedAt + 1 } as ProjectExpert;
      return structuredClone(project());
    },
    sendSequenceEmail: async (to: string) => {
      if (outcome.sent) sent.push(to);
      return outcome;
    },
    redis: () => null,
    now:   () => 1_760_000_000_000,
  };

  const step = { projectId: PROJECT, expertId: EXPERT, step: 'intro' as const, token: 'tok_held' };

  const held = await runSequenceStep(step, deps);
  check('held: the step answers ok', held.ok === true);
  check('held: not reported as already sent', held.ok === true && held.alreadySent !== true);
  eq('held: nothing went', sent.length, 0);
  eq('held: the row is a draft again', row.status, 'outreach_drafted');
  eq('held: email1SentAt released', row.email1SentAt ?? 0, 0);
  eq("held: outreachStep is back to what it was (nothing), not 'email1'", row.outreachStep, undefined);
  check('held: introAlreadySent reads it as NOT sent', introAlreadySent(row) === false);

  // The later approve: the hold has cleared, and the intro must actually go.
  outcome = { sent: true };
  const approved = await runSequenceStep(step, deps);
  check('approve after a hold: not "already sent"', approved.ok === true && approved.alreadySent !== true);
  eq('approve after a hold: the intro actually went', sent.length, 1);
  eq('approve after a hold: claimed for real', row.outreachStep, 'email1');

  const again = await runSequenceStep(step, deps);
  check('and a second approve is refused', again.ok === true && again.alreadySent === true);
  eq('…sending nothing', sent.length, 1);
}

heldIntroChecks().then(() => summary(), err => {
  console.error('test-send-chokepoint crashed:', err);
  process.exit(1);
});

