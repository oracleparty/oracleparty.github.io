// ============================================
// Oracle Party — Theme Toggle
// Sun/moon button: light ↔ dark (or light ↔ oled if OLED pref is on).
// OLED preference is set in profile settings.
// Theme saved in localStorage as 'oracle_party_theme'.
// OLED preference saved as 'oracle_party_oled_pref'.
// ============================================

const THEME_META = { light: '#F8F7F4', dark: '#1A1A2E', oled: '#000000' };

/**
 * Initialize all theme toggle buttons on the page.
 * If OLED pref is enabled, toggle swaps light ↔ oled.
 * If OLED pref is off, toggle swaps light ↔ dark.
 */
export function initThemeToggle() {
  const btns = document.querySelectorAll('.theme-toggle');
  const current = document.documentElement.getAttribute('data-theme') || 'light';

  btns.forEach(btn => {
    btn.textContent = current === 'light' ? '\uD83C\uDF19' : '\u2600\uFE0F';
    btn.addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme') || 'light';
      const oledPref = localStorage.getItem('oracle_party_oled_pref') === '1';
      const darkVariant = oledPref ? 'oled' : 'dark';
      const next = (cur === 'light') ? darkVariant : 'light';
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
