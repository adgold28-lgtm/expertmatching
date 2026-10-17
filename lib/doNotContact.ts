// lib/doNotContact.ts: a firm's own do-not-contact list.
//
// The pitch promises "your firm's do-not-contact list is applied before any
// intro goes out". Compliance teams keep lists of companies (portfolio
// companies, deal targets), named people, single addresses and whole email
// domains their analysts must not reach. This module is the rule for that list:
//
//   normalizeEntry   what a typed or uploaded value is compared as
//   detectKind       email / domain recognised on sight; anything else is the
//                    caller's choice of company or person
//   parseUpload      one value per line, or a CSV (optional header), capped
//   matchExpert      the first entry an expert hits, or null
//   checkDoNotContact the read the send chokepoint and the bookmark route make,
//                    with its failure rule (below)
//
// Backed by public.organization_do_not_contact (supabase/migrations/
// 20261014000000_launch_pack.sql): service role only, unique on
// (organization_id, kind, value_normalized). `value_normalized` is
// normalizeEntry's output, so a change to the rules below needs a backfill of
// that column, never a second matcher.
//
// MATCHING IS EXACT ON NORMALIZED TOKENS. Never a substring: "Meta" does not
// match "Metallica", "Apple" does not match "Applebee's". A domain entry covers
// the domain and its subdomains, compared label by label.
//
// THE FAILURE RULE (a compliance gate):
//   - the table does not exist yet (the migration is pasted by hand): an empty
//     list, because nothing can have been uploaded to it
//   - ANY other read failure: unavailable, and every caller holds the send,
//     exactly as an unreadable suppression list does (lib/outreachSuppressions)
//
// NO CACHE. Every check reads the table, so a removal takes effect on the very
// next send. A caller that checks the same expert twice in one request may keep
// the answer for that request; nothing here keeps it longer.
//
// CLIENT SAFE. No runtime import touches the server: the Supabase client is a
// type-only import and the store is passed in, which is also what lets
// scripts/test-do-not-contact.ts drive the failure rule with fakes. The
// settings page imports detectKind and normalizeEntry from here.
//
// Never logs: entry values, names, companies or addresses.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './supabase/database.types';

// ─── Kinds and limits ─────────────────────────────────────────────────────────

export type DoNotContactKind = 'email' | 'domain' | 'company' | 'person';

/** In the order the settings page offers them. */
export const DO_NOT_CONTACT_KINDS: readonly DoNotContactKind[] = ['company', 'person', 'email', 'domain'];

/** Most entries one organization may keep, and most one upload may carry. */
export const DO_NOT_CONTACT_LIMIT = 5000;

/** The table's check constraint on both value columns. */
export const VALUE_MAX_LENGTH = 200;

/** Upload bodies past this are refused before parsing (route and page agree). */
export const UPLOAD_MAX_BYTES = 1024 * 1024;

/** Adds, uploads and removes per user per hour (POST and DELETE share it). */
export const DO_NOT_CONTACT_WRITES_PER_HOUR = 120;

/** What the routes and the page say, in one place so they cannot drift. */
export const DNC_COPY = {
  explainer:    'Matchy checks this list before any intro goes out.',
  notAvailable: 'This list will be available shortly.',
  championNote: "Your firm's champion manages this list.",
  onList:       "On your firm's do-not-contact list.",
} as const;

export const KIND_LABELS: Record<DoNotContactKind, string> = {
  company: 'Company',
  person:  'Person',
  email:   'Email',
  domain:  'Domain',
};

export function isDoNotContactKind(value: unknown): value is DoNotContactKind {
  return value === 'email' || value === 'domain' || value === 'company' || value === 'person';
}

// ─── Shared text helpers ──────────────────────────────────────────────────────

/** "Nestlé" → "Nestle": accents compared as their base letter. */
function foldAccents(text: string): string {
  return text.normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

/** One DNS label: letters, digits, inner hyphens. */
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD_RE   = /^(?:[a-z]{2,24}|xn--[a-z0-9-]{1,59})$/;

/** A syntactically valid host with at least two labels and a real-looking TLD. */
function isHost(host: string): boolean {
  if (!host || host.length > 253) return false;
  const labels = host.split('.');
  if (labels.length < 2) return false;
  if (!labels.every(l => LABEL_RE.test(l))) return false;
  return TLD_RE.test(labels[labels.length - 1]);
}

/** Valid address syntax, already lowercased and trimmed. */
function isEmailSyntax(address: string): boolean {
  const at = address.indexOf('@');
  if (at <= 0 || at !== address.lastIndexOf('@')) return false;
  const local  = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (local.length > 64) return false;
  if (!/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local)) return false;
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  return isHost(domain);
}

