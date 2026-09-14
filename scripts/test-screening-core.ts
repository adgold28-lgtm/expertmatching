// scripts/test-screening-core.ts — unit tests for the schema-and-core half of
// the Structured Request & Screening Flow (docs/SCREENING_FLOW_PLAN.md, build
// step 1): lib/screeningToken.ts, lib/screeningCoverage.ts,
// lib/screeningValidation.ts and lib/requestStore.ts's in-memory store.
//
// OFFLINE. No network, no Supabase, no Redis, no model. The token secret is
// supplied here so the script runs with or without a .env.local, and the two
// Supabase variables are cleared so lib/requestStore falls back to its
// in-memory store — which is also the store under test.
//
//   npx tsx scripts/test-screening-core.ts
//
// Exits non-zero if any assertion failed, so it can gate a deploy.

process.env.AVAILABILITY_TOKEN_SECRET =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

// The in-memory store is deliberate here, not a fallback we tolerate: these
// tests must never touch a real database.
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

import { randomUUID } from 'crypto';
import {
  generateScreeningToken,
  verifyScreeningToken,
  hashScreeningToken,
} from '../lib/screeningToken';
import { sign } from '../lib/hmacToken';
import {
  computeCoverage,
  coverageBand,
  sortRespondents,
  COVERAGE_GREEN_MIN,
  COVERAGE_AMBER_MIN,
} from '../lib/screeningCoverage';
import {
  validateIntakeInput,
  validateObjectiveEdits,
  validateScreeningSubmission,
  validateCandidateInput,
  normalizeExpertId,
  LIMITS,
  type ValidationError,
} from '../lib/screeningValidation';
import {
  createRequest,
  getRequest,
  getRequestForUser,
  listRequestsForUser,
  updateObjectiveItems,
  approveRequest,
  addCandidate,
  listCandidates,
  getCandidateByTokenHash,
  submitScreening,
  requestCall,
  revokeCandidate,
  recordOutcomes,
} from '../lib/requestStore';
import type { Coverage, ScreeningAnswer } from '../types';
import { check, eq, summary } from './testHarness';

function section(name: string): void {
  console.log(`\n${name}`);
}

/** The snake_case codes a validator refused with; [] when it accepted. */
function codes<T>(result: { data: T } | { errors: ValidationError[] }): string[] {
  return 'errors' in result ? result.errors.map(e => e.error) : [];
}

function hasCode<T>(result: { data: T } | { errors: ValidationError[] }, code: string): boolean {
  return codes(result).includes(code);
}

