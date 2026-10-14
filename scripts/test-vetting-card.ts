// scripts/test-vetting-card.ts — the vetting card (lib/vettingCard.ts).
//
//   npx tsx scripts/test-vetting-card.ts
//
// Pure: no network, no database, no env vars. What it proves:
//   bands        the tenure and since-left edges, in words
//   phrasings    tenure and departure read deterministically from the title
//                and role claims, across the shapes sourcing writes ("2015-2021",
//                "2018 to present", "since 2019", "for six years", "former",
//                "ex-", month ranges, decades, months)
//   omission     an achievement window, an attributive range, industry
//                experience, a prior role, a publication or a future year
//                yields NO band: the card says "Not in public records"
//   departure    a year-only end date is read as December, the safe direction
//   levels       a level from the title, never the title
//   employer     the kind of organization from the anonymized descriptor, or
//                the sourcing category; never a name
//   conflicts    not asked / waiting / answered, flagged or not, from the
//                fields the inbound pipeline writes; a note that names anyone,
//                carries a figure or an unknown proper noun is dropped
//   the wall     across every fixture and status: no digit, no company, no
//                person's name anywhere in the card

import { deriveVetting, tenureBand, sinceLeftBand, conflictLine } from '../lib/vettingCard';
import type { EvidenceItem, Expert, ExpertStatus, ExpertVetting, ProjectExpert } from '../types';
import { check, eq, summary } from './testHarness';

function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

// Wednesday 14 October 2026, noon UTC.
const NOW = Date.UTC(2026, 9, 14, 12);

const NAME    = 'Scott Smithers';
const COMPANY = 'Bayview Veterinary Partners';

function claims(...texts: string[]): EvidenceItem[] {
  return texts.map((claim, i) => ({ id: `ev-${i + 1}`, sourceLabel: 'Source', claim, relevance: 'Relevant.' }));
}

function expert(over: Partial<Expert> = {}): Expert {
  return {
    id: 'exp-1', name: NAME, title: '', company: COMPANY, location: 'Austin, TX, US',
    category: 'Operator', justification: '', relevance_score: 80,
    source_url: '', source_label: '', source_links: [],
    valueChainLabel: 'Veterinary services', seniorityTier: 'executive',
    ...over,
  };
}

function pe(over: Partial<Expert> = {}, extra: Partial<ProjectExpert> = {}): ProjectExpert {
  return { expert: expert(over), status: 'contacted', addedAt: 1, updatedAt: 2, ...extra };
}

function vet(over: Partial<Expert> = {}, extra: Partial<ProjectExpert> = {}): ExpertVetting {
  return deriveVetting(pe(over, extra), NOW);
}

/** Every string the card carries, joined: what the wall checks run over. */
function cardText(v: ExpertVetting): string {
  return [
    v.roleLevel, v.employerType, v.employment, v.tenure, v.sinceLeft,
    v.conflict.status, v.conflict.summary, v.conflict.risk, conflictLine(v.conflict),
  ].filter(Boolean).join(' | ');
}

const ALL_CARDS: ExpertVetting[] = [];
function track(v: ExpertVetting): ExpertVetting { ALL_CARDS.push(v); return v; }

// ─── Bands ────────────────────────────────────────────────────────────────────

section('tenure band edges');
eq('zero years → under a year',        tenureBand(0),     'under a year');
eq('eleven months → under a year',     tenureBand(11 / 12), 'under a year');
eq('one year → one to three',          tenureBand(1),     'one to three years');
eq('two and a half → one to three',    tenureBand(2.5),   'one to three years');
eq('three → three to ten',             tenureBand(3),     'three to ten years');
eq('ten → three to ten',               tenureBand(10),    'three to ten years');
eq('just over ten → over ten',         tenureBand(10.01), 'over ten years');
eq('negative → no band',               tenureBand(-1),    null);
eq('absurd → no band',                 tenureBand(90),    null);
eq('NaN → no band',                    tenureBand(Number.NaN), null);

section('since-left band edges');
eq('zero months → within the last year', sinceLeftBand(0),  'left within the last year');
eq('eleven months → within the last year', sinceLeftBand(11), 'left within the last year');
eq('twelve months → one to three',       sinceLeftBand(12), 'one to three years ago');
eq('thirty-six → one to three',          sinceLeftBand(36), 'one to three years ago');
eq('thirty-seven → more than three',     sinceLeftBand(37), 'more than three years ago');
eq('negative → no band',                 sinceLeftBand(-3), null);

