/**
 * scripts/seed-admin.ts
 *
 * One-time setup: creates the admin user in Upstash Redis.
 *
 * Usage:
 *   npx tsx scripts/seed-admin.ts
 *
 * Reads credentials from .env.local automatically.
 *
 * Required env vars (in .env.local):
 *   UPSTASH_REDIS_REST_URL
 *   UPSTASH_REDIS_REST_TOKEN
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
import * as readline from 'readline';
import { hashPassword } from '../lib/authPassword';
import { getUpstashClient } from '../lib/upstashRedis';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });

const ADMIN_EMAIL = 'ashergoldsteinbusiness@gmail.com';

function prompt(question: string, muted = false): Promise<string> {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (muted) {
      // Write question manually so we can suppress echoed characters
      process.stdout.write(question);
      (process.stdin as NodeJS.ReadStream).setRawMode?.(true);
      let input = '';
      process.stdin.resume();
      process.stdin.setEncoding('utf8');
      function handler(char: string) {
        if (char === '\n' || char === '\r' || char === '') {
          (process.stdin as NodeJS.ReadStream).setRawMode?.(false);
          process.stdin.pause();
          process.stdin.removeListener('data', handler);
          process.stdout.write('\n');
          rl.close();
          if (char === '') process.exit(0);
          resolve(input);
        } else if (char === '') {
          if (input.length > 0) {
            input = input.slice(0, -1);
            process.stdout.write('\b \b');
          }
        } else {
          input += char;
          process.stdout.write('*');
        }
      }
      process.stdin.on('data', handler);
    } else {
      rl.question(question, answer => { rl.close(); resolve(answer.trim()); });
    }
  });
}

async function main(): Promise<void> {
  console.log('\nExpertMatch — Seed Admin User');
  console.log('─'.repeat(40));
  console.log(`Email      : ${ADMIN_EMAIL}`);
  console.log(`First name : Asher`);
  console.log(`Role       : admin\n`);

  const redis = getUpstashClient();
  if (!redis) {
    console.error('Error: Redis unavailable. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in .env.local');
    process.exit(1);
  }

  // Check for existing record
  const existing = await redis.get(`user:${ADMIN_EMAIL}`);
  if (existing) {
    const rec = (() => { try { return JSON.parse(existing as string) as Record<string, unknown>; } catch { return {}; } })();
    console.warn(`Warning: a user record already exists for ${ADMIN_EMAIL} (status: ${rec.status ?? 'unknown'}).`);
    const overwrite = await prompt('Overwrite? [y/N] ');
    if (overwrite.toLowerCase() !== 'y') {
      console.log('Aborted — existing record unchanged.');
      process.exit(0);
    }
  }

  const password = await prompt('Enter password: ', true);
  if (password.length < 8) {
    console.error('Error: password must be at least 8 characters.');
    process.exit(1);
  }

  const confirm = await prompt('Confirm password: ', true);
  if (password !== confirm) {
    console.error('Error: passwords do not match.');
    process.exit(1);
  }

  console.log('\nHashing password…');
  const passwordHash = hashPassword(password);

  await redis.set(`user:${ADMIN_EMAIL}`, JSON.stringify({
    email:              ADMIN_EMAIL,
    passwordHash,
    firstName:          'Asher',
    firmDomain:         '',
    firmName:           'ExpertMatch',
    role:               'admin',
    status:             'active',
    onboardingComplete: true,
    createdAt:          Date.now(),
  }));

  console.log('\nAdmin account created successfully.');
  console.log(`  Email  : ${ADMIN_EMAIL}`);
  console.log(`  Role   : admin`);
  console.log(`  Status : active`);
  console.log('\nSign in at /login. You may remove ADMIN_PASSWORD_HASH from your environment.\n');
}

main().catch(err => {
  console.error('\nSeed failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
