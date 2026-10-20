import crypto from 'node:crypto';
import { promisify } from 'node:util';

// Async so hashing runs on the libuv thread pool instead of blocking the event loop.
const scrypt = promisify(crypto.scrypt);

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

// Checked against when the account doesn't exist, so unknown emails take as
// long to reject as wrong passwords.
const DUMMY_HASH = `${'0'.repeat(32)}:${'0'.repeat(128)}`;

/** True if password matches the stored hash. A missing hash still costs one scrypt. */
export async function verifyPassword(password, stored) {
  const [saltHex, hashHex] = (stored || DUMMY_HASH).split(':');
  const hash = await scrypt(password, Buffer.from(saltHex, 'hex'), 64);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex')) && Boolean(stored);
}
