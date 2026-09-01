// ============================================
// Oracle Party — Title System
// Toontown-style 3-slot custom title builder.
// Phase 1: Word list, unlock conditions, evaluation logic.
// ============================================

import { MIN_QUESTIONS_FOR_TITLE, LOYAL_DAYS, ANCIENT_DAYS, NIGHT_OWL_START_HOUR, NIGHT_OWL_END_HOUR } from './constants.js';

// ============================================
// MASTER WORD LIST
// ============================================

/**
 * Each word has:
 * - slot: 1 (Prefix), 2 (Category), 3 (Tier)
 * - word: Display text
 * - rarity: 'common' | 'rare' | 'legendary' — determines celebration tier
 * - hint: Poetic hint shown for locked ??? entries
 * - unlock: { type, condition } — what triggers the unlock
 * - levelMultiplier: multiplier for micro-levels (Level I = 1×, II = 2×, III = 3× the base condition)
 */
export const TITLE_WORDS = {
  // ============================================
  // SLOT 1: PREFIX (personality/trait words)
  // ============================================
  brave: {
    slot: 1, word: 'Brave', rarity: 'common',
    hint: 'Victory favors the bold',
    unlock: { type: 'milestone', condition: { stat: 'wins', value: 5 } },
    levelMultiplier: 2 // L1: 5 wins, L2: 10, L3: 15
  },
  relentless: {
    slot: 1, word: 'Relentless', rarity: 'rare',
    hint: 'Those who never stop, never lose',
    unlock: { type: 'milestone', condition: { stat: 'winStreak', value: 10 } },
    levelMultiplier: 1.5
  },
  fearless: {
    slot: 1, word: 'Fearless', rarity: 'rare',
    hint: 'Earned through sheer persistence',
    unlock: { type: 'milestone', condition: { stat: 'gamesPlayed', value: 50 } },
    levelMultiplier: 2
  },
  loyal: {
    slot: 1, word: 'Loyal', rarity: 'common',
    hint: 'Time reveals the faithful',
    unlock: { type: 'loyalty', condition: { stat: 'accountAgeDays', value: LOYAL_DAYS } },
    levelMultiplier: 4 // L2: 120 days, L3: 360 days
  },
  steadfast: {
    slot: 1, word: 'Steadfast', rarity: 'rare',
    hint: 'Rain or shine, they return',
    unlock: { type: 'loyalty', condition: { stat: 'consecutiveDays', value: 7 } },
    levelMultiplier: 2
  },
  popular: {
    slot: 1, word: 'Popular', rarity: 'common',
    hint: 'The crowd knows your name',
    unlock: { type: 'social', condition: { stat: 'honksReceived', value: 100 } },
    levelMultiplier: 3
  },
  mighty: {
    slot: 1, word: 'Mighty', rarity: 'rare',
    hint: 'A leader of many expeditions',
    unlock: { type: 'social', condition: { stat: 'gamesHosted', value: 20 } },
    levelMultiplier: 2.5
  },
  phantom: {
    slot: 1, word: 'Phantom', rarity: 'legendary',
    hint: null, // Hidden — no hint
    unlock: { type: 'hidden', condition: { stat: 'nightOwl' } },
    levelMultiplier: 3
  },
  lucky: {
    slot: 1, word: 'Lucky', rarity: 'legendary',
    hint: null,
    unlock: { type: 'hidden', condition: { stat: 'perfectGame' } },
    levelMultiplier: 2
  },
  ancient: {
    slot: 1, word: 'Ancient', rarity: 'rare',
    hint: 'They were here before the legends',
    unlock: { type: 'loyalty', condition: { stat: 'accountAgeDays', value: ANCIENT_DAYS } },
    levelMultiplier: 1 // Only 1 level for a year-old account
  },

  // ============================================
  // SLOT 2: CATEGORY (identity words)
  // ============================================
  history: {
    slot: 2, word: 'History', rarity: 'common',
    hint: 'The past whispers to those who listen',
    unlock: { type: 'count', condition: { category: 'history', right: 10 } },
    levelMultiplier: 1 // Levels tied to tier progression, not multiplier
  },
  science: {
    slot: 2, word: 'Science', rarity: 'common',
    hint: 'Truth found through careful observation',
    unlock: { type: 'count', condition: { category: 'science', right: 10 } },
    levelMultiplier: 1
  },
  nature: {
    slot: 2, word: 'Nature', rarity: 'common',
    hint: 'The wild reveals its secrets slowly',
    unlock: { type: 'count', condition: { category: 'nature', right: 10 } },
    levelMultiplier: 1
  },
  arts: {
    slot: 2, word: 'Arts', rarity: 'common',
    hint: 'Beauty recognized by a trained eye',
    unlock: { type: 'count', condition: { category: 'arts-literature', right: 10 } },
    levelMultiplier: 1
  },
  culture: {
    slot: 2, word: 'Culture', rarity: 'common',
    hint: 'Understanding begins with curiosity',
    unlock: { type: 'count', condition: { category: 'culture-society', right: 10 } },
    levelMultiplier: 1
  },
  pop: {
    slot: 2, word: 'Pop', rarity: 'common',
    hint: 'The pulse of the modern world',
    unlock: { type: 'count', condition: { category: 'pop-culture', right: 10 } },
    levelMultiplier: 1
  },
  world: {
    slot: 2, word: 'World', rarity: 'common',
    hint: 'Every map tells a story',
    unlock: { type: 'count', condition: { category: 'world-geography', right: 10 } },
    levelMultiplier: 1
  },
  tech: {
    slot: 2, word: 'Tech', rarity: 'common',
    hint: 'The future belongs to the curious',
    unlock: { type: 'count', condition: { category: 'technology', right: 10 } },
    levelMultiplier: 1
  },
  sport: {
    slot: 2, word: 'Sport', rarity: 'common',
    hint: 'Strength measured beyond the field',
    unlock: { type: 'count', condition: { category: 'sports', right: 10 } },
    levelMultiplier: 1
  },
  food: {
    slot: 2, word: 'Food', rarity: 'common',
    hint: 'Taste is a form of knowledge',
    unlock: { type: 'count', condition: { category: 'food', right: 10 } },
    levelMultiplier: 1
  },
  logic: {
    slot: 2, word: 'Logic', rarity: 'common',
    hint: 'Patterns hide in plain sight',
    unlock: { type: 'count', condition: { category: 'logic', right: 10 } },
    levelMultiplier: 1
  },
  chaos: {
    slot: 2, word: 'Chaos', rarity: 'common',
    hint: 'Order emerges from the unpredictable',
    unlock: { type: 'count', condition: { category: 'wild-card', right: 10 } },
    levelMultiplier: 1
  },

  // --- History subcategory words (Slot 2, unlock at deeper tiers) ---
  chronicles: {
    slot: 2, word: 'Chronicles', rarity: 'uncommon',
    hint: 'Temples and empires lost to sand',
    unlock: { type: 'count', condition: { category: 'history', subcategory: 'ancient', right: 15 } },
    levelMultiplier: 1
  },
  antiquity: {
    slot: 2, word: 'Antiquity', rarity: 'legendary',
    hint: 'Before written memory, there was you',
    unlock: { type: 'count', condition: { category: 'history', subcategory: 'ancient', right: 58 } },
    levelMultiplier: 1
  },
  crusade: {
    slot: 2, word: 'Crusade', rarity: 'uncommon',
    hint: 'Swords and shields in distant lands',
    unlock: { type: 'count', condition: { category: 'history', subcategory: 'medieval', right: 13 } },
    levelMultiplier: 1
  },
  dynasty: {
    slot: 2, word: 'Dynasty', rarity: 'legendary',
    hint: 'Crowns pass but the bloodline endures',
    unlock: { type: 'count', condition: { category: 'history', subcategory: 'medieval', right: 52 } },
    levelMultiplier: 1
  },
  renaissance: {
    slot: 2, word: 'Renaissance', rarity: 'uncommon',
    hint: 'The world reborn through curious minds',
    unlock: { type: 'count', condition: { category: 'history', subcategory: 'early-modern', right: 60 } },
    levelMultiplier: 1
  },
  revolution: {
    slot: 2, word: 'Revolution', rarity: 'epic',
    hint: 'When the old order crumbles',
    unlock: { type: 'count', condition: { category: 'history', subcategory: 'early-modern', right: 180 } },
    levelMultiplier: 1
  },
  atomic: {
    slot: 2, word: 'Atomic', rarity: 'uncommon',
    hint: 'The century that split the atom and the world',
    unlock: { type: 'count', condition: { category: 'history', subcategory: 'modern', right: 82 } },
    levelMultiplier: 1
  },
  // KEY RENAMED, WORD UNCHANGED. This was `eternal`, exactly like the slot 3
  // entry near the bottom of this file — and TITLE_WORDS is a plain object, so
  // the later one silently replaced this one. It has never existed: the top
  // reward for modern history, a legendary, could not be earned by anybody, and
  // nothing anywhere would ever have said so.
  //
  // Every other era has both a Scholar word and an Oracle word (Chronicles /
  // Antiquity, Crusade / Dynasty, Renaissance / Revolution). Modern had Atomic
  // and then nothing, which is what makes the loss visible once you line them up.
  //
  // The two words are still both "Eternal" on screen. That is the author's
  // intent restored rather than a rename invented here — but it does mean a
  // title could read "Eternal Eternal", which is a decision for the owner, not
  // one to make quietly in a bug fix.
  eternalModern: {
    slot: 2, word: 'Eternal', rarity: 'legendary',
    hint: 'All of time bends to your knowledge',
    unlock: { type: 'count', condition: { category: 'history', subcategory: 'modern', right: 327 } },
    levelMultiplier: 1
  },

  // ============================================
  // SLOT 3: TIER (rank/achievement words)
  // ============================================
  apprentice: {
    slot: 3, word: 'Apprentice', rarity: 'common',
    hint: 'The first step on a long road',
    unlock: { type: 'mastery', condition: { anyCategory: 'Apprentice' } },
    levelMultiplier: 1
  },
  scholar: {
    slot: 3, word: 'Scholar', rarity: 'rare',
    hint: 'Knowledge earned through dedication',
    unlock: { type: 'mastery', condition: { anyCategory: 'Scholar' } },
    levelMultiplier: 1
  },
  master: {
    slot: 3, word: 'Master', rarity: 'rare',
    hint: 'Few reach this summit',
    unlock: { type: 'mastery', condition: { anyCategory: 'Master' } },
    levelMultiplier: 1
  },
  oracle: {
    slot: 3, word: 'Oracle', rarity: 'legendary',
    hint: 'The rarest of minds',
    unlock: { type: 'mastery', condition: { anyCategory: 'Oracle' } },
    levelMultiplier: 1
  },
  champion: {
    slot: 3, word: 'Champion', rarity: 'rare',
    hint: 'Victories carved in stone',
    unlock: { type: 'milestone', condition: { stat: 'wins', value: 25 } },
    levelMultiplier: 2
  },
  guardian: {
    slot: 3, word: 'Guardian', rarity: 'rare',
    hint: 'Protector of truth',
    unlock: { type: 'contribution', condition: { stat: 'questionsFlagged', value: 10 } },
    levelMultiplier: 3
  },
  eternal: {
    slot: 3, word: 'Eternal', rarity: 'legendary',
    hint: 'Transcended a single domain',
    unlock: { type: 'mastery', condition: { oracleCategories: 3 } },
    levelMultiplier: 1
  },
  untouchable: {
    slot: 3, word: 'Untouchable', rarity: 'legendary',
    hint: null, // Hidden
    unlock: { type: 'hidden', condition: { stat: 'perfectStreak', value: 5 } },
    levelMultiplier: 1
  }
};

