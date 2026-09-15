// scripts/test-screening-redaction.ts — the anonymity boundary of the
// Structured Request & Screening Flow, checked from both sides
// (docs/SCREENING_FLOW_PLAN.md, build step 5).
//
// THE PROMISE UNDER TEST. A client who opens a request sees "Candidate 2", the
// background lines and the expert's own sentences. They do not see the expert's
// name, the expert's email address, or the EXPERT-side rate the expert asked
// for — they see the CLIENT-side conversion of it (lib/pricing.clientRateFor),
// which is the rate rule from docs/MATCHY_SPEC.md. Platform staff see all
// three. lib/screeningView.buildRequestView is the one place that decides, so
// it is the one place this script tests.
//
// HOW IT TESTS IT. Three deliberately distinctive values go in — the name
// 'Zebulon Quartermain', the address 'zq@example.test' and the ask 731 — and
// the whole client-side view is then searched for all three: as a substring of
// its JSON, and as a primitive at any depth. A substring search alone would
// pass if a field were renamed; a deep scan alone would pass if a value were
// concatenated into a sentence. Both have to be clean. The admin view is
// checked to CONTAIN all three, which is what proves the searches work at all.
//
// Candidate ids and timestamps are hand-written rather than generated, and
// contain no digits that could make '731' appear by accident.
//
// It also covers the ordering rules the review table depends on (labels are
// minted in creation order and survive the coverage sort) and
// lib/screeningValidation.validateOutcomesInput, the stage-5 validator.
//
// OFFLINE. No network, no Supabase, no Redis, no model, no environment at all:
// every object here is built by hand and buildRequestView is pure.
//
//   npx tsx scripts/test-screening-redaction.ts
//
// Exits non-zero if any assertion failed, so it can gate a deploy.

import { buildRequestView, type ScreeningRequestView } from '../lib/screeningView';
import { clientRateFor } from '../lib/pricing';
import { validateOutcomesInput, isValid, type ValidationError } from '../lib/screeningValidation';
import type {
  ScreeningCandidate,
  ScreeningObjective,
  ScreeningRequest,
  ScreeningResponse,
} from '../types';
import { check, eq, summary } from './testHarness';

function section(name: string): void {
  console.log(`\n${name}`);
}

// ─── The three values a client must never receive ─────────────────────────────

const SECRET_NAME  = 'Zebulon Quartermain';
const SECRET_EMAIL = 'zq@example.test';
const SECRET_ASK   = 731;            // EXPERT-side dollars per hour
const REQUEST_RATE = 1300;           // CLIENT-side, what the client already agreed

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function objective(index: number, text: string): ScreeningObjective {
  return {
    id:            `obj-${index}`,
    requestId:     'req-one',
    position:      index - 1,
    objectiveText: text,
    stem:          `Have you ${text.toLowerCase()}?`,
    proofPrompt:   'Which role and which years does that come from?',
    clientEdited:  false,
    source:        'model',
  };
}

const OBJECTIVES: ScreeningObjective[] = [
  objective(1, 'Priced a private-label contract'),
  objective(2, 'Run a distribution centre through a systems cutover'),
  objective(3, 'Negotiated with a national grocer'),
  objective(4, 'Carried a regional P and L'),
];

const REQUEST: ScreeningRequest = {
  id:             'req-one',
  organizationId: 'org-one',
  ownerId:        'owner-one',
  ownerEmail:     'associate@fund.example',
  status:         'approved',
  topicStatement: 'Private-label economics in mid-market grocery distribution',
  targeting:      {},
  callCount:      2,
  deadline:       '2026-09-28T00:00:00.000Z',
  clientRate:     REQUEST_RATE,
  callLengthMin:  60,
  approvedAt:     '2026-09-02T12:00:00.000Z',
  createdAt:      '2026-09-01T08:00:00.000Z',
  updatedAt:      '2026-09-02T12:00:00.000Z',
  objectives:     OBJECTIVES,
};

function answers(pattern: Array<'yes' | 'no' | 'unsure'>): ScreeningResponse[] {
  return pattern.map((answer, index) => ({
    objectiveId: `obj-${index + 1}`,
    answer,
    proofText:   answer === 'yes'
      ? 'I owned this as the buyer on that account from twenty eighteen to twenty twenty two.'
      : null,
  }));
}

