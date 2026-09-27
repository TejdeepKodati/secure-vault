import { requireAuth } from '../auth/session.js';
import { config } from '../config.js';
import { boundaryFrom, parseMultipart } from '../http/multipart.js';
import { storage } from '../storage/index.js';
import { badRequest } from '../util/errors.js';
import { logger } from '../util/logger.js';

export function registerUploadRoutes(app) {
  /**
   * POST /api/upload?path=<destination folder> (SRS 7)
   *
   * multipart/form-data. Each file part may be preceded by a `relativePath`
   * text field carrying the browser's `webkitRelativePath`, which is how a
   * folder upload keeps its hierarchy; without it the file lands directly in the
   * destination folder. Ordering is meaningful and the parser preserves it.
   *
   * Several files per request are accepted, but the frontend deliberately sends
   * one request per file so it can report byte-accurate overall progress and a
   * per-file count (SRS 8).
   */
  app.post('/api/upload', requireAuth, async (req, res, next) => {
    const boundary = boundaryFrom(req.headers['content-type']);
    if (!boundary) {
      req.resume();
      return next(badRequest('Uploads must be sent as multipart/form-data.'));
    }

    const destination = typeof req.query.path === 'string' ? req.query.path : '';
    const target = await storage.stat(destination);
    if (target.type !== 'folder') {
      req.resume();
      return next(badRequest('The upload destination is not a folder.'));
    }

    const uploaded = [];
    let pendingRelativePath = null;

    try {
      await parseMultipart(req, {
        boundary,
        limits: {
          maxFileBytes: config.maxUploadBytes,
          maxTotalBytes: config.maxUploadBytes * 4,
          maxFiles: config.maxFilesPerRequest,
          maxFieldBytes: 8 * 1024,
          maxFields: config.maxFilesPerRequest * 2 + 10,
        },
        onField(name, value) {
          if (name === 'relativePath') pendingRelativePath = value;
        },
        async onFileStart(info) {
          const relative = pendingRelativePath || info.filename;
          pendingRelativePath = null;
          return storage.createUploadSink(destination, relative);
        },
        async onFileEnd(sink, { bytes }) {
          uploaded.push({ path: sink.path, name: sink.name, size: bytes });
        },
      });
    } catch (err) {
      // The parser has already removed any partial files. Close the connection
      // once the error response has been flushed, so a client that is still
      // sending gigabytes stops rather than being left to finish.
      res.on('finish', () => {
        if (!req.destroyed) req.destroy();
      });
      return next(err);
    }

    if (uploaded.length === 0) {
      return next(badRequest('That upload did not contain any files.'));
    }

    logger.info('upload stored', {
      files: uploaded.length,
      bytes: uploaded.reduce((sum, file) => sum + file.size, 0),
    });
    return res.status(201).json({ ok: true, uploaded });
  });
}