/**
 * THE RARITY LADDER, in one place.
 *
 * This was written out four separate times — here, the celebration table, the
 * gallery's sort and the Title Builder's sort — and three of them were still
 * the OLD three-tier ladder after the rebuild added uncommon, epic and mythic.
 * A missing key reads as rank 0, so in the Builder a mythic word sorted level
 * with a common, and nothing anywhere said so. Same shape as every other
 * "stated twice, fixed once" fault in this project: one export, and every
 * reader takes it from here.
 */
export const RARITY_ORDER = {
  common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4, mythic: 5
};

/**
 * Celebration tier for each rarity — how loudly earning one is announced.
 *
 * EPIC WAS MISSING once already. Three words carry rarity 'epic' and this table
 * had no key for them, so every lookup returned undefined. Nothing noticed,
 * because nothing read this table at all: it was written, exported, and wired
 * to nothing. UNCOMMON AND MYTHIC were missing for the same reason after the
 * rebuild — the ladder grew and this did not follow it.
 *
 * Mythic is the whole of a subject and there are twelve of them in the game, so
 * it takes the screen. Uncommon is a quarter of one topic — real, but it will
 * happen often enough that interrupting for it would wear thin.
 */
export const RARITY_CELEBRATION = {
  common: 'toast',
  uncommon: 'toast',
  rare: 'results',
  epic: 'fullscreen',
  legendary: 'fullscreen',
  mythic: 'fullscreen'
};

