import * as fsStorage from './fsStorage.js';
import * as trash from './trash.js';

/**
 * The storage interface the routes are written against (SRS 6, FR-13).
 *
 * Routes never import `fsStorage` or `trash` directly and never see an absolute
 * path, so replacing the filesystem backend with object storage means providing
 * another object with these methods - no route or frontend change.
 */
async function sizeOf(relativePath) {
  try {
    const info = await fsStorage.stat(relativePath);
    return info.totalSize ?? info.size ?? null;
  } catch {
    return null;
  }
}

export const storage = {
  init: fsStorage.init,

  // Browsing and metadata
  list: fsStorage.list,
  stat: fsStorage.stat,

  // Mutations
  createFolder: fsStorage.createFolder,
  rename: fsStorage.rename,
  move: fsStorage.move,

  // Content
  openRead: fsStorage.openRead,
  createUploadSink: fsStorage.createUploadSink,

  // Recycle bin
  moveToTrash: (inputs) => trash.moveToTrash(inputs, { sizeOf }),
  listTrash: trash.listTrash,
  restoreFromTrash: trash.restoreFromTrash,
  purgeFromTrash: trash.purgeFromTrash,
  emptyTrash: trash.emptyTrash,
};
