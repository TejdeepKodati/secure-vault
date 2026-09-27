/**
 * Modal primitive plus the two dialogs the browser needs everywhere: a
 * confirmation and a single-field prompt. Native confirm()/prompt() are avoided
 * because they cannot be styled, are blocked in some embedded browsers, and look
 * out of place next to the rest of the UI.
 */
import { byId, el, icon, trapFocus } from '../dom.js';

let current = null;

export function closeModal() {
  if (!current) return;
  const { onClose } = current;
  current = null;
  const root = byId('modal-root');
  root.replaceChildren();
  root.classList.add('is-hidden');
  document.removeEventListener('keydown', onKeydown, true);
  if (typeof onClose === 'function') onClose();
}

function onKeydown(event) {
  if (!current) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeModal();
  } else if (event.key === 'Tab') {
    trapFocus(current.node, event);
  }
}

/**
 * @param {object} options
 * @param {string} options.title
 * @param {string} [options.iconName]
 * @param {Node|Node[]} options.body
 * @param {Node[]} [options.actions]  footer buttons, in reading order
 * @param {boolean} [options.wide]    large layout, used by the preview
 * @param {boolean} [options.flush]   remove body padding
 */
export function openModal({ title, iconName, body, actions = [], wide, flush, onClose } = {}) {
  closeModal();

  const heading = el('h2', { text: title, id: 'modal-title' });
  const close = el('button', {
    class: 'icon-btn icon-btn-sm',
    type: 'button',
    'aria-label': 'Close',
    on: { click: closeModal },
  }, [icon('close')]);

  const node = el('div', {
    class: wide ? 'modal modal-wide' : 'modal',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': 'modal-title',
  }, [
    el('div', { class: 'modal-head' }, [iconName ? icon(iconName) : null, heading, close]),
    el('div', { class: flush ? 'modal-body modal-body-flush' : 'modal-body' }, [].concat(body || [])),
    actions.length ? el('div', { class: 'modal-foot' }, actions) : null,
  ]);

  const root = byId('modal-root');
  root.replaceChildren(node);
  root.classList.remove('is-hidden');
  // A click on the backdrop, but not one that started inside the panel.
  root.onmousedown = (event) => {
    if (event.target === root) closeModal();
  };

  current = { node, onClose };
  document.addEventListener('keydown', onKeydown, true);

  const focusTarget = node.querySelector('input, select, textarea, .btn-primary') || close;
  focusTarget.focus();
  if (focusTarget instanceof HTMLInputElement) focusTarget.select();

  return { node, close: closeModal };
}

export const button = (label, props = {}) => el('button', { class: 'btn', type: 'button', text: label, ...props });

/** Resolves true when confirmed, false when dismissed by any means. */
export function confirmDialog({ title, message, detail, confirmLabel = 'Confirm', danger = false, iconName }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const body = [el('p', { class: 'modal-note', text: message })];
    if (detail) body.push(el('p', { class: 'hint', text: detail }));

    openModal({
      title,
      iconName,
      body,
      onClose: () => finish(false),
      actions: [
        button('Cancel', { class: 'btn btn-ghost', on: { click: () => { finish(false); closeModal(); } } }),
        button(confirmLabel, {
          class: danger ? 'btn btn-danger' : 'btn btn-primary',
          on: { click: () => { finish(true); closeModal(); } },
        }),
      ],
    });
  });
}

/** Resolves the trimmed value, or null if dismissed. Validation runs inline. */
export function promptDialog({ title, label, value = '', confirmLabel = 'Save', iconName, hint, validate }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const input = el('input', { type: 'text', value, spellcheck: 'false', autocomplete: 'off' });
    const error = el('p', { class: 'alert is-hidden', role: 'alert' });

    const submit = () => {
      const next = input.value.trim();
      const problem = validate ? validate(next) : next === '' ? 'Please enter a name.' : null;
      if (problem) {
        error.textContent = problem;
        error.classList.remove('is-hidden');
        input.focus();
        return;
      }
      finish(next);
      closeModal();
    };

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submit();
      }
    });

    openModal({
      title,
      iconName,
      onClose: () => finish(null),
      body: [
        el('label', { class: 'field' }, [el('span', { class: 'field-label', text: label }), input]),
        hint ? el('p', { class: 'hint', text: hint }) : null,
        error,
      ],
      actions: [
        button('Cancel', { class: 'btn btn-ghost', on: { click: () => { finish(null); closeModal(); } } }),
        button(confirmLabel, { class: 'btn btn-primary', on: { click: submit } }),
      ],
    });
  });
}