// ─── Normalization ────────────────────────────────────────────────────────────

/** "Jane Doe <JANE@Acme.com>" / "mailto:jane@acme.com" → "jane@acme.com". */
function normalizeEmailValue(raw: string): string | null {
  let s = raw.trim();
  const bracketed = s.match(/<([^<>]+)>\s*$/);
  if (bracketed) s = bracketed[1];
  s = s.trim().toLowerCase().replace(/^mailto:/, '').trim();
  return isEmailSyntax(s) ? s : null;
}

/**
 * The bare host: no scheme, no path, no port, no leading "www.", "*." or "@".
 * "https://www.Acme.com/about" → "acme.com"; "@acme.com" → "acme.com".
 */
function normalizeDomainValue(raw: string): string | null {
  let s = raw.trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^mailto:/, '');
  const at = s.lastIndexOf('@');
  if (at >= 0) s = s.slice(at + 1);
  s = s.split(/[/?#]/)[0];
  s = s.replace(/:\d+$/, '').replace(/\.$/, '');
  s = s.replace(/^\*\./, '').replace(/^www\./, '');
  return isHost(s) ? s : null;
}

/**
 * Legal-form words dropped from the END of a company name. The spec's list
 * plus the long forms lib/contactDiscovery's LEGAL_SUFFIXES also carries
 * ("incorporated", "limited", "holding", "nv"). That set is not imported: the
 * module it lives in is server-only and this one is not.
 */
const COMPANY_SUFFIXES: ReadonlySet<string> = new Set([
  'inc', 'incorporated', 'llc', 'ltd', 'limited', 'plc', 'corp', 'corporation',
  'co', 'company', 'group', 'holdings', 'holding', 'lp', 'llp', 'gmbh', 'sa',
  'ag', 'bv', 'nv',
]);

/**
 * "The Coca-Cola Company" → "coca cola"; "Apple Inc." → "apple";
 * "Applebee's" → "applebees"; "AT&T" → "at and t".
 *
 * Accents folded, "&" read as "and", apostrophes and periods dropped inside a
 * word (so "J.P." is "jp" and "McDonald's" is "mcdonalds"), every other
 * punctuation mark a space, a leading "the" dropped, then legal suffixes
 * dropped from the end while a word remains. Null when nothing is left.
 */
function normalizeCompanyValue(raw: string): string | null {
  const words = foldAccents(raw)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`.]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  if (words.length > 1 && words[0] === 'the') words.shift();
  while (words.length > 1 && COMPANY_SUFFIXES.has(words[words.length - 1])) words.pop();
  const out = words.join(' ');
  return out || null;
}

const HONORIFICS: ReadonlySet<string> = new Set([
  'dr', 'prof', 'mr', 'mrs', 'ms', 'mx', 'sir', 'dame', 'rev', 'hon',
]);

/**
 * Generational and post-nominal suffixes, punctuation already stripped. Tighter
 * than lib/nameValidation's NAME_SUFFIX_RE on purpose: that one also lists
 * "do", "ma", "ba", "v", which are surnames often enough to matter here.
 */
const NAME_SUFFIXES: ReadonlySet<string> = new Set([
  'jr', 'sr', 'ii', 'iii', 'iv', 'phd', 'md', 'mba', 'jd', 'esq', 'dds', 'dvm',
  'cfa', 'cpa', 'pmp', 'msc', 'bsc', 'llm', 'mph',
]);

function isNameSuffix(word: string): boolean {
  return NAME_SUFFIXES.has(word.toLowerCase().replace(/[^a-z]/g, ''));
}

/**
 * "Dr. John Q. Smith, Jr." → "john smith"; "Smith, John" → "john smith";
 * "O'Brien" → "obrien"; "Garcia-Lopez" → "garcialopez".
 *
 * First and last name only, lowercased, punctuation stripped. Middle initials
 * (and any middle name) are dropped, so a listed "John Smith" also covers
 * "John Q. Smith". A leading honorific and trailing suffixes ("Jr", "PhD") are
 * dropped only while three or more words remain, so "Anh Do" keeps its
 * surname. "Last, First" is read as "First Last" unless what follows the comma
 * is only suffixes. Null without both a first and a last name.
 */
function normalizePersonValue(raw: string): string | null {
  let s = foldAccents(raw).trim();
  const comma = s.indexOf(',');
  if (comma >= 0) {
    const head = s.slice(0, comma).trim();
    const tail = s.slice(comma + 1).replace(/,/g, ' ').trim();
    const tailWords = tail.split(/\s+/).filter(Boolean);
    const tailIsSuffixes = tailWords.length > 0 && tailWords.every(isNameSuffix);
    s = tail && !tailIsSuffixes ? `${tail} ${head}` : s.replace(/,/g, ' ');
  }

  const words = s
    .toLowerCase()
    .split(/\s+/)
    .map(w => w.replace(/['’`.-]/g, '').replace(/[^a-z0-9]/g, ''))
    .filter(Boolean);

  while (words.length > 2 && HONORIFICS.has(words[0])) words.shift();
  while (words.length > 2 && isNameSuffix(words[words.length - 1])) words.pop();
  for (let i = words.length - 1; i >= 0 && words.length > 2; i--) {
    if (words[i].length === 1) words.splice(i, 1);
  }

  if (words.length < 2) return null;
  return `${words[0]} ${words[words.length - 1]}`;
}

