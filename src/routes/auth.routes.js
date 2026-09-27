import { clearSession, issueSession, requireAuth } from '../auth/session.js';
import {
  checkLoginAllowed,
  recordLoginFailure,
  recordLoginSuccess,
} from '../auth/throttle.js';
import { badRequest, tooManyRequests, unauthorized } from '../util/errors.js';
import { logger } from '../util/logger.js';
import {
  changePin,
  checkPin,
  pinIsInitial,
  recordSuccessfulLogin,
} from '../users/userStore.js';

/**
 * Anything that checks the PIN runs through this queue, one attempt at a time.
 *
 * The throttle can only count a failure once the (deliberately slow) hash has
 * finished. Without serialising, a burst of concurrent requests all pass the
 * "am I locked out?" gate before the first failure has been recorded, so the
 * limit of 5 attempts becomes hundreds. Serialised, each attempt sees the result
 * of the one before it, and once the limit is hit the rest of the queue is
 * rejected in microseconds without ever reaching the hash.
 *
 * One queue is enough: there is exactly one account.
 */
let attemptChain = Promise.resolve();
function serialised(task) {
  const run = attemptChain.then(task);
  attemptChain = run.catch(() => {});
  return run;
}

function lockedOut(gate) {
  return tooManyRequests(
    `Too many failed attempts. Try again in ${gate.retryAfter} seconds.`,
    `scope=${gate.scope}`,
    gate.retryAfter,
  );
}

export function registerAuthRoutes(app) {
  /**
   * POST /api/login - exchange the PIN for a session cookie (SRS 4).
   *
   * Throttled per IP and globally before the PIN is even hashed, so a flood of
   * attempts costs an attacker a 429 rather than a few hundred milliseconds of
   * the server's CPU each.
   */
  app.post('/api/login', (req, res, next) =>
    serialised(async () => {
      const gate = checkLoginAllowed(req.ip);
      if (!gate.allowed) return next(lockedOut(gate));

      const pin = req.body?.pin;
      if (typeof pin !== 'string' || pin === '') {
        return next(badRequest('Please enter your PIN.'));
      }

      if (!(await checkPin(pin))) {
        const failure = recordLoginFailure(req.ip);
        logger.warn('failed login', { ip: req.ip, lockedOut: failure.lockedOut });
        if (failure.lockedOut) {
          return next(
            tooManyRequests(
              `Too many failed attempts. Try again in ${failure.retryAfter} seconds.`,
              'lockout triggered',
              failure.retryAfter,
            ),
          );
        }
        const suffix =
          failure.remaining <= 2 ? ` ${failure.remaining} attempt${failure.remaining === 1 ? '' : 's'} left.` : '';
        return next(unauthorized(`That PIN is not correct.${suffix}`));
      }

      recordLoginSuccess(req.ip);
      await recordSuccessfulLogin();
      const session = issueSession(res);
      logger.info('login succeeded', { ip: req.ip });

      return res.json({
        ok: true,
        expiresIn: session.expiresIn,
        pinIsInitial: pinIsInitial(),
      });
    }).catch(next),
  );

  /** POST /api/logout - discard the session cookie. */
  app.post('/api/logout', (req, res) => {
    clearSession(res);
    return res.json({ ok: true });
  });

  /** GET /api/session - lets the frontend decide which view to show on load. */
  app.get('/api/session', (req, res) => {
    if (!req.session) return res.json({ authenticated: false });
    return res.json({ authenticated: true, pinIsInitial: pinIsInitial() });
  });

  /**
   * POST /api/change-pin - requires the current PIN even though the caller is
   * already authenticated, so a borrowed session cannot lock the owner out.
   *
   * A wrong current PIN counts against the same budget as a wrong login PIN;
   * otherwise this endpoint would be an unthrottled way to guess it.
   */
  app.post('/api/change-pin', requireAuth, (req, res, next) =>
    serialised(async () => {
      const { currentPin, newPin } = req.body ?? {};
      if (typeof currentPin !== 'string' || typeof newPin !== 'string') {
        return next(badRequest('Both the current and the new PIN are required.'));
      }

      const gate = checkLoginAllowed(req.ip);
      if (!gate.allowed) return next(lockedOut(gate));

      try {
        await changePin(currentPin, newPin);
      } catch (err) {
        if (err?.wrongPin) {
          const failure = recordLoginFailure(req.ip);
          logger.warn('failed PIN change', { ip: req.ip, lockedOut: failure.lockedOut });
          if (failure.lockedOut) {
            return next(
              tooManyRequests(
                `Too many failed attempts. Try again in ${failure.retryAfter} seconds.`,
                'lockout triggered (change-pin)',
                failure.retryAfter,
              ),
            );
          }
        }
        return next(err);
      }

      recordLoginSuccess(req.ip);
      // The PIN change retired every existing token, including this request's.
      const session = issueSession(res);
      return res.json({ ok: true, expiresIn: session.expiresIn });
    }).catch(next),
  );
}
