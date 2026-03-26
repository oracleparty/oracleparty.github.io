// ============================================
// Oracle Party — Theme Toggle
// Sun/moon button: light ↔ dark.
// OLED Black is a separate setting in profile.
// Preference saved in localStorage.
// ============================================

const THEME_META = { light: '#F8F7F4', dark: '#1A1A2E', oled: '#000000' };

/**
 * Initialize all theme toggle buttons on the page.
 * Simple 2-state: light ↔ dark. (OLED is set from profile settings.)
 */
export function initThemeToggle() {
  const btns = document.querySelectorAll('.theme-toggle');
  const current = document.documentElement.getAttribute('data-theme') || 'light';

  btns.forEach(btn => {
    btn.textContent = current === 'light' ? '\uD83C\uDF19' : '\u2600\uFE0F';
    btn.addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme') || 'light';
      // If on OLED, toggle goes to light (exit OLED via the toggle)
      const next = (cur === 'light') ? 'dark' : 'light';
      applyTheme(next);
      document.querySelectorAll('.theme-toggle').forEach(b => {
        b.textContent = next === 'light' ? '\uD83C\uDF19' : '\u2600\uFE0F';
      });
    });
  });
}

/**
 * Apply a theme and persist it.
 * @param {'light'|'dark'|'oled'} theme
 */
export function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('oracle_party_theme', theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = THEME_META[theme] || THEME_META.light;
}
