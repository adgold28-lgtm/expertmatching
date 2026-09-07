// scripts/verify-schema.ts — does production actually have what the migrations say?
//
//   npx tsx scripts/verify-schema.ts            # check every migration
//   npx tsx scripts/verify-schema.ts --verbose  # list the PRESENT rows too
//   npx tsx scripts/verify-schema.ts --file 20260907100000  # one migration
//
// (There is deliberately no `npm run verify:schema` — package.json is not
// this change's to edit. Run it with npx tsx as above; every other verification
// script in scripts/ is run the same way.)
//
// WHY THIS EXISTS. The Supabase CLI is not linked to this project: migrations
// are applied by pasting SQL into the Studio editor, by hand, one at a time.
// That has already gone wrong once — two migrations were recorded as applied
// and were not, and the first anyone knew was a 500 on the onboarding billing
// step in production. A file in supabase/migrations/ is a claim about
// production, and this script is what checks the claim.
//
// WHAT IT PARSES, from every file in supabase/migrations/:
//   create table [if not exists] public.X
//   alter table public.X add column [if not exists] Y
//   create [unique] index [if not exists] Z on public.X
//   create policy P on public.X
//
// WHAT IT CAN VERIFY, and what it honestly cannot:
//   tables   — a `select ... limit 1`; a missing table fails the request.
//   columns  — a `select <column> ... limit 1`; PostgREST rejects an unknown
//              column, which is exactly the signal we want.
//   indexes  — pg_indexes, and policies pg_policies, are NOT reachable over
//              PostgREST: they live in pg_catalog, which is not exposed. They
//              can only be checked through a SQL-executing `rpc`. This script
//              probes for one (see SQL_RPC_CANDIDATES) and, when none exists,
//              says so rather than quietly reporting them as fine. An
//              unverifiable check is never printed as a pass.
//
// Read-only: every query is a `limit 1` select. It writes nothing and creates
// nothing.
//
// Exits 1 when any table or column is MISSING (a real, checkable failure),
// 2 when the credentials are absent. Unverifiable indexes and policies do NOT
// fail the run — they are reported as SKIPPED with the reason.
//
// Reads NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY from .env.local
// when they are not already in the environment.

import * as fs   from 'fs';
import * as path from 'path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// ─── .env.local loader ────────────────────────────────────────────────────────
// Same minimal parser as the other verify scripts — no dotenv dependency.
// Only sets keys absent from process.env, so shell vars win.

function loadEnvLocal(): void {
  const envPath = path.resolve(__dirname, '..', '.env.local');
  if (!fs.existsSync(envPath)) return;

  for (const raw of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let   val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

loadEnvLocal();

// ─── CLI ──────────────────────────────────────────────────────────────────────

const args      = process.argv.slice(2);
const verbose   = args.includes('--verbose') || args.includes('-v');
const fileIndex = args.findIndex(a => a === '--file' || a === '-f');
const fileMatch = fileIndex !== -1 ? args[fileIndex + 1] : null;

// ─── Client ───────────────────────────────────────────────────────────────────

function serviceRoleClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
    console.error('Set them in .env.local or the shell, then re-run.');
    process.exit(2);
  }

  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

// ─── Parsing ──────────────────────────────────────────────────────────────────

interface TableTarget  { kind: 'table';  name: string; file: string }
interface ColumnTarget { kind: 'column'; table: string; name: string; file: string }
interface IndexTarget  { kind: 'index';  name: string; table: string | null; file: string }
interface PolicyTarget { kind: 'policy'; name: string; table: string; file: string }

type Target = TableTarget | ColumnTarget | IndexTarget | PolicyTarget;

/**
 * Strips SQL comments so a commented-out `create table` in a file header (this
 * repo's migrations all carry long prose headers) is never mistaken for DDL.
 * Handles `-- line` and `/* block *​/` forms, and leaves string literals alone —
 * a `--` inside quotes is not a comment.
 */
function stripComments(sql: string): string {
  let out = '';
  let i = 0;
  let inLine = false;
  let inBlock = false;
  let quote: string | null = null;

  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];

    if (inLine) {
      if (c === '\n') { inLine = false; out += c; }
      i++;
      continue;
    }
    if (inBlock) {
      if (c === '*' && next === '/') { inBlock = false; i += 2; continue; }
      i++;
      continue;
    }
    if (quote) {
      out += c;
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; out += c; i++; continue; }
    if (c === '-' && next === '-') { inLine = true; i += 2; continue; }
    if (c === '/' && next === '*') { inBlock = true; i += 2; continue; }

    out += c;
    i++;
  }

  return out;
}