/**
 * What to show for a batch of unlocks, and how loudly.
 *
 * → { tier, lead, others, count } or null when there is nothing to celebrate.
 *
 * ONE celebration for the batch, not one per word. Early on several commons
 * unlock at once — reaching Apprentice in a category can trip three at a time
 * — and six overlays in a row is not a reward, it is a queue to dismiss. The
 * loudest thing in the batch decides the tier, the rarest word leads, and the
 * rest are counted.
 *
 * The owner's rule: scale to rarity. If everything celebrates equally, nothing
 * does — so a common is a toast you can ignore, a rare interrupts the results
 * screen, and a legendary takes the screen for a beat.
 */
export function planCelebration(newUnlocks) {
  const list = (newUnlocks || []).filter(u => u && u.word);
  if (list.length === 0) return null;

  const sorted = [...list].sort((a, b) => {
    const byRarity = (RARITY_ORDER[b.rarity] ?? 0) - (RARITY_ORDER[a.rarity] ?? 0);
    if (byRarity) return byRarity;
    // A brand-new word beats an upgrade of one already held: the first time
    // you see a word is the moment worth marking.
    return (b.isNew === true) - (a.isNew === true);
  });

  const lead = sorted[0];
  return {
    tier: RARITY_CELEBRATION[lead.rarity] || 'toast',
    lead,
    others: sorted.slice(1),
    count: sorted.length,
  };
}

// ============================================
// TIER THRESHOLDS (matches utils.js calculateTitle)
// ============================================

const TIER_THRESHOLDS = {
  Apprentice: 3.0,
  Scholar: 4.5,
  Master: 5.5,
  Oracle: 6.5
};

