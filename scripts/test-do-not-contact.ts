// scripts/test-do-not-contact.ts: the firm's own do-not-contact list.
//
//   npx tsx scripts/test-do-not-contact.ts
//
// No network, no database, no email, no env vars. What it proves:
//
//   1. normalizeEntry   each kind's normal form, and the plain reason a bad
//                       value is refused with
//   2. detectKind       email / domain on sight, everything else the caller's
//   3. parseUpload      one per line, CSV with and without a header, blank
//                       lines, quotes, tabs, rejects with reasons, the cap
//   4. matchExpert      exact on normalized tokens, never a substring
//                       (Meta vs Metallica, Apple vs Applebee's), domains and
//                       their subdomains, middle initials
//   5. planAdditions    dedupe against the list and the 5,000 cap
//   6. decideListAccess champion / member / staff
//   7. the failure rule checkDoNotContact against fake stores: a missing table
//                       is an empty list, any other failure is unavailable
//   8. the send gate    resolveSendGate holds on a match and on an unreadable
//                       list (fail closed), sends on a missing table
//   9. the wiring       source-level checks that the bookmark route answers
//                       409 do_not_contact before it writes or spends, and that
//                       the chokepoint feeds the firm list into the gate
//
// Exits non-zero on the first failing assertion set, so it can gate a deploy.

import { readFileSync } from 'fs';
import {
  DO_NOT_CONTACT_LIMIT,
  checkDoNotContact,
  checkDoNotContactForOrganization,
  countByKind,
  decideListAccess,
  detectKind,
  isMissingTableError,
  lookupValues,
  matchExpert,
  normalizeEntry,
  parseUpload,
  planAdditions,
  type DoNotContactCheck,
  type DoNotContactEntry,
  type DoNotContactKind,
  type DoNotContactStore,
  type ParsedEntry,
  type StoreError,
} from '../lib/doNotContact';
import { resolveSendGate, isClientRecipient, type SendGateFacts } from '../lib/emailSequence';
import { heldLabel, toHeldReason } from '../lib/walkthrough';
import type { SuppressionCheck } from '../lib/outreachSuppressions';
import { check, eq, summary } from './testHarness';

function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

/** The normalized form, or 'REFUSED: reason'. */
function norm(kind: DoNotContactKind, value: string): string {
  const r = normalizeEntry(kind, value);
  return r.ok ? r.normalized : `REFUSED: ${r.reason}`;
}

function entry(kind: DoNotContactKind, value: string, id = `${kind}:${value}`): DoNotContactEntry {
  const r = normalizeEntry(kind, value);
  if (!r.ok) throw new Error(`test fixture did not normalize: ${kind} ${value}`);
  return { id, kind, value: r.value, normalized: r.normalized };
}

function hit(list: DoNotContactEntry[], expert: { email?: string | null; name?: string; company?: string }): string | null {
  return matchExpert(list, expert)?.id ?? null;
}

// ─── 1. normalizeEntry ────────────────────────────────────────────────────────

section('normalizeEntry: email');

eq('trimmed and lowercased',              norm('email', '  Jane.Doe@Acme.COM '), 'jane.doe@acme.com');
eq('mailto: is dropped',                  norm('email', 'mailto:jane@acme.com'), 'jane@acme.com');
eq('"Name <address>" keeps the address',  norm('email', 'Jane Doe <JANE@acme.com>'), 'jane@acme.com');
eq('plus addressing is kept as is',       norm('email', 'jane+dnc@acme.com'), 'jane+dnc@acme.com');
eq('no @ is refused',                     norm('email', 'jane.acme.com'), 'REFUSED: Not a valid email address.');
eq('no domain is refused',                norm('email', 'jane@'), 'REFUSED: Not a valid email address.');
eq('a dotless domain is refused',         norm('email', 'jane@localhost'), 'REFUSED: Not a valid email address.');
eq('two @ is refused',                    norm('email', 'a@b@acme.com'), 'REFUSED: Not a valid email address.');
eq('a space is refused',                  norm('email', 'jane doe@acme.com'), 'REFUSED: Not a valid email address.');

section('normalizeEntry: domain');

