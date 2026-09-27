/**
 * Change PIN.
 *
 * The current PIN is required even though the caller already holds a session, so
 * a borrowed or forgotten-open session cannot lock the owner out. Changing it
 * bumps the server-side session epoch, which retires every previously issued
 * token; the backend hands this request a fresh cookie so the tab stays signed in
 * while any other device is signed out.
 */
import { changePin } from '../api.js';
import { el } from '../dom.js';
import { button, closeModal, openModal } from '../ui/modal.js';
import { toastOk } from '../ui/toast.js';

const MIN_LENGTH = 4;

export function openChangePin(onChanged) {
  const currentInput = el('input', { type: 'password', autocomplete: 'current-password', inputmode: 'numeric' });
  const nextInput = el('input', { type: 'password', autocomplete: 'new-password', inputmode: 'numeric' });
  const repeatInput = el('input', { type: 'password', autocomplete: 'new-password', inputmode: 'numeric' });
  const error = el('p', { class: 'alert is-hidden', role: 'alert' });
  const save = button('Change PIN', { class: 'btn btn-primary' });

  const fail = (message, focus) => {
    error.textContent = message;
    error.classList.remove('is-hidden');
    save.disabled = false;
    if (focus) focus.focus();
  };

  async function submit() {
    error.classList.add('is-hidden');
    const currentPin = currentInput.value;
    const newPin = nextInput.value;

    if (currentPin === '') return fail('Enter your current PIN.', currentInput);
    if (newPin.length < MIN_LENGTH) return fail(`The new PIN must be at least ${MIN_LENGTH} characters.`, nextInput);
    if (newPin !== repeatInput.value) return fail('The two new PINs do not match.', repeatInput);
    if (newPin === currentPin) return fail('The new PIN must be different from the current one.', nextInput);

    save.disabled = true;
    try {
      await changePin(currentPin, newPin);
      closeModal();
      toastOk('PIN changed. Other signed-in devices have been signed out.');
      onChanged();
    } catch (err) {
      // Server-side policy checks (repeated characters, digit runs) land here.
      fail(err?.message || 'That PIN could not be changed.', nextInput);
    }
  }

  for (const input of [currentInput, nextInput, repeatInput]) {
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submit();
      }
    });
  }

  save.addEventListener('click', submit);

  openModal({
    title: 'Change PIN',
    iconName: 'key',
    body: [
      el('label', { class: 'field' }, [el('span', { class: 'field-label', text: 'Current PIN' }), currentInput]),
      el('label', { class: 'field' }, [el('span', { class: 'field-label', text: 'New PIN' }), nextInput]),
      el('label', { class: 'field' }, [el('span', { class: 'field-label', text: 'Repeat new PIN' }), repeatInput]),
      el('p', { class: 'hint', text: `At least ${MIN_LENGTH} characters. Avoid repeated or consecutive digits.` }),
      error,
    ],
    actions: [button('Cancel', { class: 'btn btn-ghost', on: { click: closeModal } }), save],
  });
}
