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
    unlock: { type: 'mastery', condition: { category: 'history', tier: 'Apprentice' } },
    levelMultiplier: 1 // Levels tied to tier progression, not multiplier
  },
  science: {
    slot: 2, word: 'Science', rarity: 'common',
    hint: 'Truth found through careful observation',
    unlock: { type: 'mastery', condition: { category: 'science', tier: 'Apprentice' } },
    levelMultiplier: 1
  },
  nature: {
    slot: 2, word: 'Nature', rarity: 'common',
    hint: 'The wild reveals its secrets slowly',
    unlock: { type: 'mastery', condition: { category: 'nature', tier: 'Apprentice' } },
    levelMultiplier: 1
  },
  arts: {
    slot: 2, word: 'Arts', rarity: 'common',
    hint: 'Beauty recognized by a trained eye',
    unlock: { type: 'mastery', condition: { category: 'arts-literature', tier: 'Apprentice' } },
    levelMultiplier: 1
  },
  culture: {
    slot: 2, word: 'Culture', rarity: 'common',
    hint: 'Understanding begins with curiosity',
    unlock: { type: 'mastery', condition: { category: 'culture-society', tier: 'Apprentice' } },
    levelMultiplier: 1
  },
  pop: {
    slot: 2, word: 'Pop', rarity: 'common',
    hint: 'The pulse of the modern world',
    unlock: { type: 'mastery', condition: { category: 'pop-culture', tier: 'Apprentice' } },
    levelMultiplier: 1
  },
  world: {
    slot: 2, word: 'World', rarity: 'common',
    hint: 'Every map tells a story',
    unlock: { type: 'mastery', condition: { category: 'world-geography', tier: 'Apprentice' } },
    levelMultiplier: 1
  },
  tech: {
    slot: 2, word: 'Tech', rarity: 'common',
    hint: 'The future belongs to the curious',
    unlock: { type: 'mastery', condition: { category: 'technology', tier: 'Apprentice' } },
    levelMultiplier: 1
  },
  sport: {
    slot: 2, word: 'Sport', rarity: 'common',
    hint: 'Strength measured beyond the field',
    unlock: { type: 'mastery', condition: { category: 'sports', tier: 'Apprentice' } },
    levelMultiplier: 1
  },
  food: {
    slot: 2, word: 'Food', rarity: 'common',
    hint: 'Taste is a form of knowledge',
    unlock: { type: 'mastery', condition: { category: 'food', tier: 'Apprentice' } },
    levelMultiplier: 1
  },
  logic: {
    slot: 2, word: 'Logic', rarity: 'common',
    hint: 'Patterns hide in plain sight',
    unlock: { type: 'mastery', condition: { category: 'logic', tier: 'Apprentice' } },
    levelMultiplier: 1
  },
  chaos: {
    slot: 2, word: 'Chaos', rarity: 'common',
    hint: 'Order emerges from the unpredictable',
    unlock: { type: 'mastery', condition: { category: 'wild-card', tier: 'Apprentice' } },
    levelMultiplier: 1
  },

  // --- History subcategory words (Slot 2, unlock at deeper tiers) ---
  chronicles: {
    slot: 2, word: 'Chronicles', rarity: 'rare',
    hint: 'Temples and empires lost to sand',
    unlock: { type: 'mastery', condition: { category: 'history', subcategory: 'ancient', tier: 'Scholar' } },
    levelMultiplier: 1
  },
  antiquity: {
    slot: 2, word: 'Antiquity', rarity: 'epic',
    hint: 'Before written memory, there was you',
    unlock: { type: 'mastery', condition: { category: 'history', subcategory: 'ancient', tier: 'Oracle' } },
    levelMultiplier: 1
  },
  crusade: {
    slot: 2, word: 'Crusade', rarity: 'rare',
    hint: 'Swords and shields in distant lands',
    unlock: { type: 'mastery', condition: { category: 'history', subcategory: 'medieval', tier: 'Scholar' } },
    levelMultiplier: 1
  },
  dynasty: {
    slot: 2, word: 'Dynasty', rarity: 'epic',
    hint: 'Crowns pass but the bloodline endures',
    unlock: { type: 'mastery', condition: { category: 'history', subcategory: 'medieval', tier: 'Oracle' } },
    levelMultiplier: 1
  },
  renaissance: {
    slot: 2, word: 'Renaissance', rarity: 'rare',
    hint: 'The world reborn through curious minds',
    unlock: { type: 'mastery', condition: { category: 'history', subcategory: 'early-modern', tier: 'Scholar' } },
    levelMultiplier: 1
  },
  revolution: {
    slot: 2, word: 'Revolution', rarity: 'epic',
    hint: 'When the old order crumbles',
    unlock: { type: 'mastery', condition: { category: 'history', subcategory: 'early-modern', tier: 'Oracle' } },
    levelMultiplier: 1
  },
  atomic: {
    slot: 2, word: 'Atomic', rarity: 'rare',
    hint: 'The century that split the atom and the world',
    unlock: { type: 'mastery', condition: { category: 'history', subcategory: 'modern', tier: 'Scholar' } },
    levelMultiplier: 1
  },
  eternal: {
    slot: 2, word: 'Eternal', rarity: 'legendary',
    hint: 'All of time bends to your knowledge',
    unlock: { type: 'mastery', condition: { category: 'history', subcategory: 'modern', tier: 'Oracle' } },
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
 * Celebration tier for each rarity.
 */
export const RARITY_CELEBRATION = {
  common: 'toast',
  rare: 'results',
  // EPIC WAS MISSING. Three words carry rarity 'epic' — Antiquity, Dynasty,
  // Revolution — and this table has never had a key for them, so every lookup
  // for those returned undefined. Nothing noticed, because nothing has ever
  // read this table at all: it was written, exported, and wired to nothing.
  epic: 'fullscreen',
  legendary: 'fullscreen'
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

  const rank = { common: 0, rare: 1, epic: 2, legendary: 3 };
  const sorted = [...list].sort((a, b) => {
    const byRarity = (rank[b.rarity] ?? 0) - (rank[a.rarity] ?? 0);
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
 */
export function computeCategoryTiers(stats) {
  const tiers = {};
  for (const s of (stats || [])) {
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
    const newLevel = computeWordLevel(wordDef, categoryTiers, aggStats, profile, context);
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
  // Look up display words from the word list
  return parts.map(id => TITLE_WORDS[id]?.word || id).join(' ');
}
