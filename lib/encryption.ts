// AES-256-GCM symmetric encryption for the two things this product keeps
// encrypted at rest: Google OAuth tokens (lib/calendarConnections.ts) and the
// raw inbound email body (conversation_messages.body_raw, lib/conversations.ts).
//
// KEYS. ENCRYPTION_KEY is the current key: exactly 64 hex characters (32
// bytes). ENCRYPTION_KEY_PREVIOUS, same format, is set only while a rotation
// is in progress. encrypt() always uses the current key; decrypt() tries the
// current key and, when that fails to authenticate, the previous one. Nothing
// in the ciphertext names its key, which is why the fallback is a second
// decryption attempt and not a lookup.
//
// ROTATION (08-key-rotation-runbook, section 4): set ENCRYPTION_KEY_PREVIOUS
// to today's key, set ENCRYPTION_KEY to a fresh `openssl rand -hex 32`,
// deploy, run `npx tsx scripts/reencrypt-at-rest.ts` until it reports nothing
// left under the previous key, then delete ENCRYPTION_KEY_PREVIOUS. Before
// this fallback existed, rotating the key made every stored refresh token
// unreadable and every linked calendar had to be linked again.
//
// Ciphertext format, unchanged: `${iv_hex}.${authTag_hex}.${ciphertext_hex}`
//
// NEVER log plaintext, ciphertext, or either key.
// NEVER return raw token strings to the client.

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES   = 12;  // 96-bit IV — GCM standard
const TAG_BYTES  = 16;  // 128-bit auth tag

const CURRENT_ENV  = 'ENCRYPTION_KEY';
const PREVIOUS_ENV = 'ENCRYPTION_KEY_PREVIOUS';

// ─── Key loading ──────────────────────────────────────────────────────────────
//
// Each key is parsed once per distinct environment value: the parsed Buffer is
// reused while the variable reads the same, and re-read when it changes (the
// test suite rotates keys in-process; production never changes them at run
// time, so this is a one-time parse there).

let _currentHex:  string | undefined;
let _current:     Buffer | null = null;
let _previousHex: string | undefined;
let _previous:    Buffer | null = null;

function parseKey(hex: string, name: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`[encryption] ${name} must be exactly 64 hex characters (32 bytes)`);
  }
  return Buffer.from(hex, 'hex');
}

function currentKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY;
  if (_current && _currentHex === hex) return _current;

  if (!hex) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(`[encryption] ${CURRENT_ENV} is required in production`);
    }
    // Dev fallback — deterministic but NOT secure; never used in production.
    console.warn(`[encryption] ${CURRENT_ENV} not set — using insecure dev fallback key`);
    _current    = Buffer.alloc(32, 0x42);
    _currentHex = hex;
    return _current;
  }

  _current    = parseKey(hex, CURRENT_ENV);
  _currentHex = hex;
  return _current;
}

/** The previous key while a rotation is in progress, otherwise null. A malformed value throws: a typo here must not pass silently as "no previous key". */
function previousKey(): Buffer | null {
  const hex = process.env.ENCRYPTION_KEY_PREVIOUS;
  if (_previousHex === hex && (hex === undefined || _previous)) return _previous;

  _previous    = hex ? parseKey(hex, PREVIOUS_ENV) : null;
  _previousHex = hex;
  return _previous;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Which key opened a ciphertext. 'previous' means the row should be rewritten. */
export type DecryptionKey = 'current' | 'previous';

/** True while ENCRYPTION_KEY_PREVIOUS is set, i.e. a rotation is in progress. */
export function hasPreviousKey(): boolean {
  return previousKey() !== null;
}

/**
 * Encrypt `plaintext` with AES-256-GCM under the CURRENT key.
 * Returns a dot-delimited string: `${iv_hex}.${authTag_hex}.${ciphertext_hex}`
 */
export function encrypt(plaintext: string): string {
  const key    = currentKey();
  const iv     = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [iv.toString('hex'), tag.toString('hex'), ciphertext.toString('hex')].join('.');
}

function parseCiphertext(ciphertext: string): { iv: Buffer; tag: Buffer; data: Buffer } {
  const parts = ciphertext.split('.');
  if (parts.length !== 3) {
    throw new Error('[encryption] malformed ciphertext — expected iv.tag.data');
  }

  const [ivHex, tagHex, dataHex] = parts;
  const iv   = Buffer.from(ivHex,  'hex');
  const tag  = Buffer.from(tagHex, 'hex');
  const data = Buffer.from(dataHex, 'hex');

  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error('[encryption] malformed ciphertext — wrong iv or tag length');
  }
  return { iv, tag, data };
}

function open(key: Buffer, iv: Buffer, tag: Buffer, data: Buffer): string {
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

/**
 * Decrypt a value produced by `encrypt()` and say which key opened it.
 * Throws if the ciphertext is malformed or neither key authenticates it. When
 * both keys fail, the error reported is the CURRENT key's: the previous key is
 * a fallback, not the expectation.
 */
export function decryptDetailed(ciphertext: string): { plaintext: string; key: DecryptionKey } {
  const { iv, tag, data } = parseCiphertext(ciphertext);

  try {
    return { plaintext: open(currentKey(), iv, tag, data), key: 'current' };
  } catch (err) {
    const previous = previousKey();
    if (!previous) throw err;
    try {
      return { plaintext: open(previous, iv, tag, data), key: 'previous' };
    } catch {
      throw err;
    }
  }
}

/**
 * Decrypt a value produced by `encrypt()`.
 * Throws if the ciphertext is malformed, the auth tag fails, or the key is wrong.
 */
export function decrypt(ciphertext: string): string {
  return decryptDetailed(ciphertext).plaintext;
}