eq('bare host',                           norm('domain', 'Acme.com'), 'acme.com');
eq('scheme, www and path dropped',        norm('domain', 'https://www.Acme.com/about?x=1'), 'acme.com');
eq('leading @ dropped',                   norm('domain', '@acme.com'), 'acme.com');
eq('wildcard dropped',                    norm('domain', '*.acme.com'), 'acme.com');
eq('port and trailing dot dropped',       norm('domain', 'acme.com.:443'), 'acme.com');
eq('an address keeps only its domain',    norm('domain', 'jane@acme.co.uk'), 'acme.co.uk');
eq('subdomain kept',                      norm('domain', 'mail.eu.acme.com'), 'mail.eu.acme.com');
eq('no dot is refused',                   norm('domain', 'acme'), 'REFUSED: Not a valid domain, like acme.com.');
eq('spaces are refused',                  norm('domain', 'acme corp.com'), 'REFUSED: Not a valid domain, like acme.com.');
eq('a numeric TLD is refused',            norm('domain', '10.0.0.1'), 'REFUSED: Not a valid domain, like acme.com.');

section('normalizeEntry: company');

eq('"Apple Inc." → apple',                norm('company', 'Apple Inc.'), 'apple');
eq('"Apple" → apple',                     norm('company', 'Apple'), 'apple');
eq("\"Applebee's\" → applebees",          norm('company', "Applebee's"), 'applebees');
eq('"The Coca-Cola Company" → coca cola', norm('company', 'The Coca-Cola Company'), 'coca cola');
eq('"Coca Cola" → coca cola',             norm('company', 'Coca Cola'), 'coca cola');
eq('"Acme, Inc." → acme',                 norm('company', 'Acme, Inc.'), 'acme');
eq('"Acme Holdings LLC" → acme',          norm('company', 'Acme Holdings LLC'), 'acme');
eq('"The Blackstone Group L.P." → blackstone', norm('company', 'The Blackstone Group L.P.'), 'blackstone');
eq('"Siemens AG" → siemens',              norm('company', 'Siemens AG'), 'siemens');
eq('"Volkswagen GmbH" → volkswagen',      norm('company', 'Volkswagen GmbH'), 'volkswagen');
eq('"J.P. Morgan" and "JP Morgan" agree', norm('company', 'J.P. Morgan'), norm('company', 'JP Morgan'));
eq('"AT&T Inc." → at and t',              norm('company', 'AT&T Inc.'), 'at and t');
eq('"Procter & Gamble" = "Procter and Gamble"', norm('company', 'Procter & Gamble'), norm('company', 'Procter and Gamble'));
eq('accents fold',                        norm('company', 'Nestlé S.A.'), 'nestle');
eq('whitespace collapses',                norm('company', '  Acme    Widget   Co  '), 'acme widget');
eq('a suffix in the middle stays',        norm('company', 'Co-operative Bank'), 'co operative bank');
eq('a name that is only a suffix keeps it', norm('company', 'Group'), 'group');
eq('"Meta Platforms" is not "Meta"',      norm('company', 'Meta Platforms, Inc.') === norm('company', 'Meta'), false);
eq('punctuation only is refused',         norm('company', '...'), 'REFUSED: Enter a company name.');
eq('empty is refused',                    norm('company', '   '), 'REFUSED: Enter a value.');
eq('over 200 characters is refused',      norm('company', 'x'.repeat(201)), 'REFUSED: Keep it under 200 characters.');

section('normalizeEntry: person');

eq('first and last, lowercased',          norm('person', 'Jane Okafor'), 'jane okafor');
eq('middle initial dropped',              norm('person', 'John Q. Smith'), 'john smith');
eq('middle name dropped',                 norm('person', 'John Quincy Smith'), 'john smith');
eq('leading initial dropped',             norm('person', 'J. Robert Smith'), 'robert smith');
eq('honorific and suffixes dropped',      norm('person', 'Dr. John Smith, Jr., PhD'), 'john smith');
eq('"Last, First" reads as First Last',   norm('person', 'Smith, John'), 'john smith');
eq('"Last, First M." too',                norm('person', 'Smith, John Q.'), 'john smith');
eq("apostrophe dropped: O'Brien",         norm('person', "Sean O'Brien"), 'sean obrien');
eq('hyphenated surname stays one word',   norm('person', 'Maria Garcia-Lopez'), 'maria garcialopez');
eq('accents fold',                        norm('person', 'José Núñez'), 'jose nunez');
eq('a short surname is not a suffix: "Anh Do"', norm('person', 'Anh Do'), 'anh do');
eq('one word is refused',                 norm('person', 'Madonna'), 'REFUSED: Enter a first and last name.');

// ─── 2. detectKind ────────────────────────────────────────────────────────────

section('detectKind');

