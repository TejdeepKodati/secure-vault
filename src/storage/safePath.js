import fsp from 'node:fs/promises';
import path from 'node:path';

import { badRequest, forbidden } from '../util/errors.js';

/**
 * Path safety (SRS 25).
 *
 * Every path that reaches the filesystem goes through this module. Client input
 * is treated as an opaque, vault-relative string: it is decomposed into
 * segments, any traversal segment is rejected outright rather than stripped, the
 * result is re-resolved against the vault root, and containment is re-verified
 * on the resolved path. Symlinks are then resolved so a link inside the vault
 * cannot point outside it.
 *
 * Rejecting rather than sanitising traversal is deliberate: silently rewriting
 * `../../etc/passwd` into `etc/passwd` turns an attack into a confusing success.
 */

/** Control characters, DEL, and the separators/reserved characters of both platforms. */
const ILLEGAL_IN_SEGMENT = /[\x00-\x1f\x7f/\\:*?"<>|]/g;
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
const NUL = '\x00';

/** Device names Windows resolves specially, regardless of extension. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

const MAX_SEGMENT_BYTES = 200;
const MAX_DEPTH = 32;

/**
 * Make an arbitrary string safe to use as one path segment.
 * Used for uploaded filenames, new folder names and renames (SRS 24).
 */
export function sanitizeName(raw) {
  let name = String(raw ?? '')
    .replace(ILLEGAL_IN_SEGMENT, '_')
    .replace(/^\.+/, '') // no hidden or dot-prefixed names, no bare "." or ".."
    .trim();

  // Windows discards trailing dots and spaces, which would silently change the
  // stored name and break later lookups by that name.
  name = name.replace(/[. ]+$/, '');

  if (WINDOWS_RESERVED.test(name)) name = `_${name}`;
  if (name === '') name = 'unnamed';

  // Truncate on a byte budget, keeping the extension so type detection survives.
  if (Buffer.byteLength(name) > MAX_SEGMENT_BYTES) {
    const extension = path.extname(name).slice(0, 24);
    let stem = name.slice(0, name.length - path.extname(name).length);
    while (Buffer.byteLength(stem + extension) > MAX_SEGMENT_BYTES && stem.length > 1) {
      stem = stem.slice(0, -1);
    }
    name = stem + extension;
  }
  return name;
}

/** Validate a name supplied for a rename or a new folder. Throws, never rewrites. */
export function assertValidName(raw) {
  const candidate = String(raw ?? '').trim();
  if (candidate === '') throw badRequest('A name is required.');
  if (candidate === '.' || candidate === '..') throw badRequest('That name is not allowed.');
  if (CONTROL_CHARS.test(candidate)) throw badRequest('That name contains control characters.');
  if (/[/\\]/.test(candidate)) throw badRequest('A name cannot contain slashes.');
  if (/[:*?"<>|]/.test(candidate)) throw badRequest('A name cannot contain : * ? " < > or |');
  if (candidate.startsWith('.')) throw badRequest('A name cannot start with a dot.');
  if (/[. ]$/.test(candidate)) throw badRequest('A name cannot end with a dot or a space.');
  if (WINDOWS_RESERVED.test(candidate)) throw badRequest('That name is reserved by the operating system.');
  if (Buffer.byteLength(candidate) > MAX_SEGMENT_BYTES) throw badRequest('That name is too long.');
  return candidate;
}

/**
 * Turn client input into a normalised, vault-relative path such as `a/b/c`.
 * Returns '' for the vault root. Throws on any traversal attempt.
 *
 * Backslash is treated as a separator so `..\..\secret.txt` cannot slip past on
 * a Windows host. The trade-off is that a filename containing a literal
 * backslash is not addressable - `sanitizeName` stops the app from creating one,
 * so this only affects files placed in the vault out-of-band.
 */
export function normalizeRelative(input) {
  if (input === undefined || input === null || input === '') return '';
  if (typeof input !== 'string') throw badRequest('That path is not valid.');
  if (input.includes(NUL)) throw badRequest('That path is not valid.', 'NUL byte in path');

  const segments = [];
  for (const rawSegment of input.split(/[/\\]+/)) {
    const segment = rawSegment.trim();
    if (segment === '' || segment === '.') continue;
    if (segment === '..' || /^\.+$/.test(segment)) {
      throw forbidden('That path is not allowed.', `traversal segment in ${JSON.stringify(input)}`);
    }
    if (CONTROL_CHARS.test(segment)) {
      throw badRequest('That path is not valid.', 'control character in path');
    }
    segments.push(segment);
  }
  if (segments.length > MAX_DEPTH) throw badRequest('That path is nested too deeply.');
  return segments.join('/');
}

/** Throw unless `absolute` is `root` itself or sits underneath it. */
export function assertInside(root, absolute) {
  const relative = path.relative(root, absolute);
  if (relative === '') return absolute;
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw forbidden('That path is not allowed.', 'resolved outside vault root');
  }
  return absolute;
}

/** Resolve vault-relative client input to an absolute, contained path. */
export function resolveInVault(root, input) {
  const relative = normalizeRelative(input);
  const absolute = relative === '' ? root : path.resolve(root, relative);
  assertInside(root, absolute);
  return { absolute, relative };
}

/**
 * Second line of defence: resolve symlinks before touching the path.
 *
 * Walks up to the nearest existing ancestor, so it also protects paths that are
 * about to be created, then verifies the fully-resolved location is still inside
 * the vault. Without this, a symlink placed in the vault - by a restored backup,
 * a synced folder, or an unpacked archive - would expose the whole filesystem.
 */
export async function assertRealPathInside(root, absolute) {
  const realRoot = await fsp.realpath(root);
  const pending = [];
  let cursor = absolute;

  for (;;) {
    try {
      const resolved = await fsp.realpath(cursor);
      const full = pending.length ? path.join(resolved, ...pending) : resolved;
      assertInside(realRoot, full);
      return full;
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw err;
      pending.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

/** Absolute path back to the client-facing relative form. Never leaks the root. */
export function toRelative(root, absolute) {
  const relative = path.relative(root, absolute);
  return relative === '' ? '' : relative.split(path.sep).join('/');
}

/** Parent of a vault-relative path, or null at the root. */
export function parentOf(relative) {
  if (!relative) return null;
  const index = relative.lastIndexOf('/');
  return index === -1 ? '' : relative.slice(0, index);
}
