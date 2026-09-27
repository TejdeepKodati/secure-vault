import fsp from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';

import { contentTypeFor } from '../util/mime.js';
import { resolveInVault } from '../storage/safePath.js';

/**
 * Static asset serving for the frontend.
 *
 * Path resolution goes through the same `resolveInVault` used for vault files
 * rather than a second, slightly different implementation - one place to audit,
 * one place to fix (SRS 31).
 */
export function serveStatic(root) {
  return async function staticHandler(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();

    let requested;
    try {
      requested = decodeURIComponent(req.path);
    } catch {
      return next();
    }
    if (requested === '/' || requested === '') requested = '/index.html';

    let absolute;
    try {
      ({ absolute } = resolveInVault(root, requested));
    } catch {
      return next();
    }

    let stats;
    try {
      stats = await fsp.stat(absolute);
    } catch {
      return next();
    }
    if (!stats.isFile()) return next();

    const etag = `W/"${stats.size}-${Number(stats.mtimeMs).toString(36)}"`;
    const isHtml = path.extname(absolute) === '.html';

    res.set('Content-Type', contentTypeFor(absolute));
    res.set('ETag', etag);
    res.set('Last-Modified', stats.mtime.toUTCString());
    // The HTML shell must always be revalidated so a deploy is picked up; the
    // hashed-by-nothing CSS/JS still revalidate, just cheaply via ETag.
    res.set('Cache-Control', isHtml ? 'no-cache' : 'private, max-age=0, must-revalidate');

    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }

    res.set('Content-Length', stats.size);
    if (req.method === 'HEAD') return res.end();

    const stream = createReadStream(absolute);
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    return stream.pipe(res);
  };
}