eq('an address is an email',              detectKind('jane@acme.com'), 'email');
eq('anything with @ is an email',         detectKind('jane@'), 'email');
eq('"@acme.com" is a domain',             detectKind('@acme.com'), 'domain');
eq('a bare host is a domain',             detectKind('acme.com'), 'domain');
eq('a URL is a domain',                   detectKind('https://www.acme.com/team'), 'domain');
eq('a country-code host is a domain',     detectKind('acme.co.uk'), 'domain');
eq('a company is ambiguous',              detectKind('Acme Corp'), null);
eq('a person is ambiguous',               detectKind('Jane Okafor'), null);
eq('"Acme Inc." (space) is ambiguous',    detectKind('Acme Inc.'), null);
eq('"J.P.Morgan" is not a host',          detectKind('J.P.Morgan'), null);
eq('a number is ambiguous',               detectKind('3.14'), null);
eq('empty is ambiguous',                  detectKind('   '), null);

// ─── 3. parseUpload ───────────────────────────────────────────────────────────

section('parseUpload: one value per line');

{
  const p = parseUpload('Acme Corp\n\njane@acme.com\n  \nglobex.com\n# a comment\nAcme, Inc.\n', 'company');
  eq('blank lines and comments skipped, four values read', p.entries.length + p.duplicates, 4);
  eq('company by default',                  p.entries[0]?.kind, 'company');
  eq('email recognised',                    p.entries[1]?.kind, 'email');
  eq('domain recognised',                   p.entries[2]?.kind, 'domain');
  eq('"Acme, Inc." is one company, and the same one as Acme Corp', p.duplicates, 1);
  eq('nothing rejected',                    p.rejected.length, 0);
  eq('line numbers are physical lines',     p.entries[2]?.line, 5);
}

{
  const p = parseUpload('Jane Okafor\r\nJohn Q. Smith\r\n', 'person');
  eq('person default + CRLF: two people',   p.entries.map(e => `${e.kind}:${e.normalized}`).join('|'), 'person:jane okafor|person:john smith');
}

{
  const p = parseUpload('﻿Acme\n', 'company');
  eq('a byte-order mark is ignored',        p.entries[0]?.normalized, 'acme');
}

section('parseUpload: CSV with a kind,value header');

{
  const csv = [
    'kind,value',
    'company,"Acme, Inc."',
    'person,"Smith, John"',
    'email,jane@acme.com',
    'domain,globex.com',
    ',initech.com',
    ',Initech',
    'vendor,Hooli',
    'person,Madonna',
    '"company","He said ""hi"" Ltd"',
  ].join('\n');
  const p = parseUpload(csv, 'company');
  const got = p.entries.map(e => `${e.kind}:${e.normalized}`);
  check('the header is not an entry',       !got.some(g => g.includes('value')));
  check('quoted value with a comma',        got.includes('company:acme'));
  check('quoted "Last, First" person',      got.includes('person:john smith'));
  check('email row',                        got.includes('email:jane@acme.com'));
  check('domain row',                       got.includes('domain:globex.com'));
  check('empty kind: detected domain',      got.includes('domain:initech.com'));
  check('empty kind: default company',      got.includes('company:initech'));
  check('escaped quotes inside a quoted cell', got.includes('company:he said hi'));
  eq('unknown kind rejected with a reason',
    p.rejected.find(r => r.line === 8)?.reason, 'Unknown kind. Use company, person, email or domain.');
  eq('one-word person rejected with a reason',
    p.rejected.find(r => r.line === 9)?.reason, 'Enter a first and last name.');
  eq('two rejects in all',                  p.rejected.length, 2);
}

{
  const p = parseUpload('value,kind\nacme.com,domain\n', 'company');
  eq('header columns in either order',      `${p.entries[0]?.kind}:${p.entries[0]?.normalized}`, 'domain:acme.com');
}

{
  const p = parseUpload('kind,value\ncompany,Acme, Inc.\n', 'company');
  eq('an unquoted comma in the last column folds back', p.entries[0]?.value, 'Acme, Inc.');
}

section('parseUpload: CSV without a header, and kind-named columns');

{
  const p = parseUpload('company,Acme\nperson,Jane Okafor\nemail,jane@acme.com\n', 'company');
  eq('kind,value rows without a header',    p.entries.map(e => e.kind).join(','), 'company,person,email');
}

