// Upstash Redis smoke test — run with:
//   UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... npx tsx scripts/test-upstash.ts
// Or export vars from .env.local first:
//   set -a && source .env.local && set +a && npx tsx scripts/test-upstash.ts
//
// Uses a "smoke:" key prefix so nothing collides with real data.
// All keys are cleaned up at the end.

import { getUpstashClient } from '../lib/upstashRedis';
import { randomBytes } from 'crypto';

const redis = getUpstashClient();
if (!redis) {
  console.error('UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set');
  process.exit(1);
}

let passed = 0;
let failed = 0;

function ok(label: string) {
  console.log(`  ✓ ${label}`);
  passed++;
}

function fail(label: string, detail?: unknown) {
  console.error(`  ✗ ${label}`, detail ?? '');
  failed++;
}

const uid   = randomBytes(4).toString('hex');
const rlKey = `smoke:rl:${uid}`;
const ckKey = `smoke:cache:${uid}`;
const lkKey = `smoke:lock:${uid}`;

async function cleanup() {
  await redis!.pipeline([
    ['DEL', rlKey],
    ['DEL', ckKey],
    ['DEL', lkKey],
  ]).catch(() => {});
}

async function run() {
  console.log('\nUpstash smoke test\n');

  // ── 1. incrWithWindow ──────────────────────────────────────────────────────
  console.log('1. incrWithWindow');
  try {
    const w = 3_000; // 3s window
    const r1 = await redis!.incrWithWindow(rlKey, w);
    if (r1.count !== 1) { fail('first increment should be 1', r1); }
    else ok('first increment = 1');

    const r2 = await redis!.incrWithWindow(rlKey, w);
    if (r2.count !== 2) { fail('second increment should be 2', r2); }
    else ok('second increment = 2');

    if (r2.ttlMs <= 0 || r2.ttlMs > w) { fail('ttlMs should be within window', r2.ttlMs); }
    else ok(`ttlMs = ${r2.ttlMs}ms (within ${w}ms window)`);

    // Window expiry: wait for TTL then verify reset
    await new Promise(r => setTimeout(r, w + 200));
    const r3 = await redis!.incrWithWindow(rlKey, w);
    if (r3.count !== 1) { fail('after window expiry, count should reset to 1', r3); }
    else ok('count resets to 1 after window expires');
  } catch (e) { fail('incrWithWindow threw', e); }

  // ── 2. cache set / get with TTL ───────────────────────────────────────────
  console.log('\n2. cache set / get');
  try {
    const payload = JSON.stringify({ foo: 'bar', ts: Date.now() });
    await redis!.set(ckKey, payload, { ex: 5 });
    ok('set with ex:5 succeeded');

    const got = await redis!.get(ckKey);
    if (got !== payload) { fail('get returned wrong value', got); }
    else ok('get returns correct value');

    // TTL expiry
    await redis!.set(ckKey, payload, { ex: 1 });
    await new Promise(r => setTimeout(r, 1_500));
    const expired = await redis!.get(ckKey);
    if (expired !== null) { fail('key should have expired', expired); }
    else ok('key expires after TTL');
  } catch (e) { fail('cache set/get threw', e); }

  // ── 3. lock: acquire / double-acquire ─────────────────────────────────────
  console.log('\n3. distributed lock');
  try {
    const lockId1 = randomBytes(16).toString('hex');
    const r1 = await redis!.set(lkKey, lockId1, { ex: 30, nx: true });
    if (r1 !== 'OK') { fail('first acquire should return OK', r1); }
    else ok('first acquire succeeds');

    const lockId2 = randomBytes(16).toString('hex');
    const r2 = await redis!.set(lkKey, lockId2, { ex: 30, nx: true });
    if (r2 !== null) { fail('second acquire should return null (lock held)', r2); }
    else ok('second acquire blocked (returns null)');

    // release with wrong lockId
    const wrongReleased = await redis!.releaseLockIfOwner(lkKey, lockId2);
    if (wrongReleased) { fail('release with wrong lockId should return false'); }
    else ok('release with wrong lockId returns false');

    // lock still held after wrong release
    const stillHeld = await redis!.get(lkKey);
    if (stillHeld !== lockId1) { fail('lock should still be held by lockId1', stillHeld); }
    else ok('lock still held after wrong-owner release attempt');

    // release with correct lockId
    const released = await redis!.releaseLockIfOwner(lkKey, lockId1);
    if (!released) { fail('release with correct lockId should return true'); }
    else ok('release with correct lockId returns true');

    // lock is gone
    const gone = await redis!.get(lkKey);
    if (gone !== null) { fail('lock key should be deleted after release', gone); }
    else ok('lock key deleted after release');

    // re-acquire after release
    const lockId3 = randomBytes(16).toString('hex');
    const r3 = await redis!.set(lkKey, lockId3, { ex: 30, nx: true });
    if (r3 !== 'OK') { fail('re-acquire after release should succeed', r3); }
    else ok('re-acquire after release succeeds');
  } catch (e) { fail('lock tests threw', e); }

  await cleanup();

  console.log(`\n${'─'.repeat(40)}`);
  console.log(`${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch(e => { console.error('Unexpected error:', e); process.exit(1); });
