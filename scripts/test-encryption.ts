// scripts/test-encryption.ts — unit tests for lib/encryption.ts: the
// AES-256-GCM round trip and the previous-key fallback a rotation leans on.
//
// Pure: no database, no network. The keys are throwaway values set here so the
// script runs with or without a .env.local; nothing encrypted under them is
// stored anywhere.
//
//   npx tsx scripts/test-encryption.ts

const KEY_A = '0123456789abcdef'.repeat(4);                  // 64 hex characters
const KEY_B = 'fedcba9876543210'.repeat(4);
const KEY_C = '00112233445566778899aabbccddeeff'.repeat(2);

process.env.ENCRYPTION_KEY = KEY_A;
delete process.env.ENCRYPTION_KEY_PREVIOUS;

import { encrypt, decrypt, decryptDetailed, hasPreviousKey } from '../lib/encryption';
import { check, eq, summary } from './testHarness';

function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

/** The error message a call throws, or null when it returns. */
function throws(fn: () => unknown): string | null {
  try { fn(); return null; } catch (err) { return err instanceof Error ? err.message : String(err); }
}

/** Flip the first nibble of a hex string so the bytes change but the length does not. */
function flipHex(hex: string): string {
  return (hex[0] === '0' ? '1' : '0') + hex.slice(1);
}

const SAMPLE = '1//0g-refresh-token-sample-value-with-dashes_and_underscores';

// ─── 1. Round trip under the current key ─────────────────────────────────────

section('round trip under the current key');

const underA = encrypt(SAMPLE);
eq('decrypt(encrypt(x)) is x',      decrypt(underA), SAMPLE);
eq('unicode survives',              decrypt(encrypt('héllo — 日本語 🙂')), 'héllo — 日本語 🙂');
eq('the empty string survives',     decrypt(encrypt('')), '');

const [ivHex, tagHex, dataHex] = underA.split('.');
eq('ciphertext is iv.tag.data',     underA.split('.').length, 3);
eq('iv is 12 bytes of hex',         ivHex.length, 24);
eq('tag is 16 bytes of hex',        tagHex.length, 32);
check('every part is lowercase hex', [ivHex, tagHex, dataHex].every(p => /^[0-9a-f]*$/.test(p)));
check('the same plaintext encrypts differently each time (random iv)', encrypt(SAMPLE) !== underA);
eq('decryptDetailed names the current key', decryptDetailed(underA).key, 'current');
eq('no rotation is in progress',    hasPreviousKey(), false);

// ─── 2. Malformed and tampered ciphertexts ───────────────────────────────────

section('malformed and tampered ciphertexts are rejected');

check('empty string → throws',   throws(() => decrypt('')) !== null);
check('two parts → throws',      throws(() => decrypt('ab.cd')) !== null);
check('four parts → throws',     throws(() => decrypt(`${underA}.ff`)) !== null);
check('short iv → throws',       throws(() => decrypt(`abcd.${tagHex}.${dataHex}`)) !== null);
check('short tag → throws',      throws(() => decrypt(`${ivHex}.abcd.${dataHex}`)) !== null);
check('tampered iv → throws',    throws(() => decrypt(`${flipHex(ivHex)}.${tagHex}.${dataHex}`)) !== null);
check('tampered tag → throws',   throws(() => decrypt(`${ivHex}.${flipHex(tagHex)}.${dataHex}`)) !== null);
check('tampered data → throws',  throws(() => decrypt(`${ivHex}.${tagHex}.${flipHex(dataHex)}`)) !== null);
check('the error never carries the ciphertext',
  !(throws(() => decrypt(`${ivHex}.${tagHex}.${flipHex(dataHex)}`)) ?? '').includes(dataHex));

// ─── 3. A new key with no previous key ───────────────────────────────────────

section('new key, no previous key');

process.env.ENCRYPTION_KEY = KEY_B;
check('a ciphertext under the old key no longer opens', throws(() => decrypt(underA)) !== null);
const underB = encrypt(SAMPLE);
eq('fresh ciphertexts open under the new key', decrypt(underB), SAMPLE);

// ─── 4. The previous-key fallback during a rotation ──────────────────────────

section('previous-key fallback during a rotation');

process.env.ENCRYPTION_KEY_PREVIOUS = KEY_A;
eq('a rotation is in progress',                        hasPreviousKey(), true);
eq('the old ciphertext opens again',                   decrypt(underA), SAMPLE);
eq('decryptDetailed names the previous key for it',    decryptDetailed(underA).key, 'previous');
eq('a current-key ciphertext is still reported as current', decryptDetailed(underB).key, 'current');
const migrated = encrypt(SAMPLE);
eq('encrypt() keeps using the current key, never the previous one', decryptDetailed(migrated).key, 'current');
check('a tampered old ciphertext is still rejected during a rotation',
  throws(() => decrypt(`${ivHex}.${flipHex(tagHex)}.${dataHex}`)) !== null);

process.env.ENCRYPTION_KEY = KEY_C;
const underC = encrypt(SAMPLE);
process.env.ENCRYPTION_KEY = KEY_B;
check('a ciphertext under a third key opens under neither', throws(() => decrypt(underC)) !== null);

process.env.ENCRYPTION_KEY_PREVIOUS = KEY_B;
eq('a previous key equal to the current one is harmless', decryptDetailed(underB).key, 'current');
check('…and does not open the old ciphertext', throws(() => decrypt(underA)) !== null);

// ─── 5. Rotation finished ────────────────────────────────────────────────────

section('rotation finished: previous key deleted');

delete process.env.ENCRYPTION_KEY_PREVIOUS;
eq('no rotation in progress',                       hasPreviousKey(), false);
check('the old ciphertext no longer opens',         throws(() => decrypt(underA)) !== null);
eq('the migrated ciphertext opens',                 decrypt(migrated), SAMPLE);

// ─── 6. Bad keys are errors, not silence ─────────────────────────────────────

section('malformed keys are errors');

process.env.ENCRYPTION_KEY_PREVIOUS = 'not-a-key';
const fallbackError = throws(() => decrypt(underA));
check('falling back to a malformed previous key throws',  fallbackError !== null);
check('the error names ENCRYPTION_KEY_PREVIOUS',          (fallbackError ?? '').includes('ENCRYPTION_KEY_PREVIOUS'));
check('the error never carries the value',                !(fallbackError ?? '').includes('not-a-key'));
eq('current-key ciphertexts are unaffected',             decrypt(underB), SAMPLE);
check('hasPreviousKey() throws rather than reporting "none"', throws(() => hasPreviousKey()) !== null);
delete process.env.ENCRYPTION_KEY_PREVIOUS;

process.env.ENCRYPTION_KEY = 'short';
const currentError = throws(() => encrypt(SAMPLE));
check('a malformed current key fails encrypt',            currentError !== null);
check('the error names ENCRYPTION_KEY',                   (currentError ?? '').includes('ENCRYPTION_KEY'));
check('a malformed current key fails decrypt',            throws(() => decrypt(underB)) !== null);
process.env.ENCRYPTION_KEY = KEY_A;
eq('restored key opens its ciphertext',                  decrypt(underA), SAMPLE);

summary();