export const TIER_ORDER = ['Apprentice', 'Scholar', 'Master', 'Oracle'];

/**
 * Where somebody stands in a category, and what it would take to move up.
 *
 * → { tier, next, needed, met, required } or null when there is no data.
 *
 *   tier     the rank they hold now, or null for none yet
 *   next     the rank above it, or null at Oracle
 *   needed   how many more questions they would have to get right to reach it,
 *            or null when that is more than this can sensibly say
 *   met      distinct questions seen
 *   required MIN_QUESTIONS_FOR_TITLE — no rank at all below this, whatever the
 *            accuracy, so a player on 3 questions needs volume before anything
 *            else and should be told that rather than a misleading number
 *
 * WHY THIS EXISTS. A rank is accuracy x log2(questions met), against fixed
 * thresholds. That is a defensible rule and completely unguessable from the
 * outside: the owner asked where their ranks were and how to improve them, and
 * nothing in the app answered either question. A progression nobody can see is
 * not a progression.
 *
 * `needed` is SIMULATED rather than solved. Answering one more question right
 * moves both halves of the fraction, so there is no clean closed form, and an
 * approximation here would be a number a player then fails to hit. Stepping
 * forward is exact and costs nothing at this size.
 */
export function tierProgress(row) {
  const prof = rowProficiency(row);
  if (!prof) return null;

  const scoreOf = (mastered, met) => (met > 0 ? (mastered / met) * Math.log2(met) : 0);
  const tierAt = (mastered, met) => {
    if (met < MIN_QUESTIONS_FOR_TITLE) return null;
    const score = scoreOf(mastered, met);
    for (let i = TIER_ORDER.length - 1; i >= 0; i--) {
      if (score >= TIER_THRESHOLDS[TIER_ORDER[i]]) return TIER_ORDER[i];
    }
    return null;
  };

  const tier = tierAt(prof.mastered, prof.met);
  const next = tier ? TIER_ORDER[TIER_ORDER.indexOf(tier) + 1] || null : TIER_ORDER[0];
  const base = { tier, next, met: prof.met, required: MIN_QUESTIONS_FOR_TITLE };
  if (!next) return { ...base, needed: 0 };

  // Capped rather than unbounded. A player far below a threshold is not helped
  // by "you need 312 more" — that is a different message, and this returns null
  // so the caller can say the honest thing instead of a discouraging one.
  let mastered = prof.mastered;
  let met = prof.met;
  for (let i = 1; i <= 200; i++) {
    mastered++; met++;
    if (tierAt(mastered, met) === next || (tierAt(mastered, met) && TIER_ORDER.indexOf(tierAt(mastered, met)) >= TIER_ORDER.indexOf(next))) {
      return { ...base, needed: i };
    }
  }
  return { ...base, needed: null };
}

// ============================================
// UNLOCK EVALUATION
// ============================================

/**
 * Compute the category tier for each category from player_stats.
 * Returns { 'history': 'Scholar', 'science': 'Apprentice', ... }
 *
 * THE ROLLUP ROWS ARE MERGED FIRST, and leaving that out was a real bug in the
 * most consequential place it could be. player_stats_computed emitted THREE
 * rollup rows for Wild Card — the profile showed the category three times, which
 * is how it was found — because `null`, `''` and `undefined` all read as "no
 * subcategory" while staying separate rows. mergedCategoryRows was written to
 * fix the profile and this function was not converted with it.
 *
 * A tier is not a display detail: it gates every title unlock, the tier badge in
 * every lobby, and hasReachedApprentice, which is what opens the Title Builder.
 * Reading one fragment of a split category understates it twice over — the
 * fragment carries a slice of the questions, and MIN_QUESTIONS_FOR_TITLE is
 * applied to that slice, so somebody with 36 questions met split 12/12/12 gets
 * NO TIER AT ALL rather than a lower one. Which of the three won was also just
 * whichever the view happened to return last.
 *
 * SUBCATEGORY ROWS ARE NOT MERGED. Each one is its own tier under its own key,
 * which is the whole point of them; only the category-level rollups are
 * ambiguous. With a single rollup per category the merge is the identity, so
 * this is a no-op wherever the view behaves.
 */
export function computeCategoryTiers(stats) {
  const tiers = {};
  const rows = [
    ...mergedCategoryRows(stats),
    ...(stats || []).filter(s => s.subcategory),
  ];
  for (const s of rows) {
    const prof = rowProficiency(s);
    if (!prof || prof.met < MIN_QUESTIONS_FOR_TITLE) continue;
    const accuracy = prof.accuracy;
    const score = accuracy * Math.log2(prof.met);
    let tier = null;
    if (score >= TIER_THRESHOLDS.Oracle) tier = 'Oracle';
    else if (score >= TIER_THRESHOLDS.Master) tier = 'Master';
    else if (score >= TIER_THRESHOLDS.Scholar) tier = 'Scholar';
    else if (score >= TIER_THRESHOLDS.Apprentice) tier = 'Apprentice';
    if (!tier) continue;
    // Category-level tier (rows where subcategory is null)
    if (!s.subcategory) {
      tiers[s.category] = tier;
    }
    // Subcategory-level tier (rows where subcategory is set)
    if (s.subcategory) {
      tiers[`${s.category}:${s.subcategory}`] = tier;
    }
  }
  return tiers;
}

