/**
 * scripts/seed-admin.ts
 *
 * Bootstraps the platform: creates (or updates) the platform-admin account in
 * Supabase Auth, marks it is_platform_admin, and ensures a home organization
 * so the admin can create projects.
 *
 * Usage:
 *   npx tsx scripts/seed-admin.ts <email> [--org-domain <domain>] [--org-name <name>]
 *
 * The password is read from the SEED_ADMIN_PASSWORD env var (never argv — argv
 * leaks into shell history and process lists).
 *
 * Required env vars (in .env.local):
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   SEED_ADMIN_PASSWORD
 *
 * Idempotent — safe to re-run; existing accounts get their password and
 * metadata updated.
 */

import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });

async function main(): Promise<void> {
  // Import after dotenv so env vars are populated.
  const { getServiceRoleClient, ensureSupabaseUser, syncAppMetadata } = await import('../lib/supabase/admin');

  const args  = process.argv.slice(2);
  const email = (args[0] ?? '').trim().toLowerCase();

  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };

  if (!email || !email.includes('@')) {
    console.error('\nUsage: npx tsx scripts/seed-admin.ts <email> [--org-domain <domain>] [--org-name <name>]\n');
    process.exit(1);
  }

  const password = process.env.SEED_ADMIN_PASSWORD ?? '';
  if (password.length < 12) {
    console.error('\nError: set SEED_ADMIN_PASSWORD (min 12 chars) in the environment or .env.local.\n');
    process.exit(1);
  }

  const db = getServiceRoleClient();
  if (!db) {
    console.error('\nError: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required in .env.local.\n');
    process.exit(1);
  }

  const orgDomain = (flag('--org-domain') ?? email.split('@')[1] ?? '').toLowerCase();
  const orgName   = flag('--org-name') ?? 'ExpertMatch';

  console.log('\nExpertMatch — Seed platform admin');
  console.log('─'.repeat(50));

  // ── 1. Auth account + password ─────────────────────────────────────────────
  const authId = await ensureSupabaseUser(email, password);
  if (!authId) {
    console.error('\nError: failed to create/update the Supabase auth user.\n');
    process.exit(1);
  }
  console.log('Auth account ready.');

  // ── 2. Platform-admin flag on the profile ──────────────────────────────────
  const { error: profileErr } = await db
    .from('profiles')
    .update({ is_platform_admin: true, onboarding_complete: true })
    .eq('id', authId);
  if (profileErr) {
    console.error('\nError: failed to update profile:', profileErr.message, '\n');
    process.exit(1);
  }
  console.log('Profile marked platform admin.');

  // ── 3. Home organization + membership ──────────────────────────────────────
  let { data: org } = await db.from('organizations').select('id').eq('domain', orgDomain).maybeSingle();
  if (!org) {
    const { data: created, error: orgErr } = await db
      .from('organizations')
      .insert({ domain: orgDomain, name: orgName, plan: 'enterprise', seat_limit: 2147483647 })
      .select('id')
      .single();
    if (orgErr || !created) {
      console.error('\nError: failed to create organization:', orgErr?.message ?? 'unknown', '\n');
      process.exit(1);
    }
    org = created;
    console.log('Organization created.');
  } else {
    console.log('Organization already exists.');
  }

  const { error: memberErr } = await db
    .from('organization_members')
    .upsert(
      { organization_id: org.id, profile_id: authId, role: 'org_admin', status: 'active' },
      { onConflict: 'organization_id,profile_id' },
    );
  if (memberErr) {
    console.error('\nError: failed to create membership:', memberErr.message, '\n');
    process.exit(1);
  }
  console.log('Membership ensured.');

  // ── 4. app_metadata mirror (role/status/firm/org/onboarding) ───────────────
  // org_id + org_role are what orgAdminGuard reads for team management.
  const synced = await syncAppMetadata(email, {
    role:                'admin',
    status:              'active',
    firm_domain:         orgDomain,
    firm_name:           orgName,
    org_id:              org.id,
    org_role:            'org_admin',
    onboarding_complete: true,
  });
  if (!synced) {
    console.error('\nError: failed to sync app_metadata.\n');
    process.exit(1);
  }

  console.log('\nDone. Sign in at /login.');
  console.log(`  Email : ${email}`);
  console.log('  Role  : platform admin\n');
}

main().catch(err => {
  console.error('\nUnexpected error:', err instanceof Error ? err.message : err, '\n');
  process.exit(1);
});
