// scripts/test-screening-form.ts — unit tests for the screening-link half of
// the Structured Request & Screening Flow (docs/SCREENING_FLOW_PLAN.md, build
// step 4): lib/screeningPublic.ts, lib/screeningEmail.ts's held path, and the
// single-use logic the public route depends on, driven against the in-memory
// store.
//
// THE ASSERTION THAT MATTERS is the redaction one. `buildScreeningPayload` is
// the whole of what an expert receives, and the test below serialises a payload
// built from a request stuffed with client identifiers and asserts that not one
// of them survives: not the owner's address, not the organization id, not the
// request id, not the candidate's name, address or row id, and not the CLIENT
// -side rate. A new field on `expert_requests` that reaches an expert fails here
// before it reaches anyone.
//
// OFFLINE. No network, no Supabase, no Redis, no Resend, no model. The token
// secret is supplied here so the script runs with or without a .env.local, the
// two Supabase variables are cleared so lib/requestStore falls back to its
// in-memory store, and DISABLE_EMAILS is set so the one send test cannot leave
// the process.
//
//   npx tsx scripts/test-screening-form.ts
//
// Exits non-zero if any assertion failed, so it can gate a deploy.

process.env.AVAILABILITY_TOKEN_SECRET =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

// The in-memory store is deliberate here, not a fallback we tolerate: these
// tests must never touch a real database.
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

// No email may leave this process, and no suppression lookup may be attempted.
process.env.DISABLE_EMAILS = 'true';

import { randomUUID } from 'crypto';
import {
  screeningLinkUrl,
  buildScreeningPayload,
  buildScreeningLinkEmail,
  matchesToken,
} from '../lib/screeningPublic';
import { sendScreeningLinkEmail } from '../lib/screeningEmail';
import {
  generateScreeningToken,
  verifyScreeningToken,
} from '../lib/screeningToken';
import {
  createRequest,
  updateObjectiveItems,
  approveRequest,
  addCandidate,
  getCandidateByTokenHash,
  submitScreening,
} from '../lib/requestStore';
import {
  validateIntakeInput,
  validateScreeningSubmission,
} from '../lib/screeningValidation';
import { expertRateFor } from '../lib/pricing';
import { DEFAULT_FIRM_PHRASE } from '../lib/matchyTemplates';
import type { ScreeningCandidate, ScreeningRequest } from '../types';
import { check, eq, summary } from './testHarness';

