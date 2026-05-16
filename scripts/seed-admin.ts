/**
 * scripts/seed-admin.ts
 *
 * One-time setup: creates an admin user in the Upstash Redis store.
 *
 * Usage:
 *   npx tsx scripts/seed-admin.ts
 *
 * Reads credentials from .env.local automatically. Alternatively, export them first:
 *   set -a && source .env.local && set +a && npx tsx scripts/seed-admin.ts
 *
 * Required env vars:
 *   UPSTASH_REDIS_REST_URL
 *   UPSTASH_REDIS_REST_TOKEN
 *
 * After running this script you can remove ADMIN_PASSWORD_HASH and ADMIN_EMAIL
 * from your environment — the admin bypass is no longer used.
 */

import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import bcrypt from 'bcryptjs';
import { getUpstashClient } from '../lib/upstashRedis';

// ─── Load .env.local before accessing process.env ─────────────────────────────

function loadEnvLocal(): void {
  const envPath = path.join(process.cwd(), '.env.local');
  if (!fs.existsSync(envPath)) {
    process.stderr.write('[warn] .env.local not found — using environment variables as-is\n');
    return;
  }
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const raw = trimmed.slice(idx + 1).trim();
    const val = raw.replace(/^(['"])(.*)\1$/, '$2'); // strip surrounding quotes
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
}

loadEnvLocal();

// ─── Terminal prompts ──────────────────────────────────────────────────────────

function promptText(question: string): Promise<string> {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, answer => { rl.close(); resolve(answer.trim()); });
  });
}

function promptPassword(question: string): Promise<string> {
  return new Promise(resolve => {
    const stdin = process.stdin as NodeJS.ReadStream;
    if (stdin.isTTY) {
      // Suppress echo for password input
      process.stdout.write(question);
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding('utf8');
      let pw = '';
      function handler(char: string) {
        if (char === '\n' || char === '\r' || char === '') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', handler);
          process.stdout.write('\n');
          resolve(pw);
        } else if (char === '') {
          process.stdout.write('\n');
          process.exit(0);
        } else if (char === '') {
          // Backspace
          if (pw.length > 0) {
            pw = pw.slice(0, -1);
            process.stdout.write('\b \b');
          }
        } else {
          pw += char;
          process.stdout.write('*');
        }
      }
      stdin.on('data', handler);
    } else {
      // Non-TTY (piped input) — readline without echo suppression
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(question, answer => { rl.close(); resolve(answer.trim()); });
    }
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const ADMIN_EMAIL  = 'ashergoldsteinbusiness@gmail.com';
const BCRYPT_ROUNDS = 12;

async function main(): Promise<void> {
  console.log('\nExpertMatch — Seed Admin User');
  console.log('─'.repeat(40));
  console.log(`Email : ${ADMIN_EMAIL}`);
  console.log(`Role  : admin\n`);

  const redis = getUpstashClient();
  if (!redis) {
    console.error(
      'Error: Redis client unavailable.\n' +
      'Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in .env.local',
    );
    process.exit(1);
  }

  // Check if a record already exists for this email
  const existingRaw = await redis.get(`user:${ADMIN_EMAIL}`);
  if (existingRaw) {
    let existing: { status?: string } = {};
    try { existing = JSON.parse(existingRaw); } catch { /* ignore */ }
    console.warn(`Warning: A user record already exists for ${ADMIN_EMAIL} (status: ${existing.status ?? 'unknown'}).`);
    const overwrite = await promptText('Overwrite? [y/N] ');
    if (overwrite.toLowerCase() !== 'y') {
      console.log('Aborted — existing record unchanged.');
      process.exit(0);
    }
  }

  const password = await promptPassword('Enter admin password: ');
  if (password.length < 8) {
    console.error('\nError: Password must be at least 8 characters.');
    process.exit(1);
  }
  if (!/\d/.test(password)) {
    console.error('\nError: Password must contain at least one number.');
    process.exit(1);
  }

  const confirm = await promptPassword('Confirm password:    ');
  if (password !== confirm) {
    console.error('\nError: Passwords do not match.');
    process.exit(1);
  }

  console.log('\nHashing password (bcrypt, 12 rounds)…');
  const passwordHash = bcrypt.hashSync(password, BCRYPT_ROUNDS);

  const record = JSON.stringify({
    email:              ADMIN_EMAIL,
    passwordHash,
    firmDomain:         '',
    firmName:           'ExpertMatch',
    role:               'admin',
    status:             'active',
    createdAt:          Date.now(),
    onboardingComplete: true,
  });

  await redis.set(`user:${ADMIN_EMAIL}`, record);

  console.log('\n✓ Admin user created.');
  console.log(`  Email:  ${ADMIN_EMAIL}`);
  console.log(`  Role:   admin`);
  console.log(`  Status: active`);
  console.log('\nYou can now sign in at /login.');
  console.log('You may remove ADMIN_PASSWORD_HASH and ADMIN_EMAIL from your environment.');
}

main().catch(err => {
  console.error('\nSeed failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
