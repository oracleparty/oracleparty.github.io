// ============================================
// LOADING THE OWNER'S WRITTEN TITLE WORDS
//
// Title words are content (migration 063): the RULES live in code, the TEXT
// lives in the database, and the owner writes it from the admin page without a
// deploy. This is the one place that fetches it and merges it in.
//
// ONE LOADER, NOT THREE. The profile, the leaderboard and the end-of-game
// unlock check all read TITLE_WORDS, and this project's single most repeated
// fault is a rule stated in several places and fixed in one — the seat ratchet,
// the answer count, the rarity ladder. Three copies of "fetch and apply" would
// be the same shape, with the failure being that a word appears on one screen
// and not another.
// ============================================

import { fetchTitleWords } from './db/social.js';
import { applyWordOverlay } from './titles.js';
import { logger } from './logger.js';

// A page may await this before it draws, so it needs a deadline of its own. A
// promise that never settles does not throw, so try/catch cannot save a caller
// from it — that is exactly how sign-in and the game page froze on 2026-08-29.
// Decorative content must never be able to hold a screen shut.
const TITLE_WORDS_TIMEOUT_MS = 6000;

let _loaded = null;

/**
 * Fetch the owner's words and merge them into TITLE_WORDS. Safe to call from
 * anywhere, any number of times: the work happens once per page load.
 *
 * NEVER FATAL, and never a blocker. If the table is not there yet, or the
 * request fails, the app shows exactly the words that are in the code — which
 * is what it did before this existed. A dropped request must not empty
 * somebody's collection, so a failed read leaves what is already applied alone
 * rather than clearing it.
 *
 * → the number of words applied, or 0.
 */
export function loadTitleWords() {
  if (_loaded) return _loaded;
  _loaded = (async () => {
    try {
      const rows = await Promise.race([
        fetchTitleWords(),
        new Promise(resolve => setTimeout(() => resolve(null), TITLE_WORDS_TIMEOUT_MS)),
      ]);
      // null means the read FAILED; [] means nothing is written yet. Treating
      // those alike is the mistake CLAUDE.md #6 catalogues five times over.
      if (rows === null) return 0;
      const n = applyWordOverlay(rows);
      if (n) logger.debug('Titles', `${n} owner-written words applied`);
      return n;
    } catch (err) {
      logger.warn('Titles', 'could not load written title words', err);
      return 0;
    }
  })();
  return _loaded;
}

/** Force the next loadTitleWords() to fetch again — used after an admin edit. */
export function resetTitleWordCache() {
  _loaded = null;
}
