import path from 'node:path';

/** Extension -> content type, for static assets, download and preview. */
const TYPES = new Map(
  Object.entries({
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.bmp': 'image/bmp',
    '.ico': 'image/x-icon',
    '.tiff': 'image/tiff',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.woff2': 'font/woff2',
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.flac': 'audio/flac',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.zip': 'application/zip',
  }),
);

/** Rendered inline by the preview endpoint (SRS 12). */
const PREVIEW_IMAGE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.ico']);
const PREVIEW_SVG = new Set(['.svg']);
const PREVIEW_PDF = new Set(['.pdf']);

/**
 * Audio and video the browser can play natively. Beyond the SRS 12 minimum, but
 * the range-request support the preview endpoint already has is exactly what
 * scrubbing needs, and a media type is passive content - unlike .html or .svg,
 * there is nothing here for a browser to execute.
 */
const PREVIEW_MEDIA = new Set(['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.flac', '.mp4', '.webm', '.mov']);

/**
 * Extensions previewed as plain text. Served as text/plain regardless of what
 * the extension implies, so a stored .html or .svg cannot execute script in the
 * vault's own origin.
 */
const PREVIEW_TEXT = new Set([
  '.txt', '.md', '.markdown', '.log', '.csv', '.tsv', '.json', '.xml', '.yml', '.yaml',
  '.ini', '.cfg', '.conf', '.env', '.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx', '.css',
  '.scss', '.html', '.htm', '.sql', '.sh', '.bash', '.zsh', '.py', '.rb', '.go', '.rs',
  '.java', '.c', '.h', '.cpp', '.cs', '.php', '.pl', '.lua', '.toml', '.gitignore', '.srt',
]);

export const ext = (name) => path.extname(String(name || '')).toLowerCase();

export function contentTypeFor(name) {
  return TYPES.get(ext(name)) || 'application/octet-stream';
}

/** Coarse grouping used for icons and the Type column in the browser. */
export function categoryFor(name) {
  const e = ext(name);
  if (PREVIEW_IMAGE.has(e) || PREVIEW_SVG.has(e)) return 'image';
  if (PREVIEW_PDF.has(e)) return 'pdf';
  if (PREVIEW_TEXT.has(e)) return 'text';
  if (['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac'].includes(e)) return 'audio';
  if (['.mp4', '.webm', '.mov', '.mkv', '.avi'].includes(e)) return 'video';
  if (['.zip', '.gz', '.tar', '.rar', '.7z', '.bz2', '.xz'].includes(e)) return 'archive';
  if (['.doc', '.docx', '.odt', '.rtf'].includes(e)) return 'document';
  if (['.xls', '.xlsx', '.ods'].includes(e)) return 'spreadsheet';
  if (['.ppt', '.pptx', '.odp'].includes(e)) return 'presentation';
  return 'file';
}

/**
 * How (or whether) a file may be previewed inline.
 *
 * Returns null when the type is not previewable, so the endpoint can answer 415
 * instead of streaming arbitrary bytes into the browser with a guessed type.
 */
export function previewMode(name) {
  const e = ext(name);
  if (PREVIEW_IMAGE.has(e)) return { kind: 'image', contentType: TYPES.get(e) || 'application/octet-stream' };
  if (PREVIEW_SVG.has(e)) return { kind: 'svg', contentType: 'image/svg+xml' };
  if (PREVIEW_PDF.has(e)) return { kind: 'pdf', contentType: 'application/pdf' };
  if (PREVIEW_MEDIA.has(e)) {
    const contentType = TYPES.get(e) || 'application/octet-stream';
    return { kind: contentType.startsWith('audio/') ? 'audio' : 'video', contentType };
  }
  if (PREVIEW_TEXT.has(e)) return { kind: 'text', contentType: 'text/plain; charset=utf-8' };
  return null;
}

/** Cap on how much of a text file the preview endpoint will stream. */
export const MAX_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024;
