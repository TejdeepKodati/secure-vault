import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Load `.env` into process.env without a dependency. Values already present in
 * the real environment win, so a platform's own configuration is never
 * overwritten by a checked-out file.
 */
function loadEnvFile(file = path.join(APP_ROOT, '.env')) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    if (value !== '' && process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile();

const readInt = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Environment variable ${name} must be a non-negative integer.`);
  }
  return parsed;
};

const readBool = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
};

const NODE_ENV = process.env.NODE_ENV || 'development';
const isProduction = NODE_ENV === 'production';
const DATA_DIR = path.resolve(APP_ROOT, process.env.DATA_DIR || 'data');

export const config = {
  appRoot: APP_ROOT,
  publicDir: path.join(APP_ROOT, 'public'),
  nodeEnv: NODE_ENV,
  isProduction,

  port: readInt('PORT', 3000),
  host: process.env.HOST || '0.0.0.0',
  trustProxy: readBool('TRUST_PROXY', false),
  // How many trusted proxies sit between the internet and this process.
  trustProxyHops: Math.max(1, readInt('TRUST_PROXY_HOPS', 1)),

  // Storage layout (SRS 6). Metadata, live content and deleted content are
  // kept in separate trees so a storage backend swap has clear boundaries.
  dataDir: DATA_DIR,
  vaultDir: path.join(DATA_DIR, 'files'),
  trashDir: path.join(DATA_DIR, 'trash'),
  userFile: path.join(DATA_DIR, 'user.json'),
  secretFile: path.join(DATA_DIR, '.session-secret'),

  sessionTtlSeconds: readInt('SESSION_TTL_SECONDS', 12 * 60 * 60),
  cookieName: 'sv_session',
  cookieSecure: readBool('COOKIE_SECURE', isProduction),

  // Only consulted during first-time initialisation (SRS 5).
  initialPin: process.env.INITIAL_PIN || '',
  minPinLength: 4,
  maxPinLength: 128,

  maxUploadBytes: readInt('MAX_UPLOAD_BYTES', 1024 * 1024 * 1024),
  maxFilesPerRequest: readInt('MAX_FILES_PER_REQUEST', 500),
  maxJsonBodyBytes: 64 * 1024,

  login: {
    maxAttempts: readInt('LOGIN_MAX_ATTEMPTS', 5),
    windowMs: readInt('LOGIN_WINDOW_SECONDS', 900) * 1000,
    lockoutMs: readInt('LOGIN_LOCKOUT_SECONDS', 300) * 1000,
    maxLockoutMs: 24 * 60 * 60 * 1000,
    globalMaxAttempts: readInt('LOGIN_GLOBAL_MAX_ATTEMPTS', 50),
  },
};

/**
 * Resolve the session signing key.
 *
 * Production requires JWT_SECRET explicitly: generating one silently would mean
 * every restart invalidates sessions, and a key that only lives in memory
 * cannot be rotated deliberately.
 *
 * In development the key is generated once and persisted inside DATA_DIR (mode
 * 0600, gitignored) so restarts do not log you out.
 */
export function resolveSessionSecret() {
  const fromEnv = process.env.JWT_SECRET;
  if (fromEnv && fromEnv.length >= 16) return fromEnv;

  if (fromEnv && fromEnv.length < 16) {
    throw new Error('JWT_SECRET is too short. Use at least 16 characters (32+ recommended).');
  }
  if (isProduction) {
    throw new Error(
      'JWT_SECRET is required when NODE_ENV=production. Generate one with:\n' +
        '  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"',
    );
  }

  fs.mkdirSync(config.dataDir, { recursive: true });
  try {
    const existing = fs.readFileSync(config.secretFile, 'utf8').trim();
    if (existing.length >= 16) return existing;
  } catch {
    /* fall through and create one */
  }
  const generated = crypto.randomBytes(48).toString('base64url');
  fs.writeFileSync(config.secretFile, `${generated}\n`, { mode: 0o600 });
  return generated;
}