/**
 * The category-level rows of player_stats_computed, and nothing else.
 *
 * THE VIEW RETURNS EACH NUMBER TWICE. For one player in one category it emits
 * a row per subcategory AND a rollup row with subcategory NULL that already
 * contains the sum of them. Anything that ADDS rows up must take the rollups
 * only; anything that reads a single row (a tier, a title, one category's
 * accuracy) can use either.
 *
 * Five places summed every row and so counted most things twice — games,
 * wins, questions and correct answers alike. Nothing caught it because the
 * view did not exist on the live database until 2026-08-19 (CLAUDE.md #8), so
 * every one of those sums had only ever run over an empty array.
 *
 * The inflation is NOT a clean factor of two: a question with no subcategory
 * is counted once and one with a subcategory twice, so it varies per player
 * and reorders a leaderboard rather than just scaling it.
 */
export function categoryRollupRows(stats) {
  return (stats || []).filter(s => !s.subcategory);
}

/**
 * One row per category, with the counters of every rollup row for it merged.
 *
 * `player_stats_computed` is meant to emit exactly one rollup per category —
 * the row where `subcategory` is null — but the profile showed WILD CARD THREE
 * TIMES, which means it emitted three rows the app could not tell apart. The
 * filter above is `!s.subcategory`, so null, '' and undefined all land in the
 * same bucket while remaining separate rows, and each one renders as another
 * identical line under the same name.
 *
 * Merging is the right answer rather than picking one: whichever way those
 * rows came to be split, together they describe the category, and showing one
 * of three would quietly under-report it. It is also self-healing — with a
 * single rollup per category, merging is the identity.
 */
export function mergedCategoryRows(stats) {
  const byCategory = new Map();
  for (const s of categoryRollupRows(stats)) {
    const key = String(s.category ?? '');
    const acc = byCategory.get(key);
    if (!acc) {
      byCategory.set(key, { ...s, subcategory: null });
      continue;
    }
    for (const col of ['games_played', 'wins', 'questions_answered', 'correct_answers',
                       'questions_met', 'questions_mastered']) {
      if (s[col] == null && acc[col] == null) continue;
      acc[col] = (acc[col] || 0) + (s[col] || 0);
    }
  }
  return [...byCategory.values()];
}

/**
 * Proficiency for one stats row: the share of the QUESTIONS you have met in it
 * that you currently get right. Returns { met, mastered, accuracy } with
 * accuracy in 0..1, or null when there is nothing to divide by.
 *
 * Counting questions rather than attempts is what makes a bad round
 * recoverable. The old measure was SUM(times_correct) / SUM(times_seen) — a
 * lifetime hit rate — so a miss was permanent dead weight that playing more
 * could dilute but never undo, not even by learning the answer. Now the most
 * recent sighting decides, in both directions: get it right later and the miss
 * is gone, forget it later and the mastery is gone.
 *
 * FALLS BACK to the attempt counters when the new columns are absent, so the
 * app behaves exactly as before until migration 040 is applied rather than
 * showing everybody 0%.
 *
 * One row only. Never sum these across rows — see categoryRollupRows for why,
 * and note that a ratio of ratios is not a ratio in any case: add the
 * numerators and denominators, then divide.
 */
export function rowProficiency(s) {
  if (!s) return null;
  const hasNew = s.questions_met != null && s.questions_mastered != null;
  const met = hasNew ? (s.questions_met || 0) : (s.questions_answered || 0);
  const mastered = hasNew ? (s.questions_mastered || 0) : (s.correct_answers || 0);
  if (met <= 0) return null;
  return { met, mastered, accuracy: mastered / met };
}

/** Proficiency across several rows, added the only way a ratio can be. */
export function sumProficiency(rows) {
  let met = 0, mastered = 0;
  for (const s of rows || []) {
    const p = rowProficiency(s);
    if (!p) continue;
    met += p.met;
    mastered += p.mastered;
  }
  return met > 0 ? { met, mastered, accuracy: mastered / met } : null;
}

/**
 * Compute aggregate stats from player_stats rows.
 *
 * Rollups only — see categoryRollupRows. Summing every row unlocked
 * play-count titles at roughly half the games they ask for.
 */
function computeAggregateStats(stats) {
  let totalGames = 0, totalWins = 0;
  for (const s of categoryRollupRows(stats)) {
    totalGames += s.games_played || 0;
    totalWins += s.wins || 0;
  }
  return { totalGames, totalWins };
}

