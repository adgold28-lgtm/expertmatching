// scripts/test-intro-personalization.ts — unit tests for lib/introPersonalization.ts.
//
// Pure functions, no network, no API key: the model path is exercised through
// the exported validator with canned output, exactly as the send path would
// receive it.
//
//   npx tsx scripts/test-intro-personalization.ts
//
// What it proves (docs/OUTREACH_EMAIL_RUBRIC.md, "Personalization"):
//   - a trusted past-tense claim becomes a second-person why-them line ending
//     in the rubric clause; a noun-phrase claim does not; a low-confidence
//     claim is never used
//   - the domain comes from the expert's own label, never their employer or a
//     client term, and falls back to the brief's industry only as a last resort
//   - the model validator refuses invented numbers, a sentence that could be
//     about anyone, the expert's own name, an em dash, a banned phrase, and a
//     domain that names the company — and never repairs anything
//   - the staff-line helpers append the clause and lint the result

import type { Expert, EvidenceItem } from '../types';
import {
  whyThemFromEvidence,
  secondPersonFromClaim,
  introDomainFor,
  normalizeDomain,
  validateModelWhyThem,
  generateWhyThem,
  whyThemRejection,
  withWhyThemClause,
  WHY_THEM_CLAUSE,
} from '../lib/introPersonalization';
import { introRubricViolation } from '../lib/matchyTemplates';
import { check, eq, summary } from './testHarness';

