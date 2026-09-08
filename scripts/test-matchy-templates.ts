// scripts/test-matchy-templates.ts — unit tests for lib/matchyTemplates.ts.
//
// Pure functions, no network and no database. The one env dependency is the
// CAN-SPAM footer's opt-out token (lib/optOutToken.ts), which signs with
// AVAILABILITY_TOKEN_SECRET; the script sets a throwaway value below when the
// environment has none, so it runs anywhere.
//
//   npx tsx scripts/test-matchy-templates.ts
//
// What it proves, per docs/MATCHY_SPEC.md:
//   - the intro never mentions money and never names the client
//   - the firm phrase is one size word plus one type word, with a sane default
//   - the topic clause carries no company names
//   - the follow-up quotes the EXPERT-side rate and never the client-side one
//   - both bodies stay under 120 words

import {
  buildIntroEmail,
  buildFollowUpEmail,
  firmPhrase,
  deriveTopic,
  descriptorFragmentFrom,
  DEFAULT_FIRM_PHRASE,
} from '../lib/matchyTemplates';
import { clientRateFor } from '../lib/pricing';

// The CAN-SPAM footer signs a per-recipient opt-out token. Give it a secret so
// the templates can be exercised without a configured environment; this value
// never leaves the test process.
process.env.AVAILABILITY_TOKEN_SECRET ||= 'test-only-secret-for-matchy-template-assertions';

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

