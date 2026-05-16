// Node.js only — uses scryptSync from the native 'crypto' module.
// Do NOT import this file from middleware or any Edge Runtime code path.
import { scryptSync, timingSafeEqual, randomBytes } from 'crypto';

// Hash format stored in ADMIN_PASSWORD_HASH:  scrypt:<16-byte hex salt>:<64-byte hex hash>
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, storedHex] = parts;

  try {
    const inputHash = scryptSync(password, salt, 64);
    const stored    = Buffer.from(storedHex, 'hex');
    const len = Math.max(inputHash.length, stored.length);
    const a   = Buffer.alloc(len);
    const b   = Buffer.alloc(len);
    inputHash.copy(a);
    stored.copy(b);
    return inputHash.length === stored.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// SECURITY: The admin password bypass is an emergency bootstrap mechanism only.
// It requires BOTH ADMIN_PASSWORD_HASH (the stored scrypt hash) AND ADMIN_EMAIL
// (the exact expected email address). Email comparison is case-insensitive.
// Do not use this as a normal login path.
export function verifyAdminPassword(password: string, email: string): boolean {
  const stored     = process.env.ADMIN_PASSWORD_HASH;
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!stored || !adminEmail) return false;
  // Case-insensitive email match — exact, never substring.
  if (email.toLowerCase().trim() !== adminEmail.toLowerCase().trim()) return false;
  return verifyPassword(password, stored);
}