// ─── Tenure phrasings ─────────────────────────────────────────────────────────

section('tenure: ranges inside one sentence');
const TENURE_CASES: Array<[string, Partial<Expert>, ExpertVetting['tenure']]> = [
  ['"from 2015 to 2021" in a served claim',
    { title: 'Former President & CEO', evidenceItems: claims('Served as CEO of Bayview from 2015 to 2021.') }, 'three to ten years'],
  ['"(2015-2021)" in the title',              { title: 'VP Operations (2015-2021)' }, 'three to ten years'],
  ['en dash "2015\u20132021"',                { title: 'VP Operations, 2015\u20132021' }, 'three to ten years'],
  ['spaced "2015 - 2021"',                    { title: 'VP Operations 2015 - 2021' }, 'three to ten years'],
  ['short "2015-21"',                          { title: 'VP Operations (2015-21)' }, 'three to ten years'],
  ['"between 2015 and 2021"',
    { title: 'Director', evidenceItems: claims('Worked at Bayview between 2015 and 2021, running procurement.') }, 'three to ten years'],
  ['"2020-2021" is one year',                  { title: 'Manager (2020-2021)' }, 'one to three years'],
  ['"2021-2021" is under a year',              { title: 'Manager (2021-2021)' }, 'under a year'],
  ['"March 2019 to June 2025" by month',
    { title: 'SVP Supply Chain', evidenceItems: claims('Held the SVP role from March 2019 to June 2025.') }, 'three to ten years'],
  ['"Jan 2026 - Present" is under a year',
    { title: 'Head of Pricing', evidenceItems: claims('Has served as head of pricing at Bayview from Jan 2026 - Present.') }, 'under a year'],
  ['"2018 to present" is eight years',
    { title: 'COO', evidenceItems: claims('Serving as COO at Bayview from 2018 to present.') }, 'three to ten years'],
  ['"2024 to present" is two years',
    { title: 'COO', evidenceItems: claims('Serving as COO from 2024 to present, overseeing all clinics.') }, 'one to three years'],
  ['"2000-2014" is over ten',                  { title: 'Former Regional VP (2000-2014)' }, 'over ten years'],
];
for (const [label, over, expected] of TENURE_CASES) eq(label, track(vet(over)).tenure, expected);

section('tenure: a start with no end');
eq('"since 2019", not former → seven years',
  track(vet({ title: 'VP Operations', evidenceItems: claims('Has served as VP Operations at Bayview since 2019.') })).tenure,
  'three to ten years');
eq('"since 2025" → one year',
  track(vet({ title: 'Director', evidenceItems: claims('Has led the clinic network at Bayview since 2025.') })).tenure,
  'one to three years');
eq('"joined in 2015" plus "left in 2017" in another sentence → two years',
  track(vet({ title: 'Former VP', evidenceItems: claims('Joined Bayview in 2015.', 'Left Bayview in 2017 to found a startup.') })).tenure,
  'one to three years');

section('tenure: a stated duration');
const DURATION_CASES: Array<[string, string, ExpertVetting['tenure']]> = [
  ['"for six years"',                 'Ran distribution in the Southeast for Sysco for six years.', 'three to ten years'],
  ['"for 6 years"',                   'Ran distribution for Bayview for 6 years.',                 'three to ten years'],
  ['"for 6+ years"',                  'Managed procurement at Bayview for 6+ years.',              'three to ten years'],
  ['"over a decade at"',              'Spent over a decade at Bayview running clinics.',           'over ten years'],
  ['"more than a decade in role"',    'Led the clinic group, more than a decade in role.',         'over ten years'],
  ['"nearly a decade"',               'Ran the southern region for nearly a decade.',              'three to ten years'],
  ['"for two decades"',               'Ran clinics at Bayview for two decades.',                   'over ten years'],
  ['"a decade-long tenure"',          'Led pricing in a decade-long tenure at Bayview.',           'three to ten years'],
  ['"a 12-year tenure"',              'Held the COO seat in a 12-year tenure.',                    'over ten years'],
  ['"eighteen months as"',            'Served eighteen months as interim CFO.',                     'one to three years'],
  ['"for 8 months"',                  'Served as interim CEO for 8 months.',                       'under a year'],
  ['"for just under three years"',    'Ran operations at Bayview for just under three years.',     'one to three years'],
  ['"more than three years as"',      'Spent more than three years as head of procurement.',       'three to ten years'],
  ['"for a couple of years"',         'Ran the pharmacy line at Bayview for a couple of years.',   'one to three years'],
  ['"for half a decade"',             'Led clinic expansion at Bayview for half a decade.',        'three to ten years'],
];
for (const [label, claim, expected] of DURATION_CASES) {
  eq(label, track(vet({ title: 'Former VP Operations', evidenceItems: claims(claim) })).tenure, expected);
}