/** Every field spelled out — the point of this script is that nothing is spread. */
function candidate(over: Partial<ScreeningCandidate> & { id: string; createdAt: string }): ScreeningCandidate {
  return {
    requestId:       'req-one',
    expertId:        `anon:${over.id}`,
    expertEmail:     null,
    snapshot:        { name: 'Unnamed', headline: '', background: [] },
    expiresAt:       '2026-09-28T00:00:00.000Z',
    submittedAt:     null,
    revokedAt:       null,
    callRequestedAt: null,
    rateAccepted:    null,
    rateAsk:         null,
    availability:    null,
    responses:       [],
    outcomes:        [],
    ...over,
  };
}

// Mint order is creation order: tok-one, tok-two, tok-three, tok-four.
const ACCEPTED = candidate({
  id:          'tok-one',
  createdAt:   '2026-09-02T09:00:00.000Z',
  expertId:    'em:aaaaaaaaaaaaaaaaaaaaaaaa',
  expertEmail: 'ada@example.test',
  snapshot: {
    name:     'Ada Ninefold',
    headline: 'Category Director, regional grocer',
    background: [
      { company: 'Northwind Foods', role: 'Category Director', dates: 'two thousand nineteen to today' },
    ],
  },
  submittedAt:  '2026-09-04T09:00:00.000Z',
  rateAccepted: true,
  availability: 'next_week',
  responses:    answers(['yes', 'no', 'yes', 'no']),          // 2 of 4
});

const COUNTERED = candidate({
  id:          'tok-two',
  createdAt:   '2026-09-02T10:00:00.000Z',
  expertId:    'em:bbbbbbbbbbbbbbbbbbbbbbbb',
  expertEmail: SECRET_EMAIL,
  snapshot: {
    name:     SECRET_NAME,
    headline: 'VP Supply Chain, mid-market distributor',
    background: [
      { company: 'Cobblestone Distribution', role: 'VP Supply Chain', dates: 'two thousand sixteen to today' },
      { company: 'Harbourline Grocers',      role: 'Director of Ops', dates: '' },
    ],
  },
  submittedAt:  '2026-09-04T11:00:00.000Z',
  rateAccepted: false,
  rateAsk:      SECRET_ASK,
  availability: 'this_week',
  responses:    answers(['yes', 'yes', 'yes', 'yes']),        // 4 of 4
  outcomes:     [{ objectiveId: 'obj-1', outcome: 'answered' }],
});

const WAITING = candidate({
  id:        'tok-three',
  createdAt: '2026-09-03T09:00:00.000Z',
  snapshot:  { name: 'Beatrix Unsent', headline: 'Head of Merchandising', background: [] },
});

const REVOKED = candidate({
  id:        'tok-four',
  createdAt: '2026-09-03T10:00:00.000Z',
  snapshot:  { name: 'Cyrus Withdrawn', headline: '', background: [] },
  revokedAt: '2026-09-05T09:00:00.000Z',
});

const CANDIDATES: ScreeningCandidate[] = [ACCEPTED, COUNTERED, WAITING, REVOKED];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Every primitive at any depth — the search a renamed field cannot escape. */
function primitives(node: unknown, out: unknown[]): unknown[] {
  if (node === null || typeof node !== 'object') { out.push(node); return out; }
  if (Array.isArray(node)) { for (const item of node) primitives(item, out); return out; }
  for (const value of Object.values(node)) primitives(value, out);
  return out;
}

function byId(view: ScreeningRequestView, id: string) {
  const found = view.respondents.find(r => r.id === id);
  if (!found) throw new Error(`respondent missing from the view: ${id}`);
  return found;
}

function codes<T>(result: { data: T } | { errors: ValidationError[] }): string[] {
  return 'errors' in result ? result.errors.map(e => e.error) : [];
}

function hasCode<T>(result: { data: T } | { errors: ValidationError[] }, code: string): boolean {
  return codes(result).includes(code);
}