const IF_NOT_EXISTS = '(?:if\\s+not\\s+exists\\s+)?';
const IDENT         = '([A-Za-z_][A-Za-z0-9_]*)';

/**
 * Every `add column` clause inside one `alter table` statement. Postgres allows
 * several, comma-separated — this repo's profiles migration adds two at once —
 * so a per-statement scan is required, not a per-line one.
 */
function columnsFromAlter(statement: string): string[] {
  const re = new RegExp(`add\\s+column\\s+${IF_NOT_EXISTS}${IDENT}`, 'gi');
  const names: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(statement)) !== null) names.push(match[1].toLowerCase());
  return names;
}

function parseMigration(sql: string, file: string): Target[] {
  const clean   = stripComments(sql);
  const targets: Target[] = [];

  // Statement-at-a-time, so a multi-clause ALTER stays together.
  for (const raw of clean.split(';')) {
    const statement = raw.trim();
    if (!statement) continue;
    const flat = statement.replace(/\s+/g, ' ');

    // create table [if not exists] public.X
    const table = new RegExp(`^create\\s+table\\s+${IF_NOT_EXISTS}(?:public\\.)?${IDENT}`, 'i').exec(flat);
    if (table) {
      targets.push({ kind: 'table', name: table[1].toLowerCase(), file });
      continue;
    }

    // alter table public.X add column [if not exists] Y[, add column ...]
    const alter = new RegExp(`^alter\\s+table\\s+(?:only\\s+)?(?:public\\.)?${IDENT}`, 'i').exec(flat);
    if (alter) {
      const tableName = alter[1].toLowerCase();
      for (const column of columnsFromAlter(flat)) {
        targets.push({ kind: 'column', table: tableName, name: column, file });
      }
      continue;
    }

    // create [unique] index [concurrently] [if not exists] Z on public.X
    const index = new RegExp(
      `^create\\s+(?:unique\\s+)?index\\s+(?:concurrently\\s+)?${IF_NOT_EXISTS}${IDENT}\\s+on\\s+(?:public\\.)?${IDENT}`,
      'i',
    ).exec(flat);
    if (index) {
      targets.push({ kind: 'index', name: index[1].toLowerCase(), table: index[2].toLowerCase(), file });
      continue;
    }

    // create policy P on public.X
    const policy = new RegExp(`^create\\s+policy\\s+${IDENT}\\s+on\\s+(?:public\\.)?${IDENT}`, 'i').exec(flat);
    if (policy) {
      targets.push({ kind: 'policy', name: policy[1].toLowerCase(), table: policy[2].toLowerCase(), file });
      continue;
    }
  }

  return targets;
}

// ─── Checking ─────────────────────────────────────────────────────────────────

type Status = 'PRESENT' | 'MISSING' | 'SKIPPED';

interface Result {
  status: Status;
  label:  string;
  file:   string;
  detail: string;
}

/** PostgREST codes that mean "the relation is not there". */
function isMissingTableError(code: string, message: string): boolean {
  return code === '42P01' || code === 'PGRST205' || /does not exist/i.test(message);
}

/** PostgREST codes that mean "the column is not there". */
function isMissingColumnError(code: string, message: string): boolean {
  return code === '42703' || code === 'PGRST204' || /column .* does not exist/i.test(message);
}

async function checkTable(db: SupabaseClient, name: string): Promise<{ ok: boolean; detail: string }> {
  const { error } = await db.from(name).select('*').limit(1);
  if (!error) return { ok: true, detail: '' };
  if (isMissingTableError(error.code ?? '', error.message)) {
    return { ok: false, detail: 'relation not found' };
  }
  // An RLS refusal or any other error still proves the relation exists — the
  // service role bypasses RLS, so in practice this is a genuine oddity worth
  // printing rather than swallowing.
  return { ok: true, detail: `readable with a caveat: ${error.message.slice(0, 60)}` };
}