// ─── Omission ─────────────────────────────────────────────────────────────────

section('omission: the record does not support a band');
const BARE = track(vet({ title: 'VP Operations' }));
eq('no dates anywhere → no tenure',          BARE.tenure, null);
eq('no dates anywhere → no departure band',  BARE.sinceLeft, null);
eq('no marker anywhere → status unknown',    BARE.employment, null);

const OMIT_CASES: Array<[string, Partial<Expert>]> = [
  ['an achievement window ("grew revenue between 2015 and 2018")',
    { title: 'Director', evidenceItems: claims('Grew revenue threefold between 2015 and 2018.') }],
  ['an attributive range ("the 2018-2020 integration")',
    { title: 'Director', evidenceItems: claims('Led the 2018-2020 integration of two plants.') }],
  ['industry experience ("in the industry for 20 years")',
    { title: 'Director', evidenceItems: claims('Has worked in the industry for 20 years.') }],
  ['a career length ("a 25-year career")',
    { title: 'Director', evidenceItems: claims('Brings a 25-year career in animal health.') }],
  ['a prior role ("previously served ... from 2005 to 2010")',
    { title: 'Director', evidenceItems: claims('Previously served as CFO of a distributor from 2005 to 2010.') }],
  ['a publication claim with a range',
    { title: 'Director', evidenceItems: [{ ...claims('Served as a columnist from 2015 to 2021.')[0], evidenceType: 'publication' }] }],
  ['a future end year ("2015-2031")',          { title: 'VP Operations (2015-2031)' }],
  ['a lone year ("quoted in 2023")',
    { title: 'Director', evidenceItems: claims('Quoted in 2023 on cold-chain capacity at Bayview.') }],
  ['clinic counts are not years ("from 6 to 41 clinics")',
    { title: 'Director', evidenceItems: claims('Scaled Bayview from 6 to 41 clinics.') }],
];
for (const [label, over] of OMIT_CASES) {
  const v = track(vet(over));
  check(`${label} → no tenure`, v.tenure === null, JSON.stringify(v));
  check(`${label} → no departure band`, v.sinceLeft === null, JSON.stringify(v));
}

section('omission: former with no end date');
const formerNoEnd = track(vet({ title: 'Former VP Distribution', evidenceItems: claims('Ran distribution for Bayview for six years.') }));
eq('former is known',                     formerNoEnd.employment, 'former');
eq('the duration still gives a tenure',   formerNoEnd.tenure, 'three to ten years');
eq('but nothing says when they left',     formerNoEnd.sinceLeft, null);

// ─── Departure ────────────────────────────────────────────────────────────────

