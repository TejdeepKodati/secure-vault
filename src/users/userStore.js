import fsp from 'node:fs/promises';
import path from 'node:path';

import { config } from '../config.js';
import { generatePin, hashPin, needsRehash, verifyPin } from '../auth/pin.js';
import { badRequest } from '../util/errors.js';
import { logger } from '../util/logger.js';

/**
 * Persistent user record (SRS 5).
 *
 * The record lives in DATA_DIR/user.json and is the single source of truth for
 * the PIN. The default PIN is written exactly once, when no record exists; every
 * subsequent boot loads what is on disk. Nothing in this module can reset a PIN
 * that already exists.
 *
 * If the record is missing but the vault already holds files, that is treated as
 * data loss rather than a first run - re-initialising would silently replace the
 * user's PIN with a new one while their files sat there. The server refuses to
 * start and says what to do (see `ALLOW_REINIT`).
 */
const RECORD_VERSION = 1;

let record = null;

async function readRecord() {
  try {
    const text = await fsp.readFile(config.userFile, 'utf8');
    const parsed = JSON.parse(text);
    if (!parsed?.pin?.hash) throw new Error('user record has no PIN hash');
    return parsed;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    if (err instanceof SyntaxError || err.message.includes('PIN hash')) {
      throw new Error(
        `The user record at ${path.basename(config.userFile)} is corrupt (${err.message}). ` +
          'Restore it from a backup, or delete it to initialise a new PIN.',
      );
    }
    throw err;
  }
}

/** Write atomically: a torn write here would lock the owner out of the vault. */
async function writeRecord(next) {
  const temporary = `${config.userFile}.${process.pid}.tmp`;
  const payload = `${JSON.stringify(next, null, 2)}\n`;
  await fsp.writeFile(temporary, payload, { mode: 0o600 });
  await fsp.rename(temporary, config.userFile);
  record = next;
}

async function vaultHasContent() {
  try {
    const entries = await fsp.readdir(config.vaultDir);
    return entries.some((name) => !name.startsWith('.'));
  } catch {
    return false;
  }
}

export async function initUserStore() {
  await fsp.mkdir(config.dataDir, { recursive: true });
  await fsp.mkdir(config.vaultDir, { recursive: true });
  await fsp.mkdir(config.trashDir, { recursive: true });

  const existing = await readRecord();
  if (existing) {
    record = existing;
    logger.info('user record loaded', { pinIsInitial: Boolean(existing.pin.isInitial) });
    return { created: false, pin: null };
  }

  if ((await vaultHasContent()) && process.env.ALLOW_REINIT !== 'true') {
    throw new Error(
      'The vault contains files but the user record is missing.\n' +
        'Refusing to create a new PIN, because that would replace your existing credentials.\n' +
        `Expected the record at: ${config.userFile}\n` +
        'Most often this means DATA_DIR is not on persistent storage, or only part of it is.\n' +
        'If you are certain you want a fresh PIN, restart with ALLOW_REINIT=true.',
    );
  }

  const pin = config.initialPin || generatePin(6);
  if (config.initialPin) assertPinPolicy(config.initialPin);

  await writeRecord({
    version: RECORD_VERSION,
    createdAt: new Date().toISOString(),
    pin: {
      hash: await hashPin(pin),
      updatedAt: new Date().toISOString(),
      isInitial: true,
    },
    sessionEpoch: 1,
    lastLoginAt: null,
  });

  logger.warn('user record created (first-time initialisation)', {
    source: config.initialPin ? 'INITIAL_PIN' : 'generated',
  });
  return { created: true, pin: config.initialPin ? null : pin };
}

function current() {
  if (!record) throw new Error('User store used before initUserStore()');
  return record;
}

export function assertPinPolicy(candidate) {
  const pin = String(candidate ?? '');
  if (pin.length < config.minPinLength) {
    throw badRequest(`The PIN must be at least ${config.minPinLength} characters.`);
  }
  if (pin.length > config.maxPinLength) {
    throw badRequest(`The PIN must be at most ${config.maxPinLength} characters.`);
  }
  if (/^(.)\1+$/.test(pin)) throw badRequest('That PIN is too easy to guess: every character is the same.');
  if (/^(0123|1234|2345|3456|4567|5678|6789|9876|8765|7654|6543|5432|4321|3210)/.test(pin)) {
    throw badRequest('That PIN is too easy to guess: it starts with a run of consecutive digits.');
  }
  return pin;
}

export const getSessionEpoch = () => current().sessionEpoch ?? 1;
export const pinIsInitial = () => Boolean(current().pin.isInitial);

/** Verify a login attempt, transparently upgrading the hash if policy moved on. */
export async function checkPin(candidate) {
  const user = current();
  const ok = await verifyPin(candidate, user.pin.hash);
  if (!ok) return false;
  if (needsRehash(user.pin.hash)) {
    await writeRecord({
      ...user,
      pin: { ...user.pin, hash: await hashPin(candidate), updatedAt: new Date().toISOString() },
    });
    logger.info('PIN hash upgraded to current parameters');
  }
  return true;
}

export async function recordSuccessfulLogin() {
  await writeRecord({ ...current(), lastLoginAt: new Date().toISOString() });
}

/**
 * Replace the PIN. Bumping `sessionEpoch` invalidates every token already
 * issued, so changing the PIN also signs out any other device.
 */
export async function changePin(currentCandidate, nextPin) {
  const user = current();
  if (!(await verifyPin(currentCandidate, user.pin.hash))) {
    // Flagged so the route can count it against the login throttle: otherwise a
    // borrowed session could guess the PIN here without limit.
    throw Object.assign(badRequest('That current PIN is not correct.'), { wrongPin: true });
  }
  assertPinPolicy(nextPin);
  if (await verifyPin(nextPin, user.pin.hash)) {
    throw badRequest('The new PIN must be different from the current one.');
  }
  await writeRecord({
    ...user,
    pin: { hash: await hashPin(nextPin), updatedAt: new Date().toISOString(), isInitial: false },
    sessionEpoch: (user.sessionEpoch ?? 1) + 1,
  });
  logger.info('PIN changed; existing sessions invalidated');
}
