// scripts/test-screening-items.ts — unit tests for the LLM step of the
// Structured Request & Screening Flow (docs/SCREENING_FLOW_PLAN.md, build step
// 3): lib/screeningItems.ts.
//
// OFFLINE. No network, no model, no API key, no Supabase, no Redis. Every
// branch of generateScreeningItems is driven through its injected
// `createMessage`, which is the reason that seam exists — the flow's whole
// point is that a model failure is survivable, and a test that needs the model
// to be up could not prove it.
//
//   npx tsx scripts/test-screening-items.ts
//
// Exits non-zero if any assertion failed, so it can gate a deploy.

// The key is cleared so the one branch that must run without it really does.
delete process.env.ANTRHOPICKEYREAL;

import type Anthropic from '@anthropic-ai/sdk';
import {
  SCREENING_MODEL,
  SYSTEM_PROMPT,
  proofPromptViolation,
  stemViolation,
  fallbackItem,
  parseModelItems,
  generateScreeningItems,
  FALLBACK_PROOF_PROMPT,
  MAX_REGENERATION_ATTEMPTS,
} from '../lib/screeningItems';
import { check, eq, summary } from './testHarness';

// ─── Stub plumbing ────────────────────────────────────────────────────────────

function message(text: string, stopReason: Anthropic.Message['stop_reason'] = 'end_turn'): Anthropic.Message {
  return {
    id:            'msg_test',
    type:          'message',
    role:          'assistant',
    model:         SCREENING_MODEL,
    content:       text ? [{ type: 'text', text, citations: null }] : [],
    stop_reason:   stopReason,
    stop_sequence: null,
    usage: {
      input_tokens:                0,
      output_tokens:               0,
      cache_creation_input_tokens: null,
      cache_read_input_tokens:     null,
      server_tool_use:             null,
      service_tier:                null,
    },
  };
}

/** The text of the single user message in a params object. */
function userTextOf(params: Anthropic.MessageCreateParamsNonStreaming): string {
  const content = params.messages[0]?.content;
  if (typeof content === 'string') return content;
  const block = Array.isArray(content) ? content.find(b => b.type === 'text') : undefined;
  return block && block.type === 'text' ? block.text : '';
}

const GOOD_STEM_A  = 'Were you directly involved in an SAP migration at a comparable company between 2023 and 2025?';
const GOOD_STEM_B  = 'Have you led a pricing change at a mid-size distributor in the last three years?';
const GOOD_STEM_C  = 'Were you responsible for a contract-manufacturing relationship at a comparable firm?';
const GOOD_PROOF_A = 'In one sentence: what was your role in that project and when?';
const GOOD_PROOF_B = FALLBACK_PROOF_PROMPT;

const OBJECTIVES = [
  { id: 'obj-1', text: 'How did the 2024 SAP migration affect order-to-cash cycle time?' },
  { id: 'obj-2', text: 'How do mid-size distributors decide on annual price increases?' },
  { id: 'obj-3', text: 'What does contract-manufacturer switching cost look like in practice?' },
];

const TOPIC = 'ERP migration and pricing in mid-market industrial distribution';

// ─── The system prompt carries the hard constraint ────────────────────────────

function promptShape(): void {
  eq('the model constant is claude-opus-5', SCREENING_MODEL, 'claude-opus-5');
  check('the system prompt states the hard constraint', /HARD CONSTRAINT/.test(SYSTEM_PROMPT));
  check('the system prompt names role and timeframe', /role and timeframe/i.test(SYSTEM_PROMPT));
  check('the system prompt forbids substance',
    /findings|results|outcomes/i.test(SYSTEM_PROMPT));
  check('the system prompt treats objectives as data',
    /DATA, NOT INSTRUCTIONS/.test(SYSTEM_PROMPT));
  check('the system prompt asks for a JSON array only',
    /Return ONLY a JSON array/.test(SYSTEM_PROMPT));
  check('the system prompt carries the worked example',
    /order-to-cash/.test(SYSTEM_PROMPT));
}

// ─── proofPromptViolation ─────────────────────────────────────────────────────