section('departure: current or former, and how long ago');
const DEPARTURE_CASES: Array<[string, Partial<Expert>, ExpertVetting['employment'], ExpertVetting['sinceLeft']]> = [
  ['ended 2021 → more than three years ago',  { title: 'VP Operations (2015-2021)' }, 'former', 'more than three years ago'],
  ['ended 2022 → more than three years ago',  { title: 'VP Operations (2015-2022)' }, 'former', 'more than three years ago'],
  ['ended 2023 → one to three years ago',     { title: 'VP Operations (2015-2023)' }, 'former', 'one to three years ago'],
  ['ended 2024 → one to three years ago',     { title: 'VP Operations (2015-2024)' }, 'former', 'one to three years ago'],
  ['ended 2025, year only → read as December → within the last year',
    { title: 'VP Operations (2015-2025)' }, 'former', 'left within the last year'],
  ['ended June 2025 → one to three years ago',
    { title: 'SVP', evidenceItems: claims('Held the SVP role from March 2019 to June 2025.') }, 'former', 'one to three years ago'],
  ['ended January 2026 → within the last year',
    { title: 'SVP', evidenceItems: claims('Held the SVP role from March 2019 to January 2026.') }, 'former', 'left within the last year'],
  ['"left in 2022" → more than three years ago',
    { title: 'COO', evidenceItems: claims('Left Bayview in 2022 after the sale.') }, 'former', 'more than three years ago'],
  ['"retired in 2025" → within the last year',
    { title: 'CEO', evidenceItems: claims('Retired from Bayview in 2025.') }, 'former', 'left within the last year'],
  ['"leaving in 2022" → more than three years ago',
    { title: 'Ex-COO', evidenceItems: claims('Spent over a decade at Bayview, leaving in 2022.') }, 'former', 'more than three years ago'],
  ['"until 2020" in a served claim → more than three years ago',
    { title: 'CFO', evidenceItems: claims('Served as CFO of Bayview until 2020.') }, 'former', 'more than three years ago'],
  ['"since 2019" → still there',
    { title: 'VP Operations', evidenceItems: claims('Has served as VP Operations at Bayview since 2019.') }, 'current', 'still there'],
  ['"currently leads" → still there',
    { title: 'Head of Clinics', evidenceItems: claims('Currently leads clinic operations at Bayview.') }, 'current', 'still there'],
  ['"2018-Present" in the title → still there',  { title: 'VP Sales, 2018-Present' }, 'current', 'still there'],
  ['"Former" in the title beats an old "since 2019" claim',
    { title: 'Former VP Operations', evidenceItems: claims('Has served as VP Operations at Bayview since 2019.') }, 'former', null],
  ['"Ex-" in the title → former',             { title: 'Ex-COO' },          'former', null],
  ['"Retired" in the title → former',         { title: 'Retired CFO' },     'former', null],
  ['"Past President" in the title → former',  { title: 'Past President' },  'former', null],
  ['"later joined a competitor" → former',
    { title: 'VP Distribution', evidenceItems: claims('Ran distribution for Bayview for six years. Later joined a competitor.') }, 'former', null],
  ['an activity window alone does not prove they left',
    { title: 'Director', evidenceItems: claims('Led the southern clinics from 2016 to 2019.') }, null, null],
];
for (const [label, over, employment, sinceLeft] of DEPARTURE_CASES) {
  const v = track(vet(over));
  eq(`${label} (status)`, v.employment, employment);
  eq(`${label} (band)`,   v.sinceLeft,  sinceLeft);
}

check('a descriptor saying "over the past decade" is not a departure',
  track(vet({ title: 'VP Operations', anonymizedDescriptor: 'Runs clinic operations, over the past decade at a regional group' })).employment === null);
check('a descriptor saying "Former" is',
  track(vet({ title: '', anonymizedDescriptor: 'Former CEO of a regional veterinary clinic group' })).employment === 'former');

// ─── Role level ───────────────────────────────────────────────────────────────

section('role level: a level, never the title');
const ROLE_CASES: Array<[string, string]> = [
  ['Former President & CEO',              'C-suite executive'],
  ['Chief Operating Officer',             'C-suite executive'],
  ['Chief Medical Officer',               'C-suite executive'],
  ['Co-Founder',                          'Founder'],
  ['Chairman of the Board',               'Board member'],
  ['President, North America',            'President'],
  ['Senior Vice President, Distribution', 'Senior vice president'],
  ['SVP Supply Chain',                    'Senior vice president'],
  ['Vice President of Sales',             'Vice president'],
  ['VP Operations',                       'Vice president'],
  ['Managing Director',                   'Managing director'],
  ['Partner',                             'Partner'],
  ['Senior Director, Pricing',            'Director'],
  ['Head of Procurement',                 'Director'],
  ['General Manager',                     'General manager'],
  ['Regional Manager',                    'Manager'],
  ['Professor of Economics',              'Academic or researcher'],
  ['Independent Consultant',              'Advisor'],
  ['Process Engineer',                    'Specialist'],
];
for (const [title, level] of ROLE_CASES) eq(`"${title}" → ${level}`, track(vet({ title })).roleLevel, level);
eq('no title → the tier',             track(vet({ title: '', seniorityTier: 'senior' })).roleLevel, 'Senior leader');
eq('an unknown title → the tier',     track(vet({ title: 'Clinic Owner', seniorityTier: 'mid' })).roleLevel, 'Mid-level');
check('"Vice President" is never read as "President"',
  track(vet({ title: 'Executive Vice President' })).roleLevel === 'Senior vice president');

