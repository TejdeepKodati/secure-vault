/**
 * Application boot and the session-scoped chrome: which view is on screen, the
 * login form, the account menu, the theme toggle and the initial-PIN nudge.
 *
 * One function decides between the login screen and the app, so an expired
 * session, a deliberate log out and a failed boot all converge on `showLogin()`
 * rather than each hiding things in its own way.
 */
import { login, logout, onSessionLost, session } from './api.js';
import { byId, show } from './dom.js';
import { currentPath, initBrowser, refresh, resetBrowser, startBrowser } from './browser.js';
import { initUploads, uploadInProgress } from './upload.js';
import { closeContextMenu, initContextMenu } from './ui/menu.js';
import { closeModal, confirmDialog } from './ui/modal.js';
import { initTheme, toggleTheme } from './ui/theme.js';
import { toastOk } from './ui/toast.js';
import { openChangePin } from './views/pin.js';
import { openTrash } from './views/trash.js';

let signedIn = false;

/* -------------------------------------------------------------- the views -- */

function setLoginError(message) {
  const error = byId('login-error');
  error.textContent = message || '';
  show(error, Boolean(message));
}

function showLogin({ message } = {}) {
  signedIn = false;
  closeModal();
  closeContextMenu();
  closeAccountMenu();
  resetBrowser();

  show(byId('app-view'), false);
  show(byId('pin-nudge'), false);
  show(byId('login-view'), true);
  setLoginError(message);

  const pin = byId('pin');
  pin.value = '';
  pin.focus();
}

async function showApp({ pinIsInitial = false } = {}) {
  signedIn = true;
  setLoginError('');
  byId('pin').value = ''; // never leave the PIN sitting in the DOM
  show(byId('login-view'), false);
  show(byId('app-view'), true);
  show(byId('pin-nudge'), Boolean(pinIsInitial));
  await startBrowser();
}

/* ------------------------------------------------------- the account menu -- */

function closeAccountMenu() {
  show(byId('menu'), false);
  byId('menu-btn').setAttribute('aria-expanded', 'false');
}

function toggleAccountMenu() {
  const menu = byId('menu');
  const opening = menu.classList.contains('is-hidden');
  show(menu, opening);
  byId('menu-btn').setAttribute('aria-expanded', String(opening));
  if (opening) menu.querySelector('.menu-item')?.focus();
}

async function doLogout() {
  if (uploadInProgress()) {
    const ok = await confirmDialog({
      title: 'Log out while an upload is running?',
      message: 'The files still waiting to upload will be cancelled.',
      confirmLabel: 'Log out',
      danger: true,
      iconName: 'logout',
    });
    if (!ok) return;
  }
  try {
    await logout();
  } catch {
    // The cookie is cleared client-side either way; there is nothing to retry.
  }
  showLogin();
  toastOk('Signed out.');
}

function runMenuAction(action) {
  closeAccountMenu();
  if (action === 'trash') openTrash(() => refresh());
  else if (action === 'change-pin') openChangePin(() => show(byId('pin-nudge'), false));
  else if (action === 'logout') doLogout();
}

/* ------------------------------------------------------------------ login -- */

/** "300 seconds" is how the API phrases a lockout; minutes read better. */
function waitLabel(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'a moment';
  if (seconds < 90) return `${Math.ceil(seconds)} seconds`;
  return `${Math.ceil(seconds / 60)} minutes`;
}

async function submitLogin(event) {
  event.preventDefault();
  const pin = byId('pin');
  const submit = byId('login-submit');

  if (pin.value === '') {
    setLoginError('Please enter your PIN.');
    pin.focus();
    return;
  }

  submit.disabled = true;
  setLoginError('');
  try {
    const result = await login(pin.value);
    await showApp({ pinIsInitial: result?.pinIsInitial });
  } catch (err) {
    setLoginError(err?.status === 429
      ? `Too many failed attempts. Try again in ${waitLabel(err.retryAfter)}.`
      : err?.message || 'That PIN was not accepted.');
    pin.select();
  } finally {
    submit.disabled = false;
  }
}

/* ------------------------------------------------------------------- boot -- */

async function boot() {
  initTheme();
  initContextMenu();
  initBrowser();
  // The destination is read when the drop happens, not when this is wired, so an
  // upload always lands in the folder that was on screen at the time.
  initUploads({ getDestination: currentPath, onComplete: refresh });

  byId('login-form').addEventListener('submit', submitLogin);
  byId('theme-toggle').addEventListener('click', toggleTheme);
  byId('menu-btn').addEventListener('click', (event) => {
    event.stopPropagation();
    toggleAccountMenu();
  });

  for (const trigger of document.querySelectorAll('#menu [data-action], #pin-nudge [data-action]')) {
    trigger.addEventListener('click', () => runMenuAction(trigger.dataset.action));
  }

  document.addEventListener('pointerdown', (event) => {
    if (!event.target.closest('.menu-wrap')) closeAccountMenu();
  }, true);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeAccountMenu();
  });

  // A 401 from any request lands here: the session went away while the tab sat
  // open, so drop to the login screen instead of showing empty folders.
  onSessionLost(() => {
    if (!signedIn) return;
    showLogin({ message: 'Your session has ended. Enter your PIN to continue.' });
  });

  try {
    const info = await session();
    if (info?.authenticated) await showApp({ pinIsInitial: info.pinIsInitial });
    else showLogin();
  } catch (err) {
    showLogin({ message: err?.message || 'The vault could not be reached.' });
  } finally {
    show(byId('boot'), false);
  }
}

boot();