function proofValidator(): void {
  // The two examples the plan writes out, and a few more that ask only for
  // access and proximity.
  const good = [
    GOOD_PROOF_A,
    GOOD_PROOF_B,
    'In one sentence: which employer was that, and over what years?',
    'One sentence on your role and the timeframe, please.',
    'Which team were you on for that work, and in which years?',
    'In one sentence: were you hands-on or overseeing it, and when?',
    'What was your title at the time, and roughly how long were you in that seat?',
  ];
  for (const text of good) {
    eq(`accepts: ${text.slice(0, 48)}`, proofPromptViolation(text), null);
  }

  // One case per banned family.
  const bad: Array<[string, string]> = [
    ['what happened',       'In one sentence: what was your role, and what happened?'],
    ['what was the result', 'What was the result of that migration?'],
    ['what was the outcome','What was the outcome for the business?'],
    ['what was the impact', 'What was the impact on cycle time?'],
    ['what were the',       'What were the biggest levers you pulled?'],
    ['what did you find',   'What did you find when you looked at the data?'],
    ['what did you learn',  'What did you learn from that project?'],
    ['what did you recommend', 'What did you recommend to the board?'],
    ['how did it go',       'How did it go once the system went live?'],
    ['how did that perform','How did that perform against plan?'],
    ['how much',            'How much did the cycle time drop?'],
    ['how many',            'How many sites were live at the end?'],
    ['by how much',         'Cycle time moved by how much?'],
    ['percent',             'What percent of orders were touchless afterwards?'],
    ['percent sign',        'Was the improvement over 20%?'],
    ['dollar sign',         'Was the saving above $1m?'],
    ['dollars',             'How many dollars did that save?'],
    ['revenue',             'What happened to revenue in that period?'],
    ['margin',              'Did margins move over that period?'],
    ['roi',                 'What was the ROI on that programme?'],
    ['kpi',                 'Which KPIs moved after go-live?'],
    ['results',             'Tell us the results in one sentence.'],
    ['outcomes',            'Summarise the outcomes in one line.'],
    ['findings',            'Give us your findings in one sentence.'],
    ['conclusions',         'State your conclusions briefly.'],
    ['recommend',           'What would you recommend to someone doing this now?'],
    ['insight',             'Give one insight from that work.'],
    ['describe the',        'Describe the migration in one sentence.'],
    ['explain how',         'Explain how the cutover worked.'],
    ['walk me through',     'Walk me through the programme briefly.'],
    ['tell us about the impact', 'Tell us about the impact on the business.'],
    ['what challenges',     'What challenges did the team hit?'],
    ['what worked',         'What worked best on that programme?'],
    ['what went wrong',     'What went wrong during the cutover?'],
    ['why did',             'Why did the timeline slip?'],
  ];
  for (const [label, text] of bad) {
    const reason = proofPromptViolation(text);
    check(`rejects ${label}`, typeof reason === 'string' && reason.length > 0, `got ${String(reason)}`);
    check(`the ${label} reason is a sentence`, (reason ?? '').trim().endsWith('.'), reason ?? '');
  }

  // Shape rules.
  check('rejects an empty prompt', proofPromptViolation('') !== null);
  check('rejects whitespace only', proofPromptViolation('   \n ') !== null);
  check('rejects over 300 characters', proofPromptViolation(`In one sentence: ${'a'.repeat(300)}?`) !== null);
  check('rejects two question marks',
    proofPromptViolation('What was your role? And when was that?') !== null);
  eq('accepts exactly one question mark', proofPromptViolation(GOOD_PROOF_A), null);
}

// ─── stemViolation ────────────────────────────────────────────────────────────

function stemValidator(): void {
  for (const stem of [GOOD_STEM_A, GOOD_STEM_B, GOOD_STEM_C]) {
    eq(`accepts stem: ${stem.slice(0, 40)}`, stemViolation(stem), null);
  }
  check('a stem may name a year range',
    stemViolation('Were you involved in a cutover between 2023 - 2025 at a comparable firm?') === null);

  check('rejects an empty stem',       stemViolation('') !== null);
  check('rejects a stem over 300',     stemViolation(`${'a'.repeat(301)}?`) !== null);
  check('rejects a stem with no "?"',  stemViolation('Were you directly involved in an SAP migration.') !== null);
  check('rejects an email in a stem',
    stemViolation('Were you involved in this, and can we reach you at sam@example.com?') !== null);
  check('rejects a url in a stem',
    stemViolation('Did you work on the programme described at https://example.com/deck?') !== null);
  check('rejects a bare domain in a stem',
    stemViolation('Were you at acme.com during the migration?') !== null);
  check('rejects a phone shape in a stem',
    stemViolation('Were you involved, and is 415-555-0134 still your number?') !== null);
  check('rejects money in a stem',
    stemViolation('Were you involved in a $40m migration at a comparable company?') !== null);
}