export type NormalizeResult =
  | { ok: true;  value: string; normalized: string }
  | { ok: false; reason: string };

const INVALID_REASON: Record<DoNotContactKind, string> = {
  email:   'Not a valid email address.',
  domain:  'Not a valid domain, like acme.com.',
  company: 'Enter a company name.',
  person:  'Enter a first and last name.',
};

/**
 * What a typed or uploaded value is stored and compared as. `value` is the
 * trimmed original (what the list shows); `normalized` is what the matcher and
 * the unique key use.
 */
export function normalizeEntry(kind: DoNotContactKind, value: string): NormalizeResult {
  const trimmed = (value ?? '').replace(/\s+/g, ' ').trim();
  if (!trimmed) return { ok: false, reason: 'Enter a value.' };
  if (trimmed.length > VALUE_MAX_LENGTH) return { ok: false, reason: 'Keep it under 200 characters.' };

  const normalized =
    kind === 'email'   ? normalizeEmailValue(trimmed)   :
    kind === 'domain'  ? normalizeDomainValue(trimmed)  :
    kind === 'company' ? normalizeCompanyValue(trimmed) :
                         normalizePersonValue(trimmed);

  if (!normalized) return { ok: false, reason: INVALID_REASON[kind] };
  if (normalized.length > VALUE_MAX_LENGTH) return { ok: false, reason: 'Keep it under 200 characters.' };
  return { ok: true, value: trimmed, normalized };
}

// ─── Kind detection ───────────────────────────────────────────────────────────

/**
 * Email or domain when the value says so on its face; null when it could be
 * either a company or a person and the caller has to choose.
 *
 *   contains "@"                       → email ("@acme.com" alone is a domain)
 *   no spaces, a dot, a real-looking host → domain ("acme.com", a URL)
 *
 * Stricter than normalizeEntry('domain'): the label before the TLD must be two
 * characters or more, so "J.P.Morgan" is not mistaken for a host. Typing
 * "x.com" and choosing Domain still works.
 */
export function detectKind(raw: string): 'email' | 'domain' | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  if (s.startsWith('@')) return normalizeDomainValue(s) ? 'domain' : null;
  if (s.includes('@')) return 'email';
  if (/\s/.test(s) || !s.includes('.')) return null;
  const host = normalizeDomainValue(s);
  if (!host) return null;
  const labels = host.split('.');
  return labels[labels.length - 2].length >= 2 ? 'domain' : null;
}

// ─── Upload parsing ───────────────────────────────────────────────────────────

export interface ParsedEntry {
  kind:       DoNotContactKind;
  value:      string;
  normalized: string;
  /** 1-based line in the upload. */
  line:       number;
}

export interface RejectedLine {
  line:   number;
  /** What was on the line, shortened for display. */
  value:  string;
  reason: string;
}

