import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { config } from '../config.js';
import { badRequest, fromFsError, notFound } from '../util/errors.js';
import { categoryFor } from '../util/mime.js';
import { logger } from '../util/logger.js';
import { relocate, uniqueName } from './fsStorage.js';
import {
  assertInside,
  assertRealPathInside,
  parentOf,
  resolveInVault,
  toRelative,
} from './safePath.js';

/**
 * Recycle bin (SRS 16).
 *
 * Deleting moves the item into DATA_DIR/trash/<uuid>/, which holds a meta.json
 * describing where it came from and a payload/ directory containing the item
 * under its original name. Two reasons for the per-item directory: names can
 * never collide, and there is no shared index file that could be corrupted or
 * drift out of step with what is actually on disk.
 *
 * Restore is included even though the SRS only asks for Empty Bin - a bin you
 * cannot recover from is just a slower delete, and the metadata needed for it is
 * already being written.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function entryDir(id) {
  if (!UUID.test(String(id ?? ''))) throw badRequest('That recycle bin reference is not valid.');
  const absolute = path.join(config.trashDir, String(id));
  assertInside(config.trashDir, absolute);
  return absolute;
}

async function readMeta(id) {
  // Resolved outside the try: an invalid id is a 400, and routing it through the
  // filesystem error translator below would report it as a server fault.
  const dir = entryDir(id);
  try {
    const text = await fsp.readFile(path.join(dir, 'meta.json'), 'utf8');
    return JSON.parse(text);
  } catch (err) {
    if (err.code === 'ENOENT') throw notFound('That item is no longer in the recycle bin.');
    throw fromFsError(err, 'That recycle bin entry could not be read.');
  }
}

/**
 * Move items into the bin. `sizeOf` is injected by the storage index so this
 * module does not need to know how folder sizes are measured.
 */
export async function moveToTrash(inputs, { sizeOf } = {}) {
  const results = [];
  for (const input of inputs) {
    const { absolute, relative } = resolveInVault(config.vaultDir, input);
    await assertRealPathInside(config.vaultDir, absolute);
    if (relative === '') throw badRequest('The vault root cannot be deleted.');

    let stats;
    try {
      stats = await fsp.stat(absolute);
    } catch (err) {
      if (err.code === 'ENOENT') throw notFound('That item no longer exists.');
      throw fromFsError(err);
    }

    const id = crypto.randomUUID();
    const directory = entryDir(id);
    const payload = path.join(directory, 'payload');
    await fsp.mkdir(payload, { recursive: true });

    const name = path.basename(relative);
    const meta = {
      id,
      name,
      type: stats.isDirectory() ? 'folder' : 'file',
      category: stats.isDirectory() ? 'folder' : categoryFor(name),
      originalPath: relative,
      originalParent: parentOf(relative) ?? '',
      size: stats.isDirectory() ? (sizeOf ? await sizeOf(relative) : null) : stats.size,
      deletedAt: new Date().toISOString(),
    };

    try {
      await relocate(absolute, path.join(payload, name));
      await fsp.writeFile(path.join(directory, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
    } catch (err) {
      await fsp.rm(directory, { recursive: true, force: true });
      throw fromFsError(err, 'That item could not be moved to the recycle bin.');
    }
    results.push({ id, name, from: relative, type: meta.type });
  }
  return results;
}

export async function listTrash() {
  let ids;
  try {
    ids = await fsp.readdir(config.trashDir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw fromFsError(err, 'The recycle bin could not be read.');
  }

  const entries = [];
  for (const id of ids) {
    if (!UUID.test(id)) continue;
    try {
      const meta = JSON.parse(await fsp.readFile(path.join(config.trashDir, id, 'meta.json'), 'utf8'));
      entries.push({
        id: meta.id,
        name: meta.name,
        type: meta.type,
        category: meta.category,
        size: meta.size ?? null,
        originalPath: meta.originalPath,
        deletedAt: meta.deletedAt,
      });
    } catch {
      // A half-written or hand-edited entry: skip it rather than fail the listing.
    }
  }
  entries.sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)));
  return entries;
}

/** Put an item back where it came from, recreating the parent folder if needed. */
export async function restoreFromTrash(ids) {
  const results = [];
  for (const id of ids) {
    const meta = await readMeta(id);
    const source = path.join(entryDir(id), 'payload', meta.name);

    const { absolute: parentAbsolute } = resolveInVault(config.vaultDir, meta.originalParent || '');
    await assertRealPathInside(config.vaultDir, parentAbsolute);
    await fsp.mkdir(parentAbsolute, { recursive: true });

    const name = await uniqueName(parentAbsolute, meta.name);
    const target = path.join(parentAbsolute, name);
    assertInside(config.vaultDir, target);

    try {
      await relocate(source, target);
    } catch (err) {
      throw fromFsError(err, 'That item could not be restored.');
    }
    await fsp.rm(entryDir(id), { recursive: true, force: true });

    results.push({
      id,
      to: toRelative(config.vaultDir, target),
      renamed: name !== meta.name ? name : undefined,
    });
  }
  return results;
}

/** Permanently delete specific bin entries. */
export async function purgeFromTrash(ids) {
  let removed = 0;
  for (const id of ids) {
    await fsp.rm(entryDir(id), { recursive: true, force: true });
    removed += 1;
  }
  logger.warn('recycle bin entries purged', { count: removed });
  return { removed };
}

/** Empty Bin: permanently delete everything in the bin (SRS 16). */
export async function emptyTrash() {
  let ids;
  try {
    ids = await fsp.readdir(config.trashDir);
  } catch (err) {
    if (err.code === 'ENOENT') return { removed: 0 };
    throw fromFsError(err, 'The recycle bin could not be emptied.');
  }
  let removed = 0;
  for (const id of ids) {
    if (!UUID.test(id)) continue;
    await fsp.rm(path.join(config.trashDir, id), { recursive: true, force: true });
    removed += 1;
  }
  logger.warn('recycle bin emptied', { removed });
  return { removed };
}
