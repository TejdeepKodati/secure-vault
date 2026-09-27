import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

/**
 * PIN hashing (SRS 4: never store the PIN in plaintext).
 *
 * Uses scrypt from Node's own crypto module - a memory-hard KDF in the same
 * family of "strong password-hashing algorithm" as bcrypt, and available without
 * a native build step or a third-party package.
 *
 * The parameters are stored alongside the hash so they can be raised later
 * without invalidating existing records (see `needsRehash`).
 *
 * A short numeric PIN has little entropy, so this hash is not what stops a
 * determined attacker - the login throttle in auth/throttle.js is. The KDF's job
 * is to make an offline attack on a leaked user.json expensive.
 */
const CURRENT = { N: 32768, r: 8, p: 1, keyLength: 32 };

// scrypt needs roughly 128 * N * r bytes; Node's default maxmem (32 MB) is just
// under what N=32768, r=8 requires, so it has to be raised explicitly.
const MAX_MEM = 96 * 1024 * 1024;

export async function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(pin).normalize('NFKC'), salt, CURRENT.keyLength, {
    N: CURRENT.N,
    r: CURRENT.r,
    p: CURRENT.p,
    maxmem: MAX_MEM,
  });
  return [
    'scrypt',
    CURRENT.N,
    CURRENT.r,
    CURRENT.p,
    salt.toString('base64'),
    key.toString('base64'),
  ].join('$');
}

function parse(stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [, N, r, p, salt, key] = parts;
  const parsed = {
    N: Number.parseInt(N, 10),
    r: Number.parseInt(r, 10),
    p: Number.parseInt(p, 10),
    salt: Buffer.from(salt, 'base64'),
    key: Buffer.from(key, 'base64'),
  };
  if (!Number.isFinite(parsed.N) || !Number.isFinite(parsed.r) || !Number.isFinite(parsed.p)) return null;
  if (parsed.salt.length === 0 || parsed.key.length === 0) return null;
  return parsed;
}

export async function verifyPin(pin, stored) {
  const parsed = parse(stored);
  if (!parsed) return false;
  let derived;
  try {
    derived = await scrypt(String(pin).normalize('NFKC'), parsed.salt, parsed.key.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: MAX_MEM,
    });
  } catch {
    return false;
  }
  return derived.length === parsed.key.length && crypto.timingSafeEqual(derived, parsed.key);
}

/** True when a stored hash used weaker parameters than the current policy. */
export function needsRehash(stored) {
  const parsed = parse(stored);
  if (!parsed) return true;
  return parsed.N < CURRENT.N || parsed.r < CURRENT.r || parsed.key.length < CURRENT.keyLength;
}

/** Cryptographically random numeric PIN for first-time initialisation. */
export function generatePin(digits = 6) {
  let out = '';
  while (out.length < digits) out += String(crypto.randomInt(0, 10));
  return out;
}
