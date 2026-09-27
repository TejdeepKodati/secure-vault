/**
 * Theme switching (SRS 20).
 *
 * The choice is stored per browser and applied to <html data-theme>, so every
 * component picks it up from the custom properties in one place rather than each
 * needing its own dark variant. With no stored choice we follow the OS setting
 * and keep following it if it changes.
 */
const KEY = 'secure-vault:theme';
const root = document.documentElement;

const prefersLight = () => window.matchMedia('(prefers-color-scheme: light)').matches;

function read() {
  try {
    const stored = localStorage.getItem(KEY);
    return stored === 'dark' || stored === 'light' ? stored : null;
  } catch {
    return null; // Private mode with storage blocked: fall back to the OS setting.
  }
}

function apply(theme) {
  root.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'light' ? '#ffffff' : '#11141a');
  const button = document.getElementById('theme-toggle');
  if (button) {
    button.setAttribute('aria-label', theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
  }
}

export function initTheme() {
  apply(read() || (prefersLight() ? 'light' : 'dark'));

  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', (event) => {
    if (!read()) apply(event.matches ? 'light' : 'dark');
  });
}

export function toggleTheme() {
  const next = root.dataset.theme === 'light' ? 'dark' : 'light';
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // Not fatal - the theme still applies for this page load.
  }
  apply(next);
  return next;
}
