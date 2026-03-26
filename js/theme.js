// ============================================
// Oracle Party — Theme Toggle
// Switches between light and dark themes.
// Preference saved in localStorage.
// ============================================

/**
 * Initialize all theme toggle buttons on the page.
 * Call once after DOM is ready.
 */
export function initThemeToggle() {
  const btns = document.querySelectorAll('.theme-toggle');
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';

  btns.forEach(btn => {
    btn.textContent = isDark ? '\u2600\uFE0F' : '\uD83C\uDF19';
    btn.addEventListener('click', () => {
      const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('oracle_party_theme', next);
      // Update all toggle buttons on the page
      document.querySelectorAll('.theme-toggle').forEach(b => {
        b.textContent = next === 'dark' ? '\u2600\uFE0F' : '\uD83C\uDF19';
      });
      // Update meta theme-color for mobile browser chrome
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.content = next === 'dark' ? '#1A1A2E' : '#F8F7F4';
    });
  });
}
