// ============================================
// Oracle Party — Theme Toggle
// Cycles: light → dark → oled (logged-in only) → light
// Preference saved in localStorage.
// ============================================

const THEME_ICONS = { light: '\uD83C\uDF19', dark: '\u26AB', oled: '\u2600\uFE0F' };
const THEME_META = { light: '#F8F7F4', dark: '#1A1A2E', oled: '#000000' };

/**
 * Get next theme in cycle.
 * Guests: light ↔ dark (no OLED).
 * Logged-in: light → dark → oled → light.
 */
function nextTheme(current, isLoggedIn) {
  if (current === 'light') return 'dark';
  if (current === 'dark') return isLoggedIn ? 'oled' : 'light';
  return 'light'; // oled → light
}

/**
 * Initialize all theme toggle buttons on the page.
 * @param {boolean} [isLoggedIn=false] - If true, OLED option is available.
 */
export function initThemeToggle(isLoggedIn = false) {
  const btns = document.querySelectorAll('.theme-toggle');
  const current = document.documentElement.getAttribute('data-theme') || 'light';

  btns.forEach(btn => {
    btn.textContent = THEME_ICONS[current] || THEME_ICONS.light;
    btn.addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme') || 'light';
      const next = nextTheme(cur, isLoggedIn);
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('oracle_party_theme', next);
      // Update all toggle buttons on the page
      document.querySelectorAll('.theme-toggle').forEach(b => {
        b.textContent = THEME_ICONS[next] || THEME_ICONS.light;
      });
      // Update meta theme-color for mobile browser chrome
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.content = THEME_META[next] || THEME_META.light;
    });
  });
}
