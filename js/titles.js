// ============================================
// Oracle Party — Title System
// Toontown-style 3-slot custom title builder.
// Phase 1: Word list, unlock conditions, evaluation logic.
// ============================================

import { LOYAL_DAYS, ANCIENT_DAYS, NIGHT_OWL_START_HOUR, NIGHT_OWL_END_HOUR } from './constants.js';
import { liveTarget, subjectRank, RANK_TIERS, RANK_WORDS, SUBJECT_RULE, TOPIC_CAP } from './title-tiers.js';

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
  // THE RANK LADDER (owner, 2026-10-30). Each word is the step of the same
  // name, reached in ANY subject — and in the Title Builder it may only sit
  // beside a reel-2 word whose subject you have reached that step in. The old
  // Apprentice / Scholar / Master came from an accuracy formula nobody could
  // follow and are gone; `oracle` keeps its id, so anyone holding it keeps it.
  caveman: {
    slot: 3, word: 'Caveman', rarity: 'common',
    hint: 'Still in the cave, but you found the light switch',
    unlock: { type: 'rank', condition: { tier: 'common' } },
    levelMultiplier: 1
  },
  hermit: {
    slot: 3, word: 'Hermit', rarity: 'uncommon',
    hint: 'Alone in the cave, thinking very hard',
    unlock: { type: 'rank', condition: { tier: 'uncommon' } },
    levelMultiplier: 1
  },
  hippie: {
    slot: 3, word: 'Hippie', rarity: 'rare',
    hint: 'Out of the cave and looking for meaning',
    unlock: { type: 'rank', condition: { tier: 'rare' } },
    levelMultiplier: 1
  },
  pilgrim: {
    slot: 3, word: 'Pilgrim', rarity: 'epic',
    hint: 'On the long road to wisdom',
    unlock: { type: 'rank', condition: { tier: 'epic' } },
    levelMultiplier: 1
  },
  guru: {
    slot: 3, word: 'Guru', rarity: 'legendary',
    hint: 'People travel to YOU now',
    unlock: { type: 'rank', condition: { tier: 'legendary' } },
    levelMultiplier: 1
  },
  oracle: {
    slot: 3, word: 'Oracle', rarity: 'mythic',
    hint: 'The source of every answer',
    unlock: { type: 'rank', condition: { tier: 'mythic' } },
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
    unlock: { type: 'rank', condition: { tier: 'mythic', subjects: 3 } },
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
// RANKS, BY SUBJECT
// ============================================

// The topic sizes the goals and ranks are measured against. Set by
// applyLiveTargets, which every page reaches through loadTitleWords; null until
// then, or when migration 078 cannot be read.
let _topicSizes = null;

/** Today's topic sizes, or null when they have not been (or cannot be) read. */
export function currentTopicSizes() { return _topicSizes; }

/**
 * Every subject's rank for this player: { history: { index, tier, next }, ... }.
 *
 * A subject appears when we know its size OR the player has a row in it, so a
 * subject they have never touched is simply absent — no rank, not a zero.
 */
export function subjectRanks(stats, sizes = _topicSizes) {
  const subjects = new Set([
    ...Object.keys(sizes || {}),
    ...(stats || []).map(s => s.category).filter(Boolean),
  ]);
  const out = {};
  for (const cat of subjects) {
    const known = sizes?.[cat];
    const topics = Object.entries(known?.sizes || {}).map(([key, size]) => ({
      key, size, right: rightIn(stats, cat, key),
    }));
    out[cat] = subjectRank({
      subjectRight: rightIn(stats, cat),
      subjectSize: known ? known.subjectSize : null,
      topics,
    });
  }
  return out;
}

/** { subject: rankIndex } — the shape the Title Builder's pairing rule reads. */
export function rankIndexBySubject(stats, sizes = _topicSizes) {
  const out = {};
  for (const [cat, r] of Object.entries(subjectRanks(stats, sizes))) out[cat] = r.index;
  return out;
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
 * @param {Object} aggStats — { totalGames, totalWins }
 * @param {Object} profile — profiles table row
 * @param {Object} [context] — optional context (e.g. { hour: 3 } for hidden checks)
 * @returns {number} 0 = locked, 1-3 = unlocked level
 */
function computeWordLevel(wordDef, aggStats, profile, context) {
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

    // RANK — the step reached in any subject (or, for Eternal, in several).
    case 'rank': {
      const want = RANK_TIERS.indexOf(condition.tier);
      if (want < 0) return 0;
      const ranks = Object.values(rankIndexBySubject(context?.stats || [], context?.sizes ?? _topicSizes));
      const reached = ranks.filter(i => i >= want).length;
      return reached >= (condition.subjects || 1) ? 1 : 0;
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
 * The target here is the one SAVED with the row. applyLiveTargets then points
 * it at the topic's size today (owner, 2026-10-30), keeping the saved number as
 * the fallback for when sizes cannot be read.
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

/**
 * Point every subject word's goal at the topic's size TODAY (owner, 2026-10-30).
 *
 * Goals follow how many questions a topic really has, capped for the easier
 * steps (title-tiers.js). The number written with a word is kept as
 * `savedRight` and used whenever the sizes do not say — not loaded, migration
 * 078 not run, or a topic under the floor — so an old word stays earnable at
 * exactly the goal it had. Earned words are never taken away; this only moves
 * the goal for people still climbing.
 *
 * `sizes` is shapeTopicSizes' output, or null. Returns how many goals moved.
 */
export function applyLiveTargets(sizes) {
  if (sizes) _topicSizes = sizes;
  let moved = 0;
  for (const def of Object.values(TITLE_WORDS)) {
    if (def?.slot !== 2 || def.unlock?.type !== 'count') continue;
    const c = def.unlock.condition;
    if (!c?.category) continue;
    if (def.savedRight == null) def.savedRight = c.right;
    const live = sizes ? liveTarget(sizes, c.category, c.subcategory || null, def.rarity) : null;
    const next = Number.isFinite(live) && live >= 1 ? live : def.savedRight;
    if (next !== c.right) { c.right = next; moved++; }
  }
  return moved;
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

    case 'rank': {
      const rule = rankRule(condition.tier);
      if (!rule) return null;
      return condition.subjects > 1
        ? `Reach ${RANK_WORDS[condition.tier]} in ${condition.subjects} subjects`
        : rule;
    }

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
    const newLevel = computeWordLevel(wordDef, aggStats, profile,
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
 * Has this player earned their first rank (Caveman) anywhere? That is what
 * opens the Title Builder: 10 questions right in any one subject. No topic
 * sizes are needed, so this answers correctly even before they load.
 */
export function hasEarnedARank(stats) {
  const subjects = new Set((stats || []).map(s => s.category).filter(Boolean));
  for (const cat of subjects) {
    if (rightIn(stats, cat) >= SUBJECT_RULE.common.right) return true;
  }
  return false;
}

/** What one step of the rank ladder asks for, in a sentence a player can act on. */
export function rankRule(tier) {
  switch (tier) {
    case 'common':    return `Get ${SUBJECT_RULE.common.right} questions right in any subject`;
    case 'uncommon':  return `Get a quarter of any topic right (at most ${TOPIC_CAP.uncommon})`;
    case 'rare':      return `Get half of any topic right (at most ${TOPIC_CAP.rare})`;
    case 'epic':      return `Get three quarters of any topic right (at most ${TOPIC_CAP.epic})`;
    case 'legendary': return 'Get every question in a topic right';
    case 'mythic':    return 'Get every question in a subject right';
    default:          return null;
  }
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
