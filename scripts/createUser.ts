/**
 * scripts/createUser.ts
 *
 * Create or overwrite any user record in Upstash Redis.
 * Uses the same scrypt hashing as the live auth system (lib/authPassword.ts).
 *
 * Usage:
 *   npx tsx scripts/createUser.ts
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

// Load .env.local before any library code that reads process.env.
dotenv.config({ path: path.join(process.cwd(), '.env.local') });

// These imports happen after dotenv so env vars are available when needed.
import { hashPassword } from '../lib/authPassword';
import { getUser, upsertUser } from '../lib/firmStore';
import { getUpstashClient } from '../lib/upstashRedis';

// ─── Prompt helpers ───────────────────────────────────────────────────────────

function ask(question: string): Promise<string> {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function askPassword(question: string): Promise<string> {
  return new Promise(resolve => {
    process.stdout.write(question);
    const stream = process.stdin as NodeJS.ReadStream;
    stream.setRawMode?.(true);
    stream.resume();
    stream.setEncoding('utf8');
    let input = '';

    function onData(char: string) {
      if (char === '\n' || char === '\r' || char === '') {
        stream.setRawMode?.(false);
        stream.pause();
        stream.removeListener('data', onData);
        process.stdout.write('\n');
        if (char === '') process.exit(0); // Ctrl-C
        resolve(input);
      } else if (char === '') {
        // Backspace
        if (input.length > 0) {
          input = input.slice(0, -1);
          process.stdout.write('\b \b');
        }
      } else {
        input += char;
        process.stdout.write('*');
      }
    }

    stream.on('data', onData);
  });
}

function askChoice(question: string, choices: string[], defaultChoice: string): Promise<string> {
  const choiceStr = choices
    .map(c => (c === defaultChoice ? `[${c}]` : c))
    .join('/');
  return ask(`${question} (${choiceStr}): `).then(ans => {
    const lower = ans.toLowerCase();
    return choices.find(c => c.toLowerCase() === lower) ?? defaultChoice;
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\nExpertMatch — Create User');
  console.log('─'.repeat(40));

  // Validate Redis connection up-front.
  const redis = getUpstashClient();
  if (!redis) {
    console.error(
      '\nError: Redis unavailable.\n' +
      'Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in .env.local\n',
    );
    process.exit(1);
  }

  // Collect inputs.
  const email = (await ask('Email: ')).toLowerCase();
  if (!email || !email.includes('@')) {
    console.error('\nError: invalid email address.');
    process.exit(1);
  }

  const role = await askChoice('Role', ['admin', 'user'], 'admin') as 'admin' | 'user';

  const firmName   = await ask('Firm name   (blank to skip): ');
  const firmDomain = (await ask('Firm domain (blank to skip): ')).toLowerCase();

  console.log('');

  const password = await askPassword('Password        : ');
  if (password.length < 8) {
    console.error('\nError: password must be at least 8 characters.');
    process.exit(1);
  }

  const confirm = await askPassword('Confirm password: ');
  if (password !== confirm) {
    console.error('\nError: passwords do not match.');
    process.exit(1);
  }

  // Check for existing record.
  const existing = await getUser(email);
  if (existing) {
    console.log(`\nWarning: a user record already exists for ${email} (status: ${existing.status}).`);
    const overwrite = await ask('Overwrite? [y/N]: ');
    if (overwrite.toLowerCase() !== 'y') {
      console.log('\nAborted — existing record unchanged.\n');
      process.exit(0);
    }
  }

  // Hash + store.
  console.log('\nHashing password…');
  const passwordHash = hashPassword(password);

  await upsertUser(email, {
    passwordHash,
    role,
    firmName:           firmName  || (existing?.firmName  ?? ''),
    firmDomain:         firmDomain || (existing?.firmDomain ?? ''),
    status:             'active',
    onboardingComplete: true,
    // Preserve existing createdAt if overwriting; otherwise upsertUser sets Date.now().
    ...(existing ? { createdAt: existing.createdAt } : {}),
  });

  console.log('\nUser created successfully.');
  console.log(`  Email  : ${email}`);
  console.log(`  Role   : ${role}`);
  console.log(`  Firm   : ${firmName || '(none)'}`);
  console.log(`  Status : active`);
  console.log('\nYou can now sign in at /login.\n');
}

main().catch(err => {
  console.error('\nFailed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