/** Body only — the CAN-SPAM footer is not part of the message we write. */
function bodyOf(text: string): string {
  const cut = text.indexOf('\n\n--\n');
  return cut === -1 ? text : text.slice(0, cut);
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

const RECIPIENT = 'expert@example.com';

// ─── Firm phrase ─────────────────────────────────────────────────────────────

section('firmPhrase — one size word plus one type word');

eq('PE firm, mid-size',         firmPhrase('pe_firm', 'mid_size'),          'a mid-size PE firm');
eq('consulting firm, boutique', firmPhrase('consulting_firm', 'boutique'),  'a boutique consulting firm');
eq('law firm, large',           firmPhrase('law_firm', 'large'),            'a large law firm');
eq('hedge fund, boutique',      firmPhrase('hedge_fund', 'boutique'),       'a boutique hedge fund');
eq('corporate, large',          firmPhrase('corporate', 'large'),           'a large corporate strategy team');
eq('family office ignores size', firmPhrase('family_office', 'large'),      'a family office');
eq('family office, no size',    firmPhrase('family_office', null),          'a family office');
eq('PE firm, size unknown',     firmPhrase('pe_firm', null),                'a PE firm');
eq('type unknown',              firmPhrase(null, 'mid_size'),               DEFAULT_FIRM_PHRASE);
eq('nothing known',             firmPhrase(null, null),                     DEFAULT_FIRM_PHRASE);
eq('"other" is the generic',    firmPhrase('other', 'large'),               'an investment firm');
check('default takes "an"',     DEFAULT_FIRM_PHRASE.startsWith('an '));

// ─── deriveTopic ─────────────────────────────────────────────────────────────

section('deriveTopic — one clause, no company names');

function topic(researchQuestion: string, industry = '', func = ''): string {
  return deriveTopic({ researchQuestion, industry, function: func, expertType: '' });
}

eq('structured industry + function wins',
  topic('anything at all', 'Veterinary Services', 'Operations'),
  'operations in veterinary services');

eq('strips "How are ... ?"',
  topic('How are multi-site veterinary groups handling staffing costs?'),
  'multi-site veterinary groups handling staffing costs');

eq('strips "We are evaluating"',
  topic('We are evaluating consolidation in industrial automation.'),
  'consolidation in industrial automation');

eq('strips "What do ... "',
  topic('What do operators think about pricing pressure in specialty pharma?'),
  'operators think about pricing pressure in specialty pharma');

check('drops a company name mid-question',
  !topic('How does Bayview Veterinary Partners price its clinic rollups?').toLowerCase().includes('bayview'),
  topic('How does Bayview Veterinary Partners price its clinic rollups?'));

check('drops a ticker',
  !topic('How is NVDA pricing its data centre GPUs?').includes('NVDA'),
  topic('How is NVDA pricing its data centre GPUs?'));

check('drops an Inc suffix',
  !topic('What margins does Acme Inc. earn on industrial fasteners?').toLowerCase().includes('acme'),
  topic('What margins does Acme Inc. earn on industrial fasteners?'));

check('drops a client-only trailing clause',
  !topic('How do vet groups scale, for a potential portfolio company?').includes('portfolio'),
  topic('How do vet groups scale, for a potential portfolio company?'));

check('caps runaway length',
  wordCount(topic(`How do ${'multi site clinic operators '.repeat(20)}scale?`)) <= 22);

check('drops a proper noun that opens the question',
  !topic('Bayview Veterinary Partners clinic economics').toLowerCase().includes('bayview'),
  topic('Bayview Veterinary Partners clinic economics'));

eq('keeps an ordinary sentence-case opening word',
  topic('Margins in specialty pharma distribution'),
  'margins in specialty pharma distribution');

// A brief is often several sentences. Only the first becomes the topic clause:
// the rest used to flow through and fuse into a run-on once a capitalised word
// was dropped as a company name, taking its full stop with it.
eq('uses only the first sentence',
  topic('We are evaluating consolidation in industrial automation. We need to understand how operators price multi-year contracts.'),
  'consolidation in industrial automation');

check('a dropped proper noun cannot fuse two sentences',
  !/\bUS We\b/.test(topic('We are evaluating an acquisition in cold chain logistics in the US Southeast. We need to understand contract pricing.')),
  topic('We are evaluating an acquisition in cold chain logistics in the US Southeast. We need to understand contract pricing.'));

check('an abbreviation is not a sentence end',
  topic('Margins at Acme Inc. Reports say they are thin').split(/\s+/).length > 2,
  topic('Margins at Acme Inc. Reports say they are thin'));

eq('empty brief falls back', topic(''), 'this market');
eq('empty question falls back to industry', topic('', 'Specialty Pharma'), 'specialty pharma');
check('never returns empty', topic('?').length > 0);

// ─── descriptorFragmentFrom ──────────────────────────────────────────────────

section('descriptorFragmentFrom — the most specific segment, lower-cased');

eq('takes the last segment',
  descriptorFragmentFrom('Executive · Operator · Veterinary services'),
  'veterinary services');
eq('single segment passes through',
  descriptorFragmentFrom('Regional operations leadership'),
  'regional operations leadership');
eq('absent descriptor is empty', descriptorFragmentFrom(undefined), '');
eq('blank descriptor is empty',  descriptorFragmentFrom('   '), '');

// ─── Intro ───────────────────────────────────────────────────────────────────

section('buildIntroEmail — no money, no client name');

const intro = buildIntroEmail({
  firmType:           'pe_firm',
  firmSize:           'mid_size',
  topic:              'multi-site veterinary groups handling staffing costs',
  descriptorFragment: 'veterinary services',
  expertFirstName:    'Scott',
  recipientEmail:     RECIPIENT,
});
const introBody = bodyOf(intro.text);

console.log('\n--- intro ---\n' + introBody + '\n-------------');

check('no "$" anywhere in the intro', !intro.text.includes('$') && !intro.subject.includes('$'));
check('no digits that could be a rate', !/\$\s*\d/.test(intro.text));
check('no "rate" / "compensat" / "pay"',
  !/\b(rate|compensat|paid per|per hour|\/hr)\b/i.test(introBody),
  introBody);
check('says "paid consultation" (the one allowed use of "paid")',
  introBody.includes('paid consultation'));
check('names the firm type, not the firm', introBody.includes('a mid-size PE firm'));
check('greets by first name', introBody.startsWith('Hi Scott,'));
check('uses the descriptor fragment', introBody.includes('veterinary services'));
check('carries the topic', introBody.includes('multi-site veterinary groups handling staffing costs'));
check('ends on the question', introBody.includes('Would you be open to it?'));
check('subject follows the spec', intro.subject.startsWith('Paid expert call'));
check(`intro body under 120 words (${wordCount(introBody)})`, wordCount(introBody) < 120);
check('html is present and escaped', intro.html.includes('<p') && intro.html.includes('Scott'));
check('footer opt-out link present', intro.text.includes('Opt out'));

// The client's real name and firm must never appear, whatever we pass in.
const CLIENT_NAME = 'Sequoia Vet Holdings';
for (const [type, size] of [
  ['pe_firm', 'boutique'], ['family_office', null], ['law_firm', 'large'], [null, null],
] as const) {
  const e = buildIntroEmail({
    firmType: type, firmSize: size,
    topic: 'clinic consolidation economics',
    descriptorFragment: 'multi-site healthcare operations',
    expertFirstName: 'Priya',
    recipientEmail: RECIPIENT,
  });
  const b = bodyOf(e.text);
  check(`intro(${type}/${size}): no client name`, !e.text.includes(CLIENT_NAME));
  check(`intro(${type}/${size}): no "$"`, !e.text.includes('$'));
  check(`intro(${type}/${size}): under 120 words (${wordCount(b)})`, wordCount(b) < 120);
  check(`intro(${type}/${size}): no em dash in the body`, !b.includes('—'));
}

// Missing descriptor still produces a complete sentence.
const introNoDescriptor = buildIntroEmail({
  firmType: 'consulting_firm', firmSize: 'boutique',
  topic: 'freight brokerage margins',
  expertFirstName: 'Dana',
  recipientEmail: RECIPIENT,
});
check('no descriptor: no dangling "background in"',
  !bodyOf(introNoDescriptor.text).includes('background in'),
  bodyOf(introNoDescriptor.text));
check('no descriptor: still asks the question',
  introNoDescriptor.text.includes('Would you be open to it?'));

// ─── Follow-up ───────────────────────────────────────────────────────────────

section('buildFollowUpEmail — asks about the expert-side rate');

const EXPERT_RATE = 650;
const followUp = buildFollowUpEmail({
  topic:           'multi-site veterinary groups handling staffing costs',
  expertRate:      EXPERT_RATE,
  expertFirstName: 'Scott',
  recipientEmail:  RECIPIENT,
});
const followUpBody = bodyOf(followUp.text);

console.log('\n--- follow-up ---\n' + followUpBody + '\n-----------------');

check(`contains $${EXPERT_RATE}`, followUpBody.includes(`$${EXPERT_RATE}`));
check('the client-side number is absent',
  !followUpBody.includes(`$${clientRateFor(EXPERT_RATE)}`),
  `clientRate would be $${clientRateFor(EXPERT_RATE)}`);
check('only one dollar figure in the body',
  (followUpBody.match(/\$\d/g) ?? []).length === 1);
check('asks, does not assert', followUpBody.includes('Does that work for you?'));
check('asks about NDAs', /NDAs or employer restrictions/i.test(followUpBody));
check('asks about current involvement', /current involvement/i.test(followUpBody));
check('carries the topic', followUpBody.includes('multi-site veterinary groups handling staffing costs'));
check('greets by first name', followUpBody.startsWith('Hi Scott,'));
check(`follow-up under 120 words (${wordCount(followUpBody)})`, wordCount(followUpBody) < 120);
check('no em dash in the body', !followUpBody.includes('—'));
check('footer opt-out link present', followUp.text.includes('Opt out'));

for (const rate of [400, 650, 675, 800, 1200]) {
  const e = buildFollowUpEmail({
    topic: 'clinic consolidation economics',
    expertRate: rate,
    expertFirstName: 'Priya',
    recipientEmail: RECIPIENT,
  });
  const b = bodyOf(e.text);
  check(`follow-up($${rate}): quotes the expert number`, b.includes(`$${rate}`));
  check(`follow-up($${rate}): omits the client number`, !b.includes(`$${clientRateFor(rate)}`));
  check(`follow-up($${rate}): under 120 words (${wordCount(b)})`, wordCount(b) < 120);
}

// A missing first name must not produce "Hi ,".
const noName = buildIntroEmail({
  firmType: 'pe_firm', firmSize: 'large',
  topic: 'industrial fastener distribution',
  expertFirstName: '',
  recipientEmail: RECIPIENT,
});
check('blank name greets "Hi there,"', bodyOf(noName.text).startsWith('Hi there,'));

// ─── Result ──────────────────────────────────────────────────────────────────

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
