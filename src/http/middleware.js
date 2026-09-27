import { config } from '../config.js';
import { AppError, forbidden } from '../util/errors.js';
import { logger } from '../util/logger.js';

/**
 * Baseline response hardening. Written out explicitly rather than pulled from a
 * package so every directive is auditable in one place.
 *
 * The frontend ships no inline script or style, so the policy needs no
 * 'unsafe-inline' escape hatch. `frame-ancestors 'self'` (with
 * X-Frame-Options: SAMEORIGIN) blocks external framing while still permitting
 * the in-app PDF preview iframe, which is same-origin.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "media-src 'self'",
  "object-src 'self'",
  "frame-src 'self'",
  "frame-ancestors 'self'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

export function securityHeaders(req, res, next) {
  res.set('Content-Security-Policy', CSP);
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Cross-Origin-Opener-Policy', 'same-origin');
  res.set('Cross-Origin-Resource-Policy', 'same-origin');
  res.set('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), usb=()');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  if (config.isProduction) {
    res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

/**
 * CSRF protection for the cookie-based session.
 *
 * SameSite=Strict on the session cookie is the primary defence. These two extra
 * checks close the residual gaps: a mismatched Origin is rejected outright, and
 * requiring a custom header means a plain cross-origin HTML form cannot forge a
 * state-changing request (setting a custom header forces a preflight, which the
 * server never approves).
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function csrfGuard(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    let originHost;
    try {
      originHost = new URL(origin).host;
    } catch {
      return next(forbidden('The request origin was not recognised.', `unparseable origin: ${origin}`));
    }
    if (originHost !== req.headers.host) {
      return next(
        forbidden('The request origin was not recognised.', `origin ${originHost} != host ${req.headers.host}`),
      );
    }
  }

  if (req.headers['x-requested-with'] !== 'SecureVault') {
    return next(forbidden('This request is missing its client header.', 'absent X-Requested-With'));
  }

  return next();
}

/** One structured line per request. Never logs query values, which carry paths. */
export function requestLog(req, res, next) {
  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    logger.info('request', {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ms: Math.round(ms),
    });
  });
  next();
}

/**
 * Terminal error handler (SRS 26). Clients receive a short, actionable message
 * and a stable machine-readable code; the diagnostic detail stays in the log.
 */
export function errorHandler(err, req, res, _next) {
  const isApp = err instanceof AppError;
  const status = isApp ? err.status : Number(err?.status) || 500;
  const code = isApp ? err.code : err?.code || 'INTERNAL_ERROR';
  const clientMessage =
    isApp || err?.expose === true ? err.message : 'Something went wrong on the server.';

  const level = status >= 500 ? 'error' : 'warn';
  logger[level]('request failed', {
    method: req.method,
    path: req.path,
    status,
    code,
    detail: isApp ? err.detail : undefined,
    stack: status >= 500 ? err?.stack : undefined,
  });

  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (err?.retryAfter) res.set('Retry-After', String(Math.ceil(err.retryAfter)));
  res.status(status).json({ error: { code, message: clientMessage } });
}
