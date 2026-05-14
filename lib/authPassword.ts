// Node.js only — uses scryptSync from the native 'crypto' module.
// Do NOT import this file from middleware or any Edge Runtime code path.
import { scryptSync, timingSafeEqual, randomBytes } from 'crypto';

// Hash format stored in ADMIN_PASSWORD_HASH:  scrypt:<16-byte hex salt>:<64-byte hex hash>
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

export function verifyAdminPassword(password: string): boolean {
  const stored = process.env.ADMIN_PASSWORD_HASH;
  if (!stored) return false;

  const parts = stored.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, storedHex] = parts;

  try {
    const inputHash  = scryptSync(password, salt, 64);
    const storedHash = Buffer.from(storedHex, 'hex');
    // Pad both to the same length before timingSafeEqual (requires equal-length buffers).
    const len = Math.max(inputHash.length, storedHash.length);
    const a   = Buffer.alloc(len);
    const b   = Buffer.alloc(len);
    inputHash.copy(a);
    storedHash.copy(b);
    return inputHash.length === storedHash.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
