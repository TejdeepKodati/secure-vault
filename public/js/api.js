/**
 * Thin API client.
 *
 * Two things every call needs and no caller should have to remember:
 *   - `X-Requested-With: SecureVault`, which the backend's CSRF guard requires on
 *     every state-changing request. Sending it on reads too keeps one code path.
 *   - the `{ error: { code, message } }` envelope unwrapped into an ApiError, so
 *     UI code can just show `err.message` - the backend has already made sure
 *     that text is safe to display (SRS 26).
 */
const CLIENT_HEADER = 'SecureVault';

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/** Subscribers are notified when the session has gone (expired, or logged out
 *  in another tab), so the app can drop straight back to the login screen. */
const expiryHandlers = new Set();
export const onSessionLost = (fn) => expiryHandlers.add(fn);

function buildUrl(path, query) {
  const url = new URL(path, window.location.origin);
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url.pathname + url.search;
}

async function parseBody(res) {
  const type = res.headers.get('content-type') || '';
  if (!type.includes('application/json')) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function request(method, path, { body, query, signal, quiet } = {}) {
  const init = {
    method,
    credentials: 'same-origin',
    signal,
    headers: { 'X-Requested-With': CLIENT_HEADER },
  };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(buildUrl(path, query), init);
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    // Network interruption is one of the failure modes SRS 26 asks for.
    throw new ApiError(0, 'NETWORK', 'Cannot reach the vault. Check your connection and try again.');
  }

  const payload = await parseBody(res);

  if (!res.ok) {
    const code = payload?.error?.code || 'ERROR';
    const message = payload?.error?.message || `Request failed (${res.status}).`;
    if (res.status === 401 && !quiet) {
      for (const fn of expiryHandlers) fn();
    }
    const err = new ApiError(res.status, code, message);
    const retry = res.headers.get('retry-after');
    if (retry) err.retryAfter = Number(retry);
    throw err;
  }

  return payload ?? {};
}

/* ------------------------------------------------------------------ session */

export const session = () => request('GET', '/api/session', { quiet: true });
export const login = (pin) => request('POST', '/api/login', { body: { pin }, quiet: true });
export const logout = () => request('POST', '/api/logout', { quiet: true });
export const changePin = (currentPin, newPin) =>
  request('POST', '/api/change-pin', { body: { currentPin, newPin }, quiet: true });

/* ------------------------------------------------------------------ browsing */

export const list = (path = '', signal) => request('GET', '/api/files', { query: { path }, signal });
export const info = (path) => request('GET', '/api/info', { query: { path } });

/* ----------------------------------------------------------------- mutations */

export const createFolder = (path, name) => request('POST', '/api/folder', { body: { path, name } });
export const rename = (path, newName) => request('POST', '/api/rename', { body: { path, newName } });
export const move = (paths, destination) => request('POST', '/api/move', { body: { paths, destination } });
export const remove = (paths) => request('DELETE', '/api/delete', { body: { paths } });

/* ---------------------------------------------------------------- recycle bin */

export const listTrash = () => request('GET', '/api/trash');
export const restoreTrash = (ids) => request('POST', '/api/trash/restore', { body: { ids } });
export const purgeTrash = (ids) => request('DELETE', '/api/trash', { body: { ids } });
export const emptyTrash = () => request('DELETE', '/api/empty-trash');

/* -------------------------------------------------------------------- content */

/**
 * URLs for <img src>, <iframe src> and download links. These are plain GETs
 * authenticated by the HttpOnly session cookie, which is why the cookie is
 * SameSite=Strict rather than a bearer token held in JavaScript (SRS 12).
 */
export const previewUrl = (path) => buildUrl('/api/preview', { path });
export const downloadUrl = (path) => buildUrl('/api/download', { path });

/** Fetch a text preview as a string, so it can be inserted with textContent. */
export async function previewText(path, signal) {
  const res = await fetch(previewUrl(path), {
    credentials: 'same-origin',
    headers: { 'X-Requested-With': CLIENT_HEADER },
    signal,
  }).catch((err) => {
    if (err?.name === 'AbortError') throw err;
    throw new ApiError(0, 'NETWORK', 'Cannot reach the vault.');
  });

  if (!res.ok) {
    const payload = await parseBody(res);
    throw new ApiError(res.status, payload?.error?.code || 'ERROR',
      payload?.error?.message || 'That file could not be previewed.');
  }
  return res.text();
}

export { CLIENT_HEADER };
