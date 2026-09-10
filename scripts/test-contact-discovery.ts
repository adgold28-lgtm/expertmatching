// scripts/test-contact-discovery.ts — unit tests for lib/contactDiscovery.ts.
//
// Pure: no network, no database, no provider credits. The one test that calls
// discoverContact() only exercises the disabled path, which returns before any
// provider or cache is touched — the env var is set and restored in-process.
//
//   npx tsx scripts/test-contact-discovery.ts
//
// What is pinned here is what costs money or reputation when it drifts:
//   1. the role-address rejector — we write to a person, never to sales@
//   2. the domain heuristic — a wrong domain spends a credit at the wrong
//      company and can produce a plausible address for the wrong person
//   3. the result-merging order — verified beats catch-all, and 'risky' /
//      'invalid' are never sendable at all
//   4. the kill switch — CONTACT_ENRICHMENT_ENABLED unset means 'unavailable'
//      and zero provider calls

import {
  isRoleAddress,
  isValidEmailSyntax,
  isUsableAddress,
  splitName,
  companySlug,
  deriveCompanyDomain,
  pickBestCandidate,
  discoverContact,
  MIN_CONFIDENCE,
} from '../lib/contactDiscovery';
import type { ProviderEmailResult, NormalizedEmailStatus } from '../lib/contactProviders/types';
import { check, summary } from './testHarness';

function section(title: string): void {
  console.log(`\n${title}`);
}

// ─── 1. Role addresses ────────────────────────────────────────────────────────

section('1. Role addresses are never sendable');

const ROLE = [
  'info@acmecoatings.com',
  'sales@acmecoatings.com',
  'noreply@acmecoatings.com',
  'no-reply@acmecoatings.com',
  'do.not.reply@acmecoatings.com',
  'support@acmecoatings.com',
  'hello@acmecoatings.com',
  'careers@acmecoatings.com',
  'hr@acmecoatings.com',
  'billing@acmecoatings.com',
  'press@acmecoatings.com',
  'admin@acmecoatings.com',
  'info.emea@acmecoatings.com',
  'sales-team@acmecoatings.com',
  'contact_us@acmecoatings.com',
];
for (const email of ROLE) {
  check(`rejects ${email}`, isRoleAddress(email) && !isUsableAddress(email));
}

const PEOPLE = [
  'dana.reyes@acmecoatings.com',
  'dreyes@acmecoatings.com',
  'dana@acmecoatings.com',
  'dana-reyes@acmecoatings.co.uk',
  'd.reyes2@acme-coatings.com',
  // Contain a role word as a substring but are not role addresses — a whole
  // segment has to match, or "salesberg" and "prosser" would never hear from us.
  'martin.salesberg@acmecoatings.com',
  'jo.prosser@acmecoatings.com',
];
for (const email of PEOPLE) {
  check(`accepts ${email}`, !isRoleAddress(email) && isUsableAddress(email));
}

section('1b. Syntax validation');

const BAD_SYNTAX = [
  '', 'dana', 'dana@', '@acmecoatings.com', 'dana@@acme.com', 'dana@acme',
  'dana @acme.com', 'dana@acme .com', '.dana@acme.com', 'dana.@acme.com',
  'da..na@acme.com', 'dana@acme..com', 'dana@-acme.com', 'dana@acme.c',
  'dana@acme.123',
];
for (const email of BAD_SYNTAX) {
  check(`rejects syntax ${JSON.stringify(email)}`, !isValidEmailSyntax(email));
}
for (const email of PEOPLE) {
  check(`accepts syntax ${email}`, isValidEmailSyntax(email));
}

section('1c. Name splitting');

check('splits a plain name',        JSON.stringify(splitName('Dana Reyes')) === JSON.stringify({ first: 'Dana', last: 'Reyes' }));
check('drops a middle name',        splitName('Dana J Reyes')?.last === 'Reyes');
check('drops a suffix',             splitName('Dana Reyes Jr.')?.last === 'Reyes');
check('drops a credential',         splitName('Dana Reyes PhD')?.last === 'Reyes');
check('rejects a single name',      splitName('Dana') === null);
check('rejects an initial surname', splitName('Dana R.') === null);
check('rejects empty',              splitName('   ') === null);

// ─── 2. Domain heuristic ──────────────────────────────────────────────────────

section('2. Company domain heuristic');

check('slug strips legal form', companySlug('Acme Coatings Inc') === 'acmecoatings',
  `got ${companySlug('Acme Coatings Inc')}`);

// The brief's case: the company site wins, the LinkedIn profile is ignored.
const brief = deriveCompanyDomain({
  company:     'Acme Coatings Inc',
  sourceLinks: ['https://www.linkedin.com/in/dana-reyes', 'https://www.acmecoatings.com/team'],
});
check('company site → acmecoatings.com', brief.domain === 'acmecoatings.com', `got ${brief.domain}`);

check('LinkedIn alone yields nothing',
  deriveCompanyDomain({
    company:     'Acme Coatings Inc',
    sourceLinks: ['https://www.linkedin.com/in/dana-reyes'],
  }).domain === null);

check('source_url is considered too',
  deriveCompanyDomain({
    company:   'Acme Coatings Inc',
    sourceUrl: 'https://acmecoatings.com/about',
  }).domain === 'acmecoatings.com');

check('hyphenated host still matches',
  deriveCompanyDomain({
    company:     'Acme Coatings Inc',
    sourceLinks: ['https://www.acme-coatings.co.uk/leadership'],
  }).domain === 'acme-coatings.co.uk');

check('an unrelated article host is not used',
  deriveCompanyDomain({
    company:     'Acme Coatings Inc',
    sourceLinks: ['https://processingworld.com/2024/interview-with-dana-reyes'],
  }).domain === null);