{
  const p = parseUpload('Email\njane@acme.com\nnot-an-address\n', 'company');
  eq('a one-column "Email" header makes every row an email', p.entries[0]?.kind, 'email');
  eq('and a bad row is rejected as an email', p.rejected[0]?.reason, 'Not a valid email address.');
}

{
  const p = parseUpload('Company,Domain\nAcme,acme.com\nGlobex,\n', 'person');
  eq('kind-named columns: three entries',   p.entries.length, 3);
  eq('an empty cell is skipped, not rejected', p.rejected.length, 0);
}

{
  const p = parseUpload('Name\nAcme Corp\n', 'company');
  eq('a "Name" header is a value column, default kind', `${p.entries[0]?.kind}:${p.entries[0]?.normalized}`, 'company:acme');
}

{
  const p = parseUpload('Acme Corp,Portfolio,2024\n', 'company');
  eq('three columns with no header are rejected',
    p.rejected[0]?.reason, 'Too many columns. Use one value per line, or kind,value.');
}

{
  const p = parseUpload('company\tAcme\nemail\tjane@acme.com\n', 'company');
  eq('tab-separated works too',             p.entries.map(e => e.kind).join(','), 'company,email');
}

{
  const p = parseUpload('Acme\nACME\nAcme Inc\nacme.com\n', 'company');
  eq('repeats inside an upload are counted, not added', p.duplicates, 2);
  eq('a domain and a company of the same name are both kept', p.entries.length, 2);
}

section('parseUpload: the 5,000 cap');

{
  const lines = Array.from({ length: DO_NOT_CONTACT_LIMIT + 7 }, (_, i) => `Company ${i}`);
  const p = parseUpload(lines.join('\n'), 'company');
  eq('keeps exactly 5,000',                 p.entries.length, DO_NOT_CONTACT_LIMIT);
  eq('counts the rest as over the limit',   p.overLimit, 7);
  eq('nothing rejected',                    p.rejected.length, 0);
}

{
  const p = parseUpload('', 'company');
  eq('an empty upload is empty',            p.entries.length + p.rejected.length, 0);
}

// ─── 4. matchExpert ───────────────────────────────────────────────────────────

section('matchExpert: companies are exact, never a substring');

{
  const list = [entry('company', 'Meta'), entry('company', 'Apple')];
  eq('Meta matches Meta',                   hit(list, { name: 'Ann Lee', company: 'Meta' }), 'company:Meta');
  eq('Meta does NOT match Metallica',       hit(list, { name: 'Ann Lee', company: 'Metallica' }), null);
  eq('Apple matches "Apple Inc."',          hit(list, { name: 'Ann Lee', company: 'Apple Inc.' }), 'company:Apple');
  eq("Apple does NOT match Applebee's",     hit(list, { name: 'Ann Lee', company: "Applebee's" }), null);
  eq('Apple does NOT match "Pineapple Co"', hit(list, { name: 'Ann Lee', company: 'Pineapple Co' }), null);
  eq('Apple does NOT match "Apple Hospitality REIT"', hit(list, { name: 'Ann Lee', company: 'Apple Hospitality REIT' }), null);
  eq('an empty company matches nothing',    hit(list, { name: 'Ann Lee', company: '' }), null);
}

{
  const list = [entry('company', 'Apple Inc.')];
  eq('"Apple Inc." on the list matches an expert at "Apple"', hit(list, { name: 'Ann Lee', company: 'Apple' }), 'company:Apple Inc.');
}

section('matchExpert: domains cover subdomains, label by label');

{
  const list = [entry('domain', 'acme.com')];
  eq('the domain itself',                   hit(list, { email: 'jane@acme.com', name: 'x y', company: '' }), 'domain:acme.com');
  eq('a subdomain',                         hit(list, { email: 'jane@mail.eu.acme.com', name: 'x y', company: '' }), 'domain:acme.com');
  eq('case does not matter',                hit(list, { email: 'Jane@ACME.com', name: 'x y', company: '' }), 'domain:acme.com');
  eq('a lookalike does not match',          hit(list, { email: 'jane@notacme.com', name: 'x y', company: '' }), null);
  eq('acme.com.evil.io does not match',     hit(list, { email: 'jane@acme.com.evil.io', name: 'x y', company: '' }), null);
  eq('no address, no domain match',         hit(list, { email: null, name: 'x y', company: 'Acme' }), null);
}