export interface UploadParse {
  /** Valid, unique within the upload, in file order, at most DO_NOT_CONTACT_LIMIT. */
  entries:    ParsedEntry[];
  rejected:   RejectedLine[];
  /** Repeats inside the upload (same kind and normalized value), not kept. */
  duplicates: number;
  /** Valid entries past the 5,000 cap, not kept. */
  overLimit:  number;
}

/** Words a header cell or a leading "kind" cell may use for each kind. */
const KIND_WORDS: Record<string, DoNotContactKind> = {
  email: 'email', emails: 'email', 'e-mail': 'email', 'email address': 'email',
  domain: 'domain', domains: 'domain', website: 'domain',
  company: 'company', companies: 'company', organization: 'company', organisation: 'company',
  person: 'person', people: 'person', persons: 'person',
};

/** Header cells for the column that says which kind a row is. */
const KIND_COLUMN_WORDS: ReadonlySet<string> = new Set(['kind', 'type']);

/**
 * Header cells for a column of values whose kind is not stated. "Name" is one
 * of them rather than a person column: a list headed "Name" is as likely to be
 * companies as people, so those rows take the chosen default.
 */
const VALUE_COLUMN_WORDS: ReadonlySet<string> = new Set(['value', 'values', 'name', 'names', 'entry', 'entries']);

function kindWord(cell: string): DoNotContactKind | null {
  return KIND_WORDS[cell.trim().toLowerCase()] ?? null;
}

type Column = DoNotContactKind | 'kind' | 'value';

/** A header row: every non-empty cell is a header word and one names a value. */
function headerColumns(cells: string[]): Array<Column | null> | null {
  const columns = cells.map((cell): Column | null => {
    const word = cell.trim().toLowerCase();
    if (KIND_COLUMN_WORDS.has(word)) return 'kind';
    if (VALUE_COLUMN_WORDS.has(word)) return 'value';
    return kindWord(word);
  });
  const allKnown = cells.every((cell, i) => cell.trim() === '' || columns[i] !== null);
  const hasValue = columns.some(c => c !== null && c !== 'kind');
  return allKnown && hasValue ? columns : null;
}

/**
 * One CSV line into cells. Double quotes wrap a cell and "" escapes a quote;
 * a quoted cell may hold the delimiter. Cells come back trimmed. A quoted cell
 * cannot span lines: a do-not-contact list has no use for that.
 */
function splitLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell.trim() === '') {
      quoted = true;
      cell = '';
    } else if (ch === delimiter) {
      cells.push(cell);
      cell = '';
    } else {
      cell += ch;
    }
  }
  cells.push(cell);
  return cells.map(c => c.trim());
}

function shorten(text: string): string {
  const t = text.trim();
  return t.length > 80 ? `${t.slice(0, 79)}…` : t;
}

/**
 * Turns a pasted list or an uploaded .csv / .txt into entries.
 *
 * Accepted shapes:
 *   - one value per line ("Acme, Inc." stays one company)
 *   - "kind,value" rows, with or without a "kind,value" header
 *   - a header naming the columns by kind ("Company", "Email,Domain", ...),
 *     every cell under it read as that kind
 * Tabs work in place of commas. Blank lines and lines starting with "#" are
 * skipped. A value with no stated kind is an email or a domain when it looks
 * like one (detectKind), else `defaultKind`.
 *
 * Never throws. Every line that cannot be used comes back in `rejected` with a
 * plain reason.
 */