check('webmail is never a company domain',
  deriveCompanyDomain({
    company:     'Acme Coatings Inc',
    sourceLinks: ['https://gmail.com/acmecoatings'],
  }).domain === null);

check('the matching link wins over an earlier non-matching one',
  deriveCompanyDomain({
    company:     'Acme Coatings Inc',
    sourceLinks: [
      'https://processingworld.com/2024/interview',
      'https://www.acmecoatings.com/team',
    ],
  }).domain === 'acmecoatings.com');

check('a token match is enough for a longer name',
  deriveCompanyDomain({
    company:     'Northwind Industrial Coatings LLC',
    sourceLinks: ['https://northwind-ic.com/people'],
  }).domain === 'northwind-ic.com');

check('no company name → no derivation',
  deriveCompanyDomain({ company: '', sourceLinks: ['https://somewhere.com/x'] }).domain === null);

check('no links at all → no derivation',
  deriveCompanyDomain({ company: 'Acme Coatings Inc' }).domain === null);

check('junk urls are ignored',
  deriveCompanyDomain({
    company:     'Acme Coatings Inc',
    sourceLinks: ['', 'not a url', 'https://www.acmecoatings.com/team'],
  }).domain === 'acmecoatings.com');

// ─── 3. Result merging ────────────────────────────────────────────────────────

section('3. Result merging order');

function result(
  email: string,
  normalizedStatus: NormalizedEmailStatus,
  extra: Partial<ProviderEmailResult> = {},
): ProviderEmailResult {
  return {
    email,
    provider:       'snov',
    providerStatus: normalizedStatus,
    normalizedStatus,
    isWebmail:      false,
    isDisposable:   false,
    isValidFormat:  true,
    isGibberish:    false,
    reason:         null,
    ...extra,
  };
}

check('nothing in, nothing out', pickBestCandidate([]) === null);

check('verified beats catch-all', pickBestCandidate([
  result('a.catchall@acmecoatings.com', 'catchall'),
  result('b.verified@acmecoatings.com', 'verified'),
])?.email === 'b.verified@acmecoatings.com');

check('catch-all is used when it is all there is', pickBestCandidate([
  result('a.catchall@acmecoatings.com', 'catchall'),
])?.email === 'a.catchall@acmecoatings.com');

check('risky is never sendable',   pickBestCandidate([result('a.risky@acmecoatings.com', 'risky')]) === null);
check('invalid is never sendable', pickBestCandidate([result('a.bad@acmecoatings.com', 'invalid')]) === null);

check('webmail is dropped',
  pickBestCandidate([result('dana@gmail.com', 'verified', { isWebmail: true })]) === null);
check('disposable is dropped',
  pickBestCandidate([result('dana@mailinator.com', 'verified', { isDisposable: true })]) === null);
check('gibberish is dropped',
  pickBestCandidate([result('xq7z@acmecoatings.com', 'verified', { isGibberish: true })]) === null);
check('a role address is dropped even when verified',
  pickBestCandidate([result('sales@acmecoatings.com', 'verified')]) === null);
check('a malformed address is dropped even when verified',
  pickBestCandidate([result('dana@@acmecoatings.com', 'verified')]) === null);

check(`confidence under ${MIN_CONFIDENCE} is dropped`,
  pickBestCandidate([result('dana.reyes@acmecoatings.com', 'verified', { confidence: 40 })]) === null);
check(`confidence at ${MIN_CONFIDENCE} is kept`,
  pickBestCandidate([result('dana.reyes@acmecoatings.com', 'verified', { confidence: MIN_CONFIDENCE })])?.email
    === 'dana.reyes@acmecoatings.com');

check('within the same status the higher confidence wins', pickBestCandidate([
  result('low.score@acmecoatings.com',  'verified', { confidence: 60 }),
  result('high.score@acmecoatings.com', 'verified', { confidence: 95 }),
])?.email === 'high.score@acmecoatings.com');

check('a verified result beats a higher-scored catch-all', pickBestCandidate([
  result('catch.all@acmecoatings.com', 'catchall', { confidence: 99 }),
  result('dana.reyes@acmecoatings.com', 'verified', { confidence: 55 }),
])?.email === 'dana.reyes@acmecoatings.com');

// ─── 4. The kill switch ───────────────────────────────────────────────────────

section('4. CONTACT_ENRICHMENT_ENABLED gates everything');

async function killSwitch(): Promise<void> {
  const original = process.env.CONTACT_ENRICHMENT_ENABLED;

  const input = {
    projectId:   'ffffffffffffffffffffffff',
    expertId:    'src-1',
    name:        'Dana Reyes',
    company:     'Acme Coatings Inc',
    title:       'VP Operations',
    sourceLinks: ['https://www.acmecoatings.com/team'],
  };

  delete process.env.CONTACT_ENRICHMENT_ENABLED;
  const unset = await discoverContact(input);
  check('unset → unavailable',        unset.outcome === 'unavailable', `got ${unset.outcome}`);
  check('unset → no provider called', unset.attempts.length === 0, JSON.stringify(unset.attempts));

  process.env.CONTACT_ENRICHMENT_ENABLED = 'false';
  const off = await discoverContact(input);
  check("'false' → unavailable", off.outcome === 'unavailable', `got ${off.outcome}`);

  process.env.CONTACT_ENRICHMENT_ENABLED = 'TRUE';
  const wrongCase = await discoverContact(input);
  check("'TRUE' → unavailable (exact match only)", wrongCase.outcome === 'unavailable', `got ${wrongCase.outcome}`);

  if (original === undefined) delete process.env.CONTACT_ENRICHMENT_ENABLED;
  else process.env.CONTACT_ENRICHMENT_ENABLED = original;
}

async function main(): Promise<void> {
  await killSwitch();

  summary();
}

void main();
