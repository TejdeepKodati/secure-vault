/**
 * Destination picker for Move (SRS 15).
 *
 * A small browser rather than a free-text path box: it makes an invalid
 * destination unreachable instead of merely rejected, and folders that would
 * create a cycle (moving a folder into itself or its own subtree) are disabled
 * rather than silently failing at the API.
 */
import { list, move } from '../api.js';
import { el, icon, plural } from '../dom.js';
import { button, closeModal, openModal } from '../ui/modal.js';
import { reportError, toastOk } from '../ui/toast.js';

const isSelfOrDescendant = (candidate, source) => candidate === source || candidate.startsWith(`${source}/`);

/**
 * @param {Array<{path:string,name:string,type:string}>} entries items being moved
 * @param {string} startPath folder to open the picker in
 * @param {() => void} onDone called after a successful move
 */
export function openMovePicker(entries, startPath, onDone) {
  const sources = entries.map((entry) => entry.path);
  const folderSources = entries.filter((entry) => entry.type === 'folder').map((entry) => entry.path);
  const originalParents = new Set(entries.map((entry) => entry.path.split('/').slice(0, -1).join('/')));

  let cursor = startPath;
  const listHost = el('ul', { class: 'tree' });
  const crumb = el('p', { class: 'modal-note' });
  const upButton = button('Up one level', { class: 'btn btn-sm btn-ghost', on: { click: () => goUp() } });
  const confirm = button('Move here', { class: 'btn btn-primary' });

  const blocked = (target) => folderSources.some((source) => isSelfOrDescendant(target, source));

  function refreshFooter() {
    const sameFolder = originalParents.size === 1 && originalParents.has(cursor);
    confirm.disabled = blocked(cursor) || sameFolder;
    confirm.textContent = sameFolder ? 'Already here' : 'Move here';
    upButton.disabled = cursor === '';
  }

  async function render() {
    crumb.textContent = cursor === '' ? 'Destination: Vault root' : `Destination: /${cursor}`;
    listHost.replaceChildren(el('li', { class: 'tree-empty', text: 'Loading...' }));
    refreshFooter();

    let data;
    try {
      data = await list(cursor);
    } catch (err) {
      listHost.replaceChildren(el('li', { class: 'tree-empty', text: err?.message || 'That folder could not be opened.' }));
      return;
    }

    const folders = data.entries.filter((entry) => entry.type === 'folder');
    if (folders.length === 0) {
      listHost.replaceChildren(el('li', { class: 'tree-empty', text: 'No subfolders here.' }));
      return;
    }

    listHost.replaceChildren(...folders.map((folder) => {
      const unusable = blocked(folder.path);
      return el('li', {}, [
        el('button', {
          class: 'tree-item',
          type: 'button',
          disabled: unusable,
          title: unusable ? 'A folder cannot be moved inside itself.' : folder.name,
          on: {
            click: () => {
              cursor = folder.path;
              render();
            },
          },
        }, [icon('folder'), el('span', { class: 'nm', text: folder.name })]),
      ]);
    }));
  }

  function goUp() {
    cursor = cursor.split('/').slice(0, -1).join('/');
    render();
  }

  confirm.addEventListener('click', async () => {
    confirm.disabled = true;
    try {
      const result = await move(sources, cursor);
      closeModal();
      const renamed = (result.moved || []).filter((item) => item.renamed).length;
      toastOk(renamed > 0
        ? `Moved ${plural(sources.length, 'item')}; ${plural(renamed, 'name')} adjusted to avoid overwriting.`
        : `Moved ${plural(sources.length, 'item')}.`);
      onDone();
    } catch (err) {
      confirm.disabled = false;
      reportError(err, 'Those items could not be moved.');
    }
  });

  openModal({
    title: `Move ${plural(sources.length, 'item')}`,
    iconName: 'move',
    body: [crumb, el('div', { class: 'upload-foot' }, [upButton]), listHost],
    actions: [button('Cancel', { class: 'btn btn-ghost', on: { click: closeModal } }), confirm],
  });

  render();
}
