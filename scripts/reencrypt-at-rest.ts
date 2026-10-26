// scripts/reencrypt-at-rest.ts — finish an ENCRYPTION_KEY rotation.
//
// Reads every ciphertext the product keeps at rest and rewrites, under the
// CURRENT key, each one that only the PREVIOUS key opens. Run it after the
// rotation deploy (lib/encryption.ts header; 08-key-rotation-runbook,
// section 4) until it reports nothing left under the previous key, then
// delete ENCRYPTION_KEY_PREVIOUS.
//
// What it touches:
//   user_calendar_connections.access_token, .refresh_token  — Google OAuth tokens
//   conversation_messages.body_raw                          — raw inbound email bodies
//
// Usage:
//   npx tsx scripts/reencrypt-at-rest.ts            # rewrite
//   npx tsx scripts/reencrypt-at-rest.ts --dry-run  # count only, write nothing
//
// Required env (in .env.local or the shell): NEXT_PUBLIC_SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY, ENCRYPTION_KEY, ENCRYPTION_KEY_PREVIOUS. Without
// ENCRYPTION_KEY_PREVIOUS there is nothing to migrate from; the script says so
// and exits 0.
//
// ENVIRONMENT GUARD (audit H-22): prints the resolved Supabase host and refuses
// a non-local host unless ALLOW_PROD=1. A rotation is finished against
// production, so that flag is expected here; the target still gets printed.
//
// Prints counts only. NEVER prints a plaintext, a ciphertext, a key, or a row.
// A value neither key opens is counted as unreadable and left exactly as it is:
// the calendar must be linked again, or the message body is gone for good —
// rewriting it would only hide that.

import * as dotenv from 'dotenv';
import * as path from 'path';
import { requireSafeTarget } from './opsGuard';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });

const PAGE_SIZE = 500;

interface Tally {
  rows:       number;  // rows read
  current:    number;  // values already under the current key
  rewritten:  number;  // values rewritten (or, in a dry run, that would be)
  unreadable: number;  // values neither key opens
}

function tally(): Tally {
  return { rows: 0, current: 0, rewritten: 0, unreadable: 0 };
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');

  requireSafeTarget('reencrypt-at-rest', [
    { label: 'Supabase', url: process.env.NEXT_PUBLIC_SUPABASE_URL },
  ]);

  // Import after dotenv so env vars are populated.
  const { decryptDetailed, encrypt, hasPreviousKey } = await import('../lib/encryption');
  const { getServiceRoleClient } = await import('../lib/supabase/admin');

  if (!hasPreviousKey()) {
    console.log('\nENCRYPTION_KEY_PREVIOUS is not set, so there is no previous key to migrate from. Nothing to do.\n');
    return;
  }

  const db = getServiceRoleClient();
  if (!db) {
    console.error('\nError: set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.\n');
    process.exit(1);
  }

  /**
   * Look at one stored value. Returns the replacement ciphertext when the value
   * only opens under the previous key, null when it is already current, empty
   * or unreadable; the tally records which.
   */
  function rewrap(value: string | null, t: Tally): string | null {
    if (!value) return null;
    let opened: { plaintext: string; key: 'current' | 'previous' };
    try { opened = decryptDetailed(value); } catch { t.unreadable += 1; return null; }
    if (opened.key === 'current') { t.current += 1; return null; }
    t.rewritten += 1;
    return encrypt(opened.plaintext);
  }

  console.log(`\n[reencrypt-at-rest] ${dryRun ? 'DRY RUN — counting only' : 'rewriting values the previous key opens'}\n`);

  // ── user_calendar_connections ──────────────────────────────────────────────
  const calendars = tally();
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await db
      .from('user_calendar_connections')
      .select('profile_id, provider, access_token, refresh_token')
      .order('profile_id', { ascending: true })
      .order('provider', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`user_calendar_connections read failed: ${error.message}`);
    if (!data || data.length === 0) break;

    for (const row of data) {
      calendars.rows += 1;
      const accessToken  = rewrap(row.access_token,  calendars);
      const refreshToken = rewrap(row.refresh_token, calendars);
      if (dryRun || (accessToken === null && refreshToken === null)) continue;

      const patch: { access_token?: string; refresh_token?: string } = {};
      if (accessToken  !== null) patch.access_token  = accessToken;
      if (refreshToken !== null) patch.refresh_token = refreshToken;
      const { error: writeError } = await db
        .from('user_calendar_connections')
        .update(patch)
        .eq('profile_id', row.profile_id)
        .eq('provider', row.provider);
      if (writeError) throw new Error(`user_calendar_connections write failed: ${writeError.message}`);
    }
    if (data.length < PAGE_SIZE) break;
  }

  // ── conversation_messages ──────────────────────────────────────────────────
  const messages = tally();
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await db
      .from('conversation_messages')
      .select('id, body_raw')
      .not('body_raw', 'is', null)
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`conversation_messages read failed: ${error.message}`);
    if (!data || data.length === 0) break;

    for (const row of data) {
      messages.rows += 1;
      const bodyRaw = rewrap(row.body_raw, messages);
      if (dryRun || bodyRaw === null) continue;

      const { error: writeError } = await db
        .from('conversation_messages')
        .update({ body_raw: bodyRaw })
        .eq('id', row.id);
      if (writeError) throw new Error(`conversation_messages write failed: ${writeError.message}`);
    }
    if (data.length < PAGE_SIZE) break;
  }

  // ── Report ─────────────────────────────────────────────────────────────────
  const verb = dryRun ? 'would rewrite' : 'rewrote';
  const line = (name: string, t: Tally): void => {
    console.log(`  ${name.padEnd(28)} ${String(t.rows).padStart(6)} rows  ${String(t.current).padStart(6)} current  ${String(t.rewritten).padStart(6)} ${verb}  ${String(t.unreadable).padStart(6)} unreadable`);
  };
  line('user_calendar_connections', calendars);
  line('conversation_messages',     messages);

  const rewritten  = calendars.rewritten  + messages.rewritten;
  const unreadable = calendars.unreadable + messages.unreadable;

  console.log('');
  if (unreadable > 0) {
    console.error(
      `${unreadable} value(s) open under neither key and were left untouched. ` +
      'A calendar token like that needs the calendar linked again; a message body like that is gone. ' +
      'Do not delete ENCRYPTION_KEY_PREVIOUS on the strength of this run.\n',
    );
    process.exit(1);
  }
  if (dryRun) {
    console.log(rewritten === 0
      ? 'Nothing is left under the previous key. ENCRYPTION_KEY_PREVIOUS can be deleted.\n'
      : `${rewritten} value(s) would be rewritten. Run again without --dry-run to do it.\n`);
    return;
  }
  console.log(rewritten === 0
    ? 'Nothing is left under the previous key. ENCRYPTION_KEY_PREVIOUS can be deleted.\n'
    : `Rewrote ${rewritten} value(s). Run again: it should now report nothing left, and then ENCRYPTION_KEY_PREVIOUS can be deleted.\n`);
}

main().catch((err: unknown) => {
  console.error(`\n[reencrypt-at-rest] failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
