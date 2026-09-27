/**
 * Uploads (SRS 7) and progress reporting (SRS 8).
 *
 * XMLHttpRequest rather than fetch, because fetch still has no upload-progress
 * event and SRS 8 asks for real-time byte progress.
 *
 * One request per file, sent sequentially. The backend accepts several files in
 * one request, but one-per-file buys three things worth more than the round
 * trips: an accurate byte total for the overall percentage, a per-file count for
 * the "3/6 files" part of the label, and a single failure that does not take the
 * rest of the batch down with it.
 */
import { CLIENT_HEADER } from './api.js';
import { byId, el, fmtBytes, icon, plural, show } from './dom.js';
import { toastError, toastOk } from './ui/toast.js';

const MAX_LISTED_ROWS = 200;

let active = null;   // the run in flight, or null
let onFinished = () => {};

/* --------------------------------------------------------------- panel ---- */

function panel() {
  return {
    root: byId('upload-panel'),
    bar: byId('upload-bar'),
    title: byId('upload-title'),
    status: byId('upload-status'),
    list: byId('upload-list'),
  };
}

function renderRows(jobs) {
  const { list } = panel();
  const rows = jobs.slice(0, MAX_LISTED_ROWS).map((job) => el('li', {
    class: 'upload-row',
    dataset: { state: job.state },
  }, [
    icon(job.state === 'done' ? 'check' : job.state === 'failed' ? 'close' : 'upload'),
    el('span', { class: 'nm', text: job.relativePath || job.file.name, title: job.relativePath }),
    el('span', { class: 'pct', text: job.state === 'failed' ? (job.error || 'failed') : fmtBytes(job.file.size) }),
  ]));

  if (jobs.length > MAX_LISTED_ROWS) {
    rows.push(el('li', { class: 'upload-row', text: `+ ${jobs.length - MAX_LISTED_ROWS} more` }));
  }
  list.replaceChildren(...rows);
}

/**
 * The percentage is derived from bytes, not from how many files have finished, so
 * one large file among small ones still moves the bar smoothly (SRS 8).
 */
function paint(run) {
  const { root, bar, title, status } = panel();
  const sent = Math.min(run.sentBytes + run.currentLoaded, run.totalBytes);
  const percent = run.totalBytes === 0 ? 100 : Math.floor((sent / run.totalBytes) * 100);
  const currentIndex = Math.min(run.completed + 1, run.jobs.length);

  bar.style.width = `${percent}%`;
  root.dataset.state = run.state;

  if (run.state === 'running') {
    title.textContent = 'Uploading';
    status.textContent = run.jobs.length === 1
      ? `Uploading ${run.jobs[0].file.name} — ${percent}%`
      : `Uploading ${currentIndex}/${run.jobs.length} files — ${percent}%`;
  } else if (run.state === 'done') {
    title.textContent = 'Upload Complete';
    status.textContent = `${plural(run.succeeded, 'file')} uploaded — ${fmtBytes(run.sentBytes)}`;
  } else if (run.state === 'error') {
    title.textContent = 'Upload finished with errors';
    const parts = [];
    if (run.succeeded) parts.push(`${plural(run.succeeded, 'file')} uploaded`);
    if (run.failed) parts.push(`${plural(run.failed, 'file')} failed`);
    status.textContent = parts.join(', ') || 'Nothing was uploaded';
  } else if (run.state === 'cancelled') {
    title.textContent = 'Upload cancelled';
    status.textContent = `${plural(run.succeeded, 'file')} uploaded before cancelling`;
  }
}

/* ---------------------------------------------------------- one request ---- */

