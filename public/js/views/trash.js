/**
 * Recycle Bin (SRS 16).
 *
 * Empty Bin is destructive and irreversible, so it is behind a confirmation that
 * names how much is about to go. Restore is offered because the metadata needed
 * for it is already stored with each deleted item.
 */
import { emptyTrash, listTrash, purgeTrash, restoreTrash } from '../api.js';
import { el, fmtBytes, fmtDate, icon, plural } from '../dom.js';
import { button, closeModal, confirmDialog, openModal } from '../ui/modal.js';
import { reportError, toastOk } from '../ui/toast.js';

const ICON_FOR = { folder: 'folder', image: 'image', pdf: 'pdf', text: 'text', audio: 'audio', video: 'video' };

export function openTrash(onChanged) {
  const body = el('div', {}, [el('div', { class: 'pv' }, [el('span', { class: 'spinner' })])]);
  const emptyButton = button('Empty Bin', { class: 'btn btn-danger', disabled: true });
  let entries = [];

  const notifyAndRefresh = () => {
    onChanged();
    render();
  };

  function rowFor(entry) {
    const restore = el('button', {
      class: 'icon-btn', type: 'button', 'aria-label': `Restore ${entry.name}`, title: 'Restore',
      on: {
        click: async () => {
          try {
            await restoreTrash([entry.id]);
            toastOk(`Restored ${entry.name}.`);
            notifyAndRefresh();
          } catch (err) {
            reportError(err, 'That item could not be restored.');
          }
        },
      },
    }, [icon('restore')]);

    const purge = el('button', {
      class: 'icon-btn', type: 'button', 'aria-label': `Permanently delete ${entry.name}`, title: 'Delete permanently',
      on: {
        click: async () => {
          const ok = await confirmDialog({
            title: 'Delete permanently?',
            message: `"${entry.name}" will be destroyed. This cannot be undone.`,
            confirmLabel: 'Delete permanently',
            danger: true,
            iconName: 'trash',
          });
          if (!ok) {
            openTrash(onChanged); // the confirmation replaced this modal
            return;
          }
          try {
            await purgeTrash([entry.id]);
            toastOk(`Deleted ${entry.name}.`);
          } catch (err) {
            reportError(err, 'That item could not be deleted.');
          }
          openTrash(onChanged);
        },
      },
    }, [icon('trash')]);

    const origin = entry.originalPath ? `was /${entry.originalPath}` : 'origin unknown';
    return el('li', { class: 'bin-row' }, [
      icon(ICON_FOR[entry.category] || 'file'),
      el('div', { class: 'bin-main' }, [
        el('div', { class: 'bin-name', text: entry.name }),
        el('div', {
          class: 'bin-sub',
          text: `${origin} - ${fmtBytes(entry.size)} - deleted ${fmtDate(entry.deletedAt)}`,
        }),
      ]),
      restore,
      purge,
    ]);
  }

  async function render() {
    try {
      const data = await listTrash();
      entries = data.entries || [];
    } catch (err) {
      body.replaceChildren(el('p', { class: 'alert', text: err?.message || 'The recycle bin could not be read.' }));
      return;
    }

    emptyButton.disabled = entries.length === 0;
    if (entries.length === 0) {
      body.replaceChildren(el('div', { class: 'empty' }, [
        el('strong', { text: 'The recycle bin is empty' }),
        el('p', { text: 'Deleted files and folders will appear here.' }),
      ]));
      return;
    }

    const total = entries.reduce((sum, entry) => sum + (entry.size || 0), 0);
    body.replaceChildren(
      el('p', { class: 'modal-note', text: `${plural(entries.length, 'item')} - ${fmtBytes(total)}` }),
      el('ul', { class: 'bin' }, entries.map(rowFor)),
    );
  }

  emptyButton.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Empty the recycle bin?',
      message: `${plural(entries.length, 'item')} will be permanently destroyed.`,
      detail: 'This cannot be undone.',
      confirmLabel: 'Empty Bin',
      danger: true,
      iconName: 'trash',
    });
    if (!ok) {
      openTrash(onChanged);
      return;
    }
    try {
      const result = await emptyTrash();
      toastOk(`Recycle bin emptied (${plural(result.removed ?? 0, 'item')}).`);
    } catch (err) {
      reportError(err, 'The recycle bin could not be emptied.');
    }
    onChanged();
    openTrash(onChanged);
  });

  openModal({
    title: 'Recycle Bin',
    iconName: 'trash',
    body,
    actions: [button('Close', { class: 'btn btn-ghost', on: { click: closeModal } }), emptyButton],
  });

  render();
}