{
  const list = [entry('domain', 'eu.acme.com')];
  eq('a subdomain entry does not cover its parent', hit(list, { email: 'jane@acme.com', name: 'x y', company: '' }), null);
  eq('but covers its own subdomains',       hit(list, { email: 'jane@mail.eu.acme.com', name: 'x y', company: '' }), 'domain:eu.acme.com');
}

section('matchExpert: emails and people');

{
  const list = [entry('email', 'jane@acme.com'), entry('person', 'John Smith')];
  eq('the exact address',                   hit(list, { email: 'JANE@acme.com', name: 'a b', company: '' }), 'email:jane@acme.com');
  eq('another address at that domain does not match an email entry',
    hit(list, { email: 'joe@acme.com', name: 'a b', company: '' }), null);
  eq('a middle initial still matches',      hit(list, { name: 'John Q. Smith', company: 'Globex' }), 'person:John Smith');
  eq('a title and suffix still match',      hit(list, { name: 'Dr. John Smith Jr.', company: 'Globex' }), 'person:John Smith');
  eq('a different first name does not',    hit(list, { name: 'Jane Smith', company: 'Globex' }), null);
  eq('a name inside a longer surname does not', hit(list, { name: 'John Smithson', company: 'Globex' }), null);
}

{
  const list = [entry('person', 'John Q. Smith')];
  eq('an entry with a middle initial matches the plain name', hit(list, { name: 'John Smith', company: '' }), 'person:John Q. Smith');
}

{
  const list = [entry('company', 'Globex'), entry('person', 'John Smith')];
  eq('the first entry in list order wins',  hit(list, { name: 'John Smith', company: 'Globex' }), 'company:Globex');
  eq('an empty list matches nothing',       matchExpert([], { name: 'John Smith', company: 'Globex' }), null);
}

section('lookupValues: what the store is asked for');

{
  const values = lookupValues({ email: 'jane@mail.acme.com', name: 'Jane Q. Okafor', company: 'Acme Inc.' });
  eq('address, every parent domain, company, person',
    values.join('|'), 'jane@mail.acme.com|mail.acme.com|acme.com|acme|jane okafor');
  check('never the bare TLD',               !values.includes('com'));
  eq('nothing to look up for an empty expert', lookupValues({ name: '', company: '' }).length, 0);
}

// ─── 5. planAdditions and counting ────────────────────────────────────────────

section('planAdditions: dedupe and the cap');

function parsed(kind: DoNotContactKind, value: string): ParsedEntry {
  const r = normalizeEntry(kind, value);
  if (!r.ok) throw new Error('fixture');
  return { kind, value: r.value, normalized: r.normalized, line: 1 };
}

{
  const existing = [{ kind: 'company' as const, normalized: 'acme' }];
  const plan = planAdditions(existing, [parsed('company', 'Acme Inc'), parsed('company', 'Globex'), parsed('domain', 'acme.com')]);
  eq('already listed is skipped',           plan.alreadyListed, 1);
  eq('the rest are added',                  plan.add.map(e => e.normalized).join(','), 'globex,acme.com');
  eq('room is the cap minus the list',      plan.room, DO_NOT_CONTACT_LIMIT - 1);
  check('well under the cap',               plan.overCap === false);
}

{
  const existing = Array.from({ length: DO_NOT_CONTACT_LIMIT - 1 }, (_, i) => ({ kind: 'company' as const, normalized: `c${i}` }));
  const one = planAdditions(existing, [parsed('company', 'Globex')]);
  check('the 5,000th entry fits',           one.overCap === false && one.add.length === 1);
  const two = planAdditions(existing, [parsed('company', 'Globex'), parsed('company', 'Initech')]);
  check('the 5,001st does not, and nothing is added', two.overCap === true);
  eq('room is reported',                    two.room, 1);
  const repeat = planAdditions(existing, [parsed('company', 'c0'), parsed('company', 'Globex')]);
  check('a re-upload of listed entries does not count against the cap', repeat.overCap === false);
}

{
  const full = Array.from({ length: DO_NOT_CONTACT_LIMIT }, (_, i) => ({ kind: 'company' as const, normalized: `c${i}` }));
  const plan = planAdditions(full, [parsed('company', 'Globex')]);
  check('a full list takes nothing',        plan.overCap === true && plan.room === 0);
}

{
  const counts = countByKind([{ kind: 'company' }, { kind: 'company' }, { kind: 'email' }, { kind: 'person' }]);
  eq('counts per kind',                     `${counts.company}/${counts.person}/${counts.email}/${counts.domain}/${counts.total}`, '2/1/1/0/4');
}

