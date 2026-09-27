/**
 * The file browser: listing, navigation, search, selection and per-item actions
 * (SRS 9, 10, 11, 13, 14, 15, 17, 19, 22).
 *
 * One module owns the current folder, its entries and the selection, and every
 * control reads from that single state. So a rename, a finished upload and a
 * restore from the recycle bin all end at the same `refresh()` rather than each
 * patching the DOM its own way - which is what makes SRS 19 (updates without a
 * page reload) hold instead of being a special case per action.
 */
import { createFolder, list, remove, rename } from './api.js';
import {
  byId, el, fmtBytes, fmtDate, icon, iconForEntry, plural, show, typeLabel,
} from './dom.js';
import { closeContextMenu, openContextMenu } from './ui/menu.js';
import { confirmDialog, promptDialog } from './ui/modal.js';
import { reportError, toastOk } from './ui/toast.js';
import { openInfo } from './views/info.js';
import { openMovePicker } from './views/move.js';
import { openPreview, startDownload } from './views/preview.js';

const PREVIEWABLE = new Set(['image', 'pdf', 'text', 'audio', 'video']);
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

const state = {
  path: '',        // vault-relative folder, '' at the root
  entries: [],
  selected: new Set(),
  filter: '',
  anchor: null,    // path of the last clicked row, for shift-range selection
  token: 0,        // guards against a slow response overwriting a newer one
  request: null,
};

/* ---------------------------------------------------------------- helpers -- */

const parentOf = (folder) => folder.split('/').slice(0, -1).join('/');
const visible = () => (state.filter === ''
  ? state.entries
  : state.entries.filter((entry) => entry.name.toLowerCase().includes(state.filter)));
const selectedEntries = () => state.entries.filter((entry) => state.selected.has(entry.path));

export const currentPath = () => state.path;

/**
 * Mirrors assertValidName on the server, message for message. The server check is
 * the one that matters; this one exists so a typo is caught before a round trip.
 */