function section(title: string): void {
  console.log(`\n${title}`);
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

function evidence(claim: string, extra: Partial<EvidenceItem> = {}): EvidenceItem {
  return { id: 'ev', sourceLabel: 'Trade Interview', claim, relevance: 'Relevant.', ...extra };
}

function expert(overrides: Partial<Expert> = {}): Expert {
  return {
    id:              'exp-1',
    name:            'Mark Ellison',
    title:           'Former VP Distribution',
    company:         'Sysco',
    location:        'Atlanta, GA, US',
    category:        'Operator',
    justification:   '',
    relevance_score: 90,
    source_url:      '',
    source_label:    '',
    source_links:    [],
    valueChainLabel: 'Cold-chain distribution',
    evidenceItems:   [
      evidence('Ran distribution in the Southeast for Sysco for six years.', { evidenceType: 'role', confidence: 'high' }),
    ],
    ...overrides,
  };
}

const GOOD_LINE = "You ran distribution in the Southeast for Sysco for six years, so I think you'd be a great fit for my client.";

// ─── whyThemFromEvidence ─────────────────────────────────────────────────────

section('whyThemFromEvidence — a trusted past-tense claim becomes the line');

const base = whyThemFromEvidence(expert());
eq('past-tense claim → second person with the clause', base?.whyThem, GOOD_LINE);
eq('domain from the value-chain label, lower-cased', base?.domain, 'cold-chain distribution');
check('the line passes the rubric lint', base !== null && introRubricViolation(base.whyThem) === null);
check('the line passes whyThemRejection', base !== null && whyThemRejection(base.whyThem) === null);

eq('noun-phrase claim → null',
  whyThemFromEvidence(expert({ evidenceItems: [evidence('Former VP of Distribution at Sysco.', { evidenceType: 'role', confidence: 'high' })] })),
  null);

eq('present-tense claim → null',
  whyThemFromEvidence(expert({ evidenceItems: [evidence('Leads distribution for Sysco in the Southeast.', { evidenceType: 'role', confidence: 'high' })] })),
  null);

eq('low confidence → null',
  whyThemFromEvidence(expert({ evidenceItems: [evidence('Ran distribution for Sysco for six years.', { evidenceType: 'role', confidence: 'low' })] })),
  null);

eq('medium confidence → null',
  whyThemFromEvidence(expert({ evidenceItems: [evidence('Ran distribution for Sysco for six years.', { evidenceType: 'company', confidence: 'medium' })] })),
  null);

check('untagged confidence is trusted only for role/company',
  whyThemFromEvidence(expert({ evidenceItems: [evidence('Scaled Bayview from 6 to 41 clinics.', { evidenceType: 'role' })] })) !== null
  && whyThemFromEvidence(expert({ evidenceItems: [evidence('Scaled Bayview from 6 to 41 clinics.', { evidenceType: 'publication' })] })) === null);

eq('a "He led …" claim loses its subject',
  whyThemFromEvidence(expert({ evidenceItems: [evidence('He led pricing for Sysco across four regions.', { evidenceType: 'role', confidence: 'high' })] }))?.whyThem,
  "You led pricing for Sysco across four regions, so I think you'd be a great fit for my client.");

eq('a claim opening with the expert\'s name loses it',
  whyThemFromEvidence(expert({ evidenceItems: [evidence('Mark Ellison oversaw 14 depots for Sysco.', { evidenceType: 'role', confidence: 'high' })] }))?.whyThem,
  "You oversaw 14 depots for Sysco, so I think you'd be a great fit for my client.");

check('role claims are preferred over company claims',
  whyThemFromEvidence(expert({ evidenceItems: [
    evidence('Built the cold-chain network at Sysco.', { evidenceType: 'company', confidence: 'high' }),
    evidence('Ran distribution in the Southeast for six years.', { evidenceType: 'role', confidence: 'high' }),
  ] }))?.whyThem.startsWith('You ran distribution') === true);

check('a claim that does not convert is skipped for one that does',
  whyThemFromEvidence(expert({ evidenceItems: [
    evidence('Former VP Distribution.', { evidenceType: 'role', confidence: 'high' }),
    evidence('Managed a 400-truck fleet for Sysco.', { evidenceType: 'role', confidence: 'high' }),
  ] }))?.whyThem === "You managed a 400-truck fleet for Sysco, so I think you'd be a great fit for my client.");

eq('a claim over 30 words → null',
  whyThemFromEvidence(expert({ evidenceItems: [evidence(`Ran ${'a very large regional distribution business '.repeat(6)}for Sysco.`, { evidenceType: 'role', confidence: 'high' })] })),
  null);

eq('a claim with an em dash → null',
  whyThemFromEvidence(expert({ evidenceItems: [evidence('Ran distribution — the whole Southeast — for Sysco.', { evidenceType: 'role', confidence: 'high' })] })),
  null);

eq('a claim with a URL → null',
  whyThemFromEvidence(expert({ evidenceItems: [evidence('Ran distribution for Sysco, see https://sysco.com/about.', { evidenceType: 'role', confidence: 'high' })] })),
  null);

eq('a claim with a banned phrase → null',
  whyThemFromEvidence(expert({ evidenceItems: [evidence('Built real insights into cold-chain pricing at Sysco.', { evidenceType: 'role', confidence: 'high' })] })),
  null);

eq('a claim with a list of three → null',
  whyThemFromEvidence(expert({ evidenceItems: [evidence('Ran sales, marketing, and operations for Sysco.', { evidenceType: 'role', confidence: 'high' })] })),
  null);

eq('a claim naming money → null (the offer sentence is the only money)',
  whyThemFromEvidence(expert({ evidenceItems: [evidence('Grew Sysco Southeast revenue to $2B.', { evidenceType: 'role', confidence: 'high' })] })),
  null);

eq('a claim with a banned word → null',
  whyThemFromEvidence(expert({ evidenceItems: [evidence('Led compliance for Sysco distribution.', { evidenceType: 'role', confidence: 'high' })] })),
  null);

eq('only the first sentence of a claim is used',
  whyThemFromEvidence(expert({ evidenceItems: [evidence('Ran distribution for Sysco for six years. Later joined a competitor.', { evidenceType: 'role', confidence: 'high' })] }))?.whyThem,
  "You ran distribution for Sysco for six years, so I think you'd be a great fit for my client.");

eq('no evidence → null', whyThemFromEvidence(expert({ evidenceItems: [] })), null);
eq('legacy expert with no evidenceItems → null', whyThemFromEvidence(expert({ evidenceItems: undefined })), null);

eq('secondPersonFromClaim lower-cases the verb', secondPersonFromClaim('Headed European operations for Lineage.'),
  "You headed European operations for Lineage, so I think you'd be a great fit for my client.");
eq('secondPersonFromClaim: "Need" is not a past-tense verb', secondPersonFromClaim('Need to know cold-chain pricing.'), null);
eq('secondPersonFromClaim: too short to be a fact', secondPersonFromClaim('Ran Sysco.'), null);

// ─── Domain ──────────────────────────────────────────────────────────────────

section('introDomainFor — specific to the expert, never the employer or the client');

eq('value-chain label first', introDomainFor(expert()), 'cold-chain distribution');
eq('descriptor last segment when there is no label',
  introDomainFor(expert({ valueChainLabel: undefined, anonymizedDescriptor: 'Executive · Operator · Multi-site veterinary operations' })),
  'multi-site veterinary operations');
eq('industry only when nothing else exists',
  introDomainFor(expert({ valueChainLabel: undefined, anonymizedDescriptor: undefined }), { industry: 'Specialty pharma distribution' }),
  'specialty pharma distribution');
eq('industry is NOT used when a label exists but fails',
  introDomainFor(expert({ valueChainLabel: 'Sysco distribution', anonymizedDescriptor: undefined }), { industry: 'Food distribution' }),
  null);
eq('a domain naming the company is rejected', introDomainFor(expert({ valueChainLabel: 'Sysco foodservice distribution' })), null);
eq('a domain carrying a client deny term is rejected',
  introDomainFor(expert({ valueChainLabel: 'Lineage cold storage' }), { denyTerms: ['Lineage Logistics'] }), null);
eq('a one-word domain is too broad', introDomainFor(expert({ valueChainLabel: 'Logistics' })), null);
eq('a six-word domain is too long', introDomainFor(expert({ valueChainLabel: 'Regional cold chain food service distribution networks' })), null);
eq('the value-chain label keeps its ampersand', normalizeDomain('Fiber & Textile Science', { company: 'Acme' }), 'fiber & textile science');
eq('the label loses trailing punctuation', normalizeDomain('Cold-chain distribution.', { company: 'Acme' }), 'cold-chain distribution');
eq('a domain with an em dash is rejected', normalizeDomain('cold — chain', { company: 'Acme' }), null);
check('whyThemFromEvidence returns null when no domain qualifies, even with a good claim',
  whyThemFromEvidence(expert({ valueChainLabel: 'Sysco distribution', anonymizedDescriptor: undefined })) === null);

// ─── validateModelWhyThem ────────────────────────────────────────────────────

section('validateModelWhyThem — the model\'s answer earns nothing it cannot prove');

const modelExpert = expert({ evidenceItems: [
  evidence('Ran distribution in the Southeast for Sysco for six years.', { evidenceType: 'role', confidence: 'high' }),
  evidence('Oversaw 14 depots and a 400-truck fleet.', { evidenceType: 'role', confidence: 'medium' }),
] });

function raw(whyThem: string, domain = 'cold-chain distribution'): string {
  return JSON.stringify({ whyThem, domain });
}

const good = validateModelWhyThem(raw(GOOD_LINE), modelExpert);
eq('a grounded sentence passes', good?.whyThem, GOOD_LINE);
eq('the domain is lower-cased', validateModelWhyThem(raw(GOOD_LINE, 'Cold-Chain Distribution'), modelExpert)?.domain, 'cold-chain distribution');
eq('fenced JSON is accepted', validateModelWhyThem('```json\n' + raw(GOOD_LINE) + '\n```', modelExpert)?.whyThem, GOOD_LINE);
eq('digits that appear in the evidence pass',
  validateModelWhyThem(raw("You oversaw 14 depots for Sysco, so I think you'd be a great fit for my client."), modelExpert)?.whyThem,
  "You oversaw 14 depots for Sysco, so I think you'd be a great fit for my client.");

eq('invented digits are rejected',
  validateModelWhyThem(raw("You ran distribution for Sysco for 12 years, so I think you'd be a great fit for my client."), modelExpert), null);
eq('a sentence that could be about anyone is rejected',
  validateModelWhyThem(raw("You have deep experience in this area, so I think you'd be a great fit for my client."), modelExpert), null);
eq('the clause words alone do not anchor it',
  validateModelWhyThem(raw("You would be great for my client, so I think you'd be a great fit for my client."), modelExpert), null);
eq('the expert\'s own name is rejected',
  validateModelWhyThem(raw("You, Mark, ran distribution for Sysco, so I think you'd be a great fit for my client."), modelExpert), null);
eq('third person is rejected',
  validateModelWhyThem(raw("He ran distribution for Sysco for six years, so I think you'd be a great fit for my client."), modelExpert), null);
eq('a missing clause is rejected, not appended',
  validateModelWhyThem(raw('You ran distribution in the Southeast for Sysco for six years.'), modelExpert), null);
eq('an em dash is rejected',
  validateModelWhyThem(raw("You ran distribution — Southeast — for Sysco, so I think you'd be a great fit for my client."), modelExpert), null);
eq('a banned phrase is rejected',
  validateModelWhyThem(raw("You bring real insights from Sysco distribution, so I think you'd be a great fit for my client."), modelExpert), null);
eq('a banned word is rejected',
  validateModelWhyThem(raw("You ran compliance for Sysco distribution, so I think you'd be a great fit for my client."), modelExpert), null);
eq('money is rejected',
  validateModelWhyThem(raw("You ran a $2B distribution business at Sysco, so I think you'd be a great fit for my client."), modelExpert), null);
eq('a URL is rejected',
  validateModelWhyThem(raw("You ran distribution for Sysco (sysco.com), so I think you'd be a great fit for my client."), modelExpert), null);
eq('over 30 words is rejected',
  validateModelWhyThem(raw(`You ran ${'the very large regional Sysco distribution business '.repeat(4)}for six years, so I think you'd be a great fit for my client.`), modelExpert), null);
eq('a company-name domain is rejected', validateModelWhyThem(raw(GOOD_LINE, 'Sysco distribution'), modelExpert), null);
eq('a client-term domain is rejected', validateModelWhyThem(raw(GOOD_LINE, 'Lineage cold storage'), modelExpert, { denyTerms: ['Lineage'] }), null);
eq('a one-word domain is rejected', validateModelWhyThem(raw(GOOD_LINE, 'distribution'), modelExpert), null);
eq('a missing domain is rejected', validateModelWhyThem(JSON.stringify({ whyThem: GOOD_LINE }), modelExpert), null);
eq('a non-string whyThem is rejected', validateModelWhyThem(JSON.stringify({ whyThem: 42, domain: 'cold-chain distribution' }), modelExpert), null);
eq('malformed JSON is rejected', validateModelWhyThem('not json', modelExpert), null);
eq('an array is rejected', validateModelWhyThem('[1,2]', modelExpert), null);
eq('empty output is rejected', validateModelWhyThem('', modelExpert), null);

// ─── generateWhyThem with a stubbed model ────────────────────────────────────

section('generateWhyThem — one call, validated, never repaired');

async function run(): Promise<void> {
  let calls = 0;
  const ok = await generateWhyThem(modelExpert, { llm: async () => { calls++; return raw(GOOD_LINE); } });
  eq('a good answer comes back', ok?.whyThem, GOOD_LINE);
  eq('exactly one call', calls, 1);

  const bad = await generateWhyThem(modelExpert, { llm: async () => raw("You ran distribution for Sysco for 12 years, so I think you'd be a great fit for my client.") });
  eq('an ungrounded answer is null, not fixed', bad, null);

  const thrown = await generateWhyThem(modelExpert, { llm: async () => { throw new Error('boom'); } });
  eq('a thrown model call is null', thrown, null);

  let called = false;
  const empty = await generateWhyThem(expert({ title: '', evidenceItems: [] }), { llm: async () => { called = true; return raw(GOOD_LINE); } });
  eq('nothing to write from → null without a call', empty, null);
  eq('the model is not called with no facts', called, false);

  const fenced = await generateWhyThem(modelExpert, {
    llm: async (system, user) => {
      check('the prompt fences the facts', user.includes('<<<EXPERT_FACTS>>>') && user.includes('<<<END_EXPERT_FACTS>>>'));
      check('the prompt never carries the expert\'s name', !user.includes('Mark Ellison') && !system.includes('Mark Ellison'));
      check('the prompt carries the claims', user.includes('Ran distribution in the Southeast'));
      return raw(GOOD_LINE);
    },
  });
  check('fenced call returns', fenced !== null);
}

// ─── Staff-line helpers ──────────────────────────────────────────────────────

section('withWhyThemClause / whyThemRejection — the admin path');

eq('a bare fact gains the clause', withWhyThemClause('You ran distribution for Sysco for six years'), `You ran distribution for Sysco for six years${WHY_THEM_CLAUSE}`);
eq('a trailing full stop is replaced by the clause', withWhyThemClause('You ran distribution for Sysco for six years.'), `You ran distribution for Sysco for six years${WHY_THEM_CLAUSE}`);
eq('a line that already ends with the clause is unchanged', withWhyThemClause(GOOD_LINE), GOOD_LINE);
eq('a straight-quote clause is normalised to the rubric spelling',
  withWhyThemClause("You ran distribution for Sysco, so I think youd be a great fit for my client"),
  `You ran distribution for Sysco${WHY_THEM_CLAUSE}`);
eq('whitespace is collapsed', withWhyThemClause('  You   ran  distribution  '), `You ran distribution${WHY_THEM_CLAUSE}`);
eq('empty stays empty', withWhyThemClause('   '), '');

eq('rejection: clean', whyThemRejection(GOOD_LINE), null);
eq('rejection: not second person', whyThemRejection("Ran distribution for Sysco, so I think you'd be a great fit for my client."), 'not_second_person');
eq('rejection: staff may skip second person', whyThemRejection("Ran distribution for Sysco, so I think you'd be a great fit for my client.", { requireSecondPerson: false }), null);
eq('rejection: missing clause', whyThemRejection('You ran distribution for Sysco.'), 'missing_clause');
eq('rejection: em dash', whyThemRejection("You ran — distribution for Sysco, so I think you'd be a great fit for my client."), 'rubric');
eq('rejection: banned phrase', whyThemRejection("You have insights on Sysco, so I think you'd be a great fit for my client."), 'rubric');
eq('rejection: url', whyThemRejection("You ran https://sysco.com, so I think you'd be a great fit for my client."), 'url');
eq('rejection: money', whyThemRejection("You ran a $2B unit at Sysco, so I think you'd be a great fit for my client."), 'money');
eq('rejection: too long', whyThemRejection(`You ${'ran '.repeat(40)}, so I think you'd be a great fit for my client.`), 'too_long');
eq('rejection: empty', whyThemRejection(''), 'empty');

run().then(() => summary());
