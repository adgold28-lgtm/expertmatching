// scripts/e2e-screening.ts — the request → screening → selection flow, end to
// end, against a RUNNING LOCAL DEV SERVER with authentication OFF and the
// in-memory request store (docs/SCREENING_FLOW_PLAN.md, final gate).
//
//   AVAILABILITY_TOKEN_SECRET=$(openssl rand -hex 32) DISABLE_EMAILS=true npx next dev -p 3100 &
//   SMOKE_BASE_URL=http://localhost:3100 npx tsx scripts/e2e-screening.ts
//
// APP_AUTH_ENABLED stays unset (every caller is the dev admin) and no Supabase
// variables are set (the in-memory store). The token secret is the one thing
// the server needs that it does not have by default: without it the mint route
// answers 500, because lib/hmacToken refuses to sign with no secret.
//
// WHAT THIS PROVES, over HTTP, in the order a client and an expert would hit
// it: intake → generation (the deterministic fallback, since no model key is
// set) → an edit the validator refuses and one it accepts → approval, which
// freezes the set → a staff-minted screening link → the public form's read →
// a refused partial submission → a full submission → single use → the review
// payload carrying coverage and the expert's own words → a revoked link →
// request-call → stage-5 outcomes → the dead-link and not-found paths.
//
// WHAT IT DOES NOT PROVE: the Supabase store (no credentials here; the store is
// exercised offline by scripts/test-screening-core.ts and by reading the SQL),
// the model call (scripts/test-screening-items.ts stubs it), the non-admin
// redaction over HTTP (auth is off, so every caller is the dev admin;
// scripts/test-screening-redaction.ts covers the view), and email (DISABLE_EMAILS).
//
// Sends nothing. Creates nothing durable: the in-memory store dies with the
// server.

import { check, eq, summary } from './testHarness';

const BASE   = (process.env.SMOKE_BASE_URL ?? 'http://localhost:3100').replace(/\/+$/, '');
const ORIGIN = process.env.NEXT_PUBLIC_APP_URL ?? BASE;

type Json = Record<string, unknown>;

