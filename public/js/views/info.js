/**
 * File / folder information (SRS 18).
 *
 * The `path` shown is the vault-relative one the API works in, never the server's
 * absolute filesystem path (SRS 24) - so it is also the string a user can paste
 * back into a Move dialog.
 */
import { info } from '../api.js';
import { el, fmtBytes, fmtDate, plural, typeLabel } from '../dom.js';
import { button, closeModal, openModal } from '../ui/modal.js';

function row(term, value, { mono = false } = {}) {
  if (value === null || value === undefined || value === '') return [];
  return [el('dt', { text: term }), el('dd', { class: mono ? 'mono' : null, text: value })];
}

function details(entry) {
  const fields = [
    ...row('Name', entry.name),
    ...row('Type', typeLabel(entry)),
  ];

  if (entry.type === 'folder') {
    const contents = `${plural(entry.fileCount ?? 0, 'file')}, ${plural(entry.folderCount ?? 0, 'folder')}`;
    fields.push(...row('Contents', entry.truncated ? `${contents} (counted up to a limit)` : contents));
    fields.push(...row('Total size', fmtBytes(entry.totalSize)));
  } else {
    fields.push(...row('Size', fmtBytes(entry.size)));
  }

  fields.push(...row('Location', entry.parent === '' ? 'Vault root' : `/${entry.parent}`, { mono: true }));
  fields.push(...row('Path', `/${entry.path}`, { mono: true }));
  fields.push(...row('Modified', fmtDate(entry.modified, { long: true })));
  fields.push(...row('Created', fmtDate(entry.created, { long: true })));
  fields.push(...row('Last opened', fmtDate(entry.accessed, { long: true })));

  return el('dl', { class: 'meta' }, fields);
}

/** Fetches fresh metadata rather than reusing the listing row, so folder sizes
 *  and timestamps are current at the moment the panel opens. */
export async function openInfo(entry) {
  const body = el('div', { class: 'pv' }, [el('span', { class: 'spinner' })]);

  openModal({
    title: 'Information',
    iconName: 'info',
    body,
    actions: [button('Close', { class: 'btn btn-primary', on: { click: closeModal } })],
  });

  try {
    const full = await info(entry.path);
    body.replaceChildren(details(full));
  } catch (err) {
    body.replaceChildren(el('p', { class: 'alert', text: err?.message || 'That item could not be read.' }));
  }
}
