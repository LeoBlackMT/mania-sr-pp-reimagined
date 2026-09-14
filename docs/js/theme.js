/* ===========================================================================
 * theme.js — Auto / Light / Dark, persisted, applied before the first paint.
 *
 * The pre-paint half of this feature is a four-line inline script in index.html's <head>: it reads localStorage and sets <html data-theme> before the body renders, which is the only way to avoid a flash of the wrong theme.
 * This module owns the other half — the button label, the cycle and the write-back — and deliberately does no work at import time beyond binding the click, so `main.js` decides when the button is first synchronised.
 * The stored value is always one of "auto", "light" or "dark"; "auto" is the absence of a choice, and the stylesheet answers it with prefers-color-scheme.
 * =========================================================================== */

import { els } from './dom.js';

/** The same key the inline script in index.html reads — change one and you must change the other. */
export const THEME_KEY = 'mania-sr-pp.theme';

/** The cycle order of the button: system, then the two explicit states. */
export const THEMES = [
  { id: 'auto', label: 'Auto', icon: '◐', title: 'Theme: auto (follows the system)' },
  { id: 'light', label: 'Light', icon: '☀', title: 'Theme: light' },
  { id: 'dark', label: 'Dark', icon: '☾', title: 'Theme: dark' },
];

export const currentTheme = () => THEMES.find((t) => t.id === (els.html.getAttribute('data-theme') || 'auto')) || THEMES[0];

/** Keep the button honest about what a click will do. */
export function syncThemeButton() {
  const t = currentTheme();
  els.themeLabel.textContent = t.label;
  els.themeIcon.textContent = t.icon;
  els.themeBtn.title = t.title;
  els.themeBtn.setAttribute('aria-label', `${t.title} — activate to change the theme`);
}

export function cycleTheme() {
  const i = THEMES.findIndex((t) => t.id === currentTheme().id);
  const next = THEMES[(i + 1) % THEMES.length];
  els.html.setAttribute('data-theme', next.id);
  try { localStorage.setItem(THEME_KEY, next.id); } catch (e) { /* private mode: the choice simply does not persist */ }
  syncThemeButton();
}

export function initTheme() {
  els.themeBtn.addEventListener('click', cycleTheme);
  syncThemeButton();
}