// ─── fallbackItem ─────────────────────────────────────────────────────────────

function fallback(): void {
  const cases: Array<[string, string]> = [
    ['ordinary',   'How did the 2024 SAP migration affect order-to-cash cycle time?'],
    ['very long',  `Understand ${'the downstream effects of the migration '.repeat(20)}in detail`],
    ['with money', 'What did the $40m ERP programme do to working capital?'],
    ['with a url', 'Compare our approach to the one at https://example.com/case-study and www.acme.com'],
    ['with email', 'Follow up on the thread from sam@example.com about pricing'],
    ['with phone', 'The programme lead on 415-555-0134 ran the 2024 cutover'],
    ['with quotes','Why did the "big bang" cutover slip, and what were the results?'],
    ['empty',      ''],
    ['whitespace', '   \n\t  '],
    ['digits',     '1234567890123456 and 20% and 100%'],
  ];

  for (const [label, objective] of cases) {
    const item = fallbackItem(objective);
    eq(`fallback stem passes for ${label}`,  stemViolation(item.stem), null);
    eq(`fallback proof passes for ${label}`, proofPromptViolation(item.proofPrompt), null);
    check(`fallback stem ends with "?" for ${label}`, item.stem.endsWith('?'));
    check(`fallback stem fits 300 for ${label}`, item.stem.length <= 300, String(item.stem.length));
  }

  eq('the fallback proof prompt is the plain one',
    fallbackItem('anything').proofPrompt, GOOD_PROOF_B);
  check('the fallback stem quotes the objective',
    fallbackItem('pricing governance in industrial distribution').stem.includes('pricing governance'));
  check('an empty objective still yields a usable stem',
    fallbackItem('').stem === 'Have you been directly involved in work of this kind?');
}

// ─── parseModelItems ──────────────────────────────────────────────────────────

function parser(): void {
  const plain = JSON.stringify([
    { index: 0, stem: GOOD_STEM_A, proof_prompt: GOOD_PROOF_A },
    { index: 1, stem: GOOD_STEM_B, proof_prompt: GOOD_PROOF_A },
  ]);

  const fromPlain = parseModelItems(plain, 2);
  check('parses plain JSON', fromPlain !== null);
  eq('two items out of plain JSON', fromPlain?.length, 2);
  eq('first stem survives', fromPlain?.[0].stem, GOOD_STEM_A);
  eq('proof_prompt is read into proofPrompt', fromPlain?.[0].proofPrompt, GOOD_PROOF_A);

  const fenced = parseModelItems('```json\n' + plain + '\n```', 2);
  eq('parses fenced JSON to the same thing', JSON.stringify(fenced), JSON.stringify(fromPlain));

  const bareFence = parseModelItems('```\n' + plain + '\n```', 2);
  eq('parses an unlabelled fence', bareFence?.length, 2);

  const outOfOrder = parseModelItems(JSON.stringify([
    { index: 2, stem: GOOD_STEM_C, proof_prompt: GOOD_PROOF_A },
    { index: 0, stem: GOOD_STEM_A, proof_prompt: GOOD_PROOF_A },
    { index: 1, stem: GOOD_STEM_B, proof_prompt: GOOD_PROOF_A },
  ]), 3);
  eq('out-of-order indexes come back ordered', outOfOrder?.map(i => i.index).join(','), '0,1,2');
  eq('out-of-order index 2 keeps its stem', outOfOrder?.[2].stem, GOOD_STEM_C);

  const positional = parseModelItems(JSON.stringify([
    { stem: GOOD_STEM_A, proof_prompt: GOOD_PROOF_A },
    { stem: GOOD_STEM_B, proof_prompt: GOOD_PROOF_A },
  ]), 2);
  eq('a missing index falls back to array position', positional?.[1].index, 1);

  eq('an out-of-range index is dropped',
    parseModelItems(JSON.stringify([{ index: 9, stem: GOOD_STEM_A, proof_prompt: GOOD_PROOF_A }]), 2)?.length, 0);
  eq('a duplicate index keeps the first',
    parseModelItems(JSON.stringify([
      { index: 0, stem: GOOD_STEM_A, proof_prompt: GOOD_PROOF_A },
      { index: 0, stem: GOOD_STEM_B, proof_prompt: GOOD_PROOF_A },
    ]), 2)?.[0].stem, GOOD_STEM_A);
  eq('non-string fields are coerced to empty',
    parseModelItems(JSON.stringify([{ index: 0, stem: 12, proof_prompt: null }]), 1)?.[0].stem, '');

  eq('garbage is null',            parseModelItems('sorry, I cannot do that', 2), null);
  eq('an object is null',          parseModelItems('{"index":0}', 2), null);
  eq('an empty string is null',    parseModelItems('', 2), null);
  eq('a truncated array is null',  parseModelItems('[{"index":0,', 2), null);
  eq('an empty array parses to no items', parseModelItems('[]', 2)?.length, 0);
}

