import { config } from '../config.js';
import { logger } from '../util/logger.js';

/**
 * Login throttling.
 *
 * Not required by the SRS, but a 4-to-6 digit PIN on a reachable URL is
 * exhaustible in minutes without it, which would undercut every other control in
 * section 24. Added deliberately; see README.
 *
 * Two independent limits:
 *   per-IP     - the usual case, with lockout doubling on each repeat offence so
 *                a persistent attacker backs off geometrically.
 *   global     - a single shared counter, because there is only one account: an
 *                attacker spreading attempts across many addresses would
 *                otherwise never trip the per-IP limit.
 *
 * State is in memory, so counters reset if the process restarts. That is an
 * acknowledged limit: it bounds sustained guessing, not an attacker who can also
 * restart the server. Moving `attempts` into DATA_DIR would close it.
 */
const attempts = new Map();
let globalFailures = [];

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const MAX_TRACKED_IPS = 10000;

function prune(list, windowMs, now) {
  const cutoff = now - windowMs;
  return list.filter((time) => time > cutoff);
}

function sweep() {
  const now = Date.now();
  globalFailures = prune(globalFailures, config.login.windowMs, now);
  for (const [key, record] of attempts) {
    const stale = record.lockedUntil < now && prune(record.failures, config.login.windowMs, now).length === 0;
    if (stale) attempts.delete(key);
  }
}

const timer = setInterval(sweep, SWEEP_INTERVAL_MS);
timer.unref();

/**
 * Check whether `key` may attempt a login right now.
 * @returns {{ allowed: boolean, retryAfter?: number, remaining?: number }}
 */
export function checkLoginAllowed(key) {
  const now = Date.now();
  const record = attempts.get(key);

  if (record && record.lockedUntil > now) {
    return { allowed: false, retryAfter: Math.ceil((record.lockedUntil - now) / 1000), scope: 'ip' };
  }

  globalFailures = prune(globalFailures, config.login.windowMs, now);
  if (globalFailures.length >= config.login.globalMaxAttempts) {
    const oldest = globalFailures[0];
    const retryAfter = Math.ceil((oldest + config.login.windowMs - now) / 1000);
    return { allowed: false, retryAfter: Math.max(retryAfter, 30), scope: 'global' };
  }

  const failures = record ? prune(record.failures, config.login.windowMs, now) : [];
  return { allowed: true, remaining: Math.max(0, config.login.maxAttempts - failures.length) };
}

/** Record a failed attempt and lock the key out once the threshold is crossed. */
export function recordLoginFailure(key) {
  const now = Date.now();
  globalFailures.push(now);

  if (attempts.size >= MAX_TRACKED_IPS && !attempts.has(key)) sweep();

  const record = attempts.get(key) || { failures: [], lockedUntil: 0, lockouts: 0 };
  record.failures = prune(record.failures, config.login.windowMs, now);
  record.failures.push(now);

  if (record.failures.length >= config.login.maxAttempts) {
    const duration = Math.min(
      config.login.lockoutMs * 2 ** record.lockouts,
      config.login.maxLockoutMs,
    );
    record.lockedUntil = now + duration;
    record.lockouts += 1;
    record.failures = [];
    attempts.set(key, record);
    logger.warn('login locked out', { key, seconds: Math.round(duration / 1000), lockouts: record.lockouts });
    return { lockedOut: true, retryAfter: Math.ceil(duration / 1000) };
  }

  attempts.set(key, record);
  return { lockedOut: false, remaining: config.login.maxAttempts - record.failures.length };
}

/** Clear a key's history after a successful login. */
export function recordLoginSuccess(key) {
  attempts.delete(key);
}

/** Test/ops helper: forget all throttle state. */
export function resetThrottle() {
  attempts.clear();
  globalFailures = [];
}
