import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { config } from '../config.js';
import { badRequest, conflict, fromFsError, notFound } from '../util/errors.js';
import { categoryFor } from '../util/mime.js';
import {
  assertInside,
  assertRealPathInside,
  assertValidName,
  normalizeRelative,
  parentOf,
  resolveInVault,
  sanitizeName,
  toRelative,
} from './safePath.js';

/**
 * Filesystem storage backend (SRS 6).
 *
 * Everything the routes need is expressed here in terms of vault-relative paths.
 * No absolute path, and no `fs` call, escapes this module - which is what makes
 * the backend swappable later (FR-13) and keeps server paths out of responses
 * (SRS 24).
 *
 * Symlinks are deliberately invisible: they are never created by the app, they
 * are omitted from listings, and any path that resolves through one to somewhere
 * outside the vault is refused by `assertRealPathInside`.
 */
const VAULT = config.vaultDir;

const asEntry = (absolute, stats, name) => ({
  name,
  path: toRelative(VAULT, absolute),
  type: stats.isDirectory() ? 'folder' : 'file',
  size: stats.isDirectory() ? null : stats.size,
  modified: stats.mtime.toISOString(),
  created: stats.birthtimeMs ? new Date(stats.birthtimeMs).toISOString() : null,
  category: stats.isDirectory() ? 'folder' : categoryFor(name),
});

/** Resolve client input, verify containment, and stat it. */
async function resolve(input, { mustExist = true } = {}) {
  const { absolute, relative } = resolveInVault(VAULT, input);
  await assertRealPathInside(VAULT, absolute);
  if (!mustExist) return { absolute, relative, stats: null };
  try {
    const stats = await fsp.stat(absolute);
    return { absolute, relative, stats };
  } catch (err) {
    if (err.code === 'ENOENT') throw notFound('That item could not be found.', err.message);
    throw fromFsError(err);
  }
}

/** Pick a name that does not collide, so no upload or move overwrites silently. */
export async function uniqueName(dirAbsolute, desired) {
  const extension = path.extname(desired);
  const stem = desired.slice(0, desired.length - extension.length) || 'unnamed';
  let candidate = desired;
  for (let index = 1; index <= 9999; index += 1) {
    try {
      await fsp.access(path.join(dirAbsolute, candidate));
    } catch {
      return candidate;
    }
    candidate = `${stem} (${index})${extension}`;
  }
  return `${stem} (${Date.now()})${extension}`;
}

/** rename(2), falling back to copy+delete when source and target differ by device. */
export async function relocate(fromAbsolute, toAbsolute) {
  try {
    await fsp.rename(fromAbsolute, toAbsolute);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    await fsp.cp(fromAbsolute, toAbsolute, { recursive: true, errorOnExist: true, force: false });
    await fsp.rm(fromAbsolute, { recursive: true, force: true });
  }
}

export async function init() {
  await fsp.mkdir(VAULT, { recursive: true });
  await fsp.mkdir(config.trashDir, { recursive: true });
}

/** Directory listing for the file browser (SRS 9, 10). */
export async function list(input) {
  const { absolute, relative, stats } = await resolve(input);
  if (!stats.isDirectory()) throw badRequest('That path is a file, not a folder.');

  let dirents;
  try {
    dirents = await fsp.readdir(absolute, { withFileTypes: true });
  } catch (err) {
    throw fromFsError(err, 'That folder could not be read.');
  }

  const entries = [];
  for (const dirent of dirents) {
    if (dirent.name.startsWith('.')) continue;
    if (!dirent.isFile() && !dirent.isDirectory()) continue; // skips symlinks, sockets, devices
    const child = path.join(absolute, dirent.name);
    try {
      entries.push(asEntry(child, await fsp.lstat(child), dirent.name));
    } catch {
      // Vanished between readdir and lstat; just leave it out of the listing.
    }
  }

  entries.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) : a.type === 'folder' ? -1 : 1,
  );

  return {
    path: relative,
    name: relative === '' ? 'Vault' : path.basename(relative),
    parent: parentOf(relative),
    entries,
  };
}

/** Metadata for the Info action (SRS 18). */
export async function stat(input) {
  const { absolute, relative, stats } = await resolve(input);
  const entry = asEntry(absolute, stats, relative === '' ? 'Vault' : path.basename(relative));
  if (!stats.isDirectory()) {
    return { ...entry, accessed: stats.atime.toISOString(), parent: parentOf(relative) };
  }
  const summary = await summarise(absolute);
  return { ...entry, ...summary, accessed: stats.atime.toISOString(), parent: parentOf(relative) };
}

/**
 * Recursive size and counts for a folder, bounded so Info on a huge tree cannot
 * stall the request. Reports `truncated` when it stopped early.
 */
async function summarise(absolute, budget = { entries: 20000, depth: 24 }) {
  let files = 0;
  let folders = 0;
  let size = 0;
  let truncated = false;

  const walk = async (dir, depth) => {
    if (truncated || depth > budget.depth) return;
    let dirents;
    try {
      dirents = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      if (files + folders >= budget.entries) {
        truncated = true;
        return;
      }
      if (dirent.name.startsWith('.')) continue;
      const child = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        folders += 1;
        await walk(child, depth + 1);
      } else if (dirent.isFile()) {
        files += 1;
        try {
          size += (await fsp.lstat(child)).size;
        } catch {
          /* ignore entries that disappear mid-walk */
        }
      }
    }
  };

  await walk(absolute, 0);
  return { fileCount: files, folderCount: folders, totalSize: size, truncated };
}

