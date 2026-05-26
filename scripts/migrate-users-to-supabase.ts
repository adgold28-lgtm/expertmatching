/**
 * scripts/migrate-users-to-supabase.ts
 *
 * Pre-creates Supabase Auth accounts for every existing Redis user.
 * Passwords are NOT migrated (scrypt → Supabase bcrypt is not possible).
 * Each account is seeded with a random placeholder password; on the user's
 * first login, the login route auto-updates their Supabase password from the
 * verified Redis/scrypt credential.
 *
 * Usage:
 *   npx tsx scripts/migrate-users-to-supabase.ts
 *
 * Required env vars (in .env.local):
 *   NEXT_PUBLIC_SUPABASE_URL      — e.g. https://xxx.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY     — from Supabase dashboard → Settings → API
 *   UPSTASH_REDIS_REST_URL
 *   UPSTASH_REDIS_REST_TOKEN
 *
 * The script is idempotent — re-running it is safe.  Existing Supabase
 * accounts are detected and skipped (only metadata is updated).
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
import * as crypto from 'crypto';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });

// Import after dotenv so env vars are populated.
import { getUpstashClient } from '../lib/upstashRedis';
import { getSupabaseAdminClient } from '../lib/supabase/admin';
import type { UserRecord } from '../lib/firmStore';

async function main(): Promise<void> {
  console.log('\nExpertMatch — Migrate Redis users → Supabase Auth');
  console.log('─'.repeat(50));

  // ── Preflight checks ───────────────────────────────────────────────────────
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    console.error(
      '\nError: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.\n' +
      'Add them to .env.local before running this script.\n',
    );
    process.exit(1);
  }

  const admin = getSupabaseAdminClient();
  if (!admin) {
    console.error('\nError: Supabase admin client could not be initialised.\n');
    process.exit(1);
  }

  const redis = getUpstashClient();
  if (!redis) {
    console.error('\nError: Redis client unavailable. Check UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.\n');
    process.exit(1);
  }

  // ── Load all Redis user keys ───────────────────────────────────────────────
  console.log('\nFetching Redis user keys...');
  const keys: string[] = await redis.keys('user:*');

  if (keys.length === 0) {
    console.log('No Redis users found. Nothing to migrate.\n');
    return;
  }

  console.log(`Found ${keys.length} user record(s) in Redis.\n`);

  // ── Load existing Supabase users (for duplicate detection) ────────────────
  console.log('Loading existing Supabase users...');
  const { data: listData, error: listErr } = await admin.auth.admin.listUsers({ perPage: 1000 });
  if (listErr) {
    console.error('Error: failed to list Supabase users:', listErr.message);
    process.exit(1);
  }
  const existingEmails = new Set(
    (listData?.users ?? []).map(u => u.email?.toLowerCase() ?? '').filter(Boolean),
  );
  console.log(`${existingEmails.size} user(s) already exist in Supabase.\n`);

  // ── Migrate each Redis user ────────────────────────────────────────────────
  let created = 0;
  let updated = 0;
  let skipped = 0;
  let errors  = 0;

  for (const key of keys) {
    const email = key.slice('user:'.length);
    if (!email || !email.includes('@')) {
      console.warn(`  ⚠ Skipping malformed key: ${key}`);
      skipped++;
      continue;
    }

    let record: UserRecord | null = null;
    try {
      const raw = await redis.get(key);
      record = raw ? JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw)) as UserRecord : null;
    } catch {
      console.warn(`  ⚠ Could not parse Redis record for ${email} — skipping`);
      skipped++;
      continue;
    }

    if (!record) {
      console.warn(`  ⚠ Empty record for ${email} — skipping`);
      skipped++;
      continue;
    }

    const metadata = {
      role:               record.role,
      firmName:           record.firmName,
      firmDomain:         record.firmDomain,
      onboardingComplete: record.onboardingComplete,
    };

    if (existingEmails.has(email.toLowerCase())) {
      // User already in Supabase — update metadata only, leave password alone.
      try {
        const existing = listData?.users.find(u => u.email?.toLowerCase() === email.toLowerCase());
        if (existing) {
          const { error: updateErr } = await admin.auth.admin.updateUserById(existing.id, {
            user_metadata: metadata,
          });
          if (updateErr) {
            console.warn(`  ⚠ ${email}: metadata update failed — ${updateErr.message}`);
            errors++;
          } else {
            console.log(`  ↺ ${email}: metadata updated (role=${record.role})`);
            updated++;
          }
        }
      } catch (err) {
        console.warn(`  ⚠ ${email}: unexpected error — ${err instanceof Error ? err.message : String(err)}`);
        errors++;
      }
      continue;
    }

    // New user — create with placeholder password.
    // The login route will set the real password on first sign-in.
    const placeholderPassword = crypto.randomUUID() + crypto.randomUUID();

    try {
      const { error: createErr } = await admin.auth.admin.createUser({
        email,
        password:      placeholderPassword,
        email_confirm: true,
        user_metadata: metadata,
      });

      if (createErr) {
        console.warn(`  ✗ ${email}: create failed — ${createErr.message}`);
        errors++;
      } else {
        console.log(`  ✓ ${email}: created (role=${record.role}, status=${record.status})`);
        created++;
      }
    } catch (err) {
      console.warn(`  ✗ ${email}: unexpected error — ${err instanceof Error ? err.message : String(err)}`);
      errors++;
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(50));
  console.log('Migration complete:');
  console.log(`  Created : ${created}`);
  console.log(`  Updated : ${updated} (metadata refresh on existing Supabase accounts)`);
  console.log(`  Skipped : ${skipped}`);
  console.log(`  Errors  : ${errors}`);
  console.log();

  if (errors > 0) {
    console.warn('Some users failed to migrate. Re-run the script to retry.\n');
    process.exit(1);
  }

  console.log(
    'NOTE: Passwords were NOT migrated (scrypt → bcrypt conversion is not possible).\n' +
    'Each migrated user will have their Supabase password auto-updated on their\n' +
    'first login via the transparent dual-auth migration in the login route.\n',
  );
}

main().catch(err => {
  console.error('\nMigration failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