// ─── 6. decideListAccess ──────────────────────────────────────────────────────

section('decideListAccess: who sees and changes the list');

{
  const ORG = '11111111-1111-1111-1111-111111111111';
  const OTHER = '22222222-2222-2222-2222-222222222222';
  const champ = decideListAccess({ role: 'user', orgId: ORG, orgRole: 'org_admin' });
  check('the champion manages their own list', champ.ok && champ.orgId === ORG && champ.canManage);
  const member = decideListAccess({ role: 'user', orgId: ORG, orgRole: 'org_member' });
  check('a member sees it but does not manage', member.ok && member.orgId === ORG && !member.canManage);
  const noRole = decideListAccess({ role: 'user', orgId: ORG, orgRole: null });
  check('no org role means member',         noRole.ok && !noRole.canManage);
  check('a member cannot name another org', !decideListAccess({ role: 'user', orgId: ORG, orgRole: 'org_admin' }, OTHER).ok);
  check('naming your own org is fine',      decideListAccess({ role: 'user', orgId: ORG, orgRole: 'org_admin' }, ORG).ok);
  check('no organization at all is refused', !decideListAccess({ role: 'user', orgId: null, orgRole: 'org_admin' }).ok);
  const staff = decideListAccess({ role: 'admin', orgId: null }, OTHER);
  check('staff may name any org, and manage it', staff.ok && staff.orgId === OTHER && staff.canManage);
  check('staff with no org named and none of their own is refused', !decideListAccess({ role: 'admin', orgId: null }).ok);
}

// ─── 7. The failure rule ──────────────────────────────────────────────────────

section('isMissingTableError');

check('PGRST205 is a missing table',        isMissingTableError({ code: 'PGRST205', message: "Could not find the table 'public.organization_do_not_contact' in the schema cache" }));
check('42P01 is a missing table',           isMissingTableError({ code: '42P01', message: 'relation "public.organization_do_not_contact" does not exist' }));
check('the message alone, naming the table', isMissingTableError({ message: 'relation "organization_do_not_contact" does not exist' }));
check('a missing COLUMN is not a missing table',
  !isMissingTableError({ code: '42703', message: 'column value_normalized does not exist' }));
check('another table missing is not this one',
  !isMissingTableError({ message: 'relation "projects" does not exist' }));
check('a timeout is not a missing table',   !isMissingTableError({ code: '57014', message: 'canceling statement due to statement timeout' }));
check('a network error is not a missing table', !isMissingTableError({ message: 'fetch failed' }));
check('no error is not a missing table',    !isMissingTableError(null));

section('checkDoNotContact against fake stores');

const ORG_ID = '33333333-3333-3333-3333-333333333333';
const EXPERT = { email: 'jane@mail.acme.com', name: 'Jane Okafor', company: 'Globex LLC' };

interface FakeOptions {
  org?:      string | null;
  orgError?: StoreError;
  orgThrows?: boolean;
  rows?:     DoNotContactEntry[];
  error?:    StoreError;
  throws?:   boolean;
}

function fakeStore(o: FakeOptions): DoNotContactStore & { asked: string[][]; orgReads: number } {
  const store = {
    asked:    [] as string[][],
    orgReads: 0,
    async organizationOfProject() {
      store.orgReads++;
      if (o.orgThrows) throw new Error('boom');
      if (o.orgError) return { data: null, error: o.orgError };
      return { data: o.org === undefined ? ORG_ID : o.org, error: null };
    },
    async findEntries(_org: string, values: string[]) {
      store.asked.push(values);
      if (o.throws) throw new Error('boom');
      if (o.error) return { data: null, error: o.error };
      // Like the database: only rows whose normalized value was asked for.
      return { data: (o.rows ?? []).filter(r => values.includes(r.normalized)), error: null };
    },
  };
  return store;
}

