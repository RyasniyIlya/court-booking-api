import bcrypt from 'bcryptjs';
import { createHash } from 'node:crypto';

// Versioned prehash: bcrypt sees 64 ASCII bytes, including for Unicode passwords.
const PREFIX = 'sha256-bcrypt$';
const digest = (password: string) => createHash('sha256').update(password, 'utf8').digest('hex');
export async function hashPassword(password: string, rounds = 12) {
  return PREFIX + await bcrypt.hash(digest(password), rounds);
}
export async function comparePassword(password: string, hash: string) {
  if (hash.startsWith(PREFIX)) return bcrypt.compare(digest(password), hash.slice(PREFIX.length));
  // Legacy hashes remain usable, but never accept an ambiguously truncated password.
  if (Buffer.byteLength(password, 'utf8') > 72) return false;
  return bcrypt.compare(password, hash);
}