/** Every refusal is shown to a person, so every message has to read as one. */
function messagesAreSentences<T>(result: { data: T } | { errors: ValidationError[] }): boolean {
  if (!('errors' in result)) return true;
  return result.errors.every(e => /^[A-Z“"$]/.test(e.message) && /[.!?]$/.test(e.message.trim()));
}

// ─── The two views ────────────────────────────────────────────────────────────

const clientView = buildRequestView(REQUEST, CANDIDATES, {
  email: 'associate@fund.example',
  role:  'user',
});
const staffView = buildRequestView(REQUEST, CANDIDATES, {
  email: 'ops@expertmatch.example',
  role:  'admin',
});

const clientJson = JSON.stringify(clientView);
const staffJson  = JSON.stringify(staffView);
const clientValues = primitives(clientView, []);
const staffValues  = primitives(staffView, []);

// ─── 1. The client view carries none of the three ─────────────────────────────

section('client view — the three redacted values');

check('no expert name in the JSON',    !clientJson.includes(SECRET_NAME));
check('no expert address in the JSON', !clientJson.includes(SECRET_EMAIL));
check('no expert ask in the JSON',     !clientJson.includes(String(SECRET_ASK)),
  'the EXPERT-side number must not appear anywhere, in any field');

check('no expert name as a value',    !clientValues.includes(SECRET_NAME));
check('no expert address as a value', !clientValues.includes(SECRET_EMAIL));
check('no expert ask as a value',     !clientValues.includes(SECRET_ASK));

check('no name key on any respondent',
  clientView.respondents.every(r => r.name === undefined));
check('no email key on any respondent',
  clientView.respondents.every(r => r.email === undefined));
check('no expertAsk key on any rate',
  clientView.respondents.every(r => r.rate === null || r.rate.expertAsk === undefined));

// The other expert's address is not the canary, but it is the same boundary.
check('no other expert address either', !clientJson.includes('ada@example.test'));
check('no other expert name either',    !clientJson.includes('Ada Ninefold'));

// ─── 2. Staff see all three (so the searches above mean something) ────────────

section('admin view — staff see all three');

check('expert name in the JSON',    staffJson.includes(SECRET_NAME));
check('expert address in the JSON', staffJson.includes(SECRET_EMAIL));
check('expert ask in the JSON',     staffJson.includes(String(SECRET_ASK)));

check('expert ask as a number value', staffValues.includes(SECRET_ASK));
eq('the name is on the respondent',    byId(staffView, 'tok-two').name,  SECRET_NAME);
eq('the address is on the respondent', byId(staffView, 'tok-two').email, SECRET_EMAIL);
eq('the ask is on the rate',           byId(staffView, 'tok-two').rate?.expertAsk, SECRET_ASK);
check('no address on a candidate that has none',
  byId(staffView, 'tok-three').email === undefined);

// ─── 3. The rate the client sees is the conversion, not the ask ───────────────

section('rate — the client sees the client-side number');

const counteredForClient = byId(clientView, 'tok-two');
eq('a counter converts through clientRateFor',
  counteredForClient.rate?.clientRate, clientRateFor(SECRET_ASK));
check('the conversion is not the ask', clientRateFor(SECRET_ASK) !== SECRET_ASK);
eq('a counter reads as not accepted', counteredForClient.rate?.accepted, false);

const acceptedForClient = byId(clientView, 'tok-one');
eq('an accepted rate is the request rate', acceptedForClient.rate?.clientRate, REQUEST_RATE);
eq('an accepted rate reads as accepted',   acceptedForClient.rate?.accepted, true);

eq('staff see the same client-side number',
  byId(staffView, 'tok-two').rate?.clientRate, clientRateFor(SECRET_ASK));

// ─── 4. Labels are minted in creation order and survive the sort ──────────────

section('labels and ordering');

eq('first minted is Candidate 1', byId(clientView, 'tok-one').label,   'Candidate 1');
eq('second minted is Candidate 2', byId(clientView, 'tok-two').label,   'Candidate 2');
eq('third minted is Candidate 3',  byId(clientView, 'tok-three').label, 'Candidate 3');
eq('fourth minted is Candidate 4', byId(clientView, 'tok-four').label,  'Candidate 4');

eq('the admin view labels identically',
  byId(staffView, 'tok-two').label, byId(clientView, 'tok-two').label);

eq('submitted first, coverage descending, then mint order',
  clientView.respondents.map(r => r.id).join(','),
  'tok-two,tok-one,tok-three,tok-four');

check('the highest coverage is displayed first, label unchanged',
  clientView.respondents[0].label === 'Candidate 2',
  'a label derived from display position would rename people on every submission');

// ─── 5. Coverage, answers and the unsubmitted ─────────────────────────────────

section('coverage and the unsubmitted');

eq('four of four',  byId(clientView, 'tok-two').coverage?.yes,   4);
eq('out of four',   byId(clientView, 'tok-two').coverage?.total, 4);
eq('two of four',   byId(clientView, 'tok-one').coverage?.yes,   2);
eq('ratio is a half', byId(clientView, 'tok-one').coverage?.ratio, 0.5);

eq('an unanswered link has no coverage', byId(clientView, 'tok-three').coverage, null);
eq('an unanswered link has no answers',  byId(clientView, 'tok-three').answers.length, 0);
eq('an unanswered link has no rate',     byId(clientView, 'tok-three').rate, null);
eq('a revoked link has no coverage',     byId(clientView, 'tok-four').coverage, null);
eq('a revoked link has no answers',      byId(clientView, 'tok-four').answers.length, 0);
check('a revoked link is still listed', clientView.respondents.some(r => r.id === 'tok-four'),
  'nothing on this surface hides a respondent');

const proof = byId(clientView, 'tok-two').answers[0].proofText;
check('the client gets the expert’s own sentence, unedited',
  proof === COUNTERED.responses[0].proofText);

eq('the client may act on their own request', clientView.canEdit, true);
eq('a client is not an admin',                clientView.isAdmin, false);
eq('staff may act',                           staffView.canEdit,  true);
eq('staff are an admin',                      staffView.isAdmin,  true);

// ─── 6. validateOutcomesInput ─────────────────────────────────────────────────

section('validateOutcomesInput');

const ids = OBJECTIVES.map(o => o.id);

const missing = validateOutcomesInput({}, ids);
check('a missing list is refused', hasCode(missing, 'outcomes_required'));

const empty = validateOutcomesInput({ outcomes: [] }, ids);
check('an empty list is refused', hasCode(empty, 'outcomes_required'));
check('and says so as a sentence', messagesAreSentences(empty));

const tooMany = validateOutcomesInput(
  { outcomes: [...ids, 'obj-1'].map(id => ({ objectiveId: id, outcome: 'answered' })) },
  ids,
);
check('more entries than objectives is refused', hasCode(tooMany, 'too_many_outcomes'));

const unknown = validateOutcomesInput(
  { outcomes: [{ objectiveId: 'obj-elsewhere', outcome: 'answered' }] },
  ids,
);
check('an objective from another request is refused', hasCode(unknown, 'unknown_objective'));

const badOutcome = validateOutcomesInput(
  { outcomes: [{ objectiveId: 'obj-1', outcome: 'maybe' }] },
  ids,
);
check('an outcome outside the three is refused', hasCode(badOutcome, 'invalid_outcome'));

const duplicate = validateOutcomesInput(
  {
    outcomes: [
      { objectiveId: 'obj-1', outcome: 'answered' },
      { objectiveId: 'obj-1', outcome: 'partial'  },
    ],
  },
  ids,
);
check('the same objective twice is refused', hasCode(duplicate, 'duplicate_outcome'));
check('a duplicate reads as a sentence', messagesAreSentences(duplicate));

const valid = validateOutcomesInput(
  {
    outcomes: [
      { objectiveId: 'obj-3', outcome: 'unanswered' },
      { objectiveId: 'obj-1', outcome: 'answered'   },
    ],
  },
  ids,
);
check('a partial list is accepted', isValid(valid),
  'a client marks what they got to and comes back for the rest');
if (isValid(valid)) {
  eq('two verdicts kept', valid.data.length, 2);
  eq('returned in objective order, not body order',
    valid.data.map(o => o.objectiveId).join(','), 'obj-1,obj-3');
  eq('the verdict survives', valid.data[0].outcome, 'answered');
}

const everything = validateOutcomesInput(
  { outcomes: ids.map(id => ({ objectiveId: id, outcome: 'partial' })) },
  ids,
);
check('one verdict per objective is accepted', isValid(everything));

summary('screening-redaction');
