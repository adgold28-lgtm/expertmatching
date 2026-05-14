// AES-256-GCM symmetric encryption for storing OAuth tokens at rest.
//
// Key source: ENCRYPTION_KEY env var — exactly 64 hex characters (32 bytes).
// Ciphertext format: `${iv_hex}.${authTag_hex}.${ciphertext_hex}`
//
// NEVER log plaintext, ciphertext, or the key.
// NEVER return raw token strings to the client.

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES   = 12;  // 96-bit IV — GCM standard
const TAG_BYTES  = 16;  // 128-bit auth tag

// ─── Key loading ──────────────────────────────────────────────────────────────

let _key: Buffer | null = null;

function getKey(): Buffer {
  if (_key) return _key;

  const hex = process.env.ENCRYPTION_KEY;
  if (!hex) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('[encryption] ENCRYPTION_KEY is required in production');
    }
    // Dev fallback — deterministic but NOT secure; never used in production.
    console.warn('[encryption] ENCRYPTION_KEY not set — using insecure dev fallback key');
    _key = Buffer.alloc(32, 0x42);
    return _key;
  }

  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('[encryption] ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)');
  }

  _key = Buffer.from(hex, 'hex');
  return _key;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Encrypt `plaintext` with AES-256-GCM.
 * Returns a dot-delimited string: `${iv_hex}.${authTag_hex}.${ciphertext_hex}`
 */
export function encrypt(plaintext: string): string {
  const key    = getKey();
  const iv     = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [iv.toString('hex'), tag.toString('hex'), ciphertext.toString('hex')].join('.');
}

/**
 * Decrypt a value produced by `encrypt()`.
 * Throws if the ciphertext is malformed, the auth tag fails, or the key is wrong.
 */
export function decrypt(ciphertext: string): string {
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

  const key      = getKey();
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
  return plaintext.toString('utf8');
}
