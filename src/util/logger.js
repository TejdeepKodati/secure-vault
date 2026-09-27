/**
 * Minimal structured logger (SRS 26: log useful server-side diagnostics
 * without exposing secrets).
 *
 * Values whose key looks sensitive are redacted before they reach the log, so
 * an accidental `logger.warn('login', { pin })` cannot write a credential to
 * disk or to a hosting platform's log drain.
 */
const SENSITIVE = /pin|secret|password|token|cookie|authorization|hash/i;
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const threshold = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

function redact(value, depth = 0) {
  if (value === null || typeof value !== 'object' || depth > 4) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    out[key] = SENSITIVE.test(key) ? '[redacted]' : redact(val, depth + 1);
  }
  return out;
}

function emit(level, message, context) {
  if (LEVELS[level] < threshold) return;
  const line = { time: new Date().toISOString(), level, message };
  if (context && Object.keys(context).length > 0) line.context = redact(context);
  const text = JSON.stringify(line);
  if (level === 'error' || level === 'warn') process.stderr.write(`${text}\n`);
  else process.stdout.write(`${text}\n`);
}

export const logger = {
  debug: (message, context) => emit('debug', message, context),
  info: (message, context) => emit('info', message, context),
  warn: (message, context) => emit('warn', message, context),
  error: (message, context) => emit('error', message, context),
  /** Unformatted operator-facing output, e.g. the first-run PIN banner. */
  banner: (text) => process.stdout.write(`${text}\n`),
};