function sendOne(job, destination, run) {
  return new Promise((resolve) => {
    const form = new FormData();
    // Order matters: the backend pairs each `relativePath` field with the file
    // part that follows it, which is how a folder upload keeps its hierarchy.
    if (job.relativePath && job.relativePath !== job.file.name) {
      form.append('relativePath', job.relativePath);
    }
    form.append('file', job.file, job.file.name);

    const xhr = new XMLHttpRequest();
    run.xhr = xhr;
    xhr.open('POST', `/api/upload?path=${encodeURIComponent(destination)}`);
    xhr.setRequestHeader('X-Requested-With', CLIENT_HEADER);
    xhr.responseType = 'json';
    xhr.withCredentials = true;

    xhr.upload.addEventListener('progress', (event) => {
      // `loaded` counts multipart framing too; clamp so the bar cannot overshoot.
      run.currentLoaded = Math.min(event.loaded, job.file.size);
      paint(run);
    });

    const settle = (ok, error, status) => {
      run.xhr = null;
      resolve({ ok, error, status });
    };

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) return settle(true);
      const body = xhr.response;
      const message = (body && body.error && body.error.message)
        || `Upload failed (${xhr.status}).`;
      settle(false, message, xhr.status);
    });
    xhr.addEventListener('error', () => settle(false, 'Network error during upload.', 0));
    xhr.addEventListener('timeout', () => settle(false, 'The upload timed out.', 0));
    xhr.addEventListener('abort', () => settle(false, 'Cancelled.', -1));

    xhr.send(form);
  });
}

/* -------------------------------------------------------------- the run ---- */

/**
 * @param {Array<{file: File, relativePath?: string}>} items
 * @param {string} destination vault-relative folder
 */
export async function startUpload(items, destination) {
  if (active) {
    toastError('An upload is already running. Wait for it to finish or cancel it.');
    return;
  }
  const jobs = items
    .filter((item) => item && item.file)
    .map((item) => ({ file: item.file, relativePath: item.relativePath || item.file.name, state: 'queued' }));

  if (jobs.length === 0) return;

  const run = {
    jobs,
    destination,
    state: 'running',
    totalBytes: jobs.reduce((sum, job) => sum + job.file.size, 0),
    sentBytes: 0,
    currentLoaded: 0,
    completed: 0,
    succeeded: 0,
    failed: 0,
    xhr: null,
    cancelled: false,
  };
  active = run;

  show(byId('upload-panel'), true);
  renderRows(jobs);
  paint(run);

  for (const job of jobs) {
    if (run.cancelled) {
      job.state = 'cancelled';
      continue;
    }
    job.state = 'active';
    run.currentLoaded = 0;
    renderRows(jobs);
    paint(run);

    const result = await sendOne(job, destination, run);

    run.sentBytes += job.file.size;
    run.currentLoaded = 0;
    run.completed += 1;

    if (result.ok) {
      job.state = 'done';
      run.succeeded += 1;
    } else {
      job.state = result.status === -1 ? 'cancelled' : 'failed';
      job.error = result.error;
      if (result.status !== -1) run.failed += 1;
      // A lost session will fail every remaining file the same way; stop early
      // and let the app drop back to the login screen.
      if (result.status === 401 || result.status === 403) {
        run.cancelled = true;
        run.fatal = result.error;
      }
    }
    renderRows(jobs);
    paint(run);
  }

  run.state = run.cancelled && run.failed === 0 ? 'cancelled' : run.failed > 0 ? 'error' : 'done';
  paint(run);
  renderRows(jobs);
  active = null;

  if (run.succeeded > 0) onFinished();
  if (run.state === 'done') {
    toastOk(`Upload complete — ${plural(run.succeeded, 'file')}.`);
    setTimeout(() => {
      if (!active) show(byId('upload-panel'), false);
    }, 4000);
  } else if (run.fatal) {
    toastError(run.fatal);
  } else if (run.failed > 0) {
    const first = jobs.find((job) => job.state === 'failed');
    toastError(`${plural(run.failed, 'file')} failed to upload. ${first?.error || ''}`.trim());
  }
}

export const uploadInProgress = () => active !== null;

function cancelUpload() {
  if (!active) return;
  active.cancelled = true;
  active.xhr?.abort();
}

/* ------------------------------------------------- drag and drop sources --- */

const MAX_DROPPED_FILES = 2000;

