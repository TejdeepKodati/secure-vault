/**
 * Context menu (SRS 22).
 *
 * Opened by right-click on desktop and by each row's "more" button, which is how
 * touch devices reach the same Open / Rename / Move / Delete actions - there is
 * one menu definition, not a desktop one and a mobile one.
 */
import { byId, el, icon } from '../dom.js';

let openMenu = null;

export function closeContextMenu() {
  if (!openMenu) return;
  openMenu = null;
  const node = byId('ctx');
  node.classList.add('is-hidden');
  node.replaceChildren();
}

function place(node, { x, y, anchor }) {
  // Measured after insertion so the real size is known before clamping.
  const { width, height } = node.getBoundingClientRect();
  const margin = 8;
  let left = x;
  let top = y;

  if (anchor) {
    left = anchor.right - width;
    top = anchor.bottom + 4;
    if (top + height > window.innerHeight - margin) top = anchor.top - height - 4;
  }

  left = Math.min(Math.max(margin, left), window.innerWidth - width - margin);
  top = Math.min(Math.max(margin, top), window.innerHeight - height - margin);

  node.style.left = `${Math.round(left)}px`;
  node.style.top = `${Math.round(top)}px`;
}

/**
 * @param {object} options
 * @param {number} [options.x] pointer position for right-click
 * @param {number} [options.y]
 * @param {DOMRect} [options.anchor] button rect, used instead of x/y when present
 * @param {string} [options.label] heading, normally the item name
 * @param {Array<{label,iconName,onSelect,danger,hidden}>} options.items
 */
export function openContextMenu({ x = 0, y = 0, anchor, label, items }) {
  const node = byId('ctx');
  const visible = items.filter((item) => item && !item.hidden);
  if (visible.length === 0) return;

  const children = [];
  if (label) children.push(el('div', { class: 'ctx-label', text: label }));

  for (const item of visible) {
    children.push(el('button', {
      class: item.danger ? 'menu-item menu-item-danger' : 'menu-item',
      type: 'button',
      role: 'menuitem',
      on: {
        click: () => {
          closeContextMenu();
          item.onSelect();
        },
      },
    }, [icon(item.iconName), el('span', { text: item.label })]));
  }

  node.replaceChildren(...children);
  node.classList.remove('is-hidden');
  place(node, { x, y, anchor });

  openMenu = true;
  node.querySelector('.menu-item')?.focus();
}

/** One set of global listeners, installed once, that dismiss the open menu. */
export function initContextMenu() {
  document.addEventListener('pointerdown', (event) => {
    if (openMenu && !event.target.closest('#ctx')) closeContextMenu();
  }, true);

  document.addEventListener('keydown', (event) => {
    if (openMenu && event.key === 'Escape') {
      event.preventDefault();
      closeContextMenu();
    }
  });

  window.addEventListener('resize', closeContextMenu);
  window.addEventListener('blur', closeContextMenu);
  document.addEventListener('scroll', closeContextMenu, true);
}