async function failureRule(): Promise<void> {
  const clear = await checkDoNotContact(fakeStore({ rows: [entry('company', 'Initech')] }), 'p1', EXPERT);
  check('not on the list → ok, no match',   clear.ok && clear.match === null);

  const byCompany = await checkDoNotContact(fakeStore({ rows: [entry('company', 'Globex')] }), 'p1', EXPERT);
  check('on the list by company → the match', byCompany.ok && byCompany.match?.kind === 'company');

  const byDomain = await checkDoNotContact(fakeStore({ rows: [entry('domain', 'acme.com')] }), 'p1', EXPERT);
  check('on the list by parent domain → the match', byDomain.ok && byDomain.match?.kind === 'domain');

  const missing = await checkDoNotContact(
    fakeStore({ error: { code: 'PGRST205', message: "Could not find the table 'public.organization_do_not_contact'" } }),
    'p1', EXPERT);
  check('table not created yet → an EMPTY list (send allowed)', missing.ok && missing.match === null && missing.listMissing === true);

  const missing42 = await checkDoNotContact(fakeStore({ error: { code: '42P01', message: 'relation does not exist' } }), 'p1', EXPERT);
  check('42P01 → an empty list too',        missing42.ok && missing42.match === null);

  const timeout = await checkDoNotContact(fakeStore({ error: { code: '57014', message: 'statement timeout' } }), 'p1', EXPERT);
  check('any other read error → unavailable (fail closed)', !timeout.ok);

  const column = await checkDoNotContact(fakeStore({ error: { code: '42703', message: 'column value_normalized does not exist' } }), 'p1', EXPERT);
  check('a missing column → unavailable, never empty', !column.ok);

  const threw = await checkDoNotContact(fakeStore({ throws: true }), 'p1', EXPERT);
  check('a read that throws → unavailable', !threw.ok);

  const noProject = await checkDoNotContact(fakeStore({ org: null }), 'p1', EXPERT);
  check('a project with no organization → unavailable', !noProject.ok);

  const orgError = await checkDoNotContact(fakeStore({ orgError: { code: 'PGRST205', message: 'x' } }), 'p1', EXPERT);
  check('a failed project read → unavailable, even if it looks like a missing table', !orgError.ok);

  const orgThrows = await checkDoNotContact(fakeStore({ orgThrows: true }), 'p1', EXPERT);
  check('a project read that throws → unavailable', !orgThrows.ok);

  const lookup = fakeStore({ rows: [] });
  await checkDoNotContact(lookup, 'p1', EXPERT);
  eq('the store is asked for exactly the lookup values',
    lookup.asked[0]?.join('|'), lookupValues(EXPERT).join('|'));

  const nothing = fakeStore({ rows: [] });
  const empty = await checkDoNotContact(nothing, 'p1', { email: null, name: '', company: '' });
  check('nothing to compare → clear without a read', empty.ok && empty.match === null && nothing.orgReads === 0);

  const direct = await checkDoNotContactForOrganization(fakeStore({ rows: [entry('person', 'Jane Okafor')] }), ORG_ID, EXPERT);
  check('the organization form matches by person', direct.ok && direct.match?.kind === 'person');

  // Fresh read every time: the same store, the row removed between two checks.
  const rows = [entry('company', 'Globex')];
  const same = fakeStore({ rows });
  const before = await checkDoNotContact(same, 'p1', EXPERT);
  rows.length = 0;
  const after = await checkDoNotContact(same, 'p1', EXPERT);
  check('a removal takes effect on the next check', before.ok && before.match !== null && after.ok && after.match === null);
  eq('both checks read the store',          same.asked.length, 2);
}

// ─── 8. The send gate ─────────────────────────────────────────────────────────

const CLEAR_SUPPRESSION: SuppressionCheck = { ok: true, suppressed: false };
const DNC_CLEAR:   DoNotContactCheck = { ok: true, match: null };
const DNC_MISSING: DoNotContactCheck = { ok: true, match: null, listMissing: true };
const DNC_MATCH:   DoNotContactCheck = { ok: true, match: entry('company', 'Globex') };
const DNC_DOWN:    DoNotContactCheck = { ok: false, reason: 'unavailable' };

function live(patch: Partial<SendGateFacts> = {}): SendGateFacts {
  return {
    disableEmails: false,
    walkthrough:   false,
    canOutreach:   true,
    suppression:   CLEAR_SUPPRESSION,
    doNotContact:  DNC_CLEAR,
    ...patch,
  };
}

function gate(facts: SendGateFacts): string {
  const g = resolveSendGate(facts);
  return g.send ? 'SENT' : g.held;
}