export function parseUpload(text: string, defaultKind: DoNotContactKind = 'company'): UploadParse {
  const lines = (text ?? '').replace(/^﻿/, '').split(/\r\n|\r|\n/);
  const firstData = lines.find(l => l.trim() !== '' && !l.trim().startsWith('#')) ?? '';
  const delimiter = firstData.includes('\t') ? '\t' : ',';

  const result: UploadParse = { entries: [], rejected: [], duplicates: 0, overLimit: 0 };
  const seen = new Set<string>();
  let columns: Array<Column | null> | null = null;
  let headerChecked = false;

  const add = (kind: DoNotContactKind, raw: string, line: number) => {
    const n = normalizeEntry(kind, raw);
    if (!n.ok) {
      result.rejected.push({ line, value: shorten(raw), reason: n.reason });
      return;
    }
    const key = `${kind}:${n.normalized}`;
    if (seen.has(key)) { result.duplicates++; return; }
    if (result.entries.length >= DO_NOT_CONTACT_LIMIT) { result.overLimit++; return; }
    seen.add(key);
    result.entries.push({ kind, value: n.value, normalized: n.normalized, line });
  };

  const unstated = (raw: string): DoNotContactKind => detectKind(raw) ?? defaultKind;

  lines.forEach((rawLine, index) => {
    const line = index + 1;
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) return;

    const cells = splitLine(rawLine, delimiter);

    if (!headerChecked) {
      headerChecked = true;
      columns = headerColumns(cells);
      if (columns) return;
    }

    if (columns) {
      const cols = columns;
      // An unquoted comma inside the last column's value spills into extra
      // cells; fold them back into that column.
      const row = cells.length > cols.length
        ? [...cells.slice(0, cols.length - 1), cells.slice(cols.length - 1).join(', ')]
        : cells;
      const kindAt = cols.indexOf('kind');
      const stated = kindAt >= 0 ? (row[kindAt] ?? '').trim() : '';
      const rowKind = stated ? kindWord(stated) : null;
      if (stated && !rowKind) {
        result.rejected.push({ line, value: shorten(trimmed), reason: 'Unknown kind. Use company, person, email or domain.' });
        return;
      }
      cols.forEach((col, i) => {
        const cell = (row[i] ?? '').trim();
        if (!cell || col === null || col === 'kind') return;
        add(col === 'value' ? (rowKind ?? unstated(cell)) : col, cell, line);
      });
      return;
    }

    const leadingKind = cells.length >= 2 ? kindWord(cells[0]) : null;
    if (leadingKind) {
      const value = cells.slice(1).filter(Boolean).join(', ');
      if (!value) {
        result.rejected.push({ line, value: shorten(trimmed), reason: 'Enter a value.' });
        return;
      }
      add(leadingKind, value, line);
      return;
    }

    if (cells.length > 2) {
      result.rejected.push({
        line,
        value:  shorten(trimmed),
        reason: 'Too many columns. Use one value per line, or kind,value.',
      });
      return;
    }

    const value = cells.filter(Boolean).join(', ');
    add(unstated(value), value, line);
  });

  return result;
}

// ─── Matching ─────────────────────────────────────────────────────────────────

export interface DoNotContactEntry {
  id?:        string;
  kind:       DoNotContactKind;
  value?:     string;
  normalized: string;
}

export interface ExpertIdentity {
  email?:   string | null;
  name?:    string | null;
  company?: string | null;
}

interface ExpertKeys {
  email:   string | null;
  /** The address's domain and every parent with two labels or more. */
  domains: string[];
  company: string | null;
  /**
   * The company name and every leading run of its whole words, longest first:
   * "meta platforms" → ["meta platforms", "meta"]. A listed company blocks any
   * company whose name STARTS with it (founder's call, 2026-10-17): a missed
   * match is a compliance breach, an extra one only skips an expert, and the
   * client sees why. Whole words only, so "meta" never matches "metallica".
   */
  companyPrefixes: string[];
  person:  string | null;
}

function expertKeys(expert: ExpertIdentity): ExpertKeys {
  const email  = expert.email ? normalizeEmailValue(expert.email) : null;
  const host   = email ? email.slice(email.indexOf('@') + 1) : null;
  const labels = host ? host.split('.') : [];
  const domains: string[] = [];
  for (let i = 0; i + 2 <= labels.length; i++) domains.push(labels.slice(i).join('.'));
  const company = expert.company ? normalizeCompanyValue(expert.company) : null;
  const words   = company ? company.split(' ').filter(Boolean) : [];
  const companyPrefixes: string[] = [];
  for (let n = words.length; n >= 1; n--) companyPrefixes.push(words.slice(0, n).join(' '));
  return {
    email,
    domains,
    company,
    companyPrefixes,
    person:  expert.name    ? normalizePersonValue(expert.name)     : null,
  };
}

/**
 * Every normalized value an entry would need to hold to match this expert.
 * The store looks up exactly these, so the database never returns more than
 * a handful of rows however long the list is.
 */
export function lookupValues(expert: ExpertIdentity): string[] {
  const keys = expertKeys(expert);
  const values = [keys.email, ...keys.domains, ...keys.companyPrefixes, keys.person]
    .filter((v): v is string => !!v);
  return Array.from(new Set(values));
}