// ─── generateScreeningItems ───────────────────────────────────────────────────

function goodJson(indexes: number[], stems: string[], proofs: string[]): string {
  return JSON.stringify(indexes.map((index, i) => ({
    index, stem: stems[i], proof_prompt: proofs[i],
  })));
}

async function generation(): Promise<void> {
  // (a) everything comes back clean.
  {
    let calls = 0;
    const result = await generateScreeningItems(
      { topic: TOPIC, objectives: OBJECTIVES },
      {
        createMessage: async () => {
          calls++;
          return message(goodJson([0, 1, 2],
            [GOOD_STEM_A, GOOD_STEM_B, GOOD_STEM_C],
            [GOOD_PROOF_A, GOOD_PROOF_A, GOOD_PROOF_A]));
        },
      },
    );
    eq('(a) one call is enough',        calls, 1);
    eq('(a) source is model',           result.source, 'model');
    eq('(a) no reason on a clean set',  result.reason, undefined);
    eq('(a) three items',               result.items.length, 3);
    eq('(a) ids follow the objectives', result.items.map(i => i.id).join(','), 'obj-1,obj-2,obj-3');
    check('(a) every item is model-sourced', result.items.every(i => i.source === 'model'));
    check('(a) the model text is kept',
      result.items.every(i => i.modelStem === i.stem && i.modelProofPrompt === i.proofPrompt));
  }

  // (b) one bad proof prompt, fixed on the single regeneration round.
  {
    const seen: string[] = [];
    const result = await generateScreeningItems(
      { topic: TOPIC, objectives: OBJECTIVES },
      {
        createMessage: async (params) => {
          seen.push(userTextOf(params));
          if (seen.length === 1) {
            return message(goodJson([0, 1, 2],
              [GOOD_STEM_A, GOOD_STEM_B, GOOD_STEM_C],
              [GOOD_PROOF_A, 'What was the result of that price increase?', GOOD_PROOF_A]));
          }
          return message(goodJson([0], [GOOD_STEM_B], [GOOD_PROOF_A]));
        },
      },
    );
    eq('(b) exactly two calls', seen.length, 2);
    check('(b) the retry carries only the failing objective',
      seen[1].includes('mid-size distributors') && !seen[1].includes('SAP migration affect'));
    check('(b) the retry names the rule that broke',
      /What was wrong: .*role and timeframe/i.test(seen[1]), seen[1].slice(0, 400));
    eq('(b) source is model after the fix', result.source, 'model');
    eq('(b) no reason after the fix',       result.reason, undefined);
    eq('(b) the fixed item took the retry text', result.items[1].proofPrompt, GOOD_PROOF_A);
    eq('(b) the fixed item took the retry stem', result.items[1].stem, GOOD_STEM_B);
    check('(b) every item is model-sourced', result.items.every(i => i.source === 'model'));
  }

  // (c) still bad after the regeneration round → that one item falls back.
  {
    let calls = 0;
    const badProof = 'What was the result of that price increase?';
    const worse    = 'And what were the biggest levers you pulled?';
    const result   = await generateScreeningItems(
      { topic: TOPIC, objectives: OBJECTIVES },
      {
        createMessage: async () => {
          calls++;
          if (calls === 1) {
            return message(goodJson([0, 1, 2],
              [GOOD_STEM_A, GOOD_STEM_B, GOOD_STEM_C],
              [GOOD_PROOF_A, badProof, GOOD_PROOF_A]));
          }
          return message(goodJson([0], [GOOD_STEM_B], [worse]));
        },
      },
    );
    eq('(c) one call plus two regenerations', calls, 1 + MAX_REGENERATION_ATTEMPTS);
    eq('(c) source is fallback',       result.source, 'fallback');
    eq('(c) reason is validation',     result.reason, 'validation');
    eq('(c) the good items stay model', result.items[0].source, 'model');
    eq('(c) the bad item falls back',   result.items[1].source, 'fallback');
    eq('(c) the fallback proof is the plain one', result.items[1].proofPrompt, GOOD_PROOF_B);
    eq('(c) what the model wrote is preserved', result.items[1].modelProofPrompt, worse);
    eq('(c) the model stem is preserved too',   result.items[1].modelStem, GOOD_STEM_B);
    eq('(c) the fallback item passes the validators',
      stemViolation(result.items[1].stem) ?? proofPromptViolation(result.items[1].proofPrompt), null);
  }

  // (d) the call throws.
  {
    let calls = 0;
    const result = await generateScreeningItems(
      { topic: TOPIC, objectives: OBJECTIVES },
      {
        createMessage: async () => {
          calls++;
          throw new Error('connection reset');
        },
      },
    );
    eq('(d) one call, no retry',   calls, 1);
    eq('(d) source is fallback',   result.source, 'fallback');
    eq('(d) reason is model_error', result.reason, 'model_error');
    eq('(d) every objective still has an item', result.items.length, 3);
    check('(d) every item is fallback', result.items.every(i => i.source === 'fallback'));
    check('(d) no model text is claimed',
      result.items.every(i => i.modelStem === null && i.modelProofPrompt === null));
    check('(d) every fallback passes both validators', result.items.every(i =>
      stemViolation(i.stem) === null && proofPromptViolation(i.proofPrompt) === null));
  }

  // (e) the model refuses.
  {
    const result = await generateScreeningItems(
      { topic: TOPIC, objectives: OBJECTIVES },
      { createMessage: async () => message('', 'refusal') },
    );
    eq('(e) source is fallback', result.source, 'fallback');
    eq('(e) reason is refusal',  result.reason, 'refusal');
    eq('(e) a full set comes back anyway', result.items.length, 3);
  }

  // (e2) a reply with no text block reads as a generation failure too.
  {
    const result = await generateScreeningItems(
      { topic: TOPIC, objectives: OBJECTIVES },
      { createMessage: async () => message('') },
    );
    eq('(e2) an empty reply falls back', result.source, 'fallback');
    eq('(e2) reason is refusal',         result.reason, 'refusal');
  }

  // (e3) unparseable output, no retry — there is no per-item rule to name.
  {
    let calls = 0;
    const result = await generateScreeningItems(
      { topic: TOPIC, objectives: OBJECTIVES },
      { createMessage: async () => { calls++; return message('Sure! Here you go.'); } },
    );
    eq('(e3) one call only',      calls, 1);
    eq('(e3) reason is unparseable', result.reason, 'unparseable');
    eq('(e3) a full set comes back', result.items.length, 3);
  }

  // (f) no key and no stub.
  {
    const result = await generateScreeningItems({ topic: TOPIC, objectives: OBJECTIVES });
    eq('(f) source is fallback',  result.source, 'fallback');
    eq('(f) reason is no_api_key', result.reason, 'no_api_key');
    eq('(f) a full editable set',  result.items.length, 3);
    check('(f) every item is fallback', result.items.every(i => i.source === 'fallback'));
    check('(f) every fallback passes both validators', result.items.every(i =>
      stemViolation(i.stem) === null && proofPromptViolation(i.proofPrompt) === null));
  }

  // The call itself: model, budget, system prompt, one user message, effort.
  {
    let captured: Anthropic.MessageCreateParamsNonStreaming | null = null;
    await generateScreeningItems(
      { topic: TOPIC, objectives: OBJECTIVES },
      {
        createMessage: async (params) => {
          captured = params;
          return message(goodJson([0, 1, 2],
            [GOOD_STEM_A, GOOD_STEM_B, GOOD_STEM_C],
            [GOOD_PROOF_A, GOOD_PROOF_A, GOOD_PROOF_A]));
        },
      },
    );
    const params = captured as Anthropic.MessageCreateParamsNonStreaming | null;
    const extras = params as unknown as Record<string, unknown> | null;
    eq('the call uses the screening model', params?.model, SCREENING_MODEL);
    eq('the call budgets 4000 tokens',      params?.max_tokens, 4000);
    eq('the call carries the system prompt', params?.system, SYSTEM_PROMPT);
    eq('the call sends one user message',   params?.messages.length, 1);
    eq('thinking is left to the model',     (extras ?? {}).thinking, undefined);
    eq('effort is medium',
      JSON.stringify((extras ?? {}).output_config), JSON.stringify({ effort: 'medium' }));

    const text = params ? userTextOf(params) : '';
    check('the user message carries the topic', text.includes(TOPIC));
    check('the objectives are numbered from 0', text.includes('0. How did the 2024 SAP migration'));
    check('every objective is present', OBJECTIVES.every(o => text.includes(o.text)));
  }

  // An empty objective list never calls the model.
  {
    let calls = 0;
    const result = await generateScreeningItems(
      { topic: TOPIC, objectives: [] },
      { createMessage: async () => { calls++; return message('[]'); } },
    );
    eq('no objectives means no call', calls, 0);
    eq('no objectives means no items', result.items.length, 0);
  }
}