/**
 * Check if a word's unlock condition is met. Returns the level (0-3).
 *
 * @param {Object} wordDef — entry from TITLE_WORDS
 * @param {Object} categoryTiers — { 'history': 'Scholar', ... }
 * @param {Object} aggStats — { totalGames, totalWins }
 * @param {Object} profile — profiles table row
 * @param {Object} [context] — optional context (e.g. { hour: 3 } for hidden checks)
 * @returns {number} 0 = locked, 1-3 = unlocked level
 */
function computeWordLevel(wordDef, categoryTiers, aggStats, profile, context) {
  const { unlock, levelMultiplier } = wordDef;
  const { type, condition } = unlock;

  let baseAchieved = 0; // How many times the base condition is met (for micro-levels)

  switch (type) {
    // COUNT — the rule the title rebuild moves everything to. `condition` is
    // { category, subcategory?, right }, where `right` is a FROZEN target
    // worked out once from the topic's size (see js/title-tiers.js and the
    // admin page's Title Words panel, which prints it).
    //
    // Frozen, not recomputed: a live percentage would move somebody's goal
    // backwards every time the bank grew, and "13 more to go" becoming "31 more
    // to go" is the worst feeling in a collection.
    //
    // NO MICRO-LEVELS. A count word is earned once and kept; levelMultiplier is
    // ignored here deliberately rather than left to produce a silent level 2.
    case 'count': {
      if (!condition.right) return 0;
      const have = rightIn(context?.stats || [], condition.category, condition.subcategory || null);
      return have >= condition.right ? 1 : 0;
    }

    case 'mastery': {
      if (condition.category && condition.tier) {
        // Subcategory-specific mastery: use "category:subcategory" key
        const tierKey = condition.subcategory
          ? `${condition.category}:${condition.subcategory}`
          : condition.category;
        const playerTier = categoryTiers[tierKey];
        if (!playerTier) return 0;
        const tierOrder = ['Apprentice', 'Scholar', 'Master', 'Oracle'];
        const required = tierOrder.indexOf(condition.tier);
        const achieved = tierOrder.indexOf(playerTier);
        if (achieved < required) return 0;
        // For mastery words, micro-level = how far above the threshold
        // L1 = reach tier, L2 = reach next tier, L3 = reach 2 tiers above
        baseAchieved = 1 + (achieved - required);
      } else if (condition.anyCategory) {
        // Any category must reach this tier
        const tierOrder = ['Apprentice', 'Scholar', 'Master', 'Oracle'];
        const required = tierOrder.indexOf(condition.anyCategory);
        let best = -1;
        for (const t of Object.values(categoryTiers)) {
          best = Math.max(best, tierOrder.indexOf(t));
        }
        if (best < required) return 0;
        baseAchieved = 1 + (best - required);
      } else if (condition.oracleCategories) {
        // Count how many categories have reached Oracle
        const oracleCount = Object.values(categoryTiers).filter(t => t === 'Oracle').length;
        if (oracleCount < condition.oracleCategories) return 0;
        baseAchieved = Math.floor(oracleCount / condition.oracleCategories);
      }
      break;
    }

    case 'milestone': {
      const { stat, value } = condition;
      let playerValue = 0;
      if (stat === 'wins') playerValue = aggStats.totalWins;
      else if (stat === 'gamesPlayed') playerValue = aggStats.totalGames;
      else if (stat === 'winStreak') playerValue = profile?.max_win_streak || 0;
      if (playerValue < value) return 0;
      baseAchieved = Math.floor(playerValue / value);
      break;
    }

    case 'social': {
      const { stat, value } = condition;
      let playerValue = 0;
      if (stat === 'honksReceived') playerValue = profile?.honks_received || 0;
      else if (stat === 'honksGiven') playerValue = profile?.honks_given || 0;
      else if (stat === 'gamesHosted') playerValue = profile?.games_hosted || 0;
      if (playerValue < value) return 0;
      baseAchieved = Math.floor(playerValue / value);
      break;
    }

    case 'loyalty': {
      const { stat, value } = condition;
      if (stat === 'accountAgeDays') {
        const created = profile?.created_at ? new Date(profile.created_at) : null;
        if (!created) return 0;
        const days = Math.floor((Date.now() - created.getTime()) / (1000 * 60 * 60 * 24));
        if (days < value) return 0;
        baseAchieved = Math.floor(days / value);
      } else if (stat === 'consecutiveDays') {
        // Future: track consecutive days in profile. For now, return 0.
        return 0;
      }
      break;
    }

    case 'contribution': {
      const { stat, value } = condition;
      if (stat === 'questionsFlagged') {
        const flagged = profile?.questions_flagged || 0;
        if (flagged < value) return 0;
        baseAchieved = Math.floor(flagged / value);
      }
      break;
    }

    case 'hidden': {
      const { stat, value } = condition;
      if (stat === 'nightOwl') {
        const hour = context?.hour ?? new Date().getHours();
        if (hour < NIGHT_OWL_START_HOUR || hour >= NIGHT_OWL_END_HOUR) return 0;
        baseAchieved = 1; // Hidden words are typically L1 only unless replayed
      } else if (stat === 'perfectGame') {
        if (!context?.perfectGame) return 0;
        baseAchieved = 1;
      } else if (stat === 'perfectStreak') {
        const streak = context?.perfectStreak || 0;
        if (streak < (value || 5)) return 0;
        baseAchieved = Math.floor(streak / (value || 5));
      }
      break;
    }

    default:
      return 0;
  }

  // Convert baseAchieved to level 1-3 using the multiplier
  if (baseAchieved <= 0) return 0;
  if (levelMultiplier <= 1) return Math.min(baseAchieved, 3);
  if (baseAchieved >= 3) return 3;
  if (baseAchieved >= 2) return 2;
  return 1;
}