async function req(method: string, path: string, body?: unknown): Promise<{ status: number; json: Json | null; text: string }> {
  const res = await fetch(BASE + path, {
    method,
    redirect: 'manual',
    headers: { 'Content-Type': 'application/json', 'Origin': ORIGIN },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: Json | null = null;
  try { json = JSON.parse(text) as Json; } catch { json = null; }
  return { status: res.status, json, text };
}

function obj(value: unknown): Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
}
function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

const TOPIC = 'How the 2024 SAP migration changed order-to-cash at mid-market distributors';
const OBJECTIVES = [
  'How did the 2024 SAP migration affect order-to-cash cycle time?',
  'Which order-to-cash steps still needed manual work after go-live?',
  'How were distributor customers migrated without billing gaps?',
  'What did the integrator relationship look like after hypercare ended?',
];

/**
 * Touch every route once before the flow starts. `next dev` compiles a route
 * the first time it is hit, and each compilation re-instantiates the server
 * modules — including lib/requestStore's in-memory Map — so a request created
 * before a later route is compiled would be gone by the time that route runs.
 * Warming the routes up front means nothing compiles mid-flow. Every response
 * here is a refusal (404 / 410) and none of it is asserted on.
 */
async function warmUp(): Promise<void> {
  const nil = '00000000-0000-4000-8000-000000000000';
  await Promise.all([
    req('GET',  '/requests'),
    req('GET',  '/requests/new'),
    req('GET',  `/requests/${nil}`),
    req('GET',  `/s/${nil}`),
    req('GET',  '/api/requests'),
    req('GET',  `/api/requests/${nil}`),
    req('POST', `/api/requests/${nil}/generate`, {}),
    req('POST', `/api/requests/${nil}/approve`, {}),
    req('POST', `/api/requests/${nil}/tokens`, {}),
    req('POST', `/api/requests/${nil}/tokens/${nil}/revoke`, {}),
    req('POST', `/api/requests/${nil}/tokens/${nil}/request-call`, {}),
    req('POST', `/api/requests/${nil}/tokens/${nil}/outcomes`, {}),
    req('GET',  `/api/s/${nil}`),
  ]);
}

async function main(): Promise<void> {
  await warmUp();

  // ── 0. The server is up and the pages render ─────────────────────────────
  const newPage = await req('GET', '/requests/new');
  eq('GET /requests/new renders', newPage.status, 200);

  // ── 1. Intake ────────────────────────────────────────────────────────────
  const noRate = await req('POST', '/api/requests', { topicStatement: TOPIC, learningObjectives: OBJECTIVES });
  eq('POST /api/requests refuses a missing rate', noRate.status, 400);
  check('…and names the rate field', arr(noRate.json?.errors).map(obj).some(e => e.field === 'clientRate' && e.error === 'rate_required'), JSON.stringify(noRate.json));

  const tooFew = await req('POST', '/api/requests', { topicStatement: TOPIC, learningObjectives: ['one', 'two'], clientRate: 1300 });
  eq('POST /api/requests refuses two objectives', tooFew.status, 400);
  check('…and names the field', str(tooFew.json?.field).startsWith('learningObjectives'), JSON.stringify(tooFew.json));

  const created = await req('POST', '/api/requests', {
    topicStatement: TOPIC,
    learningObjectives: [...OBJECTIVES, '   '],
    targeting: { targetCompanies: ['Sysco', 'sysco', 'US Foods'], geography: 'US' },
    callCount: 2,
    clientRate: 1300,
  });
  eq('POST /api/requests creates', created.status, 201);
  const request = obj(created.json?.request);
  const requestId = str(request.id);
  check('request has an id', requestId.length > 0);
  eq('request starts as draft', request.status, 'draft');
  eq('blank objective rows are dropped', arr(request.objectives).length, 4);
  eq('call count kept', request.callCount, 2);
  eq('client rate carried through', request.clientRate, 1300);
  eq('default call length', request.callLengthMin, 60);
  eq('targeting de-duplicated', arr(obj(request.targeting).targetCompanies).length, 2);
  check('objectives start without stems', arr(request.objectives).every(o => obj(o).stem === null));

  const list = await req('GET', '/api/requests');
  eq('GET /api/requests lists', list.status, 200);
  check('…and includes the new request', arr(list.json?.requests).some(r => obj(r).id === requestId));

  const missing = await req('GET', '/api/requests/00000000-0000-4000-8000-000000000000');
  eq('GET unknown request is 404', missing.status, 404);
  const malformedId = await req('GET', '/api/requests/not-a-uuid');
  eq('GET malformed request id is 404', malformedId.status, 404);

  // ── 2. Generation (fallback: no model key in this environment) ───────────
  const generated = await req('POST', `/api/requests/${requestId}/generate`, {});
  eq('POST /generate answers 200', generated.status, 200);
  const generation = obj(generated.json?.generation);
  eq('generation fell back (no key)', generation.source, 'fallback');
  eq('…for the stated reason', generation.reason, 'no_api_key');
  const genObjectives = arr(obj(generated.json?.request).objectives).map(obj);
  check('every objective now has a stem', genObjectives.every(o => str(o.stem).endsWith('?')));
  check('every objective now has a proof prompt', genObjectives.every(o => str(o.proofPrompt).length > 0));
  check('items are marked fallback', genObjectives.every(o => o.source === 'fallback'));
  const firstId = str(genObjectives[0]?.id);

  // ── 3. Edits: a substance question is refused, a role question is kept ───
  const badEdit = await req('PATCH', `/api/requests/${requestId}`, {
    objectives: [{ id: firstId, stem: str(genObjectives[0]?.stem), proofPrompt: 'What was the result of the migration and by how much did cycle time fall?' }],
  });
  eq('PATCH refuses a proof prompt that asks for findings', badEdit.status, 422);
  eq('…with the item error', badEdit.json?.error, 'invalid_item');
  eq('…naming the field', badEdit.json?.field, 'proofPrompt');

  const goodStem = 'Were you directly involved in an SAP order-to-cash migration at a distributor between 2023 and 2025?';
  const goodEdit = await req('PATCH', `/api/requests/${requestId}`, {
    objectives: [{ id: firstId, stem: goodStem, proofPrompt: 'In one sentence: what was your role in that migration and when?' }],
  });
  eq('PATCH accepts a role-and-timeframe edit', goodEdit.status, 200);
  const edited = arr(obj(goodEdit.json?.request).objectives).map(obj).find(o => o.id === firstId);
  eq('…stem stored verbatim', edited?.stem, goodStem);
  eq('…flagged as client edited', edited?.clientEdited, true);
  eq('…sourced from the client', edited?.source, 'client');

  const linkStem = await req('PATCH', `/api/requests/${requestId}`, {
    objectives: [{ id: firstId, stem: 'Have you used https://example.com tooling?', proofPrompt: 'In one sentence: what was your role and when?' }],
  });
  eq('PATCH refuses a stem carrying a link', linkStem.status, 422);

  // ── 4. Approval freezes the set ──────────────────────────────────────────
  const approved = await req('POST', `/api/requests/${requestId}/approve`, {});
  eq('POST /approve answers 200', approved.status, 200);
  eq('request is approved', obj(approved.json?.request).status, 'approved');
  check('approvedAt is stamped', str(obj(approved.json?.request).approvedAt).length > 0);

  const again = await req('POST', `/api/requests/${requestId}/approve`, {});
  eq('a second approve is 409', again.status, 409);
  const lateEdit = await req('PATCH', `/api/requests/${requestId}`, {
    objectives: [{ id: firstId, stem: goodStem, proofPrompt: 'In one sentence: what was your role and when?' }],
  });
  eq('PATCH after approval is 409', lateEdit.status, 409);
  const lateGenerate = await req('POST', `/api/requests/${requestId}/generate`, {});
  eq('generate after approval is 409', lateGenerate.status, 409);

  // ── 5. Staff mint a screening link ───────────────────────────────────────
  const noName = await req('POST', `/api/requests/${requestId}/tokens`, { headline: 'x' });
  eq('mint without a name is 400', noName.status, 400);
  const sendNoEmail = await req('POST', `/api/requests/${requestId}/tokens`, { name: 'Pat Example', send: true });
  eq('send without an address is 400', sendNoEmail.status, 400);

  const minted = await req('POST', `/api/requests/${requestId}/tokens`, {
    name:       'Zebulon Quartermain',
    headline:   'VP Order-to-Cash, mid-market distributor',
    background: [{ company: 'Regional Foods Co', role: 'VP Finance Ops', dates: '2021 to 2025' }],
    email:      'zq@example.test',
    send:       false,
  });
  eq('POST /tokens mints', minted.status, 201);
  const link = str(minted.json?.link);
  check('link points at /s/', link.includes('/s/'), link);
  eq('nothing was sent', minted.json?.sent, false);
  const respondent1 = obj(minted.json?.respondent);
  eq('first candidate label', respondent1.label, 'Candidate 1');
  eq('admin sees the name', respondent1.name, 'Zebulon Quartermain');
  eq('unsubmitted coverage is null', respondent1.coverage, null);
  const token1Id = str(respondent1.id);
  const token1 = decodeURIComponent(link.slice(link.indexOf('/s/') + 3));

  // ── 6. The public form's read ────────────────────────────────────────────
  const formPage = await req('GET', `/s/${encodeURIComponent(token1)}`);
  eq('GET /s/[token] renders', formPage.status, 200);
  const deadPage = await req('GET', '/s/not-a-real-token');
  eq('GET /s/garbage renders', deadPage.status, 200);
  check('…the expired page', /expired/i.test(deadPage.text));

  const payload = await req('GET', `/api/s/${encodeURIComponent(token1)}`);
  eq('GET /api/s/[token] answers 200', payload.status, 200);
  eq('payload topic', payload.json?.topic, TOPIC);
  eq('payload rate is the EXPERT-side number', payload.json?.expertRate, 650);
  eq('payload call length', payload.json?.callLengthMin, 60);
  eq('payload firm phrase falls back in dev', payload.json?.firmPhrase, 'an investment firm');
  eq('payload state is open', payload.json?.state, 'open');
  const items = arr(payload.json?.items).map(obj);
  eq('payload carries every objective', items.length, 4);
  check('payload never carries the request id', !payload.text.includes(requestId));
  check('payload never carries the client rate', !payload.text.includes('1300'));
  check('payload never carries the expert name', !payload.text.includes('Zebulon'));
  check('payload never carries organization or owner keys', !/organizationId|ownerEmail|targeting/.test(payload.text));

  const garbage = await req('GET', '/api/s/not-a-real-token');
  eq('GET /api/s/garbage is 410', garbage.status, 410);
  eq('…with the uniform body', garbage.json?.error, 'expired');

  // ── 7. Submission: partial refused, full accepted, single use ────────────
  const partial = await req('POST', `/api/s/${encodeURIComponent(token1)}`, {
    answers: [{ objectiveId: str(items[0]?.id), answer: 'yes', proofText: 'I ran the finance workstream in 2024.' }],
    rateAccepted: true, availability: 'next_week',
  });
  eq('a partial submission is 400', partial.status, 400);

  const yesNoProof = await req('POST', `/api/s/${encodeURIComponent(token1)}`, {
    answers: items.map((item, i) => ({ objectiveId: str(item.id), answer: i === 0 ? 'yes' : 'no' })),
    rateAccepted: true, availability: 'next_week',
  });
  eq('a yes without a sentence is 400', yesNoProof.status, 400);

  const PROOF_0 = 'I led the finance workstream of the SAP S/4 cutover as VP Finance Ops from mid-2023 to early 2025.';
  const PROOF_2 = 'I owned customer master migration for the distributor roll-out in 2024.';
  const full = await req('POST', `/api/s/${encodeURIComponent(token1)}`, {
    answers: [
      { objectiveId: str(items[0]?.id), answer: 'yes',    proofText: PROOF_0 },
      { objectiveId: str(items[1]?.id), answer: 'no' },
      { objectiveId: str(items[2]?.id), answer: 'yes',    proofText: PROOF_2 },
      { objectiveId: str(items[3]?.id), answer: 'unsure', proofText: 'should be dropped' },
    ],
    rateAccepted: false, rateAsk: 700, availability: 'this_week',
  });
  eq('a full submission is 200', full.status, 200);
  eq('coverage yes', obj(full.json?.coverage).yes, 2);
  eq('coverage total', obj(full.json?.coverage).total, 4);

  const twice = await req('POST', `/api/s/${encodeURIComponent(token1)}`, {
    answers: items.map(item => ({ objectiveId: str(item.id), answer: 'no' })),
    rateAccepted: true, availability: 'later',
  });
  eq('a second submission is 409', twice.status, 409);
  eq('…already_submitted', twice.json?.error, 'already_submitted');
  const afterSubmit = await req('GET', `/api/s/${encodeURIComponent(token1)}`);
  eq('the form now reads submitted', afterSubmit.json?.state, 'submitted');

  // ── 8. The client review payload ─────────────────────────────────────────
  const review = await req('GET', `/api/requests/${requestId}`);
  eq('GET /api/requests/[id] answers 200', review.status, 200);
  const respondents = arr(obj(review.json?.request).respondents).map(obj);
  eq('one respondent', respondents.length, 1);
  const r1 = respondents[0];
  eq('coverage 2 of 4', obj(r1.coverage).yes, 2);
  eq('ratio', obj(r1.coverage).ratio, 0.5);
  const answers = arr(r1.answers).map(obj);
  eq('every answer stored, negatives included', answers.length, 4);
  eq('the proof sentence is verbatim', str(answers.find(a => a.objectiveId === str(items[0]?.id))?.proofText), PROOF_0);
  eq('a no carries no proof', answers.find(a => a.objectiveId === str(items[1]?.id))?.proofText, null);
  eq('an unsure carries no proof', answers.find(a => a.objectiveId === str(items[3]?.id))?.proofText, null);
  eq('rate was countered', obj(r1.rate).accepted, false);
  eq('client sees the CLIENT-side conversion of $700', obj(r1.rate).clientRate, 1400);
  eq('admin sees the expert ask', obj(r1.rate).expertAsk, 700);
  eq('availability', r1.availability, 'this_week');
  check('submittedAt stamped', str(r1.submittedAt).length > 0);

  // ── 9. A second link, revoked ────────────────────────────────────────────
  const minted2 = await req('POST', `/api/requests/${requestId}/tokens`, { name: 'Second Person' });
  eq('second mint', minted2.status, 201);
  const token2Id = str(obj(minted2.json?.respondent).id);
  const link2 = str(minted2.json?.link);
  const token2 = decodeURIComponent(link2.slice(link2.indexOf('/s/') + 3));
  eq('second label', obj(minted2.json?.respondent).label, 'Candidate 2');

  const revoked = await req('POST', `/api/requests/${requestId}/tokens/${token2Id}/revoke`, {});
  eq('revoke answers 200', revoked.status, 200);
  check('revokedAt stamped', str(obj(revoked.json?.respondent).revokedAt).length > 0);
  const deadRead = await req('GET', `/api/s/${encodeURIComponent(token2)}`);
  eq('a revoked link reads 410', deadRead.status, 410);

  // ── 10. Request call and stage-5 outcomes ────────────────────────────────
  const callRevoked = await req('POST', `/api/requests/${requestId}/tokens/${token2Id}/request-call`, {});
  eq('request-call on an unanswered link is 409', callRevoked.status, 409);

  const earlyOutcomes = await req('POST', `/api/requests/${requestId}/tokens/${token1Id}/outcomes`, {
    outcomes: [{ objectiveId: str(items[0]?.id), outcome: 'answered' }],
  });
  eq('outcomes before request-call is 409', earlyOutcomes.status, 409);

  const call = await req('POST', `/api/requests/${requestId}/tokens/${token1Id}/request-call`, {});
  eq('request-call answers 200', call.status, 200);
  const requestedAt = str(obj(call.json?.respondent).callRequestedAt);
  check('callRequestedAt stamped', requestedAt.length > 0);
  const callAgain = await req('POST', `/api/requests/${requestId}/tokens/${token1Id}/request-call`, {});
  eq('request-call is idempotent', str(obj(callAgain.json?.respondent).callRequestedAt), requestedAt);

  const badOutcome = await req('POST', `/api/requests/${requestId}/tokens/${token1Id}/outcomes`, {
    outcomes: [{ objectiveId: str(items[0]?.id), outcome: 'great' }],
  });
  eq('an unknown outcome is 400', badOutcome.status, 400);

  const outcomes = await req('POST', `/api/requests/${requestId}/tokens/${token1Id}/outcomes`, {
    outcomes: [
      { objectiveId: str(items[0]?.id), outcome: 'answered' },
      { objectiveId: str(items[2]?.id), outcome: 'partial' },
    ],
  });
  eq('outcomes recorded', outcomes.status, 200);
  eq('two outcomes stored', arr(obj(outcomes.json?.respondent).outcomes).length, 2);

  const reOutcomes = await req('POST', `/api/requests/${requestId}/tokens/${token1Id}/outcomes`, {
    outcomes: [{ objectiveId: str(items[0]?.id), outcome: 'unanswered' }],
  });
  const stored = arr(obj(reOutcomes.json?.respondent).outcomes).map(obj);
  eq('re-marking upserts', stored.find(o => o.objectiveId === str(items[0]?.id))?.outcome, 'unanswered');

  // ── 11. The list reflects it all ─────────────────────────────────────────
  const finalList = await req('GET', '/api/requests');
  const row = arr(finalList.json?.requests).map(obj).find(r => r.id === requestId);
  eq('list status', row?.status, 'approved');
  eq('list respondent count', row?.respondentCount, 2);
  eq('list submitted count', row?.submittedCount, 1);

  summary();
}

main().catch(err => {
  console.error('e2e-screening crashed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
