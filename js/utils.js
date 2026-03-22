// ============================================
// Oracle Party — Shared Utilities
// ============================================

/** querySelector shorthand */
export const $ = (sel, ctx = document) => ctx.querySelector(sel);

/** querySelectorAll shorthand */
export const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

/**
 * Transition between two screens.
 * Fades out the current screen, then fades in the next.
 */
export function transitionScreens(fromEl, toEl, duration = 600) {
  return new Promise((resolve) => {
    fromEl.classList.add('fade-out');
    fromEl.classList.remove('active');

    setTimeout(() => {
      fromEl.style.display = 'none';
      fromEl.classList.remove('fade-out');
      toEl.style.display = '';
      toEl.classList.remove('fade-out');
      // Force reflow so the browser registers the display change
      void toEl.offsetHeight;
      toEl.classList.add('active');
      resolve();
    }, duration);
  });
}

/**
 * Wait for a minimum duration (used with splash screen).
 */
export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
