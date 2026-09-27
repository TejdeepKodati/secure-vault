import { requireAuth } from '../auth/session.js';
import { storage } from '../storage/index.js';
import { badRequest } from '../util/errors.js';

const MAX_BATCH = 500;

/** Accept either `?path=` or a `paths` array, and validate the shape once. */
function pathList(body, query) {
  const raw = body?.paths ?? body?.path ?? query?.path;
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  if (list.length === 0) throw badRequest('Select at least one item first.');
  if (list.length > MAX_BATCH) throw badRequest(`Please do that in batches of ${MAX_BATCH} or fewer.`);
  for (const entry of list) {
    if (typeof entry !== 'string') throw badRequest('That selection is not valid.');
  }
  return list;
}

function idList(body) {
  const raw = body?.ids ?? body?.id;
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  if (list.length === 0) throw badRequest('Select at least one item first.');
  if (list.length > MAX_BATCH) throw badRequest(`Please do that in batches of ${MAX_BATCH} or fewer.`);
  return list.map(String);
}

export function registerFileRoutes(app) {
  /** GET /api/files?path= - directory listing (SRS 9, 10). */
  app.get('/api/files', requireAuth, async (req, res) => {
    return res.json(await storage.list(req.query.path));
  });

  /** GET /api/info?path= - metadata for one item (SRS 18). */
  app.get('/api/info', requireAuth, async (req, res) => {
    return res.json(await storage.stat(req.query.path));
  });

  /**
   * POST /api/folder - create a folder.
   * Not itemised in the SRS, but Move (SRS 15) needs somewhere to move things to
   * and folder upload is a clumsy way to create one empty folder.
   */
  app.post('/api/folder', requireAuth, async (req, res) => {
    const { path: parent, name } = req.body ?? {};
    const entry = await storage.createFolder(parent ?? '', name);
    return res.status(201).json({ ok: true, entry });
  });

  /** POST /api/rename (SRS 14). */
  app.post('/api/rename', requireAuth, async (req, res, next) => {
    const { path: target, newName } = req.body ?? {};
    if (typeof target !== 'string') return next(badRequest('Which item should be renamed?'));
    const entry = await storage.rename(target, newName);
    return res.json({ ok: true, entry });
  });

  /** POST /api/move (SRS 15). */
  app.post('/api/move', requireAuth, async (req, res, next) => {
    const destination = req.body?.destination;
    if (typeof destination !== 'string') {
      return next(badRequest('Choose a destination folder.'));
    }
    const results = await storage.move(pathList(req.body, req.query), destination);
    return res.json({ ok: true, moved: results });
  });

  /**
   * DELETE /api/delete - moves items to the recycle bin rather than destroying
   * them (SRS 16). Accepts several paths so bulk delete works (SRS 17).
   */
  app.delete('/api/delete', requireAuth, async (req, res) => {
    const results = await storage.moveToTrash(pathList(req.body, req.query));
    return res.json({ ok: true, trashed: results });
  });

  /** GET /api/trash - list the recycle bin. */
  app.get('/api/trash', requireAuth, async (req, res) => {
    return res.json({ entries: await storage.listTrash() });
  });

  /** POST /api/trash/restore - put items back where they came from. */
  app.post('/api/trash/restore', requireAuth, async (req, res) => {
    return res.json({ ok: true, restored: await storage.restoreFromTrash(idList(req.body)) });
  });

  /** DELETE /api/trash - permanently delete selected bin entries. */
  app.delete('/api/trash', requireAuth, async (req, res) => {
    return res.json({ ok: true, ...(await storage.purgeFromTrash(idList(req.body))) });
  });

  /** DELETE /api/empty-trash - Empty Bin (SRS 16). Irreversible. */
  app.delete('/api/empty-trash', requireAuth, async (req, res) => {
    return res.json({ ok: true, ...(await storage.emptyTrash()) });
  });
}