/**
 * The first entry this expert is on, or null.
 *
 *   email    the address, exactly
 *   domain   the address's domain, or any subdomain of it
 *   company  the expert's company, or any company whose name it starts
 *            with, on whole words ("Meta" covers "Meta Platforms")
 *   person   the expert's first and last name
 */
export function matchExpert(
  list:   readonly DoNotContactEntry[],
  expert: ExpertIdentity,
): DoNotContactEntry | null {
  const keys = expertKeys(expert);
  for (const entry of list) {
    switch (entry.kind) {
      case 'email':
        if (keys.email && entry.normalized === keys.email) return entry;
        break;
      case 'domain':
        if (keys.domains.includes(entry.normalized)) return entry;
        break;
      case 'company':
        if (keys.companyPrefixes.includes(entry.normalized)) return entry;
        break;
      case 'person':
        if (keys.person && entry.normalized === keys.person) return entry;
        break;
    }
  }
  return null;
}

// ─── Counting and the cap ─────────────────────────────────────────────────────

export type KindCounts = Record<DoNotContactKind, number> & { total: number };

export function countByKind(entries: ReadonlyArray<{ kind: DoNotContactKind }>): KindCounts {
  const counts: KindCounts = { company: 0, person: 0, email: 0, domain: 0, total: 0 };
  for (const e of entries) {
    counts[e.kind]++;
    counts.total++;
  }
  return counts;
}

export interface AdditionPlan {
  /** New to the list, in upload order. */
  add:           ParsedEntry[];
  /** Already on the list, skipped. */
  alreadyListed: number;
  /** True when adding `add` would take the list past the cap; nothing is added. */
  overCap:       boolean;
  /** Entries the list still has room for. */
  room:          number;
}

/** What an add or an upload would actually change, and whether it fits. */
export function planAdditions(
  existing: ReadonlyArray<{ kind: DoNotContactKind; normalized: string }>,
  incoming: readonly ParsedEntry[],
  limit = DO_NOT_CONTACT_LIMIT,
): AdditionPlan {
  const listed = new Set(existing.map(e => `${e.kind}:${e.normalized}`));
  const add: ParsedEntry[] = [];
  let alreadyListed = 0;
  for (const entry of incoming) {
    const key = `${entry.kind}:${entry.normalized}`;
    if (listed.has(key)) { alreadyListed++; continue; }
    listed.add(key);
    add.push(entry);
  }
  const room = Math.max(0, limit - existing.length);
  return { add, alreadyListed, overCap: add.length > room, room };
}

// ─── Who may see and change the list ──────────────────────────────────────────

export interface ListViewer {
  role:     'admin' | 'user';
  orgId?:   string | null;
  orgRole?: 'org_admin' | 'org_member' | null;
}

export type ListAccess =
  | { ok: true;  orgId: string; canManage: boolean }
  | { ok: false; error: 'no_organization' };

/**
 * The organization a request acts on, and whether the caller may change it.
 * Same scoping rule as app/api/org/members: platform staff may name any
 * organization (?orgId=) and always manage; everyone else gets their own
 * organization only, and manages it only as its champion (org_admin). An orgId
 * that is not the caller's own is refused, never silently swapped.
 */
export function decideListAccess(viewer: ListViewer, requestedOrgId?: string | null): ListAccess {
  const asked = (requestedOrgId ?? '').trim();
  if (viewer.role === 'admin') {
    const orgId = asked || viewer.orgId || '';
    return orgId ? { ok: true, orgId, canManage: true } : { ok: false, error: 'no_organization' };
  }
  const own = viewer.orgId ?? '';
  if (!own || (asked && asked !== own)) return { ok: false, error: 'no_organization' };
  return { ok: true, orgId: own, canManage: viewer.orgRole === 'org_admin' };
}

// ─── Reading the list ─────────────────────────────────────────────────────────

export interface StoreError {
  code?:    string | null;
  message?: string | null;
}

/**
 * True when the error says the table itself is not there yet: PostgREST's
 * PGRST205 (not in the schema cache) or Postgres 42P01 (undefined_table). The
 * message fallback only counts when it names this table, so a missing COLUMN
 * ("column ... does not exist") can never pass for an empty list.
 */