// ─── Employer type ────────────────────────────────────────────────────────────

section('employer type: the kind of organization, never its name');
const EMPLOYER_CASES: Array<[string, string, string]> = [
  ['after a comma', 'Former President & CEO, regional veterinary clinic group \u2014 dozens of locations', 'Regional veterinary clinic group'],
  ['after an article', 'Owns and ran a multi-site veterinary group as President & CEO', 'Multi-site veterinary group'],
  ['after "at a"', 'VP Marketing at a national specialty retailer', 'National specialty retailer'],
  ['an acronym is fine', 'Former CFO of a PE-backed food manufacturer', 'PE-backed food manufacturer'],
  ['"Fortune 500" carries no figure', 'Fortune 500 manufacturer, more than a decade in role', 'Large manufacturer'],
  ['plural folded', 'Led purchasing for regional grocery chains', 'Regional grocery chains'],
  ['a two-word kind', 'Ran finance at a large regional health system', 'Large regional health system'],
];
for (const [label, descriptor, expected] of EMPLOYER_CASES) {
  eq(`${label}: "${descriptor}"`, track(vet({ anonymizedDescriptor: descriptor })).employerType, expected);
}

const EMPLOYER_FALLBACKS: Array<[string, Partial<Expert>, string]> = [
  ['the deterministic descriptor names no kind → Operator',
    { anonymizedDescriptor: 'Executive · Operator · Veterinary services' }, 'Operating company in veterinary services'],
  ['no descriptor → Advisor',
    { category: 'Advisor', valueChainLabel: undefined }, 'Advisory or consulting firm'],
  ['Outsider, Government',
    { category: 'Outsider', outsider_subcategory: 'Government', valueChainLabel: undefined }, 'Government or public body'],
  ['Outsider, Large Enterprise',
    { category: 'Outsider', outsider_subcategory: 'Large Enterprise', valueChainLabel: undefined }, 'Large enterprise'],
  ['Outsider, Small Business',
    { category: 'Outsider', outsider_subcategory: 'Small Business', valueChainLabel: undefined }, 'Small business'],
  ['Outsider, no subcategory',
    { category: 'Outsider', valueChainLabel: undefined }, 'Research, policy or academic institution'],
  ['a third-party name in the phrase is refused → category',
    { anonymizedDescriptor: 'Runs operations for a Walmart supplier' }, 'Operating company in veterinary services'],
  ['the employer word in the phrase is refused → category',
    { anonymizedDescriptor: 'Former CEO of the Bayview clinic group' }, 'Operating company in veterinary services'],
  ['a lone vague kind is not enough → category',
    { anonymizedDescriptor: 'Former CEO of the company' }, 'Operating company in veterinary services'],
  ['a figure in the phrase is refused → category',
    { anonymizedDescriptor: 'Ran a 40-clinic group' }, 'Operating company in veterinary services'],
];
for (const [label, over, expected] of EMPLOYER_FALLBACKS) eq(label, track(vet(over)).employerType, expected);

// ─── Conflicts ────────────────────────────────────────────────────────────────