function nameProblem(value, taken = []) {
  if (value === '') return 'A name is required.';
  if (value === '.' || value === '..') return 'That name is not allowed.';
  if (/[/\\]/.test(value)) return 'A name cannot contain slashes.';
  if (/[:*?"<>|]/.test(value)) return 'A name cannot contain : * ? " < > or |';
  if (value.startsWith('.')) return 'A name cannot start with a dot.';
  if (/[. ]$/.test(value)) return 'A name cannot end with a dot or a space.';
  if (WINDOWS_RESERVED.test(value)) return 'That name is reserved by the operating system.';
  if (value.length > 200) return 'That name is too long.';
  if (taken.some((name) => name.toLowerCase() === value.toLowerCase())) {
    return 'Something with that name already exists here.';
  }
  return null;
}

/* ------------------------------------------------------------- chrome ------ */

function paintBreadcrumb() {
  const host = byId('breadcrumb');
  const segments = state.path === '' ? [] : state.path.split('/');
  const nodes = [];

  const crumb = (label, target, isLast) => el('button', {
    class: isLast ? 'crumb crumb-current' : 'crumb',
    type: 'button',
    text: label,
    'aria-current': isLast ? 'location' : null,
    on: { click: () => { if (!isLast) goTo(target); } },
  });

  nodes.push(crumb('Vault', '', segments.length === 0));
  segments.forEach((segment, index) => {
    nodes.push(el('span', { class: 'crumb-sep', text: '/' }));
    nodes.push(crumb(segment, segments.slice(0, index + 1).join('/'), index === segments.length - 1));
  });

  host.replaceChildren(...nodes);
  byId('back-btn').disabled = state.path === '';
}

function paintStatusbar() {
  const shown = visible();
  const folders = shown.filter((entry) => entry.type === 'folder').length;
  const files = shown.length - folders;
  const bytes = shown.reduce((sum, entry) => sum + (entry.type === 'folder' ? 0 : entry.size || 0), 0);

  const left = [`${plural(folders, 'folder')}, ${plural(files, 'file')}`];
  if (state.filter !== '') left.push(`filtered from ${plural(state.entries.length, 'item')}`);

  byId('statusbar').replaceChildren(
    el('span', { text: left.join(' - ') }),
    el('span', { class: 'statusbar-end', text: fmtBytes(bytes) }),
  );
}

/** SRS 17: actions that only make sense for exactly one item are gated here. */
function paintSelbar() {
  const bar = byId('selbar');
  const chosen = selectedEntries();
  show(bar, chosen.length > 0);
  bar.dataset.single = String(chosen.length === 1);
  bar.dataset.kind = chosen.length === 1 ? chosen[0].type : 'mixed';
  byId('sel-count').textContent = `${plural(chosen.length, 'item')} selected`;

  const shown = visible();
  const box = byId('select-all');
  box.checked = shown.length > 0 && chosen.length >= shown.length;
  box.indeterminate = chosen.length > 0 && chosen.length < shown.length;
}

/* ------------------------------------------------------------ selection --- */

function paintSelection() {
  for (const row of byId('rows').children) {
    row.dataset.selected = String(state.selected.has(row.dataset.path));
    const box = row.querySelector('input[type="checkbox"]');
    if (box) box.checked = state.selected.has(row.dataset.path);
  }
  paintSelbar();
}

function setSelection(paths) {
  state.selected = new Set(paths);
  paintSelection();
}

export function clearSelection() {
  if (state.selected.size === 0) return;
  setSelection([]);
}

function toggle(path, on) {
  if (on) state.selected.add(path);
  else state.selected.delete(path);
  state.anchor = path;
  paintSelection();
}

/** Ctrl/Cmd extends by one, Shift takes the range, a plain click replaces. */
function rowClicked(entry, event) {
  if (event.shiftKey && state.anchor) {
    const shown = visible().map((item) => item.path);
    const from = shown.indexOf(state.anchor);
    const to = shown.indexOf(entry.path);
    if (from !== -1 && to !== -1) {
      const [lo, hi] = from < to ? [from, to] : [to, from];
      setSelection(shown.slice(lo, hi + 1));
      return;
    }
  }
  if (event.ctrlKey || event.metaKey) {
    toggle(entry.path, !state.selected.has(entry.path));
    return;
  }
  state.anchor = entry.path;
  setSelection([entry.path]);
}

/* -------------------------------------------------------------- actions ---- */

/** A folder opens in place; a file opens the preview modal (SRS 12, 13). */
function open(entry) {
  if (entry.type === 'folder') goTo(entry.path);
  else openPreview(entry);
}

async function doRename(entry) {
  const taken = state.entries.filter((item) => item.path !== entry.path).map((item) => item.name);
  const next = await promptDialog({
    title: `Rename ${entry.type === 'folder' ? 'folder' : 'file'}`,
    label: 'New name',
    value: entry.name,
    iconName: 'pencil',
    confirmLabel: 'Rename',
    validate: (value) => nameProblem(value, taken),
  });
  if (next === null || next === entry.name) return;

  try {
    const result = await rename(entry.path, next);
    toastOk(`Renamed to ${result?.entry?.name || next}.`);
    state.selected.delete(entry.path);
    await refresh();
  } catch (err) {
    reportError(err, 'That item could not be renamed.');
  }
}

/** SRS 14: delete is a move to the recycle bin, so the wording promises recovery. */
async function doDelete(entries) {
  const label = entries.length === 1 ? `"${entries[0].name}"` : plural(entries.length, 'item');
  const ok = await confirmDialog({
    title: 'Move to the recycle bin?',
    message: `${label} will be moved to the recycle bin.`,
    detail: 'You can restore it from the recycle bin later.',
    confirmLabel: 'Delete',
    danger: true,
    iconName: 'trash',
  });
  if (!ok) return;

  try {
    const result = await remove(entries.map((entry) => entry.path));
    toastOk(`Moved ${plural(result?.trashed?.length ?? entries.length, 'item')} to the recycle bin.`);
  } catch (err) {
    reportError(err, 'Those items could not be deleted.');
  }
  clearSelection();
  await refresh();
}

function doMove(entries) {
  openMovePicker(entries, state.path, () => {
    clearSelection();
    refresh();
  });
}

async function doNewFolder() {
  const taken = state.entries.map((entry) => entry.name);
  const name = await promptDialog({
    title: 'New folder',
    label: 'Folder name',
    iconName: 'plus',
    confirmLabel: 'Create',
    hint: state.path === '' ? 'Created in the vault root.' : `Created in /${state.path}.`,
    validate: (value) => nameProblem(value, taken),
  });
  if (name === null) return;

  try {
    const result = await createFolder(state.path, name);
    toastOk(`Created ${result?.entry?.name || name}.`);
    await refresh();
  } catch (err) {
    reportError(err, 'That folder could not be created.');
  }
}

/**
 * One definition used by right-click and by each row's button, so a touch device
 * reaches exactly the same actions (SRS 22). Right-clicking inside a multi-row
 * selection acts on the whole selection instead of silently dropping it.
 */
function menuFor(entry) {
  const chosen = selectedEntries();
  const bulk = chosen.length > 1 && state.selected.has(entry.path);
  if (bulk) {
    return {
      label: `${plural(chosen.length, 'item')} selected`,
      items: [
        { label: 'Move to...', iconName: 'move', onSelect: () => doMove(chosen) },
        { label: 'Delete', iconName: 'trash', danger: true, onSelect: () => doDelete(chosen) },
      ],
    };
  }

  const isFolder = entry.type === 'folder';
  return {
    label: entry.name,
    items: [
      {
        label: isFolder ? 'Open' : PREVIEWABLE.has(entry.category) ? 'Preview' : 'Open',
        iconName: isFolder ? 'folder' : 'eye',
        onSelect: () => open(entry),
      },
      { label: 'Download', iconName: 'download', hidden: isFolder, onSelect: () => startDownload(entry) },
      { label: 'Rename', iconName: 'pencil', onSelect: () => doRename(entry) },
      { label: 'Move to...', iconName: 'move', onSelect: () => doMove([entry]) },
      { label: 'Information', iconName: 'info', onSelect: () => openInfo(entry) },
      { label: 'Delete', iconName: 'trash', danger: true, onSelect: () => doDelete([entry]) },
    ],
  };
}

/* ------------------------------------------------------------------ rows ---- */

function rowFor(entry) {
  const isFolder = entry.type === 'folder';
  const openLabel = isFolder ? 'Open' : PREVIEWABLE.has(entry.category) ? 'Preview' : 'Open';

  const box = el('input', {
    type: 'checkbox',
    checked: state.selected.has(entry.path),
    'aria-label': `Select ${entry.name}`,
    on: {
      // Without stopPropagation the row handler would run too and undo the tick.
      click: (event) => event.stopPropagation(),
      change: () => toggle(entry.path, box.checked),
    },
  });

  const nameButton = el('button', {
    class: 'name-btn',
    type: 'button',
    text: entry.name,
    title: entry.name,
    on: { click: (event) => { event.stopPropagation(); open(entry); } },
  });

  const openButton = el('button', {
    class: 'icon-btn',
    type: 'button',
    title: openLabel,
    'aria-label': `${openLabel} ${entry.name}`,
    on: { click: (event) => { event.stopPropagation(); open(entry); } },
  }, [icon(isFolder ? 'folder' : 'eye')]);

  const moreButton = el('button', {
    class: 'icon-btn',
    type: 'button',
    title: 'More actions',
    'aria-label': `Actions for ${entry.name}`,
    on: {
      click: (event) => {
        event.stopPropagation();
        openContextMenu({ anchor: moreButton.getBoundingClientRect(), ...menuFor(entry) });
      },
    },
  }, [icon('dots')]);

  return el('div', {
    class: 'row',
    role: 'row',
    dataset: { path: entry.path, type: entry.type, selected: String(state.selected.has(entry.path)) },
    on: {
      click: (event) => rowClicked(entry, event),
      dblclick: () => open(entry),
      contextmenu: (event) => {
        event.preventDefault();
        // Right-clicking outside the current selection selects that row first, so
        // the menu can never act on something the user cannot see is chosen.
        if (!state.selected.has(entry.path)) setSelection([entry.path]);
        openContextMenu({ x: event.clientX, y: event.clientY, ...menuFor(entry) });
      },
    },
  }, [
    el('span', { class: 'col-check', role: 'cell' }, [el('label', { class: 'check' }, [box])]),
    el('span', { class: 'col-name', role: 'cell' }, [iconForEntry(entry), nameButton]),
    el('span', { class: 'col-type', role: 'cell', text: typeLabel(entry) }),
    el('span', { class: 'col-size', role: 'cell', text: isFolder ? '--' : fmtBytes(entry.size) }),
    el('span', { class: 'col-date', role: 'cell', text: fmtDate(entry.modified) }),
    el('span', { class: 'col-actions', role: 'cell' }, [openButton, moreButton]),
  ]);
}

function paintRows() {
  const shown = visible();
  const empty = byId('listing-empty');

  byId('rows').replaceChildren(...shown.map(rowFor));

  if (shown.length === 0) {
    empty.replaceChildren(state.filter === ''
      ? el('div', {}, [
        el('strong', { text: 'This folder is empty' }),
        el('p', { text: 'Drop files here, or use Upload to add some.' }),
      ])
      : el('div', {}, [
        el('strong', { text: 'No matching items' }),
        el('p', { text: `Nothing in this folder matches "${state.filter}".` }),
      ]));
  }
  show(empty, shown.length === 0);
  paintStatusbar();
  paintSelbar();
}

/* ------------------------------------------------------------------ load ---- */

/**
 * Loads `state.path`. A token plus an AbortController means a slow answer for a
 * folder the user has already left is discarded instead of painted over the one
 * they are now looking at.
 */
async function load({ keepSelection = false } = {}) {
  const token = ++state.token;
  state.request?.abort();
  const controller = new AbortController();
  state.request = controller;

  const busy = byId('listing-busy');
  const rows = byId('rows');
  if (rows.children.length === 0) show(busy, true);

  try {
    const data = await list(state.path, controller.signal);
    if (token !== state.token) return;

    state.entries = data.entries || [];
    if (keepSelection) {
      // Drop anything that has gone, so a stale path can never be acted on.
      const live = new Set(state.entries.map((entry) => entry.path));
      for (const path of [...state.selected]) if (!live.has(path)) state.selected.delete(path);
    } else {
      state.selected.clear();
    }
    paintBreadcrumb();
    paintRows();
  } catch (err) {
    if (token !== state.token || err?.name === 'AbortError') return;
    state.entries = [];
    state.selected.clear();
    rows.replaceChildren();
    const empty = byId('listing-empty');
    empty.replaceChildren(
      el('strong', { text: 'This folder could not be opened' }),
      el('p', { text: err?.message || 'Try refreshing.' }),
    );
    show(empty, true);
    paintBreadcrumb();
    paintStatusbar();
    paintSelbar();
  } finally {
    if (token === state.token) {
      state.request = null;
      show(busy, false);
    }
  }
}

/** SRS 19: every mutation ends here, and nothing reloads the page. */
export const refresh = () => load({ keepSelection: true });

/* ------------------------------------------------------------ navigation --- */

/** Each segment is encoded separately so a `#` or `?` in a folder name survives. */
const toHash = (folder) => `#/${folder.split('/').filter(Boolean).map(encodeURIComponent).join('/')}`;

const fromHash = () => (window.location.hash || '')
  .replace(/^#\/?/, '')
  .split('/')
  .filter(Boolean)
  .map((segment) => { try { return decodeURIComponent(segment); } catch { return segment; } })
  .join('/');

function paintSearch({ writeValue = false } = {}) {
  const input = byId('search');
  if (writeValue) input.value = state.filter;
  show(byId('search-clear'), input.value !== '');
}

/**
 * @param {string} folder vault-relative destination
 * The hash is kept in step so the browser's own Back button walks the folder
 * history instead of leaving the app.
 */
export function goTo(folder, { replace = false } = {}) {
  closeContextMenu();
  if (folder === state.path) return refresh();

  state.path = folder;
  state.filter = '';
  state.anchor = null;
  paintSearch({ writeValue: true });

  const entry = { path: folder };
  if (replace) window.history.replaceState(entry, '', toHash(folder));
  else window.history.pushState(entry, '', toHash(folder));
  return load();
}

/** SRS 11: filtering hides rows, it never touches what is stored. */
function setFilter(raw) {
  state.filter = raw.trim().toLowerCase();
  paintSearch();
  const shown = new Set(visible().map((item) => item.path));
  for (const path of [...state.selected]) if (!shown.has(path)) state.selected.delete(path);
  paintRows();
}

/* --------------------------------------------------------------- keyboard --- */

const isTyping = () => {
  const node = document.activeElement;
  return Boolean(node) && (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' || node.isContentEditable);
};

function onKeydown(event) {
  // Nothing here applies while the login screen or a modal owns the keyboard.
  if (!byId('login-view').classList.contains('is-hidden')) return;
  if (!byId('modal-root').classList.contains('is-hidden')) return;

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a' && !isTyping()) {
    event.preventDefault();
    setSelection(visible().map((entry) => entry.path));
    return;
  }
  if (event.key === 'Escape' && !isTyping()) {
    clearSelection();
    return;
  }
  if (isTyping()) return;

  const chosen = selectedEntries();
  if (event.key === 'Enter' && chosen.length === 1) {
    event.preventDefault();
    open(chosen[0]);
  } else if (event.key === 'F2' && chosen.length === 1) {
    event.preventDefault();
    doRename(chosen[0]);
  } else if (event.key === 'Delete' && chosen.length > 0) {
    event.preventDefault();
    doDelete(chosen);
  } else if (event.key === 'Backspace' && state.path !== '') {
    event.preventDefault();
    goTo(parentOf(state.path));
  }
}

/** The selection bar's buttons carry the same names as the context menu items. */
function runSelectionAction(action) {
  const chosen = selectedEntries();
  if (chosen.length === 0) return;
  const only = chosen.length === 1 ? chosen[0] : null;

  if (action === 'move') doMove(chosen);
  else if (action === 'delete') doDelete(chosen);
  else if (!only) return;
  else if (action === 'open') open(only);
  else if (action === 'rename') doRename(only);
  else if (action === 'info') openInfo(only);
  else if (action === 'download' && only.type === 'file') startDownload(only);
}

/* ------------------------------------------------------------------ wiring --- */

/** Listeners are installed once, at boot, and survive every log in and out. */
export function initBrowser() {
  byId('back-btn').addEventListener('click', () => goTo(parentOf(state.path)));
  byId('refresh-btn').addEventListener('click', () => refresh());
  byId('new-folder-btn').addEventListener('click', doNewFolder);

  const search = byId('search');
  search.addEventListener('input', () => setFilter(search.value));
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      setFilter('');
      paintSearch({ writeValue: true });
    }
  });
  byId('search-clear').addEventListener('click', () => {
    setFilter('');
    paintSearch({ writeValue: true });
    search.focus();
  });

  byId('select-all').addEventListener('change', (event) => {
    setSelection(event.target.checked ? visible().map((entry) => entry.path) : []);
  });
  byId('sel-clear').addEventListener('click', clearSelection);
  for (const trigger of document.querySelectorAll('#selbar [data-action]')) {
    trigger.addEventListener('click', () => runSelectionAction(trigger.dataset.action));
  }

  const dropzone = byId('dropzone');
  // A click on the blank area below the rows means "never mind".
  dropzone.addEventListener('click', (event) => {
    if (!event.target.closest('.row')) clearSelection();
  });
  dropzone.addEventListener('contextmenu', (event) => {
    if (event.target.closest('.row')) return;
    event.preventDefault();
    openContextMenu({
      x: event.clientX,
      y: event.clientY,
      label: state.path === '' ? 'Vault' : `/${state.path}`,
      items: [
        { label: 'New folder', iconName: 'plus', onSelect: doNewFolder },
        { label: 'Refresh', iconName: 'refresh', onSelect: () => refresh() },
      ],
    });
  });

  window.addEventListener('popstate', (event) => {
    if (byId('app-view').classList.contains('is-hidden')) return;
    state.path = event.state?.path ?? fromHash();
    state.filter = '';
    state.anchor = null;
    paintSearch({ writeValue: true });
    load();
  });

  document.addEventListener('keydown', onKeydown);
}

/**
 * Called once a session is confirmed. The folder in the URL hash is honoured, so
 * a reload or a bookmarked deep link lands where the user left off; an unknown
 * path simply reports that it could not be opened, with the breadcrumb still
 * offering the way back to the root.
 */
export function startBrowser() {
  state.path = fromHash();
  state.filter = '';
  state.anchor = null;
  state.selected.clear();
  paintSearch({ writeValue: true });
  window.history.replaceState({ path: state.path }, '', toHash(state.path));
  return load();
}

/** Wipes what is on screen when the session ends, so nothing lingers behind the
 *  login form or reappears in a screenshot. */
export function resetBrowser() {
  state.token += 1;
  state.request?.abort();
  state.request = null;
  state.entries = [];
  state.selected.clear();
  state.filter = '';
  state.path = '';
  byId('rows').replaceChildren();
  byId('statusbar').replaceChildren();
  byId('breadcrumb').replaceChildren();
  show(byId('selbar'), false);
  show(byId('listing-empty'), false);
  closeContextMenu();
}
