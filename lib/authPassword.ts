// Node.js only — uses bcryptjs for password hashing.
// Backward-compatible with legacy scrypt hashes (format: "scrypt:<salt>:<hash>").
// Do NOT import this file from middleware or any Edge Runtime code path.
//
// New dependency: bcryptjs (pure-JS, no native compilation required).

import bcrypt from 'bcryptjs';
import { scryptSync, timingSafeEqual } from 'crypto';

const BCRYPT_ROUNDS = 12;

// Returns a bcrypt hash. Stored format: "$2b$12$..."
export function hashPassword(password: string): string {
  return bcrypt.hashSync(password, BCRYPT_ROUNDS);
}

// Returns true if the hash uses the legacy scrypt format ("scrypt:<salt>:<hex>").
// Used by the login route to trigger an upgrade after successful authentication.
export function isScryptHash(hash: string): boolean {
  return typeof hash === 'string' && hash.startsWith('scrypt:');
}

// Verifies a password against a stored hash.
// Supports bcrypt (new) and legacy scrypt (backward-compat).
// After a successful scrypt verify, the caller should re-hash with hashPassword()
// and save the upgraded hash — see the login route for the upgrade-on-login pattern.
export function verifyPassword(password: string, storedHash: string): boolean {
  if (!storedHash) return false;
  if (isScryptHash(storedHash)) return verifyScrypt(password, storedHash);
  try {
    return bcrypt.compareSync(password, storedHash);
  } catch {
    return false;
  }
}

// Verifies against the legacy scrypt format: "scrypt:<16-byte hex salt>:<64-byte hex hash>"
function verifyScrypt(password: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, storedHex] = parts;
  try {
    const inputHash = scryptSync(password, salt, 64);
    const stored    = Buffer.from(storedHex, 'hex');
    const len       = Math.max(inputHash.length, stored.length);
    const a         = Buffer.alloc(len);
    const b         = Buffer.alloc(len);
    inputHash.copy(a);
    stored.copy(b);
    return inputHash.length === stored.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