section('conflicts: where the questions stand');
const T0 = 1_790_000_000_000;
const CONFLICT_CASES: Array<[string, Partial<ProjectExpert>, ExpertVetting['conflict']['status'], boolean]> = [
  ['bookmarked, nothing sent',              { status: 'bookmarked' }, 'not_asked', false],
  ['intro sent, no reply',                  { status: 'contacted', contactedAt: T0 }, 'not_asked', false],
  ['said yes, follow-up held for review',   { status: 'replied', replyIntent: 'interested', replyDetectedAt: T0 }, 'not_asked', false],
  ['countered on the intro (never asked)',  { status: 'rate_negotiation', replyIntent: 'counter_rate', replyDetectedAt: T0 }, 'not_asked', false],
  ['follow-up sent, no reply',              { status: 'followup_sent', followupSentAt: T0, replyDetectedAt: T0 - 1000 }, 'waiting', false],
  ['the retired cadence asked (email2)',    { status: 'email2_sent', email2SentAt: T0 }, 'waiting', false],
  ['replied after the ask but unreadable',  { status: 'replied', followupSentAt: T0, replyDetectedAt: T0 + 1000, replyIntent: 'unclear' }, 'waiting', false],
  ['yes to the follow-up (rate agreed)',    { status: 'replied', followupSentAt: T0, replyDetectedAt: T0 + 1000, replyIntent: 'interested', rateAgreedAt: T0 + 1000 }, 'answered', false],
  ['countered after the ask',               { status: 'rate_negotiation', followupSentAt: T0, replyDetectedAt: T0 + 1000, replyIntent: 'counter_rate' }, 'answered', false],
  ['times being proposed',                  { status: 'scheduling_sent', followupSentAt: T0 }, 'answered', false],
  ['call booked',                           { status: 'scheduled', followupSentAt: T0 }, 'answered', false],
  ['call done',                             { status: 'completed', followupSentAt: T0 }, 'answered', false],
  ['raised a conflict on the intro',        { status: 'conflict_flagged', replyIntent: 'conflict', conflictNote: 'Under an NDA with a competitor.' }, 'answered', true],
  ['raised a conflict after the ask',       { status: 'conflict_flagged', followupSentAt: T0, replyIntent: 'conflict', replyDetectedAt: T0 + 1000 }, 'answered', true],
  ['staff set the flag by hand',            { status: 'conflict_flagged' }, 'answered', true],
  ['moved on, but the note stays',          { status: 'scheduling_sent', followupSentAt: T0, conflictNote: 'Bound by a non-compete in a related segment.' }, 'answered', true],
];
for (const [label, extra, status, flagged] of CONFLICT_CASES) {
  const v = track(vet({}, extra));
  eq(`${label} → ${status}`, v.conflict.status, status);
  eq(`${label} → flagged ${flagged}`, v.conflict.flagged, flagged);
}

eq('the line: not asked',        conflictLine({ status: 'not_asked', flagged: false, summary: null, risk: null }), 'Not asked yet');
eq('the line: waiting',          conflictLine({ status: 'waiting',   flagged: false, summary: null, risk: null }), 'Asked, waiting on their answer');
eq('the line: answered, clear',  conflictLine({ status: 'answered',  flagged: false, summary: null, risk: null }), 'Answered, nothing flagged');
eq('the line: answered, flagged', conflictLine({ status: 'answered', flagged: true,  summary: null, risk: null }), 'Raised a possible conflict');

section('conflicts: the risk, when staff recorded one');
eq('high',            track(vet({}, { conflictRisk: 'high' })).conflict.risk,    'high');
eq('low',             track(vet({}, { conflictRisk: 'low' })).conflict.risk,     'low');
eq('unknown → none',  track(vet({}, { conflictRisk: 'unknown' })).conflict.risk, null);
eq('absent → none',   track(vet({})).conflict.risk, null);

section("conflicts: Matchy's masked note, only when it names nobody");
const flaggedWith = (conflictNote: string) =>
  track(vet({}, { status: 'conflict_flagged', replyIntent: 'conflict', conflictNote })).conflict.summary;

eq('a plain note is shown',               flaggedWith('Under an NDA with a competitor'), 'Under an NDA with a competitor.');
eq('a note with its own full stop',       flaggedWith('Bound by a non-compete in a related segment.'), 'Bound by a non-compete in a related segment.');
eq('a note that names a company → dropped',          flaggedWith('Under an NDA with Zoetis.'), null);
eq('a company opening the sentence → dropped',       flaggedWith('Zoetis has me under an NDA.'), null);
eq('an unknown acronym → dropped',                   flaggedWith('Under an NDA with GE.'), null);
eq('the employer → dropped',                         flaggedWith('Still restricted by Bayview policy.'), null);
eq('the surname → dropped',                          flaggedWith('Smithers is under an NDA.'), null);
eq('the surname in lower case → dropped',            flaggedWith('restricted per smithers family trust rules.'), null);
eq('a year → dropped',                               flaggedWith('Under an NDA until 2027.'), null);
eq('a mask token → dropped',                         flaggedWith('Under an NDA with [removed].'), null);
eq('an email address → dropped',                     flaggedWith('Ask legal at legal@bayviewvet.com first.'), null);
eq('a dollar sign → dropped',                        flaggedWith('Would need $ to clear it.'), null);
check('the first name used as a word does not sink a note ("will")',
  deriveVetting(pe({ name: 'Will Turner' }, { status: 'conflict_flagged', conflictNote: 'They will need to check their NDA.' }), NOW)
    .conflict.summary === 'They will need to check their NDA.');