function readAllEntries(reader) {
  // readEntries yields at most ~100 per call and signals the end with an empty
  // batch, so it has to be drained in a loop.
  return new Promise((resolve, reject) => {
    const all = [];
    const next = () => reader.readEntries((batch) => {
      if (batch.length === 0) return resolve(all);
      all.push(...batch);
      next();
    }, reject);
    next();
  });
}

async function walkEntry(entry, prefix, out) {
  if (out.length >= MAX_DROPPED_FILES) return;
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    out.push({ file, relativePath: prefix ? `${prefix}/${entry.name}` : entry.name });
  } else if (entry.isDirectory) {
    const nested = prefix ? `${prefix}/${entry.name}` : entry.name;
    for (const child of await readAllEntries(entry.createReader())) {
      await walkEntry(child, nested, out);
    }
  }
}

/**
 * Dropped folders are only reachable through webkitGetAsEntry, and the item list
 * is neutered as soon as the drop handler returns - so the entries are grabbed
 * synchronously here, before any await.
 */
async function collectFromDrop(dataTransfer) {
  const entries = Array.from(dataTransfer.items || [])
    .map((item) => (typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null))
    .filter(Boolean);

  if (entries.length === 0) {
    return Array.from(dataTransfer.files || []).map((file) => ({ file, relativePath: file.name }));
  }

  const out = [];
  for (const entry of entries) {
    try {
      await walkEntry(entry, '', out);
    } catch {
      // Unreadable directory: skip it rather than abandoning the whole drop.
    }
  }
  if (out.length >= MAX_DROPPED_FILES) {
    toastError(`Only the first ${MAX_DROPPED_FILES} files from that drop will be uploaded.`);
  }
  return out;
}

const fromInput = (input) => Array.from(input.files || []).map((file) => ({
  file,
  // Set by the folder picker (webkitdirectory); plain file pickers leave it empty.
  relativePath: file.webkitRelativePath || file.name,
}));

/* -------------------------------------------------------------- wiring ----- */

/**
 * @param {object} options
 * @param {() => string} options.getDestination current folder, read at drop time
 * @param {() => void} options.onComplete refresh hook, called once per run
 */
export function initUploads({ getDestination, onComplete }) {
  onFinished = onComplete;

  const fileInput = byId('file-input');
  const folderInput = byId('folder-input');
  const dropzone = byId('dropzone');
  const hint = byId('drop-hint');

  byId('upload-files-btn').addEventListener('click', () => fileInput.click());
  byId('upload-folder-btn').addEventListener('click', () => folderInput.click());

  for (const input of [fileInput, folderInput]) {
    input.addEventListener('change', () => {
      const items = fromInput(input);
      input.value = ''; // so re-picking the same file fires change again
      if (items.length > 0) startUpload(items, getDestination());
    });
  }

  byId('upload-cancel').addEventListener('click', cancelUpload);
  byId('upload-close').addEventListener('click', () => {
    if (active) cancelUpload();
    show(byId('upload-panel'), false);
  });

  // A drag that enters a child element fires dragenter again, so depth is counted
  // rather than toggled - otherwise the hint flickers as the pointer crosses rows.
  let depth = 0;
  const carriesFiles = (event) => Array.from(event.dataTransfer?.types || []).includes('Files');

  dropzone.addEventListener('dragenter', (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    depth += 1;
    show(hint, true);
  });

  dropzone.addEventListener('dragover', (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });

  dropzone.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) show(hint, false);
  });

  dropzone.addEventListener('drop', async (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    depth = 0;
    show(hint, false);
    const destination = getDestination();
    const items = await collectFromDrop(event.dataTransfer);
    if (items.length === 0) {
      toastError('Nothing usable was dropped.');
      return;
    }
    startUpload(items, destination);
  });

  // Without this, dropping a file anywhere else in the window makes the browser
  // navigate to it and the app disappears.
  for (const type of ['dragover', 'drop']) {
    window.addEventListener(type, (event) => {
      if (!event.target.closest('#dropzone') && carriesFiles(event)) event.preventDefault();
    });
  }

  window.addEventListener('beforeunload', (event) => {
    if (!active) return;
    event.preventDefault();
    event.returnValue = '';
  });
}
