/**
 * Preview modal (SRS 12).
 *
 * Every variant loads through the authenticated /api/preview endpoint - nothing
 * is ever served from a public path. Text arrives as a string and is inserted
 * with textContent, so a stored .html or .md file is shown as source rather than
 * being parsed; the backend also forces text/plain and a sandbox CSP on it.
 */
import { downloadUrl, previewText, previewUrl } from '../api.js';
import { el, fmtBytes, icon } from '../dom.js';
import { button, closeModal, openModal } from '../ui/modal.js';
import { reportError } from '../ui/toast.js';

const CATEGORY_TO_KIND = {
  image: 'image',
  pdf: 'pdf',
  text: 'text',
  audio: 'audio',
  video: 'video',
};

function fallback(entry, message) {
  return el('div', { class: 'pv-fallback' }, [
    icon('file', 'ico ico-brand'),
    el('p', { class: 'modal-note', text: message }),
    el('p', { class: 'hint', text: `${entry.name} - ${fmtBytes(entry.size)}` }),
  ]);
}

function imageView(entry) {
  const img = el('img', { class: 'pv-img', src: previewUrl(entry.path), alt: entry.name });
  const host = el('div', { class: 'pv' }, [img]);
  img.addEventListener('error', () => {
    host.replaceChildren(fallback(entry, 'That image could not be displayed.'));
  });
  return host;
}

function mediaView(entry, tag) {
  const media = el(tag, { class: 'pv-media', controls: '', preload: 'metadata', src: previewUrl(entry.path) });
  const host = el('div', { class: 'pv' }, [media]);
  media.addEventListener('error', () => {
    host.replaceChildren(fallback(entry, 'This browser cannot play that file. Download it to open it locally.'));
  });
  return host;
}

async function textView(entry, host, signal) {
  try {
    const text = await previewText(entry.path, signal);
    if (signal.aborted) return;
    const pre = el('pre', { class: 'pv-text' });
    pre.textContent = text;
    host.replaceChildren(pre);
  } catch (err) {
    if (signal.aborted || err?.name === 'AbortError') return;
    host.replaceChildren(fallback(entry, err?.message || 'That file could not be previewed.'));
  }
}

/** Open the preview for one file entry. Folders never reach here. */
export function openPreview(entry) {
  const kind = CATEGORY_TO_KIND[entry.category];

  // PDFs are opened as a direct top-level navigation instead of inside an
  // iframe in the modal. Mobile Chromium-based browsers (Chrome, Brave, Edge
  // on Android) refuse to render a PDF inside an iframe at all - a
  // deliberate anti-abuse restriction - while desktop allows it, which is
  // why this used to work on PC and silently fail on phones. A plain
  // top-level navigation isn't subject to that restriction and renders
  // natively everywhere, the same as clicking any other PDF link on the web.
  // The session cookie goes with it automatically; no extra auth needed.
  if (kind === 'pdf') {
    window.open(previewUrl(entry.path), '_blank', 'noopener');
    return;
  }

  const controller = new AbortController();

  let body;
  if (kind === 'image') body = imageView(entry);
  else if (kind === 'audio') body = mediaView(entry, 'audio');
  else if (kind === 'video') body = mediaView(entry, 'video');
  else if (kind === 'text') {
    body = el('div', { class: 'pv' }, [el('span', { class: 'spinner' })]);
    textView(entry, body, controller.signal);
  } else {
    body = fallback(entry, 'There is no preview for this file type. Download it to open it locally.');
  }

  const download = el('a', {
    class: 'btn btn-primary',
    href: downloadUrl(entry.path),
    download: entry.name,
  }, [icon('download'), el('span', { text: 'Download' })]);

  openModal({
    title: entry.name,
    iconName: kind === 'image' ? 'image' : 'file',
    wide: true,
    flush: true,
    body,
    onClose: () => controller.abort(),
    actions: [button('Close', { class: 'btn btn-ghost', on: { click: closeModal } }), download],
  });
}

/** Used by the Download action so a failure surfaces as a toast, not a blank tab. */
export function startDownload(entry) {
  try {
    const link = el('a', { href: downloadUrl(entry.path), download: entry.name });
    document.body.append(link);
    link.click();
    link.remove();
  } catch (err) {
    reportError(err, 'That download could not be started.');
  }
}