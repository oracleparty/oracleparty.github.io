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
export function transitionScreens(fromEl, toEl, duration = 500) {
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
      // Scroll new screen and its content to top
      toEl.scrollTop = 0;
      const content = toEl.querySelector('.game-content');
      if (content) content.scrollTop = 0;
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

// ============================================
// Avatar Rendering
// ============================================

/**
 * Render an avatar HTML string.
 * Authenticated players with avatar_color + avatar_emoji get a color+emoji circle.
 * Guests (null fields) fall back to the deterministic initial-letter HSL circle.
 *
 * @param {Object} opts
 * @param {string}      opts.displayName  - Player's display name (required)
 * @param {string|null} opts.avatarColor  - Hex color from profile (null = guest)
 * @param {string|null} opts.avatarEmoji  - Emoji from profile (null = guest)
 * @param {string}      [opts.size]       - CSS size override (e.g. '48px')
 * @param {string}      [opts.extraClass] - Additional CSS class(es)
 * @returns {string} HTML string
 */
export function renderAvatar({ displayName, avatarColor, avatarEmoji, size, extraClass }) {
  const safeExtra = extraClass ? extraClass.replace(/[^a-zA-Z0-9_ -]/g, '') : '';
  const cls = `avatar${safeExtra ? ' ' + safeExtra : ''}`;
  const sizeStyle = size ? `width:${size};height:${size};` : '';

  if (avatarColor && avatarEmoji) {
    // Sanitize: validate hex color (3/4/6/8 digit), strip HTML from emoji
    const safeColor = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(avatarColor) ? avatarColor : '#78716C';
    const safeEmoji = (avatarEmoji || '').replace(/[<>"&]/g, '');
    const emojiSize = size ? `font-size:calc(${size} * 0.55);` : '';
    return `<div class="${cls}" style="background:${safeColor};${sizeStyle}${emojiSize}">${safeEmoji}</div>`;
  }

  // Guest fallback: initial-letter circle
  const hue = getAvatarHue(displayName || '?');
  const initial = (displayName || '?')[0].toUpperCase();
  return `<div class="${cls} avatar--guest" style="background:hsl(${hue},45%,45%);${sizeStyle}">${initial}</div>`;
}

// ============================================
// Auto-Titles
// ============================================

/** Category → Display title name mapping (from SPEC-profiles.md). */
export const CATEGORY_TITLES = {
  'history': 'The Historian',
  'science': 'The Scientist',
  'nature': 'The Naturalist',
  'arts-literature': 'The Literati',
  'culture-society': 'The Anthropologist',
  'pop-culture': 'The Culturist',
  'world-geography': 'The Cartographer',
  'technology': 'The Technologist',
  'sports': 'The Athlete',
  'food': 'The Connoisseur',
  'logic': 'The Logician',
  'wild-card': 'The Polymath'
};

const TITLE_TIERS = [
  { min: 6.5, label: 'Oracle' },
  { min: 5.5, label: 'Master' },
  { min: 4.5, label: 'Scholar' },
  { min: 3.0, label: 'Apprentice' },
];

/**
 * Calculate auto-title from player_stats rows.
 * Formula: category_score = accuracy × log2(questions_answered)
 * Minimum 20 questions in a category before it counts.
 *
 * @param {Array} stats - Array of { category, questions_answered, correct_answers }
 * @returns {{ title: string, tier: string, category: string|null }}
 */
export function calculateTitle(stats) {
  let bestScore = -1;
  let bestCat = null;

  for (const s of (stats || [])) {
    if (s.questions_answered < 20) continue;
    const accuracy = s.correct_answers / s.questions_answered;
    const score = accuracy * Math.log2(s.questions_answered);
    if (score > bestScore) {
      bestScore = score;
      bestCat = s.category;
    }
  }

  if (!bestCat) return { title: 'Novice', tier: 'Novice', category: null };

  const tier = TITLE_TIERS.find(t => bestScore >= t.min)?.label || 'Apprentice';
  const catTitle = CATEGORY_TITLES[bestCat] || 'The Scholar';
  return { title: `${catTitle} — ${tier}`, tier, category: bestCat };
}

// ============================================
// Misc Helpers
// ============================================

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
 * Extract all contiguous digit sequences from a string, in order.
 * e.g. "apollo 13" → ["13"],  "world war 2" → ["2"],  "1996" → ["1996"]
 */
function digitSequences(str) {
  return str.match(/\d+/g) || [];
}

/**
 * Return true when both strings contain the same digit sequences in the same order.
 * Empty sequences (no digits in either) also count as matching.
 */
function digitSequencesMatch(a, b) {
  const da = digitSequences(a);
  const db = digitSequences(b);
  if (da.length !== db.length) return false;
  return da.every((d, i) => d === db[i]);
}

/**
 * Check if a submitted answer matches the correct answer or any acceptable alternate.
 * Uses exact match first, then Levenshtein distance with a tolerance threshold.
 * Threshold: max(1, floor(target.length * 0.25)) — roughly 1 typo per 4 characters.
 *
 * Numeric guard: if either string contains digits, their digit sequences must be
 * identical before Levenshtein is applied. This prevents "1994" ≈ "1996" while
 * still allowing "Appollo 13" ≈ "Apollo 13" (word typo, same number).
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

    // Numeric guard: digit sequences must be identical — no fuzzy tolerance on digits.
    // Only checked when at least one string contains a digit.
    if (/\d/.test(normalizedSubmitted) || /\d/.test(normalizedCandidate)) {
      if (!digitSequencesMatch(normalizedSubmitted, normalizedCandidate)) continue;
    }

    // Levenshtein distance with threshold (word-part tolerance only)
    const threshold = Math.max(1, Math.floor(normalizedCandidate.length * 0.25));
    const distance = levenshteinDistance(normalizedSubmitted, normalizedCandidate);
    if (distance <= threshold) return true;

    // Last name matching: if the correct answer contains a space (likely a name),
    // accept any single word longer than 3 characters from the correct answer.
    // e.g. "Antoinette" matches "Marie Antoinette", "Booth" matches "John Wilkes Booth"
    if (normalizedCandidate.includes(' ')) {
      const words = normalizedCandidate.split(/\s+/);
      for (const word of words) {
        if (word.length > 3) {
          const wordDist = levenshteinDistance(normalizedSubmitted, word);
          const wordThreshold = Math.max(1, Math.floor(word.length * 0.25));
          if (wordDist <= wordThreshold) return true;
        }
      }
    }
  }

  return false;
}
