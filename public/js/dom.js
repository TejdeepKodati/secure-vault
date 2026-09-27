/**
 * DOM and formatting helpers.
 *
 * Everything user-supplied (filenames, error text) goes in through `textContent`
 * or an attribute setter - there is no innerHTML anywhere in the frontend, so a
 * file called `<img onerror=...>` is displayed, never parsed.
 */
const SVG_NS = 'http://www.w3.org/2000/svg';

export const byId = (id) => document.getElementById(id);

/**
 * @param {string} tag
 * @param {object} [props] class/text/attrs/dataset/on handlers
 * @param {Array<Node|string>} [children]
 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'on') for (const [evt, fn] of Object.entries(value)) node.addEventListener(evt, fn);
    else if (key === 'value') node.value = value;
    else if (key === 'checked' || key === 'disabled' || key === 'multiple') node[key] = Boolean(value);
    else node.setAttribute(key, String(value));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

/** An <svg><use href="#i-name"> referencing the sprite in index.html. */
export function icon(name, className = 'ico') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

const CATEGORY_ICON = {
  folder: 'folder',
  image: 'image',
  pdf: 'pdf',
  text: 'text',
  audio: 'audio',
  video: 'video',
  archive: 'archive',
};

export const iconForEntry = (entry) =>
  icon(entry.type === 'folder' ? 'folder' : CATEGORY_ICON[entry.category] || 'file');

const TYPE_LABEL = {
  folder: 'Folder',
  image: 'Image',
  pdf: 'PDF',
  text: 'Text',
  audio: 'Audio',
  video: 'Video',
  archive: 'Archive',
  document: 'Document',
  spreadsheet: 'Spreadsheet',
  presentation: 'Presentation',
  file: 'File',
};

export function typeLabel(entry) {
  if (entry.type === 'folder') return 'Folder';
  const suffix = entry.name.includes('.') ? entry.name.split('.').pop().toUpperCase() : '';
  const base = TYPE_LABEL[entry.category] || 'File';
  return suffix && suffix.length <= 5 && base === 'File' ? `${suffix} file` : base;
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function fmtBytes(bytes) {
  if (bytes === null || bytes === undefined) return '--';
  if (bytes === 0) return '0 B';
  const i = Math.min(UNITS.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** i;
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${UNITS[i]}`;
}

export function fmtDate(iso, { long = false } = {}) {
  if (!iso) return '--';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '--';
  if (long) return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: sameYear ? undefined : 'numeric',
  });
}

/** "3 items", "1 item" - avoids a stray plural in the status bar. */
export const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

export const show = (node, visible = true) => node.classList.toggle('is-hidden', !visible);

/** Trap Tab inside a modal so keyboard focus cannot wander behind the overlay. */
export function trapFocus(container, event) {
  const focusable = container.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
  );
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  }
}