export function isMissingTableError(error: StoreError | null | undefined): boolean {
  if (!error) return false;
  if (error.code === 'PGRST205' || error.code === '42P01') return true;
  const message = error.message ?? '';
  return /organization_do_not_contact/i.test(message)
    && /does not exist|could not find the table/i.test(message);
}

type StoreResult<T> = { data: T; error: null } | { data: null; error: StoreError };

/** The two reads a check needs. Injected, so tests can fail them on purpose. */
export interface DoNotContactStore {
  /** The organization a project belongs to; data null when there is no such project. */
  organizationOfProject(projectId: string): Promise<StoreResult<string | null>>;
  /** Entries of this organization whose normalized value is one of `values`. */
  findEntries(organizationId: string, values: string[]): Promise<StoreResult<DoNotContactEntry[]>>;
}

export type DoNotContactCheck =
  | { ok: true;  match: DoNotContactEntry | null; listMissing?: true }
  | { ok: false; reason: 'unavailable' };

const UNAVAILABLE: DoNotContactCheck = { ok: false, reason: 'unavailable' };

/** Is this expert on this organization's list? Never throws; see the failure rule. */
export async function checkDoNotContactForOrganization(
  store:          DoNotContactStore,
  organizationId: string,
  expert:         ExpertIdentity,
): Promise<DoNotContactCheck> {
  const values = lookupValues(expert);
  if (values.length === 0) return { ok: true, match: null };
  try {
    const found = await store.findEntries(organizationId, values);
    if (found.error) {
      if (isMissingTableError(found.error)) return { ok: true, match: null, listMissing: true };
      console.error('[doNotContact] read error:', (found.error.message ?? '').slice(0, 120));
      return UNAVAILABLE;
    }
    return { ok: true, match: matchExpert(found.data, expert) };
  } catch (err) {
    console.error('[doNotContact] read threw:', err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return UNAVAILABLE;
  }
}

/**
 * Is this expert on the list of the organization that owns this project?
 * A project we cannot place in an organization is unavailable, never clear.
 */
export async function checkDoNotContact(
  store:     DoNotContactStore,
  projectId: string,
  expert:    ExpertIdentity,
): Promise<DoNotContactCheck> {
  if (lookupValues(expert).length === 0) return { ok: true, match: null };
  try {
    const org = await store.organizationOfProject(projectId);
    if (org.error || !org.data) {
      if (org.error) console.error('[doNotContact] project read error:', (org.error.message ?? '').slice(0, 120));
      return UNAVAILABLE;
    }
    return await checkDoNotContactForOrganization(store, org.data, expert);
  } catch (err) {
    console.error('[doNotContact] project read threw:', err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return UNAVAILABLE;
  }
}

/**
 * The answer when there is no database client at all. In production that is a
 * misconfiguration and the list cannot be read, so it holds. In development the
 * in-memory project store (lib/projectStore) is in use and there is nowhere a
 * list could live, which is the same as a table not created yet: empty.
 */
export function checkWithoutDatabase(): DoNotContactCheck {
  return process.env.NODE_ENV === 'production'
    ? UNAVAILABLE
    : { ok: true, match: null, listMissing: true };
}

type DoNotContactRow = Database['public']['Tables']['organization_do_not_contact']['Row'];

export function rowToEntry(row: Pick<DoNotContactRow, 'id' | 'kind' | 'value' | 'value_normalized'>): DoNotContactEntry {
  return { id: row.id, kind: row.kind, value: row.value, normalized: row.value_normalized };
}

/** The store over the service-role client (lib/supabase/admin). Server only by use. */
export function supabaseDoNotContactStore(db: SupabaseClient<Database>): DoNotContactStore {
  return {
    async organizationOfProject(projectId) {
      const { data, error } = await db
        .from('projects')
        .select('organization_id')
        .eq('id', projectId)
        .maybeSingle();
      if (error) return { data: null, error };
      return { data: data?.organization_id ?? null, error: null };
    },
    async findEntries(organizationId, values) {
      const { data, error } = await db
        .from('organization_do_not_contact')
        .select('id, kind, value, value_normalized')
        .eq('organization_id', organizationId)
        .in('value_normalized', values)
        .limit(100);
      if (error) return { data: null, error };
      return { data: (data ?? []).map(rowToEntry), error: null };
    },
  };
}
