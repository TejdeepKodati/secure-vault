import { config } from '../config.js';
import { unauthorized } from '../util/errors.js';
import { getSessionEpoch } from '../users/userStore.js';
import { signToken, verifyToken } from './tokens.js';

/**
 * Session handling.
 *
 * The token is delivered in an HttpOnly, SameSite=Strict cookie. That keeps it
 * out of reach of JavaScript (so a stored-content XSS cannot exfiltrate it) and
 * means `<img>`, `<iframe>` and plain navigation to /api/preview and
 * /api/download authenticate themselves - no blob juggling in the frontend.
 *
 * A bearer token is also accepted so the API is usable from curl or a script.
 */
let secret = null;

export function initSessions(resolvedSecret) {
  secret = resolvedSecret;
}

export function issueSession(res) {
  if (!secret) throw new Error('initSessions() was not called');
  const token = signToken({ sub: 'owner', epoch: getSessionEpoch() }, secret, config.sessionTtlSeconds);
  res.cookie(config.cookieName, token, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'Strict',
    maxAge: config.sessionTtlSeconds,
    path: '/',
  });
  return { token, expiresIn: config.sessionTtlSeconds };
}

export function clearSession(res) {
  res.cookie(config.cookieName, '', {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'Strict',
    maxAge: 0,
    path: '/',
  });
}

function tokenFrom(req) {
  const fromCookie = req.cookies?.[config.cookieName];
  if (fromCookie) return fromCookie;
  const header = req.headers.authorization;
  if (typeof header === 'string' && /^bearer /i.test(header)) return header.slice(7).trim();
  return null;
}

/** Resolve the session without failing; sets `req.session` to null when absent. */
export function readSession(req) {
  const token = tokenFrom(req);
  if (!token) return null;
  const payload = verifyToken(token, secret);
  if (!payload || payload.sub !== 'owner') return null;
  // A PIN change bumps the epoch, retiring tokens issued before it.
  if (payload.epoch !== getSessionEpoch()) return null;
  return payload;
}

export function attachSession(req, _res, next) {
  req.session = readSession(req);
  next();
}

/** Guard for every protected route (SRS 23, 24). */
export function requireAuth(req, res, next) {
  if (!req.session) {
    req.session = readSession(req);
  }
  if (!req.session) {
    return next(unauthorized('Please sign in to continue.'));
  }
  return next();
}