/** Create a folder so Move has somewhere to move things to. */
export async function createFolder(parentInput, rawName) {
  const name = sanitizeName(assertValidName(rawName));
  const { absolute: parentAbsolute, stats } = await resolve(parentInput);
  if (!stats.isDirectory()) throw badRequest('That path is a file, not a folder.');

  const target = path.join(parentAbsolute, name);
  assertInside(VAULT, target);
  try {
    await fsp.mkdir(target);
  } catch (err) {
    if (err.code === 'EEXIST') throw conflict('An item with that name already exists here.');
    throw fromFsError(err, 'That folder could not be created.');
  }
  return asEntry(target, await fsp.stat(target), name);
}

/** Rename in place (SRS 14). */
export async function rename(input, rawName) {
  const name = sanitizeName(assertValidName(rawName));
  const { absolute, relative } = await resolve(input);
  if (relative === '') throw badRequest('The vault root cannot be renamed.');

  const target = path.join(path.dirname(absolute), name);
  assertInside(VAULT, target);
  if (target === absolute) return asEntry(absolute, await fsp.stat(absolute), name);

  try {
    // Refuse rather than clobber, including a case-only change on a
    // case-insensitive filesystem where the two paths are the same file.
    await fsp.access(target);
    throw conflict('An item with that name already exists here.');
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      if (err?.status) throw err;
      throw fromFsError(err, 'That item could not be renamed.');
    }
  }

  try {
    await fsp.rename(absolute, target);
  } catch (err) {
    throw fromFsError(err, 'That item could not be renamed.');
  }
  return asEntry(target, await fsp.stat(target), name);
}

const isDescendant = (candidate, ancestor) => {
  const relative = path.relative(ancestor, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};

/**
 * Move items into another folder (SRS 15).
 *
 * Refuses to move a folder into itself or into its own subtree - rename(2) would
 * either fail cryptically or, worse, detach the subtree. Name collisions are
 * resolved by suffixing rather than overwriting, and the chosen name is returned
 * so the UI can say what actually happened.
 */
export async function move(inputs, destinationInput) {
  const destination = await resolve(destinationInput);
  if (!destination.stats.isDirectory()) throw badRequest('The destination is not a folder.');

  const results = [];
  for (const input of inputs) {
    const source = await resolve(input);
    if (source.relative === '') throw badRequest('The vault root cannot be moved.');

    if (source.absolute === destination.absolute) {
      throw badRequest('A folder cannot be moved into itself.');
    }
    if (source.stats.isDirectory() && isDescendant(destination.absolute, source.absolute)) {
      throw badRequest('A folder cannot be moved into one of its own subfolders.');
    }
    if (path.dirname(source.absolute) === destination.absolute) {
      results.push({ from: source.relative, to: source.relative, unchanged: true });
      continue;
    }

    const name = await uniqueName(destination.absolute, path.basename(source.absolute));
    const target = path.join(destination.absolute, name);
    assertInside(VAULT, target);
    try {
      await relocate(source.absolute, target);
    } catch (err) {
      throw fromFsError(err, 'That item could not be moved.');
    }
    results.push({
      from: source.relative,
      to: toRelative(VAULT, target),
      renamed: name !== path.basename(source.absolute) ? name : undefined,
    });
  }
  return results;
}

/**
 * Open a file for streaming (download and preview).
 * Returns a stream factory rather than a path, so no absolute path leaves here.
 */
export async function openRead(input) {
  const { absolute, relative, stats } = await resolve(input);
  if (stats.isDirectory()) throw badRequest('That item is a folder, so it cannot be opened as a file.');
  return {
    path: relative,
    name: path.basename(relative),
    size: stats.size,
    modified: stats.mtime,
    createStream: (options) => createReadStream(absolute, options),
  };
}

/**
 * Create a write sink for one uploaded file (SRS 7).
 *
 * `rawRelativeName` may carry a folder path from a directory upload
 * (`photos/2024/img.jpg`); every segment is sanitised individually and the
 * hierarchy is recreated under the destination. The file is opened with 'wx' so
 * two concurrent uploads that picked the same free name cannot overwrite each
 * other - the loser errors instead of silently winning.
 */
export async function createUploadSink(destinationInput, rawRelativeName) {
  const segments = String(rawRelativeName ?? '')
    .split(/[/\\]+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
    .map(sanitizeName);

  const fileName = segments.pop() || 'unnamed';
  const directoryRelative = [normalizeRelative(destinationInput), ...segments].filter(Boolean).join('/');
  const { absolute: directoryAbsolute } = resolveInVault(VAULT, directoryRelative);
  await assertRealPathInside(VAULT, directoryAbsolute);
  await fsp.mkdir(directoryAbsolute, { recursive: true });

  const name = await uniqueName(directoryAbsolute, fileName);
  const absolute = path.join(directoryAbsolute, name);
  assertInside(VAULT, absolute);

  const handle = await fsp.open(absolute, 'wx', 0o600);
  const stream = handle.createWriteStream();
  let closed = false;

  return {
    name,
    path: toRelative(VAULT, absolute),
    async write(chunk) {
      if (!stream.write(chunk)) await once(stream, 'drain');
    },
    async finish() {
      if (closed) return;
      closed = true;
      await new Promise((resolve_, reject) => {
        stream.once('error', reject);
        stream.end(resolve_);
      });
    },
    async abort() {
      if (!closed) {
        closed = true;
        stream.destroy();
      }
      await fsp.rm(absolute, { force: true });
    },
  };
}
