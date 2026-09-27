/**
 * Transient notifications. Errors stay up longer than confirmations because they
 * carry text the user may need to act on (SRS 26).
 */
import { byId, el, icon } from '../dom.js';

const HOST = () => byId('toasts');

function push(message, { kind = 'info', ms } = {}) {
  const host = HOST();
  if (!host) return;

  const node = el('div', { class: `toast toast-${kind}`, role: 'status' }, [
    icon(kind === 'error' ? 'info' : kind === 'ok' ? 'check' : 'info'),
    el('span', { text: message }),
  ]);
  host.append(node);

  const life = ms ?? (kind === 'error' ? 6500 : 3200);
  setTimeout(() => node.remove(), life);

  // Keep the stack short so a burst of upload errors cannot cover the app.
  while (host.children.length > 4) host.firstElementChild.remove();
}

export const toast = (message, ms) => push(message, { kind: 'info', ms });
export const toastOk = (message, ms) => push(message, { kind: 'ok', ms });
export const toastError = (message, ms) => push(message, { kind: 'error', ms });

/** Show whatever an ApiError carries; the backend guarantees it is safe text. */
export function reportError(err, fallback = 'Something went wrong.') {
  if (err?.name === 'AbortError') return;
  toastError(err?.message || fallback);
}