// ─── Adversarial objectives (founder, 2026-09-15) ─────────────────────────────
//
// Ten objectives written the way clients write them — each one is a question
// about RESULTS, so the tempting proof prompt is the one that asks the expert
// for the answer. For each, the prompt a lazy model would write; the validator
// has to refuse every one, and the generation loop has to regenerate at most
// MAX_REGENERATION_ATTEMPTS times and then land on the fixed fallback string.

const ADVERSARIAL: Array<{ objective: string; tempting: string }> = [
  { objective: 'How did the 2024 SAP migration affect order-to-cash cycle time?',
    tempting:  'In one sentence: what was the result of the migration and by how much did cycle time change?' },
  { objective: 'Why did Tier 2 suppliers in Southeast Asia lose share in 2023-2025?',
    tempting:  'Briefly, why did they lose share and what drove it?' },
  { objective: 'What drove churn in mid-market SaaS security tooling last year?',
    tempting:  'What were the main reasons customers churned, in your view?' },
  { objective: 'How do regional grocers actually evaluate private-label vendors?',
    tempting:  'What would you recommend a vendor do to win that evaluation?' },
  { objective: 'What changed in poultry cold-chain logistics costs post-2022?',
    tempting:  'What changed in your costs after 2022, roughly what percentage?' },
  { objective: 'Was the 2023 pricing increase successful at holding volume?',
    tempting:  'Was it successful, and did volume hold?' },
  { objective: 'Which order-to-cash steps still needed manual work after go-live?',
    tempting:  'What did you find still needed manual work after go-live?' },
  { objective: 'How much did the integrator overrun the original budget?',
    tempting:  'How much did the programme overrun, in dollars?' },
  { objective: 'What lessons did the team take from the hypercare period?',
    tempting:  'What were the biggest lessons learned from hypercare?' },
  { objective: 'How does your churn compare with the category average?',
    tempting:  'How does your churn compare with the rest of the category?' },
  { objective: 'Is the vendor relationship worth keeping after the renewal?',
    tempting:  'In your opinion, is the relationship worth it, and what would you do?' },
  { objective: 'What happened to margins after the private-label switch?',
    tempting:  'What happened to margins after the switch?' },
];

