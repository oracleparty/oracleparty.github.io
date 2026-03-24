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
export function transitionScreens(fromEl, toEl, duration = 800) {
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

/**
 * Escape HTML entities to prevent XSS.
 */
export function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/**
 * Generate a deterministic hue (0-359) from a player name for avatar coloring.
 */
export function getAvatarHue(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return Math.abs(hash) % 360;
}

/**
 * Fisher-Yates shuffle. Returns a new array.
 */
export function shuffleArray(arr) {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// ============================================
// Answer Judging — Fuzzy Matching
// ============================================

/**
 * Normalize an answer string for comparison.
 * Lowercases, strips leading articles, removes punctuation, collapses whitespace.
 */
export function normalizeAnswer(str) {
  if (!str) return '';
  let s = str.toLowerCase().trim();
  // Strip leading articles
  s = s.replace(/^(the|a|an)\s+/i, '');
  // Remove punctuation (keep alphanumeric and spaces)
  s = s.replace(/[^a-z0-9\s]/g, '');
  // Collapse whitespace
  s = s.replace(/\s+/g, ' ').trim();
  // Expand common numeric abbreviations (only after digits)
  s = s.replace(/(\d)\s*bil\b/g, '$1 billion');
  s = s.replace(/(\d)\s*mil\b/g, '$1 million');
  s = s.replace(/(\d)\s*tril\b/g, '$1 trillion');
  s = s.replace(/(\d)\s*k\b/g, '$1 thousand');
  return s;
}

/**
 * Compute Levenshtein (edit) distance between two strings.
 */
export function levenshteinDistance(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const cost = b[i - 1] === a[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,      // deletion
        matrix[i][j - 1] + 1,      // insertion
        matrix[i - 1][j - 1] + cost // substitution
      );
    }
  }
  return matrix[b.length][a.length];
}

/**
 * Check if a submitted answer matches the correct answer or any acceptable alternate.
 * Uses exact match first, then Levenshtein distance with a tolerance threshold.
 * Threshold: max(1, floor(target.length * 0.25)) — roughly 1 typo per 4 characters.
 */
export function fuzzyMatch(submitted, correct, alternates = []) {
  const normalizedSubmitted = normalizeAnswer(submitted);
  if (!normalizedSubmitted) return false;

  const candidates = [correct, ...(alternates || [])].filter(Boolean);

  for (const candidate of candidates) {
    const normalizedCandidate = normalizeAnswer(candidate);
    if (!normalizedCandidate) continue;

    // Exact match after normalization
    if (normalizedSubmitted === normalizedCandidate) return true;

    // Levenshtein distance with threshold
    const threshold = Math.max(1, Math.floor(normalizedCandidate.length * 0.25));
    const distance = levenshteinDistance(normalizedSubmitted, normalizedCandidate);
    if (distance <= threshold) return true;
  }

  return false;
}