/**
 * Evaluate all title word unlocks for a player.
 *
 * @param {Array} stats — player_stats rows
 * @param {Object} profile — profiles table row
 * @param {Array} currentUnlocks — existing title_unlocks rows
 * @param {Object} [context] — optional context for hidden conditions
 * @returns {Array} Array of { wordId, word, level, rarity, isNew, isUpgrade }
 */
/**
 * How many distinct questions this player CURRENTLY gets right in a category,
 * or in one topic of it.
 *
 * THE ONE MEASURE THE NEW TITLE RULES USE (see "The agreed shape of titles" in
 * CLAUDE.md). Never a percentage of what they have MET: that falls when they
 * meet a new question and get it wrong, so a word built on it is taken away for
 * being curious — which is exactly what the old rank formula did.
 *
 * Reads through rowProficiency so the fallback to the older attempt counters is
 * stated once. And for a whole CATEGORY it takes the rollup rows only:
 * player_stats_computed emits a row per subcategory AND a rollup that already
 * contains their sum, so adding everything counts most things twice.
 */
export function rightIn(stats, category, subcategory = null) {
  if (!category) return 0;
  const rows = (stats || []).filter(s => s.category === category);
  const wanted = subcategory
    ? rows.filter(s => s.subcategory === subcategory)
    : categoryRollupRows(rows);
  let total = 0;
  for (const row of wanted) {
    const p = rowProficiency(row);
    if (p) total += p.mastered;
  }
  return total;
}

// ============================================
// WORDS WRITTEN BY THE OWNER, FROM THE DATABASE
//
// Title words are CONTENT, and content lives in the database and is edited from
// the admin page — the same as the question bank's answers and alternates. The
// owner has ~86 still to write, and a trickle of two a week should not need a
// deploy.
//
// The STRUCTURE is never stored: which slots exist and what each requires is
// computed from CATEGORY_META and title-tiers.js. Only the text is stored, and
// a slot with no row simply does not exist — which is what makes "a player never
// sees a slot they cannot fill" true by construction rather than by care.
// ============================================

/** A stable id for a written word, so an unlock survives the text being edited. */
export function overlayWordId(category, subcategory, tier) {
  return `w:${category}:${subcategory || ''}:${tier}`;
}

/**
 * Merge owner-written words into TITLE_WORDS.
 *
 * MUTATES the exported object on purpose. Roughly a dozen places import
 * TITLE_WORDS synchronously — the gallery, the builder, the celebration, the
 * unlock evaluation — and turning all of them async to await a fetch would be a
 * far larger change than this earns. Applying the overlay once at load keeps
 * every existing call site correct.
 *
 * A row whose slot is already defined in code WINS OVER THE CODE, so the owner
 * can correct a word without a deploy. Returns how many were applied.
 *
 * THE TARGET COMES FROM THE ROW, not from recomputing the share. It was frozen
 * when the word was written, deliberately: a share recomputed live means adding
 * questions to the bank moves everybody's goal further away. It also means this
 * needs no counting at all, where computing it here would cost about fifty
 * requests on every profile load.
 */
export function applyWordOverlay(rows) {
  let applied = 0;
  for (const r of rows || []) {
    const word = String(r.word || '').trim();
    const right = Number(r.target_right);
    if (!word || !r.category || !r.tier) continue;
    if (!Number.isFinite(right) || right < 1) continue;  // no target — not a real slot
    TITLE_WORDS[overlayWordId(r.category, r.subcategory, r.tier)] = {
      slot: Number(r.slot) || 2,
      word,
      rarity: r.tier,
      // Not a secret: a written word always says what it requires.
      hint: '',
      unlock: { type: 'count', condition: {
        category: r.category,
        ...(r.subcategory ? { subcategory: r.subcategory } : {}),
        right,
      } },
      levelMultiplier: 1,
      fromOverlay: true,
      // Players are never told a word is temporary — it is a real word they
      // really earn. The flag exists so the ADMIN page can say how much is
      // still scaffolding, which is the owner's view and not the player's.
      isPlaceholder: !!r.is_placeholder,
    };
    applied++;
  }
  return applied;
}

/** Drop every overlay word. Used when reloading, and by tests. */
export function clearWordOverlay() {
  for (const id of Object.keys(TITLE_WORDS)) {
    if (TITLE_WORDS[id]?.fromOverlay) delete TITLE_WORDS[id];
  }
}

