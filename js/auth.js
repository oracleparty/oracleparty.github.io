// ============================================
// Oracle Party — Display Name / Auth
// ============================================

import { $ } from './utils.js';

const STORAGE_KEY = 'oracle_party_display_name';

/** Get stored display name, or null if not set. */
export function getDisplayName() {
  return localStorage.getItem(STORAGE_KEY);
}

/** Save display name to localStorage. */
export function setDisplayName(name) {
  localStorage.setItem(STORAGE_KEY, name.trim());
}

/**
 * Show the display-name modal overlay.
 * Returns a Promise that resolves with the entered name.
 */
export function showDisplayNameModal() {
  return new Promise((resolve) => {
    const overlay = $('#display-name-modal');
    const input = $('#display-name-input');
    const btn = $('#display-name-submit');
    const error = $('#display-name-error');

    // Reset state
    input.value = '';
    if (error) error.textContent = '';
    overlay.classList.add('active');
    input.focus();

    function submit() {
      const name = input.value.trim();
      if (name.length < 1 || name.length > 20) {
        if (error) error.textContent = 'Enter a name (1–20 characters)';
        input.focus();
        return;
      }
      setDisplayName(name);
      overlay.classList.remove('active');
      resolve(name);
    }

    // Click submit
    btn.onclick = submit;

    // Enter key submits
    input.onkeydown = (e) => {
      if (e.key === 'Enter') submit();
    };
  });
}

/**
 * Ensure the user has a display name.
 * If one is stored, returns it immediately.
 * Otherwise shows the modal and waits for input.
 */
export async function ensureDisplayName() {
  const existing = getDisplayName();
  if (existing) return existing;
  return showDisplayNameModal();
}
