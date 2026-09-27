import { requireAuth } from '../auth/session.js';
import { storage } from '../storage/index.js';
import { badRequest, unsupportedMedia } from '../util/errors.js';
import { logger } from '../util/logger.js';
import { MAX_TEXT_PREVIEW_BYTES, previewMode } from '../util/mime.js';

/** RFC 6266 / RFC 5987 header that survives non-ASCII names (SRS 13). */
function contentDisposition(disposition, name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Single-range parsing, enough for media scrubbing and PDF.js range requests. */
function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;

  let start;
  let end;
  if (rawStart === '') {
    const suffix = Number.parseInt(rawEnd, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number.parseInt(rawStart, 10);
    end = rawEnd === '' ? size - 1 : Number.parseInt(rawEnd, 10);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end || start >= size) return { unsatisfiable: true };
  return { start, end: Math.min(end, size - 1) };
}

function stream(req, res, file, { contentType, disposition, extraHeaders = {} }) {
  const size = file.size;
  res.set('Content-Type', contentType);
  res.set('Content-Disposition', contentDisposition(disposition, file.name));
  res.set('Accept-Ranges', 'bytes');
  res.set('Cache-Control', 'private, no-store');
  res.set('Last-Modified', file.modified.toUTCString());
  for (const [key, value] of Object.entries(extraHeaders)) res.set(key, value);

  const range = req.headers.range ? parseRange(req.headers.range, size) : null;
  if (range?.unsatisfiable) {
    res.set('Content-Range', `bytes */${size}`);
    return res.status(416).json({
      error: { code: 'RANGE_NOT_SATISFIABLE', message: 'That byte range is outside the file.' },
    });
  }

  const start = range ? range.start : 0;
  const end = range ? range.end : Math.max(0, size - 1);
  const length = size === 0 ? 0 : end - start + 1;

  if (range) {
    res.status(206).set('Content-Range', `bytes ${start}-${end}/${size}`);
  }
  res.set('Content-Length', length);

  if (req.method === 'HEAD') return res.end();
  if (size === 0) return res.end();

  const readable = file.createStream({ start, end });
  readable.on('error', (err) => {
    logger.error('stream failed', { detail: err.message });
    res.destroy();
  });
  res.on('close', () => readable.destroy());
  return readable.pipe(res);
}

export function registerContentRoutes(app) {
  /**
   * GET /api/preview?path= - inline rendering for supported types (SRS 12).
   *
   * Only whitelisted extensions are served inline, and anything text-like goes
   * out as text/plain no matter what its extension claims. That is what stops a
   * stored .html or .svg from running script in the vault's own origin and
   * reading the session cookie.
   */
  app.get('/api/preview', requireAuth, async (req, res, next) => {
    if (typeof req.query.path !== 'string' || req.query.path === '') {
      return next(badRequest('Which file should be previewed?'));
    }
    const file = await storage.openRead(req.query.path);
    const mode = previewMode(file.name);
    if (!mode) {
      return next(
        unsupportedMedia('There is no preview for this file type. Download it to open it locally.'),
      );
    }

    if (mode.kind === 'text' && file.size > MAX_TEXT_PREVIEW_BYTES) {
      return next(
        unsupportedMedia(
          `That text file is larger than ${Math.round(MAX_TEXT_PREVIEW_BYTES / (1024 * 1024))} MB. Download it to read it all.`,
        ),
      );
    }

    // SVG and text are sandboxed; PDF is left alone because a sandbox directive
    // breaks the browsers' built-in viewers.
    const extraHeaders =
      mode.kind === 'svg' || mode.kind === 'text'
        ? { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" }
        : {};

    return stream(req, res, file, {
      contentType: mode.contentType,
      disposition: 'inline',
      extraHeaders,
    });
  });

  /**
   * GET /api/download?path= - always an attachment with an octet-stream type, so
   * no stored file can ever be rendered as active content by the browser.
   */
  app.get('/api/download', requireAuth, async (req, res, next) => {
    if (typeof req.query.path !== 'string' || req.query.path === '') {
      return next(badRequest('Which file should be downloaded?'));
    }
    const file = await storage.openRead(req.query.path);
    return stream(req, res, file, {
      contentType: 'application/octet-stream',
      disposition: 'attachment',
    });
  });
}