async function checkColumn(
  db: SupabaseClient, table: string, column: string,
): Promise<{ ok: boolean; detail: string }> {
  const { error } = await db.from(table).select(column).limit(1);
  if (!error) return { ok: true, detail: '' };
  if (isMissingColumnError(error.code ?? '', error.message)) {
    return { ok: false, detail: 'column not found' };
  }
  if (isMissingTableError(error.code ?? '', error.message)) {
    return { ok: false, detail: 'table not found' };
  }
  return { ok: true, detail: `readable with a caveat: ${error.message.slice(0, 60)}` };
}

// ─── Index / policy checking via a SQL rpc, when one exists ───────────────────

/**
 * Names a project sometimes exposes for "run this SQL". None of them exist in
 * this project today — the probe is here so that the day one is added, indexes
 * and policies start being verified without a code change.
 */
const SQL_RPC_CANDIDATES = ['exec_sql', 'execute_sql', 'sql', 'run_sql'] as const;

interface CatalogReader {
  indexes:  Set<string>;
  policies: Set<string>;
  via:      string;
}

/** Rows a SQL rpc might return for the catalog probes. */
function namesFrom(payload: unknown, key: string): string[] {
  if (!Array.isArray(payload)) return [];
  const names: string[] = [];
  for (const row of payload) {
    if (row === null || typeof row !== 'object') continue;
    const value = (row as Record<string, unknown>)[key];
    if (typeof value === 'string') names.push(value.toLowerCase());
  }
  return names;
}

/**
 * Tries to read pg_indexes / pg_policies through a SQL-executing rpc. Returns
 * null when there is no such function — the honest, expected outcome here.
 */
async function catalogReader(db: SupabaseClient): Promise<CatalogReader | null> {
  for (const fn of SQL_RPC_CANDIDATES) {
    try {
      const probe = await db.rpc(fn, { query: 'select indexname from pg_indexes where schemaname = \'public\'' });
      if (probe.error) continue;

      const indexNames = namesFrom(probe.data, 'indexname');
      if (indexNames.length === 0) continue;

      const policyProbe = await db.rpc(fn, { query: 'select policyname from pg_policies where schemaname = \'public\'' });
      const policyNames = policyProbe.error ? [] : namesFrom(policyProbe.data, 'policyname');

      return {
        indexes:  new Set(indexNames),
        policies: new Set(policyNames),
        via:      fn,
      };
    } catch {
      // Wrong argument name, wrong return type, no such function — try the next.
    }
  }
  return null;
}

