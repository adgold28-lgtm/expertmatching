// scripts/test-matchy-templates.ts — unit tests for lib/matchyTemplates.ts.
//
// Pure functions, no network and no database. The one env dependency is the
// CAN-SPAM footer's opt-out token (lib/optOutToken.ts), which signs with
// AVAILABILITY_TOKEN_SECRET; the script sets a throwaway value below when the
// environment has none, so it runs anywhere.
//
//   npx tsx scripts/test-matchy-templates.ts
//
// What it proves:
//   - the intro follows docs/OUTREACH_EMAIL_RUBRIC.md in all four trial arms:
//     subject format, price in the subject only for arms 1 and 3, "Dear
//     {First}," the why-them line first, the money sentence in every arm
//     (hourly for 1/2, flat for 3/4), the scope clause verbatim, the closing
//     question, zero em dashes, under 90 words, no banned phrase or word,
//     signed "Asher" over a real signature block
//   - introArmFor is deterministic, covers all four arms, and INTRO_ARM pins it
//   - the intro never names the client (docs/MATCHY_SPEC.md)
//   - the firm phrase is one size word plus one type word, with a sane default
//   - the topic clause carries no company names
//   - the follow-up quotes the EXPERT-side rate and never the client-side one

import {
  buildIntroEmail,
  buildFollowUpEmail,
  firmPhrase,
  deriveTopic,
  descriptorFragmentFrom,
  introArmFor,
  introRubricViolation,
  IntroRubricError,
  INTRO_ARMS,
  INTRO_BANNED_PHRASES,
  INTRO_BANNED_WORDS,
  INTRO_SCOPE_CLAUSE,
  INTRO_QUESTION,
  DEFAULT_FIRM_PHRASE,
} from '../lib/matchyTemplates';
import { clientRateFor } from '../lib/pricing';
import type { IntroArm } from '../types';

// The CAN-SPAM footer signs a per-recipient opt-out token. Give it a secret so
// the templates can be exercised without a configured environment; this value
// never leaves the test process.
process.env.AVAILABILITY_TOKEN_SECRET ||= 'test-only-secret-for-matchy-template-assertions';

// The intro's signature block reads the sender env. Start from a known state:
// no sign-off configured (the rubric says it is "Asher" regardless), a From
// address on the verified domain, no LinkedIn, no pinned arm.
delete process.env.OUTREACH_SIGNATURE;
delete process.env.OUTREACH_LINKEDIN_URL;
delete process.env.INTRO_ARM;
process.env.OUTREACH_FROM_EMAIL = 'Asher Goldstein <asher@expertmatch.fit>';

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

// ─── Client identity: the deny list and the sentence-start rule ──────────────
// A client's own firm, a target, a lowercase brand, a possessive, a title — none
// of it may reach an expert. lib/matchyTemplates.deriveTopic is deterministic;
// these are the shapes the 2026-09-08 audit found leaking.

function topicWithDeny(researchQuestion: string, extra: Record<string, string> = {}, deny: string[] = []): string {
  return deriveTopic({ researchQuestion, industry: '', function: '', expertType: '', ...extra }, { denyTerms: deny });
}

check('client firm named in the question is removed (deny list)',
  !topicWithDeny('Commercial diligence for Blackstone', {}, ['Blackstone']).toLowerCase().includes('blackstone'),
  topicWithDeny('Commercial diligence for Blackstone', {}, ['Blackstone']));

check('client firm named in the question is removed even without a deny list (sentence-internal capital)',
  !topicWithDeny('Commercial diligence for Blackstone').toLowerCase().includes('blackstone'),
  topicWithDeny('Commercial diligence for Blackstone'));

check('no dangling preposition is left where the name was',
  !/\b(for|at|in|of|and)$/.test(topicWithDeny('Commercial diligence for Blackstone')),
  topicWithDeny('Commercial diligence for Blackstone'));