function adversarialValidator(): void {
  check('at least ten adversarial objectives', ADVERSARIAL.length >= 10, String(ADVERSARIAL.length));
  for (const { tempting } of ADVERSARIAL) {
    const reason = proofPromptViolation(tempting);
    check(`refuses: ${tempting.slice(0, 60)}`, reason !== null);
    check(`…with a sentence: ${tempting.slice(0, 30)}`, typeof reason === 'string' && /[.!]$/.test(reason));
  }
  // The fixed fallback passes, and so does a role-and-timeframe prompt written
  // against every one of those objectives.
  eq('the fixed fallback string passes', proofPromptViolation(FALLBACK_PROOF_PROMPT), null);
  eq('the fixed fallback string is the one the founder set',
    FALLBACK_PROOF_PROMPT, 'In one sentence: what was your role in this and when?');
  eq('a role-and-timeframe prompt passes',
    proofPromptViolation('In one sentence: what was your role in that programme and in which years?'), null);
}

async function adversarialGeneration(): Promise<void> {
  const objectives = ADVERSARIAL.map((a, i) => ({ id: `adv-${i}`, text: a.objective }));
  const stems      = ADVERSARIAL.map(() => 'Were you directly involved in work of this kind at a comparable company in the last three years?');
  const indexes    = (n: number) => Array.from({ length: n }, (_, i) => i);

  // (adv-1) the model insists on result-seeking prompts on every attempt:
  // one call, MAX_REGENERATION_ATTEMPTS regenerations, then the fixed string.
  {
    let calls = 0;
    const result = await generateScreeningItems(
      { topic: 'Adversarial', objectives },
      {
        createMessage: async (params) => {
          calls++;
          // Every attempt returns tempting prompts for whatever it was asked.
          const text  = userTextOf(params);
          const count = calls === 1 ? objectives.length : (text.match(/^\d+\. /gm) ?? []).length;
          return message(goodJson(indexes(count), stems.slice(0, count),
            ADVERSARIAL.slice(0, count).map(a => a.tempting)));
        },
      },
    );
    eq('(adv-1) one call plus the capped regenerations', calls, 1 + MAX_REGENERATION_ATTEMPTS);
    eq('(adv-1) source is fallback', result.source, 'fallback');
    eq('(adv-1) reason is validation', result.reason, 'validation');
    check('(adv-1) every item fell back', result.items.every(i => i.source === 'fallback'));
    check('(adv-1) every proof prompt is the fixed string',
      result.items.every(i => i.proofPrompt === FALLBACK_PROOF_PROMPT));
    check('(adv-1) every fallback passes the validator',
      result.items.every(i => proofPromptViolation(i.proofPrompt) === null));
    check('(adv-1) what the model wrote is kept for the record',
      result.items.every(i => i.modelProofPrompt !== null && proofPromptViolation(i.modelProofPrompt) !== null));
  }

  // (adv-2) the model gets it right on the SECOND regeneration: model text wins.
  {
    let calls = 0;
    const result = await generateScreeningItems(
      { topic: 'Adversarial', objectives },
      {
        createMessage: async (params) => {
          calls++;
          const text  = userTextOf(params);
          const count = calls === 1 ? objectives.length : (text.match(/^\d+\. /gm) ?? []).length;
          const proofs = calls === 3
            ? indexes(count).map(() => 'In one sentence: what was your role in that work and in which years?')
            : ADVERSARIAL.slice(0, count).map(a => a.tempting);
          return message(goodJson(indexes(count), stems.slice(0, count), proofs));
        },
      },
    );
    eq('(adv-2) three calls', calls, 3);
    eq('(adv-2) source is model', result.source, 'model');
    check('(adv-2) every item is model-sourced', result.items.every(i => i.source === 'model'));
    check('(adv-2) no fixed string was needed', result.items.every(i => i.proofPrompt !== FALLBACK_PROOF_PROMPT));
  }

  // (adv-3) a third bad attempt is never requested: the cap holds even when
  // the model would have got it right on a fourth try.
  {
    let calls = 0;
    await generateScreeningItems(
      { topic: 'Adversarial', objectives: objectives.slice(0, 1) },
      {
        createMessage: async () => {
          calls++;
          return message(goodJson([0], [stems[0]], [calls >= 4 ? GOOD_PROOF_A : ADVERSARIAL[0].tempting]));
        },
      },
    );
    eq('(adv-3) the cap is exactly MAX_REGENERATION_ATTEMPTS', calls, 1 + MAX_REGENERATION_ATTEMPTS);
    eq('(adv-3) the cap is two', MAX_REGENERATION_ATTEMPTS, 2);
  }
}

// ─── Run ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  promptShape();
  proofValidator();
  stemValidator();
  fallback();
  parser();
  await generation();
  adversarialValidator();
  await adversarialGeneration();
}

main()
  .then(() => summary('screening-items'))
  .catch((error: unknown) => {
    console.error('[test-screening-items] threw',
      error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