/** Every message a validator produces must read as a sentence, never as a code. */
function messagesAreSentences<T>(result: { data: T } | { errors: ValidationError[] }): boolean {
  if (!('errors' in result)) return true;
  return result.errors.every(e => /^[A-Z“"$]/.test(e.message) && /[.!?]$/.test(e.message.trim()));
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** A UTC 'YYYY-MM-DD' this many days from now — what a date input submits. */
function isoDay(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10);
}

function answers(n: number, yes: number): Array<{ answer: ScreeningAnswer }> {
  return Array.from({ length: n }, (_, i) => ({ answer: i < yes ? 'yes' : 'no' }));
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. lib/screeningToken.ts
// ═══════════════════════════════════════════════════════════════════════════

section('Screening token — mint and verify');
{
  const tokenId   = randomUUID();
  const requestId = randomUUID();
  const expiresAt = Date.now() + 14 * DAY_MS;

  const minted = generateScreeningToken(tokenId, requestId, expiresAt);
  const result = verifyScreeningToken(minted.token);

  check('round trip verifies', result.ok);
  if (result.ok) {
    eq('tokenId survives',   result.data.tokenId,   tokenId);
    eq('requestId survives', result.data.requestId, requestId);
    eq('expiry survives',    result.data.expiry,    Math.floor(expiresAt));
  }
  eq('minted expiry is the request deadline', minted.expiry, Math.floor(expiresAt));
  check('token carries a dot-separated signature', minted.token.split('.').length === 2);

  // Two mints of the same pair differ — the nonce is what makes a revoked link
  // unrecoverable rather than reproducible.
  const second = generateScreeningToken(tokenId, requestId, expiresAt);
  check('nonce makes each mint unique', second.token !== minted.token);
}

section('Screening token — tamper, malformed, expired');
{
  const minted = generateScreeningToken(randomUUID(), randomUUID(), Date.now() + DAY_MS);

  const [payload, signature] = minted.token.split('.');
  const flipped = signature[0] === 'A' ? `B${signature.slice(1)}` : `A${signature.slice(1)}`;
  const tampered = verifyScreeningToken(`${payload}.${flipped}`);
  check('tampered signature refused', !tampered.ok);
  if (!tampered.ok) eq('tampered reason', tampered.reason, 'invalid_signature');

  // A rewritten payload fails the same way: the HMAC covers the encoded payload.
  const otherPayload = Buffer.from(`${randomUUID()}:${randomUUID()}:${Date.now() + DAY_MS}:ff`, 'utf8')
    .toString('base64url');
  const swapped = verifyScreeningToken(`${otherPayload}.${signature}`);
  check('swapped payload refused', !swapped.ok);
  if (!swapped.ok) eq('swapped reason', swapped.reason, 'invalid_signature');

  const garbage = verifyScreeningToken('not-a-token');
  check('garbage refused', !garbage.ok);
  if (!garbage.ok) eq('garbage reason', garbage.reason, 'malformed');

  // Correctly signed, wrong payload shape — three segments instead of four.
  const shortPayload = verifyScreeningToken(sign('a:b:c', 'screening'));
  check('short payload refused', !shortPayload.ok);
  if (!shortPayload.ok) eq('short payload reason', shortPayload.reason, 'malformed');

  const expired = verifyScreeningToken(
    generateScreeningToken(randomUUID(), randomUUID(), Date.now() - DAY_MS).token);
  check('expired refused', !expired.ok);
  if (!expired.ok) eq('expired reason', expired.reason, 'expired');
}

section('Screening token — hashing');
{
  const minted = generateScreeningToken(randomUUID(), randomUUID(), Date.now() + DAY_MS);

  eq('hash is stable',            hashScreeningToken(minted.token), hashScreeningToken(minted.token));
  eq('minted hash matches',       minted.tokenHash,                 hashScreeningToken(minted.token));
  check('hash is not the token',  minted.tokenHash !== minted.token);
  check('hash is 64 hex',         /^[0-9a-f]{64}$/.test(minted.tokenHash));

  const other = generateScreeningToken(randomUUID(), randomUUID(), Date.now() + DAY_MS);
  check('different tokens hash differently', other.tokenHash !== minted.tokenHash);
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. lib/screeningCoverage.ts
// ═══════════════════════════════════════════════════════════════════════════

section('Coverage — arithmetic');
{
  const empty = computeCoverage([]);
  eq('empty yes',   empty.yes,   0);
  eq('empty total', empty.total, 0);
  eq('empty ratio', empty.ratio, 0);

  eq('0 of 6 ratio', computeCoverage(answers(6, 0)).ratio, 0);
  eq('2 of 6 ratio', computeCoverage(answers(6, 2)).ratio, 2 / 6);
  eq('3 of 6 ratio', computeCoverage(answers(6, 3)).ratio, 0.5);
  eq('4 of 6 ratio', computeCoverage(answers(6, 4)).ratio, 4 / 6);
  eq('6 of 6 ratio', computeCoverage(answers(6, 6)).ratio, 1);
  eq('6 of 6 yes',   computeCoverage(answers(6, 6)).yes,   6);

  // Unsure counts against coverage: only a yes is a claim to answer it.
  const mixed = computeCoverage([{ answer: 'yes' }, { answer: 'unsure' }, { answer: 'no' }]);
  eq('unsure is not a yes', mixed.yes,   1);
  eq('unsure counts in total', mixed.total, 3);
}

section('Coverage — bands at the boundaries');
{
  eq('green min constant', COVERAGE_GREEN_MIN, 0.66);
  eq('amber min constant', COVERAGE_AMBER_MIN, 0.34);

  eq('empty is red',  coverageBand(computeCoverage([]).ratio),            'red');
  eq('0 of 6 is red', coverageBand(computeCoverage(answers(6, 0)).ratio), 'red');
  eq('2 of 6 is red', coverageBand(computeCoverage(answers(6, 2)).ratio), 'red');
  eq('1 of 3 is red', coverageBand(computeCoverage(answers(3, 1)).ratio), 'red');
  eq('3 of 6 is amber', coverageBand(computeCoverage(answers(6, 3)).ratio), 'amber');
  eq('4 of 6 is green', coverageBand(computeCoverage(answers(6, 4)).ratio), 'green');
  eq('2 of 3 is green', coverageBand(computeCoverage(answers(3, 2)).ratio), 'green');
  eq('6 of 6 is green', coverageBand(computeCoverage(answers(6, 6)).ratio), 'green');

  eq('exactly green min', coverageBand(COVERAGE_GREEN_MIN),         'green');
  eq('just under green',  coverageBand(COVERAGE_GREEN_MIN - 0.001), 'amber');
  eq('exactly amber min', coverageBand(COVERAGE_AMBER_MIN),         'amber');
  eq('just under amber',  coverageBand(COVERAGE_AMBER_MIN - 0.001), 'red');
}

section('Coverage — respondent ordering');
{
  interface Row { id: string; coverage: Coverage | null; submittedAt: string | null; createdAt: string }
  const rows: Row[] = [
    { id: 'half',      coverage: computeCoverage(answers(6, 3)), submittedAt: '2026-09-01T00:00:00.000Z', createdAt: '2026-09-01T00:00:00.000Z' },
    { id: 'full-six',  coverage: computeCoverage(answers(6, 6)), submittedAt: '2026-09-05T00:00:00.000Z', createdAt: '2026-09-05T00:00:00.000Z' },
    { id: 'waiting-b', coverage: null,                           submittedAt: null,                       createdAt: '2026-09-02T00:00:00.000Z' },
    { id: 'full-three',coverage: computeCoverage(answers(3, 3)), submittedAt: '2026-09-03T00:00:00.000Z', createdAt: '2026-09-03T00:00:00.000Z' },
    { id: 'waiting-a', coverage: null,                           submittedAt: null,                       createdAt: '2026-09-01T00:00:00.000Z' },
  ];

  const order = sortRespondents(rows).map(r => r.id).join(',');
  eq('submitted first, coverage desc, yes desc, then oldest',
    order, 'full-six,full-three,half,waiting-a,waiting-b');

  check('input array is not reordered', rows[0].id === 'half');

  // A submitted respondent with no coverage at all still outranks an unsent link.
  const edge = sortRespondents([
    { id: 'waiting', coverage: null, submittedAt: null, createdAt: '2026-09-01T00:00:00.000Z' },
    { id: 'zero',    coverage: computeCoverage(answers(4, 0)), submittedAt: '2026-09-09T00:00:00.000Z', createdAt: '2026-09-09T00:00:00.000Z' },
  ]).map(r => r.id).join(',');
  eq('a zero-coverage reply still beats silence', edge, 'zero,waiting');
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. lib/screeningValidation.ts — intake
// ═══════════════════════════════════════════════════════════════════════════

const THREE = ['Pricing changes since 2023', 'Vendor switching costs', 'Who signs off on renewals'];

section('Intake — defaults');
{
  const result = validateIntakeInput({ topicStatement: 'Mid-market ERP renewals', learningObjectives: THREE });
  check('minimal intake accepted', 'data' in result, codes(result).join(','));
  if ('data' in result) {
    eq('topic kept',         result.data.topicStatement, 'Mid-market ERP renewals');
    eq('objectives kept',    result.data.learningObjectives.length, 3);
    eq('call count default', result.data.callCount,      1);
    eq('rate default',       result.data.clientRate,     1300);
    eq('length default',     result.data.callLengthMin,  60);
    eq('targeting empty',    Object.keys(result.data.targeting).length, 0);

    const drift = Math.abs(Date.parse(result.data.deadline) - (Date.now() + 14 * DAY_MS));
    check('deadline defaults to about 14 days out', drift < 5_000, `drift ${drift}ms`);
  }
}

section('Intake — objectives');
{
  const two = validateIntakeInput({ topicStatement: 't', learningObjectives: THREE.slice(0, 2) });
  check('two objectives refused', hasCode(two, 'too_few_objectives'), codes(two).join(','));

  const seven = validateIntakeInput({
    topicStatement: 't',
    learningObjectives: [...THREE, 'd', 'e', 'f', 'g'],
  });
  check('seven objectives refused', hasCode(seven, 'too_many_objectives'), codes(seven).join(','));

  const six = validateIntakeInput({
    topicStatement: 't',
    learningObjectives: [...THREE, 'd', 'e', 'f'],
  });
  check('six objectives accepted', 'data' in six, codes(six).join(','));

  const blanks = validateIntakeInput({
    topicStatement: 't',
    learningObjectives: [THREE[0], '', '   ', THREE[1], THREE[2], '\n'],
  });
  check('blank rows dropped, three survive', 'data' in blanks, codes(blanks).join(','));
  if ('data' in blanks) {
    eq('three objectives after dropping blanks', blanks.data.learningObjectives.length, 3);
    eq('objectives are trimmed', blanks.data.learningObjectives[0], THREE[0]);
  }

  const tooLong = validateIntakeInput({
    topicStatement: 't',
    learningObjectives: [...THREE.slice(0, 2), 'x'.repeat(LIMITS.objectiveText + 1)],
  });
  check('over-long objective refused', hasCode(tooLong, 'objective_too_long'), codes(tooLong).join(','));

  const notAList = validateIntakeInput({ topicStatement: 't', learningObjectives: 'a, b, c' });
  check('a string of objectives refused', hasCode(notAList, 'objectives_required'), codes(notAList).join(','));
}

section('Intake — topic');
{
  const missing = validateIntakeInput({ learningObjectives: THREE });
  check('missing topic refused', hasCode(missing, 'topic_required'), codes(missing).join(','));

  const blank = validateIntakeInput({ topicStatement: '   ', learningObjectives: THREE });
  check('blank topic refused', hasCode(blank, 'topic_required'), codes(blank).join(','));

  const long = validateIntakeInput({
    topicStatement: 't'.repeat(LIMITS.topicStatement + 1),
    learningObjectives: THREE,
  });
  check('over-long topic refused', hasCode(long, 'topic_too_long'), codes(long).join(','));

  const exact = validateIntakeInput({
    topicStatement: 't'.repeat(LIMITS.topicStatement),
    learningObjectives: THREE,
  });
  check('topic at the limit accepted', 'data' in exact, codes(exact).join(','));
}

section('Intake — deadline window');
{
  const base = { topicStatement: 't', learningObjectives: THREE };

  const today = validateIntakeInput({ ...base, deadline: isoDay(0) });
  check('today refused', hasCode(today, 'deadline_too_soon'), codes(today).join(','));

  const yesterday = validateIntakeInput({ ...base, deadline: isoDay(-3) });
  check('a past date refused', hasCode(yesterday, 'deadline_too_soon'), codes(yesterday).join(','));

  const tomorrow = validateIntakeInput({ ...base, deadline: isoDay(1) });
  check('one day out accepted', 'data' in tomorrow, codes(tomorrow).join(','));

  const ninety = validateIntakeInput({ ...base, deadline: isoDay(90) });
  check('ninety days out accepted', 'data' in ninety, codes(ninety).join(','));

  const ninetyOne = validateIntakeInput({ ...base, deadline: isoDay(91) });
  check('ninety-one days refused', hasCode(ninetyOne, 'deadline_too_far'), codes(ninetyOne).join(','));

  const dayOnly = validateIntakeInput({ ...base, deadline: isoDay(30) });
  check('a date-only deadline accepted', 'data' in dayOnly, codes(dayOnly).join(','));
  if ('data' in dayOnly) {
    check('a date-only deadline means the END of that day',
      dayOnly.data.deadline === `${isoDay(30)}T23:59:59.999Z`, dayOnly.data.deadline);
  }

  const full = new Date(Date.now() + 10 * DAY_MS).toISOString();
  const fullIso = validateIntakeInput({ ...base, deadline: full });
  check('a full ISO deadline accepted', 'data' in fullIso, codes(fullIso).join(','));
  if ('data' in fullIso) eq('full ISO kept as the instant it names', fullIso.data.deadline, full);

  const nonsense = validateIntakeInput({ ...base, deadline: 'next tuesday' });
  check('unparseable deadline refused', hasCode(nonsense, 'invalid_deadline'), codes(nonsense).join(','));

  const impossible = validateIntakeInput({ ...base, deadline: '2026-02-31' });
  check('a date that does not exist refused',
    hasCode(impossible, 'invalid_deadline'), codes(impossible).join(','));
}

section('Intake — rate, call length, call count');
{
  const base = { topicStatement: 't', learningObjectives: THREE };

  const offGrid = validateIntakeInput({ ...base, clientRate: 1325 });
  check('an off-grid rate refused', hasCode(offGrid, 'invalid_client_rate'), codes(offGrid).join(','));

  const belowFloor = validateIntakeInput({ ...base, clientRate: 50 });
  check('a rate under the floor refused', hasCode(belowFloor, 'invalid_client_rate'), codes(belowFloor).join(','));

  const onGrid = validateIntakeInput({ ...base, clientRate: 1350 });
  check('an on-grid rate accepted', 'data' in onGrid, codes(onGrid).join(','));
  if ('data' in onGrid) eq('rate kept', onGrid.data.clientRate, 1350);

  const badLength = validateIntakeInput({ ...base, callLengthMin: 90 });
  check('a 90-minute call refused', hasCode(badLength, 'invalid_call_length'), codes(badLength).join(','));

  const shortCall = validateIntakeInput({ ...base, callLengthMin: 45 });
  check('45 minutes accepted', 'data' in shortCall, codes(shortCall).join(','));
  if ('data' in shortCall) eq('call length kept', shortCall.data.callLengthMin, 45);

  const tooMany = validateIntakeInput({ ...base, callCount: 51 });
  check('51 calls refused', hasCode(tooMany, 'invalid_call_count'), codes(tooMany).join(','));

  const zero = validateIntakeInput({ ...base, callCount: 0 });
  check('zero calls refused', hasCode(zero, 'invalid_call_count'), codes(zero).join(','));

  const fractional = validateIntakeInput({ ...base, callCount: 2.5 });
  check('a fractional call count refused', hasCode(fractional, 'invalid_call_count'), codes(fractional).join(','));

  const five = validateIntakeInput({ ...base, callCount: 5 });
  check('five calls accepted', 'data' in five, codes(five).join(','));
  if ('data' in five) eq('call count kept', five.data.callCount, 5);
}

section('Intake — targeting is sanitised, not refused');
{
  const result = validateIntakeInput({
    topicStatement: 't',
    learningObjectives: THREE,
    // Unknown keys are ignored rather than refused.
    somethingElse: { nested: true },
    targeting: {
      targetCompanies: ['Acme', '  acme ', '', 'Beta', 'BETA'],
      seniority: '  VP and above  ',
      function: '',
      geography: 'North America',
      exclusions: { companies: ['Us Inc'], experts: [] },
      bogus: 12,
    },
  });
  check('targeting never blocks an intake', 'data' in result, codes(result).join(','));
  if ('data' in result) {
    const t = result.data.targeting;
    eq('duplicates and blanks dropped', (t.targetCompanies ?? []).join('|'), 'Acme|Beta');
    eq('text trimmed',                  t.seniority,  'VP and above');
    eq('empty text left out',           t.function,   undefined);
    eq('geography kept',                t.geography,  'North America');
    eq('exclusion companies kept',      (t.exclusions?.companies ?? []).join('|'), 'Us Inc');
    eq('empty exclusion list left out', t.exclusions?.experts, undefined);
  }

  const huge = validateIntakeInput({
    topicStatement: 't',
    learningObjectives: THREE,
    targeting: {
      targetCompanies: Array.from({ length: 40 }, (_, i) => `Company ${i}`),
      geography: 'g'.repeat(LIMITS.targetingText + 50),
    },
  });
  check('an over-long targeting list is still accepted', 'data' in huge, codes(huge).join(','));
  if ('data' in huge) {
    eq('list capped at 30', (huge.data.targeting.targetCompanies ?? []).length, LIMITS.targetingListMax);
    eq('text cut to the limit', (huge.data.targeting.geography ?? '').length, LIMITS.targetingText);
  }
}

section('Intake — every message reads as a sentence');
{
  const bad = validateIntakeInput({
    topicStatement: '',
    learningObjectives: ['only one'],
    callCount: 0,
    clientRate: 7,
    callLengthMin: 12,
    deadline: 'whenever',
  });
  check('a wholly invalid body collects every error', codes(bad).length >= 5, codes(bad).join(','));
  check('messages are sentences, not codes', messagesAreSentences(bad));
  check('every error names a field',
    'errors' in bad && bad.errors.every(e => e.field.length > 0));
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. lib/screeningValidation.ts — objective edits
// ═══════════════════════════════════════════════════════════════════════════

section('Objective edits');
{
  const ok = validateObjectiveEdits({
    objectives: [
      { id: 'a', stem: 'Have you set pricing for an ERP renewal?', proofPrompt: 'Which role, and which years?' },
      { id: 'b', stem: 'Have you switched vendors?',               proofPrompt: 'Which role, and which years?' },
    ],
  });
  check('valid edits accepted', 'data' in ok, codes(ok).join(','));
  if ('data' in ok) eq('two edits returned', ok.data.length, 2);

  const empty = validateObjectiveEdits({ objectives: [] });
  check('an empty edit list is a no-op, not an error', 'data' in empty, codes(empty).join(','));

  const missing = validateObjectiveEdits({});
  check('a missing list refused', hasCode(missing, 'objectives_required'), codes(missing).join(','));

  const seven = validateObjectiveEdits({
    objectives: Array.from({ length: 7 }, (_, i) => ({ id: `id${i}`, stem: 's', proofPrompt: 'p' })),
  });
  check('seven edits refused', hasCode(seven, 'too_many_objectives'), codes(seven).join(','));

  const noId = validateObjectiveEdits({ objectives: [{ stem: 's', proofPrompt: 'p' }] });
  check('an edit with no id refused', hasCode(noId, 'objective_id_required'), codes(noId).join(','));

  const blankStem = validateObjectiveEdits({ objectives: [{ id: 'a', stem: '  ', proofPrompt: 'p' }] });
  check('a blanked stem refused', hasCode(blankStem, 'stem_required'), codes(blankStem).join(','));

  const blankPrompt = validateObjectiveEdits({ objectives: [{ id: 'a', stem: 's', proofPrompt: '' }] });
  check('a blanked proof prompt refused',
    hasCode(blankPrompt, 'proof_prompt_required'), codes(blankPrompt).join(','));

  const longStem = validateObjectiveEdits({
    objectives: [{ id: 'a', stem: 's'.repeat(LIMITS.stem + 1), proofPrompt: 'p' }],
  });
  check('an over-long stem refused', hasCode(longStem, 'stem_too_long'), codes(longStem).join(','));

  const dupes = validateObjectiveEdits({
    objectives: [{ id: 'a', stem: 's', proofPrompt: 'p' }, { id: 'a', stem: 't', proofPrompt: 'q' }],
  });
  check('two edits to one objective refused',
    hasCode(dupes, 'duplicate_objective_id'), codes(dupes).join(','));
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. lib/screeningValidation.ts — the expert's submission
// ═══════════════════════════════════════════════════════════════════════════

const OBJ = ['o-one', 'o-two', 'o-three'];

function submission(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    answers: [
      { objectiveId: 'o-one',   answer: 'yes',    proofText: 'I ran renewals at Acme from 2021 to 2024.' },
      { objectiveId: 'o-two',   answer: 'no' },
      { objectiveId: 'o-three', answer: 'unsure' },
    ],
    rateAccepted: true,
    availability: 'next_week',
    ...overrides,
  };
}

section('Expert submission — the happy path');
{
  const result = validateScreeningSubmission(submission(), OBJ);
  check('complete submission accepted', 'data' in result, codes(result).join(','));
  if ('data' in result) {
    eq('every objective answered',   result.data.answers.length, 3);
    eq('answers follow objective order', result.data.answers.map(a => a.objectiveId).join(','), OBJ.join(','));
    eq('yes keeps its proof',        result.data.answers[0].proofText,
      'I ran renewals at Acme from 2021 to 2024.');
    eq('no carries no proof',        result.data.answers[1].proofText, null);
    eq('unsure carries no proof',    result.data.answers[2].proofText, null);
    eq('rate accepted',              result.data.rateAccepted, true);
    eq('no ask when accepted',       result.data.rateAsk,      null);
    eq('availability kept',          result.data.availability, 'next_week');
  }
}

section('Expert submission — coverage of the objective set');
{
  const short = validateScreeningSubmission(
    { ...submission(), answers: [{ objectiveId: 'o-one', answer: 'no' }] }, OBJ);
  check('a partial submission refused', hasCode(short, 'missing_answer'), codes(short).join(','));

  const extra = validateScreeningSubmission({
    ...submission(),
    answers: [
      ...(submission().answers as unknown[]),
      { objectiveId: 'someone-elses-objective', answer: 'yes', proofText: 'x' },
    ],
  }, OBJ);
  check('an objective from another request refused',
    hasCode(extra, 'unknown_objective'), codes(extra).join(','));

  const twice = validateScreeningSubmission({
    ...submission(),
    answers: [...(submission().answers as unknown[]), { objectiveId: 'o-one', answer: 'no' }],
  }, OBJ);
  check('answering one objective twice refused',
    hasCode(twice, 'duplicate_answer'), codes(twice).join(','));

  const noAnswers = validateScreeningSubmission({ ...submission(), answers: undefined }, OBJ);
  check('no answers at all refused', hasCode(noAnswers, 'answers_required'), codes(noAnswers).join(','));

  const badAnswer = validateScreeningSubmission({
    ...submission(),
    answers: [
      { objectiveId: 'o-one', answer: 'maybe' },
      { objectiveId: 'o-two', answer: 'no' },
      { objectiveId: 'o-three', answer: 'no' },
    ],
  }, OBJ);
  check('an answer outside yes/no/unsure refused',
    hasCode(badAnswer, 'invalid_answer'), codes(badAnswer).join(','));
}

section('Expert submission — proof rules');
{
  const noProof = validateScreeningSubmission({
    ...submission(),
    answers: [
      { objectiveId: 'o-one', answer: 'yes' },
      { objectiveId: 'o-two', answer: 'no' },
      { objectiveId: 'o-three', answer: 'no' },
    ],
  }, OBJ);
  check('a yes with no sentence refused', hasCode(noProof, 'proof_required'), codes(noProof).join(','));

  const blankProof = validateScreeningSubmission({
    ...submission(),
    answers: [
      { objectiveId: 'o-one', answer: 'yes', proofText: '    ' },
      { objectiveId: 'o-two', answer: 'no' },
      { objectiveId: 'o-three', answer: 'no' },
    ],
  }, OBJ);
  check('a whitespace-only sentence refused',
    hasCode(blankProof, 'proof_required'), codes(blankProof).join(','));

  const longProof = validateScreeningSubmission({
    ...submission(),
    answers: [
      { objectiveId: 'o-one', answer: 'yes', proofText: 'x'.repeat(LIMITS.proofText + 1) },
      { objectiveId: 'o-two', answer: 'no' },
      { objectiveId: 'o-three', answer: 'no' },
    ],
  }, OBJ);
  check('a sentence over 400 characters refused',
    hasCode(longProof, 'proof_too_long'), codes(longProof).join(','));

  const atLimit = validateScreeningSubmission({
    ...submission(),
    answers: [
      { objectiveId: 'o-one', answer: 'yes', proofText: 'x'.repeat(LIMITS.proofText) },
      { objectiveId: 'o-two', answer: 'no' },
      { objectiveId: 'o-three', answer: 'no' },
    ],
  }, OBJ);
  check('a sentence exactly at the limit accepted', 'data' in atLimit, codes(atLimit).join(','));

  // Proof arriving on a No did not come from the form; it is dropped, not refused.
  const strayProof = validateScreeningSubmission({
    ...submission(),
    answers: [
      { objectiveId: 'o-one', answer: 'yes', proofText: 'Real answer.' },
      { objectiveId: 'o-two', answer: 'no', proofText: 'Smuggled text.' },
      { objectiveId: 'o-three', answer: 'unsure', proofText: 'Also smuggled.' },
    ],
  }, OBJ);
  check('proof on a no is accepted but dropped', 'data' in strayProof, codes(strayProof).join(','));
  if ('data' in strayProof) {
    eq('no forced to null',     strayProof.data.answers[1].proofText, null);
    eq('unsure forced to null', strayProof.data.answers[2].proofText, null);
  }
}

section('Expert submission — rate and availability');
{
  const noAsk = validateScreeningSubmission(submission({ rateAccepted: false }), OBJ);
  check('declining without a number refused', hasCode(noAsk, 'rate_ask_required'), codes(noAsk).join(','));

  const withAsk = validateScreeningSubmission(submission({ rateAccepted: false, rateAsk: 750 }), OBJ);
  check('declining with a number accepted', 'data' in withAsk, codes(withAsk).join(','));
  if ('data' in withAsk) {
    eq('ask kept',          withAsk.data.rateAsk,      750);
    eq('accepted is false', withAsk.data.rateAccepted, false);
  }

  const lowAsk = validateScreeningSubmission(submission({ rateAccepted: false, rateAsk: 10 }), OBJ);
  check('an implausibly low ask refused', hasCode(lowAsk, 'invalid_rate_ask'), codes(lowAsk).join(','));

  const highAsk = validateScreeningSubmission(submission({ rateAccepted: false, rateAsk: 99_000 }), OBJ);
  check('an implausibly high ask refused', hasCode(highAsk, 'invalid_rate_ask'), codes(highAsk).join(','));

  // An ask sent alongside an acceptance is not stored — accepted means accepted.
  const bothAsk = validateScreeningSubmission(submission({ rateAccepted: true, rateAsk: 900 }), OBJ);
  check('acceptance plus an ask accepted', 'data' in bothAsk, codes(bothAsk).join(','));
  if ('data' in bothAsk) eq('ask dropped when accepted', bothAsk.data.rateAsk, null);

  const noRate = validateScreeningSubmission(submission({ rateAccepted: undefined }), OBJ);
  check('no rate answer refused', hasCode(noRate, 'invalid_rate_accepted'), codes(noRate).join(','));

  const badAvailability = validateScreeningSubmission(submission({ availability: 'someday' }), OBJ);
  check('an availability outside the three refused',
    hasCode(badAvailability, 'invalid_availability'), codes(badAvailability).join(','));

  const noAvailability = validateScreeningSubmission(submission({ availability: undefined }), OBJ);
  check('no availability refused',
    hasCode(noAvailability, 'invalid_availability'), codes(noAvailability).join(','));

  check('expert-facing messages are sentences', messagesAreSentences(noAsk));
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. lib/screeningValidation.ts — candidates and expert ids
// ═══════════════════════════════════════════════════════════════════════════

section('Candidate input');
{
  const minimal = validateCandidateInput({ name: 'Dana Whitfield' });
  check('a name alone is enough', 'data' in minimal, codes(minimal).join(','));
  if ('data' in minimal) {
    eq('headline defaults to empty', minimal.data.headline,         '');
    eq('background defaults to empty', minimal.data.background.length, 0);
    eq('email defaults to null',     minimal.data.email,            null);
    eq('send defaults to false',     minimal.data.send,             false);
  }

  const full = validateCandidateInput({
    name: 'Dana Whitfield',
    headline: 'Former VP Procurement, mid-market SaaS',
    background: [
      { company: 'Acme', role: 'VP Procurement', dates: '2019-2024' },
      { company: 'Beta' },
    ],
    email: '  Dana.Whitfield@ACME.com ',
    send: true,
  });
  check('a full candidate accepted', 'data' in full, codes(full).join(','));
  if ('data' in full) {
    eq('email lower-cased',        full.data.email, 'dana.whitfield@acme.com');
    eq('two background lines',     full.data.background.length, 2);
    eq('missing role defaults to empty', full.data.background[1].role, '');
    eq('send kept',                full.data.send, true);
  }

  const noName = validateCandidateInput({ headline: 'Someone' });
  check('a candidate with no name refused', hasCode(noName, 'name_required'), codes(noName).join(','));

  const longName = validateCandidateInput({ name: 'n'.repeat(LIMITS.candidateName + 1) });
  check('an over-long name refused', hasCode(longName, 'name_too_long'), codes(longName).join(','));

  const longHeadline = validateCandidateInput({
    name: 'Dana', headline: 'h'.repeat(LIMITS.candidateHeadline + 1),
  });
  check('an over-long headline refused',
    hasCode(longHeadline, 'headline_too_long'), codes(longHeadline).join(','));

  const nineLines = validateCandidateInput({
    name: 'Dana',
    background: Array.from({ length: LIMITS.backgroundLinesMax + 1 }, (_, i) => ({ company: `C${i}` })),
  });
  check('a ninth background line refused',
    hasCode(nineLines, 'too_many_background_lines'), codes(nineLines).join(','));

  const noCompany = validateCandidateInput({ name: 'Dana', background: [{ role: 'VP' }] });
  check('a background line with no company refused',
    hasCode(noCompany, 'company_required'), codes(noCompany).join(','));

  const badEmail = validateCandidateInput({ name: 'Dana', email: 'dana at acme' });
  check('a malformed address refused', hasCode(badEmail, 'invalid_email'), codes(badEmail).join(','));

  const sendNoEmail = validateCandidateInput({ name: 'Dana', send: true });
  check('"email it" with no address refused',
    hasCode(sendNoEmail, 'email_required_to_send'), codes(sendNoEmail).join(','));
  check('staff-facing messages are sentences', messagesAreSentences(sendNoEmail));
}

section('Expert id');
{
  const a = normalizeExpertId('dana@acme.com');
  const b = normalizeExpertId('  DANA@ACME.COM  ');
  eq('the same address always gives the same id', a, b);
  check('addressed ids carry the em: prefix', a.startsWith('em:'), a);
  check('addressed ids are 24 hex', /^em:[0-9a-f]{24}$/.test(a), a);

  const other = normalizeExpertId('sam@acme.com');
  check('different addresses give different ids', other !== a);
  check('the id does not contain the address', !a.includes('acme'));

  const anon1 = normalizeExpertId(null);
  const anon2 = normalizeExpertId(null);
  check('anonymous ids carry the anon: prefix', anon1.startsWith('anon:'), anon1);
  check('anonymous ids are 12 hex', /^anon:[0-9a-f]{12}$/.test(anon1), anon1);
  check('anonymous ids are never reused', anon1 !== anon2);

  const blank = normalizeExpertId('   ');
  check('a blank address is anonymous', blank.startsWith('anon:'), blank);
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. lib/requestStore.ts — the in-memory store, end to end
// ═══════════════════════════════════════════════════════════════════════════

const OWNER = 'associate@acmecapital.com';
const OTHER = 'someone@elsefirm.com';
const ADMIN = 'ops@expertmatch.com';

async function storeWalkthrough(): Promise<void> {
  section('Store — create and read back');

  const intake = validateIntakeInput({
    topicStatement: 'Mid-market ERP renewals',
    learningObjectives: THREE,
    clientRate: 1300,
    callLengthMin: 60,
  });
  if (!('data' in intake)) {
    check('intake for the store walkthrough is valid', false, codes(intake).join(','));
    return;
  }

  const created = await createRequest(intake.data, OWNER);
  eq('starts as a draft',        created.status,          'draft');
  eq('owner email recorded',     created.ownerEmail,      OWNER);
  eq('dev organization',         created.organizationId,  'dev-org');
  eq('three objectives stored',  created.objectives.length, 3);
  eq('positions are 0-based',    created.objectives.map(o => o.position).join(','), '0,1,2');
  eq('objective text verbatim',  created.objectives[0].objectiveText, THREE[0]);
  eq('no stem before generation', created.objectives[0].stem,        null);
  eq('no proof prompt yet',      created.objectives[0].proofPrompt,  null);
  eq('no source yet',            created.objectives[0].source,       null);
  eq('not approved',             created.approvedAt,                 null);
  eq('rate carried through',     created.clientRate,                 1300);

  section('Store — access control');

  const asOwner = await getRequestForUser(created.id, OWNER, 'user');
  check('the owner can read it', asOwner !== null);

  const asStranger = await getRequestForUser(created.id, OTHER, 'user');
  eq('another client sees nothing (404, never 403)', asStranger, null);

  const asAdmin = await getRequestForUser(created.id, ADMIN, 'admin');
  check('a platform admin can read it', asAdmin !== null);

  const internal = await getRequest(created.id);
  check('the unscoped read works for server-internal callers', internal !== null);

  const missing = await getRequestForUser(randomUUID(), OWNER, 'user');
  eq('an unknown id is null', missing, null);

  const malformed = await getRequestForUser('not-a-uuid', OWNER, 'admin');
  eq('a malformed id is null, not a crash', malformed, null);

  const ownerList = await listRequestsForUser(OWNER, 'user');
  eq('the owner lists one request', ownerList.length, 1);
  eq('summary counts objectives',   ownerList[0].objectiveCount, 3);
  eq('no respondents yet',          ownerList[0].respondentCount, 0);
  eq('no submissions yet',          ownerList[0].submittedCount,  0);

  const strangerList = await listRequestsForUser(OTHER, 'user');
  eq('another client lists nothing', strangerList.length, 0);

  const adminList = await listRequestsForUser(ADMIN, 'admin');
  check('an admin lists everything', adminList.length >= 1);

  section('Store — generation and approval');

  const generated = await updateObjectiveItems(created.id, created.objectives.map((o, i) => ({
    id:               o.id,
    stem:             `Stem ${i}?`,
    proofPrompt:      'Which role, and which years?',
    source:           'model' as const,
    modelStem:        `Stem ${i}?`,
    modelProofPrompt: 'Which role, and which years?',
  })));
  eq('stems written',       generated.objectives[0].stem,        'Stem 0?');
  eq('proof prompts written', generated.objectives[1].proofPrompt, 'Which role, and which years?');
  eq('source recorded',     generated.objectives[2].source,      'model');
  eq('not marked as a client edit', generated.objectives[0].clientEdited, false);

  const edited = await updateObjectiveItems(created.id, [{
    id:           generated.objectives[0].id,
    stem:         'Have you priced an ERP renewal yourself?',
    proofPrompt:  'Which role, and which years?',
    source:       'client' as const,
    clientEdited: true,
  }]);
  eq('client edit applied',   edited.objectives[0].stem, 'Have you priced an ERP renewal yourself?');
  eq('client edit flagged',   edited.objectives[0].clientEdited, true);
  eq('source flipped to client', edited.objectives[0].source, 'client');
  eq('other objectives untouched', edited.objectives[1].stem, 'Stem 1?');

  const approved = await approveRequest(created.id);
  eq('approved',            approved.status, 'approved');
  check('approval stamped', approved.approvedAt !== null);

  section('Store — candidates and the screening link');

  const tokenId   = randomUUID();
  const minted    = generateScreeningToken(tokenId, created.id, Date.parse(approved.deadline));
  const candidate = await addCandidate(created.id, {
    expertId:       normalizeExpertId('dana@acme.com'),
    expertEmail:    'dana@acme.com',
    snapshot:       {
      name: 'Dana Whitfield',
      headline: 'Former VP Procurement',
      background: [{ company: 'Acme', role: 'VP Procurement', dates: '2019-2024' }],
    },
    tokenHash:      minted.tokenHash,
    expiresAt:      approved.deadline,
    createdByEmail: ADMIN,
  });
  eq('candidate belongs to the request', candidate.requestId, created.id);
  eq('not submitted yet',  candidate.submittedAt,     null);
  eq('not revoked',        candidate.revokedAt,       null);
  eq('no call requested',  candidate.callRequestedAt, null);
  eq('no answers yet',     candidate.responses.length, 0);
  eq('snapshot kept',      candidate.snapshot.background[0].company, 'Acme');

  const found = await getCandidateByTokenHash(minted.tokenHash);
  check('the link resolves by its hash', found !== null);
  if (found) {
    eq('same candidate', found.candidate.id, candidate.id);
    eq('carries its request', found.request.id, created.id);
    eq('the request is approved', found.request.status, 'approved');
  }
  eq('an unknown hash resolves to nothing', await getCandidateByTokenHash('deadbeef'), null);

  section('Store — the single-use submission');

  const objectiveIds = approved.objectives.map(o => o.id);
  const form = validateScreeningSubmission({
    answers: [
      { objectiveId: objectiveIds[0], answer: 'yes', proofText: 'I ran renewals at Acme from 2021 to 2024.' },
      { objectiveId: objectiveIds[1], answer: 'yes', proofText: 'Same role, I owned the switching analysis.' },
      { objectiveId: objectiveIds[2], answer: 'no' },
    ],
    rateAccepted: false,
    rateAsk: 700,
    availability: 'this_week',
  }, objectiveIds);
  if (!('data' in form)) {
    check('the walkthrough submission is valid', false, codes(form).join(','));
    return;
  }

  eq('first submission is recorded', await submitScreening(candidate.id, form.data), 'ok');
  eq('a second submission changes nothing',
    await submitScreening(candidate.id, form.data), 'already_submitted');
  eq('an unknown link is not found',
    await submitScreening(randomUUID(), form.data), 'not_found');

  const withAnswers = await listCandidates(created.id);
  eq('one respondent',        withAnswers.length, 1);
  eq('three answers stored',  withAnswers[0].responses.length, 3);
  eq('submission stamped',    withAnswers[0].submittedAt !== null, true);
  eq('rate answer stored',    withAnswers[0].rateAccepted, false);
  eq('expert-side ask stored', withAnswers[0].rateAsk, 700);
  eq('availability stored',   withAnswers[0].availability, 'this_week');
  eq('proof kept verbatim',   withAnswers[0].responses[0].proofText,
    'I ran renewals at Acme from 2021 to 2024.');
  eq('the no carries no proof', withAnswers[0].responses[2].proofText, null);

  const coverage = computeCoverage(withAnswers[0].responses);
  eq('coverage is two of three', `${coverage.yes}/${coverage.total}`, '2/3');
  eq('two of three reads green', coverageBand(coverage.ratio), 'green');

  const afterSubmit = await listRequestsForUser(OWNER, 'user');
  eq('summary counts the respondent', afterSubmit[0].respondentCount, 1);
  eq('summary counts the submission', afterSubmit[0].submittedCount,  1);

  section('Store — request a call, then record what it delivered');

  const requested = await requestCall(created.id, candidate.id);
  check('the call is requested', requested?.callRequestedAt != null);

  const again = await requestCall(created.id, candidate.id);
  eq('requesting twice keeps the first stamp',
    again?.callRequestedAt, requested?.callRequestedAt);

  eq('a link on another request cannot be actioned',
    await requestCall(randomUUID(), candidate.id), null);
  eq('an unknown link cannot be actioned',
    await requestCall(created.id, randomUUID()), null);

  const marked = await recordOutcomes(created.id, candidate.id, [
    { objectiveId: objectiveIds[0], outcome: 'answered' },
    { objectiveId: objectiveIds[1], outcome: 'unanswered' },
  ], OWNER);
  eq('two verdicts recorded', marked?.outcomes.length, 2);

  const remarked = await recordOutcomes(created.id, candidate.id, [
    { objectiveId: objectiveIds[1], outcome: 'partial' },
  ], OWNER);
  eq('re-marking upserts rather than adding', remarked?.outcomes.length, 2);
  eq('the verdict moved',
    remarked?.outcomes.find(o => o.objectiveId === objectiveIds[1])?.outcome, 'partial');
  eq('the untouched verdict stands',
    remarked?.outcomes.find(o => o.objectiveId === objectiveIds[0])?.outcome, 'answered');

  section('Store — revocation');

  const second = randomUUID();
  const secondMint = generateScreeningToken(second, created.id, Date.parse(approved.deadline));
  const pending = await addCandidate(created.id, {
    expertId:       normalizeExpertId(null),
    expertEmail:    null,
    snapshot:       { name: 'Unknown', headline: '', background: [] },
    tokenHash:      secondMint.tokenHash,
    expiresAt:      approved.deadline,
    createdByEmail: ADMIN,
  });

  const revoked = await revokeCandidate(created.id, pending.id);
  check('the link is revoked', revoked?.revokedAt != null);
  eq('revoking twice keeps the first stamp',
    (await revokeCandidate(created.id, pending.id))?.revokedAt, revoked?.revokedAt);
  eq('a revoked link refuses a submission',
    await submitScreening(pending.id, form.data), 'already_submitted');

  const both = await listCandidates(created.id);
  eq('two candidates on the request', both.length, 2);
  eq('oldest first', both[0].id, candidate.id);
}

storeWalkthrough()
  .then(() => summary('screening-core'))
  .catch((error: unknown) => {
    console.error('[test-screening-core] threw',
      error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