/**
 * What a word requires, in words a player can act on.
 *
 * THE FIX FOR THE COMPLAINT THAT STARTED THE REBUILD: the gallery showed a
 * riddle and nothing else, so nobody — including the owner — could tell where
 * any word came from or how to get the next one. A riddle is right for a
 * secret and wrong for everything else.
 *
 * Returns null for a genuine secret, which the caller should render as such
 * rather than as a blank.
 */
export function describeRequirement(wordDef, labelFor = k => k) {
  if (!wordDef?.unlock) return null;
  const { type, condition = {} } = wordDef.unlock;
  if (type === 'hidden') return null;

  const where = condition.subcategory
    ? labelFor(condition.subcategory)
    : condition.category ? labelFor(condition.category) : null;

  switch (type) {
    case 'count':
      return where
        ? `Get ${condition.right} questions right in ${where}`
        : `Get ${condition.right} questions right`;

    case 'mastery':
      // LEGACY, and it reads as vague because it IS vague — "Scholar" is
      // between 23 and 512 questions depending on accuracy. Said plainly here
      // rather than dressed up; these words move to `count` as targets are set.
      if (condition.anyCategory) return `Reach ${condition.anyCategory} in any subject`;
      if (condition.oracleCategories) return `Reach Oracle in ${condition.oracleCategories} subjects`;
      if (condition.tier && where) return `Reach ${condition.tier} in ${where}`;
      return null;

    case 'milestone':
    case 'loyalty':
    case 'social':
    case 'contribution': {
      const n = condition.value;
      const what = {
        wins: 'Win %n games',
        winStreak: 'Win %n games in a row',
        gamesPlayed: 'Play %n games',
        gamesHosted: 'Host %n games',
        accountAgeDays: 'Keep an account for %n days',
        consecutiveDays: 'Play on %n days running',
        honksReceived: 'Receive %n honks',
        questionsFlagged: 'Report %n bad questions',
      }[condition.stat];
      return what ? what.replace('%n', n) : null;
    }

    default:
      return null;
  }
}

export function evaluateUnlocks(stats, profile, currentUnlocks, context) {
  const categoryTiers = computeCategoryTiers(stats);
  const aggStats = computeAggregateStats(stats);
  const unlockMap = {};
  for (const u of (currentUnlocks || [])) {
    unlockMap[u.word_id] = u.level;
  }

  const changes = [];
  for (const [id, wordDef] of Object.entries(TITLE_WORDS)) {
    const currentLevel = unlockMap[id] || 0;
    // The raw stat rows go through so a `count` word can ask how many
    // questions this player currently gets right in one topic. Merged into
    // context rather than added as a parameter: every other unlock type
    // reads pre-computed summaries, and only this one needs the rows.
    const newLevel = computeWordLevel(wordDef, categoryTiers, aggStats, profile,
                                      { ...(context || {}), stats: stats || [] });
    if (newLevel > currentLevel) {
      changes.push({
        wordId: id,
        word: wordDef.word,
        level: newLevel,
        rarity: wordDef.rarity,
        hint: wordDef.hint,
        isNew: currentLevel === 0,
        isUpgrade: currentLevel > 0
      });
    }
  }
  return changes;
}

/**
 * Check if the player has reached Apprentice in any category.
 * This is the trigger for the Title Builder unlock.
 */
export function hasReachedApprentice(stats) {
  const tiers = computeCategoryTiers(stats);
  return Object.keys(tiers).length > 0;
}

/**
 * Build the display title string from a profile's slot selections.
 * Returns "Novice" if no title builder, null if guest.
 */
export function buildDisplayTitle(profile) {
  if (!profile) return null;
  if (!profile.title_builder_unlocked) return 'Novice';
  const parts = [profile.title_slot1, profile.title_slot2, profile.title_slot3].filter(Boolean);
  if (parts.length === 0) return 'Novice';
  // AN ID THIS BUILD DOES NOT KNOW IS DROPPED, NEVER PRINTED.
  //
  // This was `TITLE_WORDS[id]?.word || id`, and the fallback is a slot key:
  // a player whose title could not be resolved was shown, to the entire room,
  // as "w:science::rare".
  //
  // It is not a rare state. Owner-written words arrive through applyWordOverlay,
  // which is fetched, and initAuth computes this title BEFORE that fetch — so on
  // every page load, every owner-written word in a title resolves to nothing.
  // The result is then cached to localStorage and copied onto the players row,
  // where it is what the whole lobby reads for the length of a game.
  //
  // Invisible while title_words is empty, and certain the moment the owner
  // writes one. Deleting a word does the same thing permanently.
  //
  // Dropping the part degrades to a shorter title, or to Novice if nothing
  // resolves — the same thing a player sees before they have chosen one, and a
  // far better wrong answer than a database key.
  const words = parts.map(id => TITLE_WORDS[id]?.word).filter(Boolean);
  if (words.length === 0) return 'Novice';
  return words.join(' ');
}