function sendGateSection(): void {
  section('resolveSendGate: the firm list is the fifth gate');

  eq('clear → sent',                        gate(live()), 'SENT');
  eq('table not created yet → sent',        gate(live({ doNotContact: DNC_MISSING })), 'SENT');
  eq('on the list → held do_not_contact',   gate(live({ doNotContact: DNC_MATCH })), 'do_not_contact');
  eq('list unreadable → held (fail closed)', gate(live({ doNotContact: DNC_DOWN })), 'do_not_contact');
  eq('never checked → held (fail closed)',  gate(live({ doNotContact: null })), 'do_not_contact');
  eq('the global opt-out is reported first', gate(live({ suppression: { ok: true, suppressed: true }, doNotContact: DNC_MATCH })), 'suppressed');
  eq('no card on file is reported first',   gate(live({ canOutreach: false, doNotContact: DNC_MATCH })), 'trial');
  eq('walkthrough is reported first',       gate(live({ walkthrough: true, doNotContact: null })), 'walkthrough');

  section('isClientRecipient: the firm list never holds mail to the firm');

  const project = { ownerEmail: 'Owner@Firm.com', clientEmail: 'client@firm.com' };
  check('the owner is the client',          isClientRecipient(' owner@firm.com ', project));
  check('the brief contact is the client',  isClientRecipient('CLIENT@firm.com', project));
  check('the expert is not',                !isClientRecipient('jane@acme.com', project));
  check('an empty address is not',          !isClientRecipient('', project));
  check('no client email on file',          !isClientRecipient('x@y.com', { ownerEmail: '', clientEmail: null }));

  section('the held reason reaches the client in plain words');

  eq('toHeldReason keeps do_not_contact',   toHeldReason('do_not_contact'), 'do_not_contact');
  eq('heldLabel says why',                  heldLabel('do_not_contact'), "Not sent: on your firm's do-not-contact list");
  check('no em dash in the label',          !heldLabel('do_not_contact').includes('\u2014'));
}

// ─── 9. The wiring, at source level ───────────────────────────────────────────

function wiringSection(): void {
  section('bookmark: 409 do_not_contact before anything is written or spent');

  const bookmark = readFileSync(
    new URL('../app/api/projects/[projectId]/experts/[expertId]/bookmark/route.ts', import.meta.url), 'utf8');
  const post = bookmark.slice(bookmark.indexOf('export async function POST'));
  const listedAt   = post.indexOf('await checkFirmList(');
  const applyAt    = post.indexOf('await applyBookmark(');
  const discoverAt = post.indexOf('await startContactDiscovery(');
  const eventAt    = post.indexOf('await emitEngagementEvent(');
  check('the firm list is checked in POST',  listedAt > 0);
  check('before the status write',           listedAt > 0 && listedAt < applyAt);
  check('before any event',                  listedAt > 0 && listedAt < eventAt);
  check('before contact discovery',          listedAt > 0 && listedAt < discoverAt);
  check("the exact error code the bulk UI relies on",
    /error:\s*'do_not_contact',\s*message:\s*"On your firm's do-not-contact list\."/.test(bookmark));
  check('a 409',                             /'do_not_contact'[\s\S]{0,160}status:\s*409/.test(bookmark));
  check('an unreadable list refuses the bookmark (503)',
    /if \(!listed\.ok\)[\s\S]{0,300}status:\s*503/.test(bookmark));
  check('name and company are what it checks',
    /name:\s*pe\.expert\.name/.test(bookmark) && /company:\s*pe\.expert\.company/.test(bookmark));

  section('the chokepoint feeds the firm list into the gate');

  const chokepoint = readFileSync(new URL('../lib/emailSequence.ts', import.meta.url), 'utf8');
  check('sendSequenceEmail passes doNotContact to resolveSendGate',
    /resolveSendGate\(\{[\s\S]{0,240}doNotContact,?\s*\}\)/.test(chokepoint));
  check('the check uses the expert from the reply token',
    chokepoint.includes('checkFirmList(resolved.project, resolved.expertId, to)'));
  check('the check is read fresh (no module-level cache)',
    !/const\s+\w*[Cc]ache\w*\s*=\s*new Map/.test(chokepoint));

  const lib = readFileSync(new URL('../lib/doNotContact.ts', import.meta.url), 'utf8');
  check('lib/doNotContact keeps no module-level cache',
    !/^(let|const)\s+\w+\s*=\s*new (Map|Set)/m.test(lib));
  check('lib/doNotContact has no runtime server import',
    !/^import\s+(?!type)[^;]*from\s+'\.\/supabase\/admin'/m.test(lib));
}

// ─── Run ──────────────────────────────────────────────────────────────────────

failureRule()
  .then(() => {
    sendGateSection();
    wiringSection();
    summary();
  })
  .catch((err: unknown) => {
    console.error('test-do-not-contact threw:', err);
    process.exit(1);
  });
