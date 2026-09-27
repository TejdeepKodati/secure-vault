import http from 'node:http';

import { config, resolveSessionSecret } from './src/config.js';
import { attachSession, initSessions } from './src/auth/session.js';
import { decorate, jsonBody } from './src/http/helpers.js';
import { createApp } from './src/http/router.js';
import { csrfGuard, errorHandler, requestLog, securityHeaders } from './src/http/middleware.js';
import { serveStatic } from './src/http/static.js';
import { registerAuthRoutes } from './src/routes/auth.routes.js';
import { registerContentRoutes } from './src/routes/content.routes.js';
import { registerFileRoutes } from './src/routes/files.routes.js';
import { registerUploadRoutes } from './src/routes/upload.routes.js';
import { storage } from './src/storage/index.js';
import { initUserStore } from './src/users/userStore.js';
import { logger } from './src/util/logger.js';

/**
 * The SRS names its contract without the /api prefix (POST /login, GET /files,
 * ...). /api is used internally so API and static routes cannot collide; these
 * aliases keep the documented contract working by rewriting the path, so there is
 * one handler per endpoint rather than two registrations of the same logic.
 */
const SPEC_ALIASES = new Set([
  '/login', '/logout', '/session', '/change-pin',
  '/files', '/info', '/folder', '/upload', '/preview', '/download',
  '/rename', '/move', '/delete', '/trash', '/trash/restore', '/empty-trash',
]);

function buildApp() {
  const app = createApp({
    onError(err, req, res) {
      logger.error('unhandled error escaped the error handler', { detail: err?.message });
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    },
  });

  app.use((req, _res, next) => {
    if (SPEC_ALIASES.has(req.path)) req.path = `/api${req.path}`;
    next();
  });

  app.use(securityHeaders);
  // Liveness probe for hosting platforms and the Docker HEALTHCHECK. Public by
  // design, reveals nothing, and sits ahead of requestLog so a probe every few
  // seconds does not flood the log.
  app.get('/healthz', (_req, res) => res.set('Cache-Control', 'no-store').json({ ok: true }));
  app.use(requestLog);
  // Applied to every method-changing request, including the aliases above.
  app.use(csrfGuard);
  app.use(jsonBody);
  app.use(attachSession);

  registerAuthRoutes(app);
  registerFileRoutes(app);
  registerContentRoutes(app);
  registerUploadRoutes(app);

  app.use(serveStatic(config.publicDir));
  app.useError(errorHandler);
  return app;
}

function firstRunBanner(pin) {
  const line = '='.repeat(64);
  logger.banner(
    `\n${line}\n` +
      '  Secure Vault first-time setup\n' +
      `  Your PIN is:  ${pin}\n\n` +
      '  This is shown once and is not recoverable from the stored hash.\n' +
      '  Sign in and change it from the profile menu.\n' +
      `${line}\n`,
  );
}

async function main() {
  let secret;
  try {
    secret = resolveSessionSecret();
  } catch (err) {
    logger.error('configuration error', { detail: err.message });
    process.stderr.write(`\n${err.message}\n\n`);
    process.exit(1);
  }
  initSessions(secret);

  const initialised = await initUserStore();
  await storage.init();
  if (initialised.created && initialised.pin) firstRunBanner(initialised.pin);
  if (initialised.created && !initialised.pin) {
    logger.warn('first-time setup complete; PIN taken from INITIAL_PIN');
  }

  const app = buildApp();
  const server = http.createServer((req, res) => {
    decorate(req, res);
    app.handle(req, res);
  });

  // Node's default 5-minute request timeout would abort a large upload on a slow
  // link. Body duration is instead bounded by the upload size limits, while
  // header and idle-socket timeouts still cut off stalled connections.
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;
  server.keepAliveTimeout = 65_000;
  server.timeout = 10 * 60_000;

  server.listen(config.port, config.host, () => {
    logger.info('secure vault listening', {
      url: `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`,
      env: config.nodeEnv,
      dataDir: config.dataDir,
    });
    if (!config.isProduction) {
      logger.banner(`\n  Secure Vault -> http://localhost:${config.port}\n`);
    }
  });

  const shutdown = (signal) => {
    logger.info('shutting down', { signal });
    server.close(() => process.exit(0));
    // Do not let a hung connection keep the process alive indefinitely.
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled rejection', { detail: reason instanceof Error ? reason.message : String(reason) });
  });
  process.on('uncaughtException', (err) => {
    logger.error('uncaught exception', { detail: err.message, stack: err.stack });
    process.exit(1);
  });
}

main().catch((err) => {
  logger.error('failed to start', { detail: err.message });
  process.stderr.write(`\n${err.message}\n\n`);
  process.exit(1);
});