function section(name: string): void {
  console.log(`\n${name}`);
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const OWNER = 'associate@peclient.com';
const ADMIN = 'ops@expertmatch.com';

const OWNER_ID  = '11111111-1111-4111-8111-111111111111';
const ORG_ID    = '22222222-2222-4222-8222-222222222222';
const REQ_ID    = '33333333-3333-4333-8333-333333333333';
const CAND_ID   = '44444444-4444-4444-8444-444444444444';

const EXPERT_NAME  = 'Dana Whitfield';
const EXPERT_EMAIL = 'dana@acme-supply.com';
const EXPERT_ID    = 'em:abcdef0123456789abcdef01';

const DEADLINE = '2026-09-28T17:00:00.000Z';

/** Positions deliberately out of array order — the payload must re-sort. */
function fixtureRequest(): ScreeningRequest {
  return {
    id:             REQ_ID,
    organizationId: ORG_ID,
    ownerId:        OWNER_ID,
    ownerEmail:     OWNER,
    status:         'approved',
    topicStatement: 'Mid-market ERP renewals',
    targeting:      { seniority: 'VP and above', targetCompanies: ['Acme Supply'] },
    callCount:      3,
    deadline:       DEADLINE,
    clientRate:     1300,
    callLengthMin:  60,
    approvedAt:     '2026-09-15T09:00:00.000Z',
    createdAt:      '2026-09-14T09:00:00.000Z',
    updatedAt:      '2026-09-15T09:00:00.000Z',
    objectives: [
      {
        id: 'c0000000-0000-4000-8000-000000000003', requestId: REQ_ID, position: 2,
        objectiveText: 'Who signs off on renewals',
        stem: 'Have you owned a renewal sign-off?', proofPrompt: 'Which role, and which years?',
        clientEdited: false, source: 'model',
      },
      {
        id: 'a0000000-0000-4000-8000-000000000001', requestId: REQ_ID, position: 0,
        objectiveText: 'Pricing changes since 2023',
        stem: 'Have you priced an ERP renewal since 2023?', proofPrompt: 'Which role, and which years?',
        clientEdited: false, source: 'model',
      },
      {
        id: 'b0000000-0000-4000-8000-000000000002', requestId: REQ_ID, position: 1,
        objectiveText: 'Vendor switching costs',
        stem: 'Have you run a vendor switch?', proofPrompt: 'Which role, and which years?',
        clientEdited: true, source: 'client',
      },
    ],
  };
}

function fixtureCandidate(submittedAt: string | null): ScreeningCandidate {
  return {
    id:              CAND_ID,
    requestId:       REQ_ID,
    expertId:        EXPERT_ID,
    expertEmail:     EXPERT_EMAIL,
    snapshot: {
      name:       EXPERT_NAME,
      headline:   'Former VP Procurement',
      background: [{ company: 'Acme Supply', role: 'VP Procurement', dates: '2019-2024' }],
    },
    expiresAt:       DEADLINE,
    submittedAt,
    revokedAt:       null,
    callRequestedAt: null,
    rateAccepted:    null,
    rateAsk:         null,
    availability:    null,
    createdAt:       '2026-09-15T10:00:00.000Z',
    responses:       [],
    outcomes:        [],
  };
}

// ─── 1. The link ──────────────────────────────────────────────────────────────

function linkTests(): void {
  section('Link — screeningLinkUrl');

  eq('builds /s/<token>',
    screeningLinkUrl('https://expertmatch.fit', 'abc.def'),
    'https://expertmatch.fit/s/abc.def');

  eq('strips a trailing slash',
    screeningLinkUrl('https://expertmatch.fit/', 'abc.def'),
    'https://expertmatch.fit/s/abc.def');

  eq('strips several trailing slashes',
    screeningLinkUrl('https://expertmatch.fit///', 'abc.def'),
    'https://expertmatch.fit/s/abc.def');

  eq('percent-encodes the token',
    screeningLinkUrl('https://expertmatch.fit', 'a+b/c=d'),
    'https://expertmatch.fit/s/a%2Bb%2Fc%3Dd');

  eq('leaves base64url characters alone',
    screeningLinkUrl('https://expertmatch.fit', 'aZ0-_.9'),
    'https://expertmatch.fit/s/aZ0-_.9');
}

// ─── 2. The payload ───────────────────────────────────────────────────────────

function payloadTests(): void {
  section('Payload — shape and order');

  const request   = fixtureRequest();
  const candidate = fixtureCandidate(null);
  const payload   = buildScreeningPayload(request, candidate, null);

  eq('exact key set',
    Object.keys(payload).sort().join(','),
    'callLengthMin,deadline,expertRate,firmPhrase,items,state,topic');

  eq('exact item key set',
    Object.keys(payload.items[0]).sort().join(','),
    'id,proofPrompt,stem');

  eq('three items',        payload.items.length, 3);
  eq('items in position order',
    payload.items.map(item => item.stem).join(' | '),
    'Have you priced an ERP renewal since 2023? | Have you run a vendor switch? | Have you owned a renewal sign-off?');

  eq('topic carried verbatim', payload.topic,         request.topicStatement);
  eq('call length carried',    payload.callLengthMin, 60);
  eq('deadline carried',       payload.deadline,      DEADLINE);
  eq('state open before a submission', payload.state, 'open');

  section('Payload — the rate rule');

  eq('expert-side rate only', payload.expertRate, expertRateFor(request.clientRate));
  check('the expert rate is below the client rate', payload.expertRate < request.clientRate);

  section('Payload — the firm phrase');

  eq('falls back when no firm is known', payload.firmPhrase, DEFAULT_FIRM_PHRASE);
  eq('names the shape, never the firm',
    buildScreeningPayload(request, candidate, { firmType: 'pe_firm', firmSize: 'mid_size' }).firmPhrase,
    'a mid-size PE firm');
  eq('an unknown type still falls back',
    buildScreeningPayload(request, candidate, { firmType: null, firmSize: 'large' }).firmPhrase,
    DEFAULT_FIRM_PHRASE);

  section('Payload — redaction (the one that matters)');

  const serialized = JSON.stringify(
    buildScreeningPayload(request, candidate, { firmType: 'pe_firm', firmSize: 'mid_size' }),
  );

  const forbidden: Array<[string, string]> = [
    ['the owner email',        OWNER],
    ['the organization id',    ORG_ID],
    ['the request id',         REQ_ID],
    ['the candidate row id',   CAND_ID],
    ['the expert name',        EXPERT_NAME],
    ['the expert email',       EXPERT_EMAIL],
    ['the expert id',          EXPERT_ID],
    ['the owner id',           OWNER_ID],
    ['the client rate',        String(request.clientRate)],
    ['the targeting',          'VP and above'],
  ];
  for (const [what, value] of forbidden) {
    check(`the payload never carries ${what}`, !serialized.includes(value), serialized);
  }

  check('the objective text never travels either',
    !serialized.includes('Who signs off on renewals'), serialized);

  section('Payload — state');

  eq('state flips once the link has been used',
    buildScreeningPayload(request, fixtureCandidate('2026-09-16T12:00:00.000Z'), null).state,
    'submitted');

  section('Payload — a missing item text degrades, never prints null');

  const incomplete = fixtureRequest();
  incomplete.objectives[0].stem        = null;
  incomplete.objectives[0].proofPrompt = null;
  const degraded = buildScreeningPayload(incomplete, candidate, null);
  eq('a null stem becomes an empty string',         degraded.items[2].stem,        '');
  eq('a null proof prompt becomes an empty string', degraded.items[2].proofPrompt, '');
}

// ─── 3. The email ─────────────────────────────────────────────────────────────

function emailTests(): void {
  section('Email — the screening link');

  const link  = 'https://expertmatch.fit/s/abc.def';
  const email = buildScreeningLinkEmail({
    link,
    topic:           'Mid-market ERP renewals',
    firmPhrase:      'a mid-size PE firm',
    expertRate:      650,
    callLengthMin:   60,
    deadline:        DEADLINE,
    expertFirstName: EXPERT_NAME,
    itemCount:       3,
  });

  check('the subject asks whether it fits',
    email.subject === 'A paid expert call on Mid-market ERP renewals: does it fit?', email.subject);

  check('the text carries the link',   email.text.includes(link), email.text);
  check('the html carries the link',   email.html.includes(link), email.html);
  check('the text quotes the rate',    email.text.includes('$650/hr'), email.text);
  check('the html quotes the rate',    email.html.includes('$650/hr'), email.html);
  check('the text names the call length', email.text.includes('60-minute call'), email.text);
  check('the text names the firm shape',  email.text.includes('A mid-size PE firm'), email.text);
  check('the html names the firm shape',  email.html.includes('A mid-size PE firm'), email.html);
  check('the greeting is the first name only',
    email.text.startsWith('Dear Dana,'), email.text);
  check('the deadline reads as a date', email.text.includes('Sep 28, 2026'), email.text);
  check('the count is spelled out',     email.text.includes('three quick yes/no questions'), email.text);

  section('Email — what it must never say');

  const whole = `${email.subject}\n${email.text}\n${email.html}`;
  const forbidden: Array<[string, string]> = [
    ['the client-side rate, formatted', '$1,300'],
    ['the client-side rate, bare',      '1300'],
    ['a client firm name',              'Meridian Capital'],
    ['a client contact',                OWNER],
  ];
  for (const [what, value] of forbidden) {
    check(`the email never carries ${what}`, !whole.includes(value), whole);
  }

  section('Email — a long topic is clipped in the subject');

  const longTopic = 'Mid-market ERP renewal pricing, vendor switching costs and sign-off authority in North America';
  const clipped   = buildScreeningLinkEmail({
    link, topic: longTopic, firmPhrase: 'a boutique consulting firm',
    expertRate: 400, callLengthMin: 30, deadline: DEADLINE, expertFirstName: 'Sam',
  });
  check('the subject is clipped with an ellipsis', clipped.subject.includes('…'), clipped.subject);
  check('the subject is shorter than the topic',
    clipped.subject.length < `A paid expert call on ${longTopic}: does it fit?`.length,
    clipped.subject);
  check('the body still carries the whole topic', clipped.text.includes(longTopic), clipped.text);
  check('an unknown count reads "a few"',
    clipped.text.includes('a few quick yes/no questions'), clipped.text);
}

// ─── 4. End to end against the in-memory store ────────────────────────────────

async function storeWalkthrough(): Promise<void> {
  section('Store — mint, resolve, submit');

  const intake = validateIntakeInput({
    topicStatement:     'Mid-market ERP renewals',
    learningObjectives: [
      'Pricing changes since 2023',
      'Vendor switching costs',
      'Who signs off on renewals',
    ],
    clientRate:    1300,
    callLengthMin: 60,
  });
  if (!('data' in intake)) {
    check('intake for the walkthrough is valid', false, intake.errors.map(e => e.error).join(','));
    return;
  }

  const created = await createRequest(intake.data, OWNER);
  await updateObjectiveItems(created.id, created.objectives.map((objective, index) => ({
    id:          objective.id,
    stem:        `Stem ${index}?`,
    proofPrompt: 'Which role, and which years?',
    source:      'model' as const,
  })));
  const approved = await approveRequest(created.id);
  eq('the request is approved', approved.status, 'approved');

  // The mint order the route uses: id first, signed second, stored third.
  const id     = randomUUID();
  const minted = generateScreeningToken(id, approved.id, Date.parse(approved.deadline));

  const candidate = await addCandidate(approved.id, {
    id,
    expertId:       EXPERT_ID,
    expertEmail:    EXPERT_EMAIL,
    snapshot: {
      name:       EXPERT_NAME,
      headline:   'Former VP Procurement',
      background: [{ company: 'Acme Supply', role: 'VP Procurement', dates: '2019-2024' }],
    },
    tokenHash:      minted.tokenHash,
    expiresAt:      approved.deadline,
    createdByEmail: ADMIN,
  });
  eq('the row is the id the token was signed for', candidate.id, id);

  const found = await getCandidateByTokenHash(minted.tokenHash);
  check('the link resolves by its hash', found !== null);
  if (!found) return;
  eq('and resolves to that same row', found.candidate.id, id);

  section('Store — the token cross-check');

  const verified = verifyScreeningToken(minted.token);
  check('the minted token verifies', verified.ok);
  if (!verified.ok) return;
  check('the row matches its own token', matchesToken(found.candidate, verified.data));

  const otherRequestId = randomUUID();
  const crossToken = generateScreeningToken(id, otherRequestId, Date.parse(approved.deadline));
  const crossVerified = verifyScreeningToken(crossToken.token);
  check('a token for another request still verifies as ours', crossVerified.ok);
  if (crossVerified.ok) {
    check('but the row refuses it', !matchesToken(found.candidate, crossVerified.data));
  }

  const otherRowToken = generateScreeningToken(randomUUID(), approved.id, Date.parse(approved.deadline));
  const otherRowVerified = verifyScreeningToken(otherRowToken.token);
  if (otherRowVerified.ok) {
    check('a token for another row is refused too',
      !matchesToken(found.candidate, otherRowVerified.data));
  }

  section('Store — the submission is single use');

  const objectiveIds = [...approved.objectives]
    .sort((a, b) => a.position - b.position)
    .map(objective => objective.id);

  const form = validateScreeningSubmission({
    answers: [
      { objectiveId: objectiveIds[0], answer: 'yes', proofText: 'I ran renewals as VP Procurement, 2019 to 2024.' },
      { objectiveId: objectiveIds[1], answer: 'no' },
      { objectiveId: objectiveIds[2], answer: 'unsure' },
    ],
    rateAccepted: false,
    rateAsk:      800,
    availability: 'next_week',
  }, objectiveIds);
  check('the submission validates', 'data' in form,
    'errors' in form ? form.errors.map(e => e.error).join(',') : '');
  if (!('data' in form)) return;

  eq('answers come back in position order',
    form.data.answers.map(a => a.objectiveId).join(','), objectiveIds.join(','));
  eq('a no carries no proof', form.data.answers[1].proofText, null);

  eq('the first submission is accepted', await submitScreening(candidate.id, form.data), 'ok');
  eq('the second is refused',            await submitScreening(candidate.id, form.data), 'already_submitted');

  const after = await getCandidateByTokenHash(minted.tokenHash);
  check('the link is stamped as used', after?.candidate.submittedAt != null);
  eq('the answers were stored',        after?.candidate.responses.length, 3);
  eq('the rate ask was stored',        after?.candidate.rateAsk, 800);

  if (after) {
    eq('and the payload now reads submitted',
      buildScreeningPayload(approved, after.candidate, null).state, 'submitted');
  }

  section('Store — an expiry in the past is dead on arrival');

  const stale = generateScreeningToken(randomUUID(), approved.id, Date.now() - 1000);
  const staleVerified = verifyScreeningToken(stale.token);
  check('a token stamped in the past does not verify', !staleVerified.ok);
  if (!staleVerified.ok) eq('and says why, to the server only', staleVerified.reason, 'expired');
}

// ─── 5. The send is held ──────────────────────────────────────────────────────

async function sendTests(): Promise<void> {
  section('Email — DISABLE_EMAILS holds the send');

  const outcome = await sendScreeningLinkEmail({
    to:              EXPERT_EMAIL,
    link:            'https://expertmatch.fit/s/abc.def',
    topic:           'Mid-market ERP renewals',
    firmPhrase:      'a mid-size PE firm',
    expertRate:      650,
    callLengthMin:   60,
    deadline:        DEADLINE,
    expertFirstName: EXPERT_NAME,
    itemCount:       3,
  });

  eq('nothing was sent', outcome.sent, false);
  if (!outcome.sent) eq('and the reason is honest', outcome.held, 'disabled');
}

// ─── Run ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  linkTests();
  payloadTests();
  emailTests();
  await storeWalkthrough();
  await sendTests();
  summary('screening form');
}

void main().catch((err: unknown) => {
  console.error('test-screening-form crashed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