check('structured industry/function path is filtered too',
  !topicWithDeny('anything', { industry: 'Acme Corp veterinary roll-up', function: 'Commercial diligence for Blackstone' })
    .toLowerCase().match(/acme|blackstone/),
  topicWithDeny('anything', { industry: 'Acme Corp veterinary roll-up', function: 'Commercial diligence for Blackstone' }));

check('sentence-initial company name is dropped',
  !topicWithDeny('Zoetis pricing power in companion animal diagnostics').toLowerCase().includes('zoetis'),
  topicWithDeny('Zoetis pricing power in companion animal diagnostics'));

check('possessive company name is dropped',
  !topicWithDeny("Zoetis's pricing power in companion animal diagnostics").toLowerCase().includes('zoetis'),
  topicWithDeny("Zoetis's pricing power in companion animal diagnostics"));

check('lowercase company names are removed when the brief lists them as targets',
  !topicWithDeny('Understand margins at chewy and petco', { targetCompanies: 'Chewy, Petco' }).toLowerCase().match(/chewy|petco/),
  topicWithDeny('Understand margins at chewy and petco', { targetCompanies: 'Chewy, Petco' }));

check('a target named in the project TITLE is removed from the topic',
  !topicWithDeny('Pricing dynamics in cold chain logistics at Lineage', { name: 'Lineage diligence' }).toLowerCase().includes('lineage'),
  topicWithDeny('Pricing dynamics in cold chain logistics at Lineage', { name: 'Lineage diligence' }));

check('the owner email domain label is a deny term',
  !topicWithDeny('How is blackstone thinking about cold storage?', { firmDomain: 'blackstone.com' }).toLowerCase().includes('blackstone'),
  topicWithDeny('How is blackstone thinking about cold storage?', { firmDomain: 'blackstone.com' }));

check('a lowercase deny term matches whatever the case in the brief',
  !topicWithDeny('How is KKR thinking about cold storage consolidation?', {}, ['kkr']).toLowerCase().includes('kkr'),
  topicWithDeny('How is KKR thinking about cold storage consolidation?', {}, ['kkr']));

check('multi-sentence brief: only the first sentence, names removed',
  (() => {
    const t = topicWithDeny('Acme Corp is exploring cold storage. Blackstone wants to know pricing. We need contract terms.', {}, ['Acme Corp']);
    return !t.toLowerCase().match(/acme|blackstone/) && !t.toLowerCase().includes('contract terms');
  })(),
  topicWithDeny('Acme Corp is exploring cold storage. Blackstone wants to know pricing. We need contract terms.', {}, ['Acme Corp']));

eq('ordinary opening words survive the sentence-start rule',
  topicWithDeny('Pricing dynamics in cold chain logistics'),
  'pricing dynamics in cold chain logistics');

check('the topic still describes the subject after a name is removed',
  topicWithDeny('Zoetis pricing power in companion animal diagnostics').includes('companion animal diagnostics'),
  topicWithDeny('Zoetis pricing power in companion animal diagnostics'));

check('never empty — falls back rather than returning nothing',
  topicWithDeny('Blackstone', {}, ['Blackstone']).length > 0,
  topicWithDeny('Blackstone', {}, ['Blackstone']));

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

section('buildIntroEmail — the rubric, in all four arms');

const WHY_THEM = "You ran distribution in the Southeast for Sysco for six years, so I think you'd be a great fit for my client.";
const DOMAIN   = 'cold-chain distribution';
const RATE     = 800;
const ARMS: readonly IntroArm[] = [1, 2, 3, 4];

function introFor(arm: IntroArm, overrides: Partial<Parameters<typeof buildIntroEmail>[0]> = {}) {
  return buildIntroEmail({
    arm,
    domain:          DOMAIN,
    whyThem:         WHY_THEM,
    firmType:        'pe_firm',
    firmSize:        null,
    topic:           'cold-chain economics',
    expertRate:      RATE,
    expertFirstName: 'Scott',
    recipientEmail:  RECIPIENT,
    ...overrides,
  });
}