check('the first name as a name does',
  deriveVetting(pe({ name: 'Will Turner' }, { status: 'conflict_flagged', conflictNote: 'Will needs to check an NDA.' }), NOW)
    .conflict.summary === null);
eq('no summary when nothing was flagged', track(vet({}, { status: 'completed', followupSentAt: T0 })).conflict.summary, null);

// ─── A record already redacted for a client ───────────────────────────────────

section('a client-redacted record can only say less');
const redacted = deriveVetting({
  expert: {
    id: 'exp-1', name: 'Scott S.', title: '', company: '', location: 'US', category: 'Operator',
    justification: '', relevance_score: 80, source_url: '', source_label: '', source_links: [],
    valueChainLabel: 'Veterinary services', seniorityTier: 'executive',
    anonymizedDescriptor: 'Former President & CEO, regional veterinary clinic group',
  },
  status: 'followup_sent', followupSentAt: T0, addedAt: 1, updatedAt: 2,
}, NOW);
track(redacted);
eq('the level comes from the tier',          redacted.roleLevel, 'Executive');
eq('the kind comes from the descriptor',     redacted.employerType, 'Regional veterinary clinic group');
eq('former comes from the descriptor',       redacted.employment, 'former');
eq('no evidence → no tenure',                redacted.tenure, null);
eq('the conflict state still reads',         redacted.conflict.status, 'waiting');

// ─── The wall ─────────────────────────────────────────────────────────────────

section('the wall: across every card above and every status');
const STATUSES: ExpertStatus[] = [
  'discovered', 'shortlisted', 'bookmarked', 'contact_found', 'outreach_drafted', 'contacted',
  'replied', 'followup_sent', 'rate_negotiation', 'conflict_flagged', 'scheduling_sent',
  'scheduled', 'completed', 'rejected', 'rejected_after_outreach', 'email2_sent',
];
const LOADED: Partial<Expert> = {
  title: 'Former President & CEO, Bayview Veterinary Partners (2015-2021)',
  anonymizedDescriptor: 'Former President & CEO of Bayview Veterinary Partners, 40+ clinics in Austin',
  evidenceItems: claims(
    'Scott Smithers served as CEO of Bayview Veterinary Partners from 2015 to 2021.',
    'Scaled Bayview from 6 to 41 clinics and $120M revenue.',
    'Reach him at scott@bayviewvet.com or 512-555-0142.',
  ),
};
for (const status of STATUSES) {
  track(vet(LOADED, {
    status, followupSentAt: T0, replyDetectedAt: T0 + 1, replyIntent: 'conflict',
    conflictNote: 'Scott Smithers is under an NDA with Bayview until 2027, call 512-555-0142.',
    conflictRisk: 'medium',
  }));
}

for (const card of ALL_CARDS) {
  const text = cardText(card);
  if (/\d/.test(text)) { check(`no digit: ${text}`, false); }
  if (/bayview|smithers|sysco|walmart|zoetis|austin/i.test(text)) { check(`no name: ${text}`, false); }
  if (/@|https?:|\$/.test(text)) { check(`no contact or money: ${text}`, false); }
  if (/\bScott\b/.test(text)) { check(`no first name: ${text}`, false); }
}
check(`every one of ${ALL_CARDS.length} cards is words only (no digit)`,
  ALL_CARDS.every(card => !/\d/.test(cardText(card))));
check('no card names the employer, the person or a third party',
  ALL_CARDS.every(card => !/bayview|smithers|scott|sysco|walmart|zoetis|austin/i.test(cardText(card))));
check('no card carries an address, a link or a dollar sign',
  ALL_CARDS.every(card => !/@|https?:|\$/.test(cardText(card))));

const loaded = vet(LOADED, { status: 'conflict_flagged', conflictNote: 'Scott Smithers is under an NDA with Bayview.' });
eq('a leaky descriptor yields the category kind, not the employer', loaded.employerType, 'Operating company in veterinary services');
eq('the title range still bands',                         loaded.tenure, 'three to ten years');
eq('and the departure',                                   loaded.sinceLeft, 'more than three years ago');
eq('the leaky note is dropped, the flag stays',           loaded.conflict.summary, null);
eq('flagged',                                             loaded.conflict.flagged, true);

summary('vetting card');