// ─── Output ───────────────────────────────────────────────────────────────────

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function printTable(rows: Result[]): void {
  const statusWidth = 7;
  const labelWidth  = Math.min(52, Math.max(20, ...rows.map(r => r.label.length)));
  const fileWidth   = Math.min(30, Math.max(10, ...rows.map(r => r.file.length)));

  console.log('');
  console.log(`${pad('STATUS', statusWidth)}  ${pad('OBJECT', labelWidth)}  ${pad('MIGRATION', fileWidth)}  NOTE`);
  console.log(`${'-'.repeat(statusWidth)}  ${'-'.repeat(labelWidth)}  ${'-'.repeat(fileWidth)}  ----`);

  for (const row of rows) {
    console.log(
      `${pad(row.status, statusWidth)}  ${pad(row.label.slice(0, labelWidth), labelWidth)}  `
      + `${pad(row.file.slice(0, fileWidth), fileWidth)}  ${row.detail}`,
    );
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const dir = path.resolve(__dirname, '..', 'supabase', 'migrations');
  if (!fs.existsSync(dir)) {
    console.error(`No migrations directory at ${dir}`);
    process.exit(2);
  }

  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.sql'))
    .filter(f => (fileMatch ? f.includes(fileMatch) : true))
    .sort();

  if (files.length === 0) {
    console.error(fileMatch ? `No migration matching "${fileMatch}".` : 'No .sql migrations found.');
    process.exit(2);
  }

  // Parse first, so a bad regex fails before any network call.
  const targets: Target[] = [];
  for (const file of files) {
    targets.push(...parseMigration(fs.readFileSync(path.join(dir, file), 'utf8'), file));
  }

  // De-duplicate: `create table if not exists` for the same table appears in
  // more than one migration, and re-checking it says nothing new.
  const seen = new Set<string>();
  const unique = targets.filter(t => {
    const key =
      t.kind === 'table'  ? `table:${t.name}`
      : t.kind === 'column' ? `column:${t.table}.${t.name}`
      : t.kind === 'index'  ? `index:${t.name}`
      : `policy:${t.table}.${t.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`Parsed ${files.length} migration file(s) → ${unique.length} distinct object(s).`);

  const db      = serviceRoleClient();
  const catalog = await catalogReader(db);

  const results: Result[] = [];
  let missing = 0;
  let skipped = 0;

  for (const target of unique) {
    if (target.kind === 'table') {
      const { ok, detail } = await checkTable(db, target.name);
      if (!ok) missing++;
      results.push({
        status: ok ? 'PRESENT' : 'MISSING',
        label:  `table  ${target.name}`,
        file:   target.file,
        detail,
      });
      continue;
    }

    if (target.kind === 'column') {
      const { ok, detail } = await checkColumn(db, target.table, target.name);
      if (!ok) missing++;
      results.push({
        status: ok ? 'PRESENT' : 'MISSING',
        label:  `column ${target.table}.${target.name}`,
        file:   target.file,
        detail,
      });
      continue;
    }

    if (target.kind === 'index') {
      if (!catalog) {
        skipped++;
        results.push({
          status: 'SKIPPED', label: `index  ${target.name}`, file: target.file,
          detail: 'not checkable via REST',
        });
        continue;
      }
      const present = catalog.indexes.has(target.name);
      if (!present) missing++;
      results.push({
        status: present ? 'PRESENT' : 'MISSING',
        label:  `index  ${target.name}`,
        file:   target.file,
        detail: present ? `via ${catalog.via}` : 'not in pg_indexes',
      });
      continue;
    }

    // policy
    if (!catalog) {
      skipped++;
      results.push({
        status: 'SKIPPED', label: `policy ${target.table}.${target.name}`, file: target.file,
        detail: 'not checkable via REST',
      });
      continue;
    }
    const present = catalog.policies.has(target.name);
    if (!present) missing++;
    results.push({
      status: present ? 'PRESENT' : 'MISSING',
      label:  `policy ${target.table}.${target.name}`,
      file:   target.file,
      detail: present ? `via ${catalog.via}` : 'not in pg_policies',
    });
  }

  const shown = verbose ? results : results.filter(r => r.status !== 'PRESENT');
  if (shown.length > 0) printTable(shown);
  else console.log('\nEverything checkable is PRESENT.');

  const present = results.filter(r => r.status === 'PRESENT').length;

  console.log('');
  console.log(`PRESENT ${present}   MISSING ${missing}   SKIPPED ${skipped}`);

  if (!catalog) {
    console.log('');
    console.log('policies/indexes: not checkable via REST — pg_indexes and pg_policies live in');
    console.log('pg_catalog, which PostgREST does not expose, and this project has no SQL rpc.');
    console.log('Verify them in the Supabase Studio SQL editor:');
    console.log("  select indexname  from pg_indexes  where schemaname = 'public' order by 1;");
    console.log("  select policyname from pg_policies where schemaname = 'public' order by 1;");
  }

  if (missing > 0) {
    console.log('');
    console.log(`FAIL — ${missing} object(s) in supabase/migrations/ are not in production.`);
    console.log('Paste the migration(s) named above into the Supabase Studio SQL editor and re-run.');
    process.exit(1);
  }

  console.log(`\nPASS — every checkable object from ${files.length} migration file(s) is in production.`);
}

main().catch((err: unknown) => {
  console.error('verify-schema failed:', err instanceof Error ? err.message : String(err));
  process.exit(2);
});