/** The body up to (not including) the sign-off — the part the 90-word rule covers. */
function bodyBeforeSignOff(text: string): string {
  const body = bodyOf(text);
  const cut  = body.lastIndexOf('\n\nAsher');
  return cut === -1 ? body : body.slice(0, cut);
}

const SUBJECT_RE: Record<IntroArm, RegExp> = {
  1: /^Expert in cold-chain distribution: compensated \$800\/hr for your time\?$/,
  2: /^Expert in cold-chain distribution: a paid call for my client\?$/,
  3: /^Expert in cold-chain distribution: \$800 for up to an hour of your time\?$/,
  4: /^Expert in cold-chain distribution: a paid call for my client\?$/,
};

const HOURLY_MONEY = `they want to compensate you $${RATE}/hr for 15 to 60 minutes of your time.`;
const FLAT_MONEY   = `they want to pay you $${RATE} for up to an hour, even if we only need 20 minutes.`;

for (const arm of ARMS) {
  const e    = introFor(arm);
  const body = bodyBeforeSignOff(e.text);
  const full = bodyOf(e.text);
  const spec = INTRO_ARMS[arm];

  if (arm === 1 || arm === 3) console.log(`\n--- intro, arm ${arm} ---\nSubject: ${e.subject}\n\n${full}\n-------------`);

  check(`arm ${arm}: subject format`, SUBJECT_RE[arm].test(e.subject), e.subject);
  eq(`arm ${arm}: price in subject only for arms 1 and 3`, e.subject.includes('$'), spec.priceInSubject);
  check(`arm ${arm}: subject uses a colon, never an em dash`, e.subject.includes(':') && !e.subject.includes('—'));
  check(`arm ${arm}: opens "Dear Scott,"`, body.startsWith('Dear Scott,\n\n'));
  check(`arm ${arm}: why-them line comes first`, body.split('\n\n')[1] === WHY_THEM, body.split('\n\n')[1]);
  check(`arm ${arm}: money sentence present (${spec.framing})`,
    body.includes(spec.framing === 'hourly' ? HOURLY_MONEY : FLAT_MONEY), body);
  check(`arm ${arm}: exactly one dollar figure in the body`, (body.match(/\$\d/g) ?? []).length === 1);
  check(`arm ${arm}: the client number is absent`, !e.text.includes(`$${clientRateFor(RATE)}`));
  check(`arm ${arm}: names the firm type`, body.includes('They are a PE firm looking to understand cold-chain economics, and'));
  check(`arm ${arm}: scope clause verbatim`, body.includes(INTRO_SCOPE_CLAUSE));
  check(`arm ${arm}: ends on the question`, body.endsWith(INTRO_QUESTION));
  check(`arm ${arm}: zero em dashes in subject and body`, !e.subject.includes('—') && !full.includes('—'));
  check(`arm ${arm}: body under 90 words (${wordCount(body)})`, wordCount(body) < 90);
  for (const { label, pattern } of INTRO_BANNED_PHRASES) {
    check(`arm ${arm}: banned phrase absent: ${label}`, !pattern.test(e.subject) && !pattern.test(full));
  }
  for (const { label, pattern } of INTRO_BANNED_WORDS) {
    check(`arm ${arm}: banned word absent: ${label}`, !pattern.test(e.subject) && !pattern.test(full));
  }
  check(`arm ${arm}: none of secrets / NDA / confidential / compliance`,
    !/\b(secrets?|NDAs?|confidential|compliance)\b/i.test(e.subject + ' ' + full));
  check(`arm ${arm}: contractions as written`, full.includes("wouldn't") && full.includes("you'd"));
  check(`arm ${arm}: no scheduling link, agreement or payment mechanics`,
    !/\b(calendly|zoom|agreement|invoice|stripe|payment)\b/i.test(full));
  check(`arm ${arm}: signs off "Asher" on its own line`, /\n\nAsher\n/.test(full), full);
  check(`arm ${arm}: signature block carries the From address`, full.includes('\nAsher Goldstein\nasher@expertmatch.fit'));
  check(`arm ${arm}: no LinkedIn line when OUTREACH_LINKEDIN_URL is unset`, !/linkedin/i.test(full));
  check(`arm ${arm}: footer opt-out link present`, e.text.includes('Opt out'));
  check(`arm ${arm}: html carries the body and the block`, e.html.includes('Dear Scott,') && e.html.includes('asher@expertmatch.fit'));
}

