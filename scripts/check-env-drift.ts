// scripts/check-env-drift.ts — the two environment-variable invariants that
// nothing else in the repository checks (ARCHITECTURE-AUDIT.md M-50, M-51).
//
//   npx tsx scripts/check-env-drift.ts
//
// 1. NOTHING IS REQUIRED THAT NOTHING READS. Every name in validateEnv's
//    REQUIRED_VARS and OPTIONAL_VARS, and every key in .env.example, must be
//    read by real code. A variable in REQUIRED_VARS that nothing reads FAILS A
//    PRODUCTION BOOT for a value the app has no use for (M-50: that is exactly
//    what GOOGLE_CALENDAR_REFRESH_TOKEN and STRIPE_CONNECT_CLIENT_ID did), and
//    a documented-but-unread one sends the operator hunting for a credential
//    that does not exist.
//
// 2. NOTHING IS READ THAT NOBODY CAN SEE. Every variable the running code reads
//    must appear in one of validateEnv's two lists AND in .env.example.
//    GET /api/admin/env-status iterates those lists and nothing else, so a
//    variable missing from them is invisible in the product — including the two
//    kill switches, PROJECTS_ENABLED and DISABLE_EMAILS (M-51).
//
// Reads are found by scanning app/, lib/, components/, middleware.ts and
// instrumentation.ts for `process.env.NAME` and for NAME inside a
// `const { A, B } = process.env` destructure (lib/createZoomMeeting.ts uses the
// second form). Pure: no network, no database, no secrets — it never reads a
// VALUE, only the source text.
//
// Exits non-zero on the first failing invariant, so it can gate a deploy.

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { REQUIRED_VARS, OPTIONAL_VARS } from '../lib/validateEnv';

let checks = 0;
let failures = 0;

function check(label: string, ok: boolean, detail?: string): void {
  checks += 1;
  if (ok) {
    console.log(`  ok    ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`);
  }
}

// ── What counts as "read by real code" ───────────────────────────────────────

const SCAN_ROOTS = ['app', 'lib', 'components'];
const SCAN_FILES = ['middleware.ts', 'instrumentation.ts'];
const REPO_ROOT  = join(__dirname, '..');

/**
 * Supplied by the runtime, never by an operator, so they belong in neither
 * validateEnv nor .env.example.
 */
const RUNTIME_BUILTINS = new Set(['NODE_ENV', 'NEXT_RUNTIME']);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

function readVariables(): Set<string> {
  const found = new Set<string>();
  const files = [
    ...SCAN_ROOTS.flatMap(d => sourceFiles(join(REPO_ROOT, d))),
    ...SCAN_FILES.map(f => join(REPO_ROOT, f)),
  ];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    // process.env.NAME  and  process.env['NAME']
    for (const m of text.matchAll(/process\.env(?:\.([A-Z0-9_]+)|\['([A-Z0-9_]+)'\])/g)) {
      found.add((m[1] ?? m[2]) as string);
    }
    // const { A, B } = process.env
    for (const m of text.matchAll(/\{([^{}]*)\}\s*=\s*process\.env/g)) {
      for (const name of (m[1] as string).split(',')) {
        const clean = name.split(':')[0]?.trim() ?? '';
        if (/^[A-Z0-9_]+$/.test(clean)) found.add(clean);
      }
    }
  }
  return found;
}

function envExampleKeys(): Set<string> {
  const text = readFileSync(join(REPO_ROOT, '.env.example'), 'utf8');
  const keys = new Set<string>();
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=/);
    if (m) keys.add(m[1] as string);
  }
  return keys;
}

const read       = readVariables();
const documented = envExampleKeys();
const required   = new Set<string>(REQUIRED_VARS);
const optional   = new Set<string>(OPTIONAL_VARS);
const listed     = new Set<string>([...required, ...optional]);

// ── 1. Nothing is required or documented that nothing reads (M-50) ───────────

console.log('\n── M-50: no variable is demanded that no code reads ──');

const requiredButUnread = [...required].filter(n => !read.has(n)).sort();
check(
  'every REQUIRED_VARS entry is read somewhere — an unread one fails a production boot for nothing',
  requiredButUnread.length === 0,
  requiredButUnread.length ? `unread: ${requiredButUnread.join(', ')}` : undefined,
);

const optionalButUnread = [...optional].filter(n => !read.has(n)).sort();
check(
  'every OPTIONAL_VARS entry is read somewhere — the admin console must not advertise a dead knob',
  optionalButUnread.length === 0,
  optionalButUnread.length ? `unread: ${optionalButUnread.join(', ')}` : undefined,
);

const documentedButUnread = [...documented].filter(n => !read.has(n)).sort();
check(
  'every .env.example key is read somewhere — a documented ghost sends the operator hunting',
  documentedButUnread.length === 0,
  documentedButUnread.length ? `unread: ${documentedButUnread.join(', ')}` : undefined,
);

// ── 2. Nothing is read that the operator cannot see (M-51) ───────────────────

console.log('\n── M-51: every variable the code reads is visible to the operator ──');

const readButUnlisted = [...read].filter(n => !RUNTIME_BUILTINS.has(n) && !listed.has(n)).sort();
check(
  'every variable read by app code is in REQUIRED_VARS or OPTIONAL_VARS — env-status iterates only those',
  readButUnlisted.length === 0,
  readButUnlisted.length ? `invisible in /api/admin/env-status: ${readButUnlisted.join(', ')}` : undefined,
);

const readButUndocumented = [...read].filter(n => !RUNTIME_BUILTINS.has(n) && !documented.has(n)).sort();
check(
  'every variable read by app code is in .env.example — a fresh checkout must be able to boot',
  readButUndocumented.length === 0,
  readButUndocumented.length ? `undocumented: ${readButUndocumented.join(', ')}` : undefined,
);

// ── 3. The two kill switches are named, not just implied ─────────────────────

console.log('\n── the kill switches are operator-visible by name ──');

for (const name of ['PROJECTS_ENABLED', 'DISABLE_EMAILS']) {
  check(`${name} is listed in validateEnv`,  listed.has(name));
  check(`${name} is in .env.example`,        documented.has(name));
}

// ── Result ───────────────────────────────────────────────────────────────────

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks} checks passed`);
console.log(`(${read.size} variables read, ${listed.size} listed in validateEnv, ${documented.size} in .env.example)`);
process.exit(failures === 0 ? 0 : 1);
