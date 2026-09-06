// scripts/verify-matchy-migration.ts
//
// Checks that supabase/migrations/20260907000000_matchy_phase1.sql has actually
// been applied. The Supabase CLI is not linked to this project, so migrations
// are run by pasting them into the Studio SQL editor — which means "did it
// land?" is a question worth being able to answer in one command.
//
//   npx tsx scripts/verify-matchy-migration.ts
//
// Reads SUPABASE credentials from .env.local when they are not already in the
// environment. Read-only: every check is a `select ... limit 0` through the
// service-role client, so it touches no rows and creates nothing.
//
// Exits non-zero if anything is MISSING.

import * as fs   from 'fs';
import * as path from 'path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// ─── .env.local loader ────────────────────────────────────────────────────────
// Same minimal parser as scripts/check-availability.ts — no dotenv dependency.
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

// ─── Checks ───────────────────────────────────────────────────────────────────

/** One thing the migration was supposed to create. */
interface Target {
  label:   string;
  table:   string;
  /** Columns to select. A missing column makes PostgREST fail the request. */
  columns: string;
}

const TARGETS: Target[] = [
  {
    label:   'table  conversation_messages',
    table:   'conversation_messages',
    columns: 'id, project_id, expert_id, direction, author, body_raw, body_clean, summary, intent, screen_result, resend_message_id, created_at',
  },
  {
    label:   'table  engagement_events',
    table:   'engagement_events',
    columns: 'id, project_id, expert_id, org_id, type, payload, created_at',
  },
  {
    label:   'column organizations.firm_type / firm_size',
    table:   'organizations',
    columns: 'id, firm_type, firm_size',
  },
  {
    label:   'column access_requests.firm_type / firm_size',
    table:   'access_requests',
    columns: 'id, firm_type, firm_size',
  },
  {
    label:   'column projects.review_first / client_rate_min / client_rate_max',
    table:   'projects',
    columns: 'id, review_first, client_rate_min, client_rate_max',
  },
];

async function check(db: SupabaseClient, target: Target): Promise<boolean> {
  // limit(0) reads no rows; PostgREST still validates every column name, so a
  // missing table or column comes back as an error rather than an empty set.
  const { error } = await db.from(target.table).select(target.columns).limit(0);

  if (!error) {
    console.log(`PRESENT  ${target.label}`);
    return true;
  }

  console.log(`MISSING  ${target.label}`);
  console.log(`         ${error.message.slice(0, 160)}`);
  return false;
}

async function main(): Promise<void> {
  const db = serviceRoleClient();

  console.log('\nMatchy Phase 1 — 20260907000000_matchy_phase1.sql\n');

  let missing = 0;
  for (const target of TARGETS) {
    const ok = await check(db, target);
    if (!ok) missing++;
  }

  if (missing > 0) {
    console.log(`\n${missing} of ${TARGETS.length} MISSING.`);
    console.log('Paste supabase/migrations/20260907000000_matchy_phase1.sql into the');
    console.log('Supabase Studio SQL editor and run it, then re-run this script.\n');
    process.exit(1);
  }

  console.log(`\nAll ${TARGETS.length} present — the migration is applied.\n`);
}

main().catch((err: unknown) => {
  console.error('verify failed:', err instanceof Error ? err.message : String(err));
  process.exit(2);
});