// The signature block with a LinkedIn URL configured.
process.env.OUTREACH_LINKEDIN_URL = 'https://www.linkedin.com/in/ashergoldstein/';
const withLinkedIn = bodyOf(introFor(1).text);
check('LinkedIn line present when OUTREACH_LINKEDIN_URL is set',
  withLinkedIn.endsWith('\nAsher\nAsher Goldstein\nasher@expertmatch.fit\nhttps://www.linkedin.com/in/ashergoldstein'),
  withLinkedIn.slice(-140));
check('LinkedIn is a real link in the html', introFor(1).html.includes('href="https://www.linkedin.com/in/ashergoldstein"'));
process.env.OUTREACH_LINKEDIN_URL = 'https://evil.example/phish';
check('a non-LinkedIn URL is dropped, not mailed', !bodyOf(introFor(1).text).includes('evil.example'));
delete process.env.OUTREACH_LINKEDIN_URL;

// A configured multi-line signature still signs with the first name only.
process.env.OUTREACH_SIGNATURE = 'Asher Goldstein\nExpertMatch';
check('multi-line OUTREACH_SIGNATURE still signs "Asher"', /\n\nAsher\nAsher Goldstein\n/.test(bodyOf(introFor(2).text)));
delete process.env.OUTREACH_SIGNATURE;

// Every firm type reads right and never carries the client's name.
const CLIENT_NAME = 'Sequoia Vet Holdings';
for (const [type, size] of [
  ['pe_firm', 'boutique'], ['family_office', null], ['law_firm', 'large'], ['consulting_firm', 'mid_size'], [null, null],
] as const) {
  const e = introFor(2, { firmType: type, firmSize: size, topic: 'clinic consolidation economics' });
  const b = bodyBeforeSignOff(e.text);
  check(`intro(${type}/${size}): no client name`, !e.text.includes(CLIENT_NAME));
  check(`intro(${type}/${size}): under 90 words (${wordCount(b)})`, wordCount(b) < 90);
  check(`intro(${type}/${size}): says "They are ${firmPhrase(type, size)}"`, b.includes(`They are ${firmPhrase(type, size)} looking to understand`));
}

// The rate is whatever the engagement carries, whole dollars.
for (const rate of [400, 650, 675, 1200]) {
  const e = introFor(1, { expertRate: rate });
  check(`intro($${rate}): subject and body carry $${rate}`, e.subject.includes(`$${rate}/hr`) && bodyOf(e.text).includes(`$${rate}/hr`));
  check(`intro($${rate}): the client number is absent`, !e.text.includes(`$${clientRateFor(rate)}`));
}

// Enforced in code: a long topic is trimmed to keep the body under 90 words.
const longTopic = introFor(1, { topic: 'how multi-site veterinary consolidators price and staff their clinics across the US Southeast and Midwest markets today' });
check(`runaway topic still under 90 words (${wordCount(bodyBeforeSignOff(longTopic.text))})`,
  wordCount(bodyBeforeSignOff(longTopic.text)) < 90);
check('trimmed topic does not end on a preposition', !/\b(in|for|at|of|and|across)\b, and they want/.test(bodyOf(longTopic.text)));

// Enforced in code: a hard-rule violation throws rather than sends.
function throws(fn: () => unknown): string {
  try { fn(); return ''; } catch (err) { return err instanceof IntroRubricError ? err.rule : `other: ${String(err)}`; }
}
check('em dash in the why-them line throws',
  throws(() => introFor(1, { whyThem: "You ran Sysco's Southeast distribution — for six years, so I think you'd be a great fit for my client." })) === 'em dash');
check('banned phrase in the why-them line throws',
  throws(() => introFor(1, { whyThem: "You built real insights into cold-chain pricing at Sysco, so I think you'd be a great fit for my client." })).startsWith('banned phrase'));
check('banned word in the topic throws',
  throws(() => introFor(1, { topic: 'compliance costs in cold storage' })).startsWith('banned word'));
check('em dash in the domain throws', throws(() => introFor(1, { domain: 'cold-chain — distribution' })) === 'em dash');
check('missing rate throws', throws(() => introFor(1, { expertRate: 0 })) === 'no expert rate');
check('blank why-them throws', throws(() => introFor(1, { whyThem: '   ' })) === 'no why-them line');
check('a why-them line that is itself too long throws',
  throws(() => introFor(1, { whyThem: `You ${'ran a very large regional distribution business '.repeat(9)}, so I think you'd be a great fit for my client.` })) === 'body over 90 words');
check('a missing first name greets "Dear there,"', bodyOf(introFor(1, { expertFirstName: '' }).text).startsWith('Dear there,'));
check('a why-them line without a full stop gains one',
  bodyOf(introFor(1, { whyThem: "You ran distribution for Sysco for six years, so I think you'd be a great fit for my client" }).text).includes('my client.\n\nThey are'));

// introRubricViolation — the lint the send path relies on.
eq('lint: clean text passes', introRubricViolation('You ran distribution for Sysco.'), null);
eq('lint: em dash', introRubricViolation('You ran — distribution.'), 'em dash');
eq('lint: double hyphen counts as an em dash', introRubricViolation('You ran -- distribution.'), 'em dash');
check('lint: "reaching out"', introRubricViolation('I am reaching out about a call.')?.startsWith('banned phrase') === true);
check('lint: "the fintech space"', introRubricViolation('You know the fintech space.')?.startsWith('banned phrase') === true);
check('lint: "insights"', introRubricViolation('You have insights.')?.startsWith('banned phrase') === true);
check('lint: a list of three', introRubricViolation('You ran sales, marketing, and operations.')?.startsWith('banned phrase') === true);
check('lint: "NDA"', introRubricViolation('No NDA needed.')?.startsWith('banned word') === true);
check('lint: "confidential"', introRubricViolation('Nothing confidential.')?.startsWith('banned word') === true);
eq('lint: "15 to 60 minutes" is not a list', introRubricViolation('for 15 to 60 minutes of your time'), null);

// ─── introArmFor ─────────────────────────────────────────────────────────────

section('introArmFor — deterministic, covers all four arms, INTRO_ARM pins');

const ids = Array.from({ length: 200 }, (_, i) => `expert-${i}-${(i * 7919).toString(16)}`);
const seen = new Set<IntroArm>();
let stable = true;
for (const id of ids) {
  const arm = introArmFor(id);
  seen.add(arm);
  if (introArmFor(id) !== arm) stable = false;
  if (!ARMS.includes(arm)) stable = false;
}
check('every id maps to the same arm twice', stable);
check(`all four arms appear over 200 ids (${Array.from(seen).sort().join(',')})`, seen.size === 4);
check('INTRO_ARMS names the price-in-subject arms', INTRO_ARMS[1].priceInSubject && INTRO_ARMS[3].priceInSubject && !INTRO_ARMS[2].priceInSubject && !INTRO_ARMS[4].priceInSubject);
check('INTRO_ARMS names the flat arms', INTRO_ARMS[3].framing === 'flat' && INTRO_ARMS[4].framing === 'flat' && INTRO_ARMS[1].framing === 'hourly' && INTRO_ARMS[2].framing === 'hourly');

for (const pin of ARMS) {
  process.env.INTRO_ARM = String(pin);
  check(`INTRO_ARM=${pin} pins every id`, ids.every(id => introArmFor(id) === pin));
}
process.env.INTRO_ARM = '7';
check('an out-of-range INTRO_ARM is ignored', new Set(ids.map(introArmFor)).size === 4);
delete process.env.INTRO_ARM;

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

// ─── Result ──────────────────────────────────────────────────────────────────

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
