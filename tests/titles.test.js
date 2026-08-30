import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TITLE_WORDS,
  RARITY_CELEBRATION,
  RARITY_ORDER,
  computeCategoryTiers,
  evaluateUnlocks,
  hasReachedApprentice,
  buildDisplayTitle,
  categoryRollupRows, rowProficiency, sumProficiency, rightIn, describeRequirement, applyWordOverlay, clearWordOverlay, overlayWordId,
  mergedCategoryRows,
  tierProgress,
  TIER_ORDER,
  planCelebration,
} from '../js/titles.js';

// ============================================
// computeCategoryTiers
// ============================================
describe('computeCategoryTiers', () => {
  it('returns empty object for null/empty stats', () => {
    expect(computeCategoryTiers(null)).toEqual({});
    expect(computeCategoryTiers([])).toEqual({});
  });

  it('ignores categories below MIN_QUESTIONS_FOR_TITLE (20)', () => {
    const stats = [{ category: 'history', questions_answered: 19, correct_answers: 19 }];
    expect(computeCategoryTiers(stats)).toEqual({});
  });

  it('returns Apprentice at the threshold boundary', () => {
    // score = accuracy * log2(questions_answered)
    // Need score >= 3.0. With 20 questions: log2(20) ≈ 4.32
    // accuracy needed: 3.0 / 4.32 ≈ 0.694 → 14/20 = 0.7 → score = 0.7 * 4.32 ≈ 3.02
    const stats = [{ category: 'history', questions_answered: 20, correct_answers: 14 }];
    expect(computeCategoryTiers(stats)).toEqual({ history: 'Apprentice' });
  });

  it('returns nothing when score is below Apprentice threshold', () => {
    // 10/20 = 0.5 accuracy, log2(20) ≈ 4.32, score ≈ 2.16 < 3.0
    const stats = [{ category: 'history', questions_answered: 20, correct_answers: 10 }];
    expect(computeCategoryTiers(stats)).toEqual({});
  });

  it('returns Scholar tier', () => {
    // Need score >= 4.5. With 40 questions: log2(40) ≈ 5.32
    // accuracy needed: 4.5 / 5.32 ≈ 0.846 → 34/40 = 0.85 → score ≈ 4.52
    const stats = [{ category: 'science', questions_answered: 40, correct_answers: 34 }];
    expect(computeCategoryTiers(stats)).toEqual({ science: 'Scholar' });
  });

  it('returns Master tier', () => {
    // Need score >= 5.5. With 60 questions: log2(60) ≈ 5.91
    // accuracy needed: 5.5 / 5.91 ≈ 0.931 → 56/60 ≈ 0.933 → score ≈ 5.51
    const stats = [{ category: 'nature', questions_answered: 60, correct_answers: 56 }];
    expect(computeCategoryTiers(stats)).toEqual({ nature: 'Master' });
  });

  it('returns Oracle tier for perfect high-volume', () => {
    // 200/200 = 1.0, log2(200) ≈ 7.64, score ≈ 7.64 >= 6.5
    const stats = [{ category: 'history', questions_answered: 200, correct_answers: 200 }];
    expect(computeCategoryTiers(stats)).toEqual({ history: 'Oracle' });
  });

  it('handles multiple categories independently', () => {
    const stats = [
      { category: 'history', questions_answered: 200, correct_answers: 200 },
      { category: 'science', questions_answered: 20, correct_answers: 10 },
      { category: 'nature', questions_answered: 20, correct_answers: 14 },
    ];
    const tiers = computeCategoryTiers(stats);
    expect(tiers.history).toBe('Oracle');
    expect(tiers.science).toBeUndefined(); // below Apprentice
    expect(tiers.nature).toBe('Apprentice');
  });

  it('stores subcategory tiers with "category:subcategory" key', () => {
    const stats = [
      { category: 'history', subcategory: 'ancient', questions_answered: 200, correct_answers: 200 },
    ];
    const tiers = computeCategoryTiers(stats);
    expect(tiers['history:ancient']).toBe('Oracle');
    expect(tiers.history).toBeUndefined(); // no top-level row
  });

  it('stores category-level tiers when subcategory is null', () => {
    const stats = [
      { category: 'history', subcategory: null, questions_answered: 200, correct_answers: 200 },
    ];
    expect(computeCategoryTiers(stats)).toEqual({ history: 'Oracle' });
  });

  // player_stats_computed emitted THREE rollup rows for Wild Card — null, ''
  // and undefined all read as "no subcategory" while staying separate rows.
  // mergedCategoryRows was written for the profile and this function was not
  // converted with it, so a tier — which gates every title unlock and every
  // lobby badge — was computed from one fragment of a split category.
  //
  // 60 questions met split three ways. Merged: 46/60 = 0.767, log2(60) ≈ 5.91,
  // score ≈ 4.53 → Scholar. Any ONE row alone: 15 or 16 of 20, log2(20) ≈ 4.32,
  // score ≈ 3.24–3.46 → Apprentice. So the answer differs, and which of the
  // three "won" was only ever whichever the view returned last.
  it('merges split rollup rows before deciding a tier', () => {
    const stats = [
      { category: 'wild-card', subcategory: null, questions_answered: 20, correct_answers: 15 },
      { category: 'wild-card', subcategory: '', questions_answered: 20, correct_answers: 15 },
      { category: 'wild-card', questions_answered: 20, correct_answers: 16 },
    ];
    expect(computeCategoryTiers(stats)).toEqual({ 'wild-card': 'Scholar' });
  });

  it('gives a tier at all when no single fragment reaches the volume gate', () => {
    // Three fragments of 12, none of which reaches MIN_QUESTIONS_FOR_TITLE (20),
    // so reading them one at a time returns NOTHING for somebody with 36
    // questions met at 92%.
    const stats = [
      { category: 'wild-card', subcategory: null, questions_answered: 12, correct_answers: 11 },
      { category: 'wild-card', subcategory: '', questions_answered: 12, correct_answers: 11 },
      { category: 'wild-card', subcategory: undefined, questions_answered: 12, correct_answers: 11 },
    ];
    expect(computeCategoryTiers(stats)['wild-card']).toBeTruthy();
  });

  it('still keeps subcategory rows apart — each is its own tier', () => {
    const stats = [
      { category: 'history', subcategory: 'ancient', questions_answered: 200, correct_answers: 200 },
      { category: 'history', subcategory: 'modern', questions_answered: 20, correct_answers: 10 },
    ];
    const tiers = computeCategoryTiers(stats);
    expect(tiers['history:ancient']).toBe('Oracle');
    expect(tiers['history:modern']).toBeUndefined();
  });
});

// ============================================
// evaluateUnlocks
// ============================================
describe('evaluateUnlocks', () => {
  it('returns empty array when no conditions are met', () => {
    // Pass hour: 12 to ensure nightOwl hidden unlock doesn't trigger
    const changes = evaluateUnlocks([], {}, [], { hour: 12 });
    expect(changes).toEqual([]);
  });

  it('unlocks mastery words when category tier is reached', () => {
    const stats = [{ category: 'history', questions_answered: 200, correct_answers: 200 }];
    const changes = evaluateUnlocks(stats, {}, []);
    const historyWord = changes.find(c => c.wordId === 'history');
    expect(historyWord).toBeDefined();
    expect(historyWord.isNew).toBe(true);
    expect(historyWord.word).toBe('History');
  });

  it('unlocks tier words (slot 3) when any category reaches that tier', () => {
    const stats = [{ category: 'science', questions_answered: 200, correct_answers: 200 }];
    const changes = evaluateUnlocks(stats, {}, []);
    const oracleWord = changes.find(c => c.wordId === 'oracle');
    expect(oracleWord).toBeDefined();
    expect(oracleWord.rarity).toBe('legendary');
  });

  it('detects upgrades (not new) when current level is lower', () => {
    const stats = [{ category: 'history', questions_answered: 200, correct_answers: 200 }];
    const currentUnlocks = [{ word_id: 'history', level: 1 }];
    const changes = evaluateUnlocks(stats, {}, currentUnlocks);
    const historyWord = changes.find(c => c.wordId === 'history');
    if (historyWord) {
      expect(historyWord.isNew).toBe(false);
      expect(historyWord.isUpgrade).toBe(true);
    }
  });

  it('skips words already at or above computed level', () => {
    const stats = [{ category: 'history', questions_answered: 20, correct_answers: 14 }];
    const currentUnlocks = [{ word_id: 'history', level: 3 }];
    const changes = evaluateUnlocks(stats, {}, currentUnlocks);
    const historyWord = changes.find(c => c.wordId === 'history');
    expect(historyWord).toBeUndefined();
  });

  it('unlocks milestone words based on aggregate stats', () => {
    // brave: 5 wins needed
    const stats = [
      { category: 'history', questions_answered: 20, correct_answers: 14, games_played: 10, wins: 6 },
    ];
    const changes = evaluateUnlocks(stats, {}, []);
    const brave = changes.find(c => c.wordId === 'brave');
    expect(brave).toBeDefined();
    expect(brave.word).toBe('Brave');
  });

  it('unlocks social words based on profile stats', () => {
    // popular: 100 honks received
    const profile = { honks_received: 150 };
    const changes = evaluateUnlocks([], profile, []);
    const popular = changes.find(c => c.wordId === 'popular');
    expect(popular).toBeDefined();
  });

  it('unlocks loyalty words based on account age', () => {
    // loyal: 30 days
    const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    const profile = { created_at: thirtyOneDaysAgo };
    const changes = evaluateUnlocks([], profile, []);
    const loyal = changes.find(c => c.wordId === 'loyal');
    expect(loyal).toBeDefined();
  });

  it('does not unlock loyalty words if account is too young', () => {
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const profile = { created_at: fiveDaysAgo };
    const changes = evaluateUnlocks([], profile, []);
    const loyal = changes.find(c => c.wordId === 'loyal');
    expect(loyal).toBeUndefined();
  });

  it('unlocks hidden nightOwl via context', () => {
    const changes = evaluateUnlocks([], {}, [], { hour: 3 });
    const phantom = changes.find(c => c.wordId === 'phantom');
    expect(phantom).toBeDefined();
    expect(phantom.rarity).toBe('legendary');
  });

  it('does not unlock nightOwl outside the hour range', () => {
    const changes = evaluateUnlocks([], {}, [], { hour: 12 });
    const phantom = changes.find(c => c.wordId === 'phantom');
    expect(phantom).toBeUndefined();
  });

  it('unlocks hidden perfectGame via context', () => {
    const changes = evaluateUnlocks([], {}, [], { perfectGame: true });
    const lucky = changes.find(c => c.wordId === 'lucky');
    expect(lucky).toBeDefined();
  });

  it('unlocks hidden perfectStreak via context', () => {
    const changes = evaluateUnlocks([], {}, [], { perfectStreak: 5 });
    const untouchable = changes.find(c => c.wordId === 'untouchable');
    expect(untouchable).toBeDefined();
  });

  it('does not unlock perfectStreak below threshold', () => {
    const changes = evaluateUnlocks([], {}, [], { perfectStreak: 4 });
    const untouchable = changes.find(c => c.wordId === 'untouchable');
    expect(untouchable).toBeUndefined();
  });

  it('unlocks contribution words based on profile', () => {
    // guardian: 10 questions flagged
    const profile = { questions_flagged: 12 };
    const changes = evaluateUnlocks([], profile, []);
    const guardian = changes.find(c => c.wordId === 'guardian');
    expect(guardian).toBeDefined();
  });

  it('unlocks oracleCategories (eternal slot 3) when enough categories reach Oracle', () => {
    const stats = [
      { category: 'history', questions_answered: 200, correct_answers: 200 },
      { category: 'science', questions_answered: 200, correct_answers: 200 },
      { category: 'nature', questions_answered: 200, correct_answers: 200 },
    ];
    const changes = evaluateUnlocks(stats, {}, []);
    // "eternal" in slot 3 requires oracleCategories: 3
    // Note: there are two "eternal" entries — slot 2 (history:modern Oracle) and slot 3 (oracleCategories: 3)
    // The slot 3 one should be unlocked
    const eternalSlot3 = changes.find(c => c.wordId === 'eternal' && TITLE_WORDS[c.wordId].slot === 3);
    expect(eternalSlot3).toBeDefined();
  });

  it('unlocks subcategory mastery words', () => {
    const stats = [
      { category: 'history', subcategory: 'ancient', questions_answered: 40, correct_answers: 34 },
    ];
    const changes = evaluateUnlocks(stats, {}, []);
    const chronicles = changes.find(c => c.wordId === 'chronicles');
    expect(chronicles).toBeDefined();
    expect(chronicles.word).toBe('Chronicles');
  });
});

// ============================================
// hasReachedApprentice
// ============================================
describe('hasReachedApprentice', () => {
  it('returns false for null/empty stats', () => {
    expect(hasReachedApprentice(null)).toBe(false);
    expect(hasReachedApprentice([])).toBe(false);
  });

  it('returns false when no category reaches Apprentice', () => {
    const stats = [{ category: 'history', questions_answered: 20, correct_answers: 5 }];
    expect(hasReachedApprentice(stats)).toBe(false);
  });

  it('returns true when any category reaches Apprentice', () => {
    const stats = [{ category: 'history', questions_answered: 20, correct_answers: 14 }];
    expect(hasReachedApprentice(stats)).toBe(true);
  });

  it('returns false when below MIN_QUESTIONS_FOR_TITLE', () => {
    const stats = [{ category: 'history', questions_answered: 19, correct_answers: 19 }];
    expect(hasReachedApprentice(stats)).toBe(false);
  });
});

// ============================================
// buildDisplayTitle
// ============================================
describe('buildDisplayTitle', () => {
  it('returns null for null profile', () => {
    expect(buildDisplayTitle(null)).toBe(null);
  });

  it('returns Novice when title builder not unlocked', () => {
    expect(buildDisplayTitle({ title_builder_unlocked: false })).toBe('Novice');
  });

  it('returns Novice when title builder unlocked but no slots set', () => {
    expect(buildDisplayTitle({
      title_builder_unlocked: true,
      title_slot1: null,
      title_slot2: null,
      title_slot3: null,
    })).toBe('Novice');
  });

  it('builds title from single slot', () => {
    expect(buildDisplayTitle({
      title_builder_unlocked: true,
      title_slot1: 'brave',
      title_slot2: null,
      title_slot3: null,
    })).toBe('Brave');
  });

  it('builds title from all three slots', () => {
    expect(buildDisplayTitle({
      title_builder_unlocked: true,
      title_slot1: 'brave',
      title_slot2: 'history',
      title_slot3: 'oracle',
    })).toBe('Brave History Oracle');
  });

  it('handles partial slots (slot 2 only)', () => {
    expect(buildDisplayTitle({
      title_builder_unlocked: true,
      title_slot1: null,
      title_slot2: 'science',
      title_slot3: null,
    })).toBe('Science');
  });

  it('falls back to raw ID for unknown word IDs', () => {
    expect(buildDisplayTitle({
      title_builder_unlocked: true,
      title_slot1: 'nonexistent',
      title_slot2: null,
      title_slot3: null,
    })).toBe('nonexistent');
  });
});

// ============================================
// TITLE_WORDS structure sanity
// ============================================
describe('TITLE_WORDS structure', () => {
  it('every word has required fields', () => {
    for (const [id, w] of Object.entries(TITLE_WORDS)) {
      expect(w.slot, `${id} missing slot`).toBeOneOf([1, 2, 3]);
      expect(typeof w.word, `${id} missing word`).toBe('string');
      expect(w.rarity, `${id} invalid rarity`).toBeOneOf(Object.keys(RARITY_ORDER));
      expect(w.unlock, `${id} missing unlock`).toBeDefined();
      expect(typeof w.unlock.type, `${id} missing unlock.type`).toBe('string');
    }
  });

  // THE LADDER GREW AND THREE OF ITS FOUR READERS DID NOT FOLLOW IT. When the
  // rebuild added uncommon, epic and mythic, the celebration table and both
  // sorts still listed the old three, and a missing key reads as rank 0 rather
  // than as an error — so in the Title Builder a mythic word sorted level with
  // a common. These two assertions are what make the next growth loud: add a
  // rarity to a word and forget a reader, and they name it.
  it('every rarity a word actually uses is on the ladder', () => {
    for (const r of new Set(Object.values(TITLE_WORDS).map(w => w.rarity))) {
      expect(RARITY_ORDER[r], `${r} is not on the rarity ladder`).toBeDefined();
    }
  });

  it('every rarity on the ladder has a celebration tier', () => {
    for (const r of Object.keys(RARITY_ORDER)) {
      expect(RARITY_CELEBRATION[r], `missing celebration for ${r}`).toBeDefined();
    }
  });

  it('celebrates a rarer word over a commoner one in the same batch', () => {
    const plan = planCelebration([
      { word: 'Cheap', rarity: 'common', isNew: true },
      { word: 'Dear', rarity: 'mythic', isNew: true },
    ]);
    expect(plan.lead.word).toBe('Dear');
    expect(plan.tier).toBe('fullscreen');
  });
});


// ============================================
// categoryRollupRows — the double-count guard
//
// player_stats_computed returns every number twice: a row per subcategory AND
// a rollup row (subcategory null) that already contains their sum. Anything
// that ADDS rows up has to take the rollups only.
//
// This went unnoticed for as long as it did because the view did not exist on
// the live database, so every one of those sums had only ever run over an
// empty array (CLAUDE.md #8).
// ============================================
describe('categoryRollupRows', () => {
  const rows = [
    { category: 'history', subcategory: null, questions_answered: 100, correct_answers: 80, games_played: 10, wins: 4 },
    { category: 'history', subcategory: 'ancient', questions_answered: 60, correct_answers: 50, games_played: 6, wins: 3 },
    { category: 'history', subcategory: 'medieval', questions_answered: 40, correct_answers: 30, games_played: 4, wins: 1 },
  ];

  it('keeps only the category-level rows', () => {
    expect(categoryRollupRows(rows).map(r => r.subcategory)).toEqual([null]);
  });

  it('treats undefined and empty-string subcategories as rollups', () => {
    // A row from a client-side fallback may carry no subcategory key at all.
    expect(categoryRollupRows([{ category: 'x' }, { category: 'y', subcategory: '' }])).toHaveLength(2);
  });

  it('survives null and undefined input', () => {
    expect(categoryRollupRows(null)).toEqual([]);
    expect(categoryRollupRows(undefined)).toEqual([]);
  });

  it('the rollup alone is the true total — summing every row doubles it', () => {
    const rollupOnly = categoryRollupRows(rows)
      .reduce((n, r) => n + r.games_played, 0);
    const everyRow = rows.reduce((n, r) => n + r.games_played, 0);
    expect(rollupOnly).toBe(10);
    expect(everyRow).toBe(20);   // what the five broken call sites were computing
  });
});

// ============================================
// Title unlocks must count games once, not twice
// ============================================
describe('evaluateUnlocks play-count milestones', () => {
  // 'fearless' unlocks at 50 games played.
  const gamesRow = (subcategory, games) =>
    ({ category: 'history', subcategory, questions_answered: 10, correct_answers: 5, games_played: games, wins: 0 });

  it('does not unlock a 50-game title on 30 real games', () => {
    // 30 real games. Counting the subcategory rows as well would reach 60 and
    // hand out a title the player has not earned.
    const stats = [
      gamesRow(null, 30),
      gamesRow('ancient', 20),
      gamesRow('medieval', 10),
    ];
    const changes = evaluateUnlocks(stats, {}, [], { hour: 12 });
    expect(changes.find(c => c.wordId === 'fearless')).toBeUndefined();
  });

  it('still unlocks it once the rollup itself reaches the threshold', () => {
    const stats = [gamesRow(null, 50), gamesRow('ancient', 50)];
    const changes = evaluateUnlocks(stats, {}, [], { hour: 12 });
    expect(changes.find(c => c.wordId === 'fearless')).toBeDefined();
  });
});


// ============================================
// rowProficiency / sumProficiency
//
// Proficiency counts QUESTIONS and lets the most recent result win, rather
// than being a lifetime hit rate over attempts. That is what makes a bad round
// recoverable: answer it wrong then right and the miss is gone. The old
// measure could only dilute a miss, never undo it.
//
// The fallback matters as much as the rule. Migration 040 is hand-applied, and
// before it runs the two new columns are simply absent — the app must behave
// exactly as it did rather than reading undefined and showing everybody 0%.
// ============================================
describe('rowProficiency', () => {
  it('counts questions known over questions met', () => {
    const p = rowProficiency({ questions_met: 10, questions_mastered: 7, questions_answered: 40, correct_answers: 9 });
    expect(p.met).toBe(10);
    expect(p.mastered).toBe(7);
    expect(p.accuracy).toBeCloseTo(0.7);
  });

  it('a miss corrected later leaves no trace', () => {
    // Same person, same one question: seen twice, right once, currently right.
    // The attempt rate says 50%; proficiency says they know it.
    const row = { questions_met: 1, questions_mastered: 1, questions_answered: 2, correct_answers: 1 };
    expect(rowProficiency(row).accuracy).toBe(1);
  });

  it('and forgetting later costs the mastery', () => {
    const row = { questions_met: 1, questions_mastered: 0, questions_answered: 2, correct_answers: 1 };
    expect(rowProficiency(row).accuracy).toBe(0);
  });

  it('falls back to the attempt counters before migration 040', () => {
    const p = rowProficiency({ questions_answered: 8, correct_answers: 6 });
    expect(p.met).toBe(8);
    expect(p.mastered).toBe(6);
    expect(p.accuracy).toBeCloseTo(0.75);
  });

  it('returns null when there is nothing to divide by', () => {
    expect(rowProficiency({ questions_met: 0, questions_mastered: 0 })).toBe(null);
    expect(rowProficiency(null)).toBe(null);
    expect(rowProficiency({})).toBe(null);
  });

  it('sums numerators and denominators, not percentages', () => {
    // 1/1 and 1/99 is 2/100, not the 50.5% an average of the two ratios gives.
    const p = sumProficiency([
      { questions_met: 1, questions_mastered: 1 },
      { questions_met: 99, questions_mastered: 1 },
    ]);
    expect(p.met).toBe(100);
    expect(p.mastered).toBe(2);
    expect(p.accuracy).toBeCloseTo(0.02);
  });
});

// calculateTitle lives in utils.js and duplicates the proficiency rule inline,
// because titles.js imports utils.js and the reverse would be a cycle. Two
// copies of one rule drift, so this pins them together.
describe('the auto-title maths agrees with rowProficiency', () => {
  it('ranks on questions known, not attempts', async () => {
    const { calculateTitle } = await import('../js/utils.js');
    // IDENTICAL attempt counters in both — 400 attempts, 200 right, a 50% hit
    // rate either way. Only the question-level verdicts differ: 180 of 200
    // currently known versus 90 of 200. A rule still ranking on attempts would
    // score these two the same and land them in the same tier.
    //
    // 200 met, chosen so the scores fall either side of a tier boundary rather
    // than both bottoming out at Apprentice, which is what the first version of
    // this test did — it passed nothing and proved nothing.
    const sharp = [{ category: 'history', questions_met: 200, questions_mastered: 180,
                     questions_answered: 400, correct_answers: 200 }];
    const blunt = [{ category: 'history', questions_met: 200, questions_mastered: 90,
                     questions_answered: 400, correct_answers: 200 }];
    const a = calculateTitle(sharp);
    const b = calculateTitle(blunt);
    expect(a.category).toBe('history');
    // Same attempts and same correct_answers in both; only the question-level
    // verdicts differ, so a rule that ignored them would return the same tier.
    expect(a.tier).not.toBe(b.tier);
  });
});

// ============================================
// mergedCategoryRows — one row per category, whatever the view emits
//
// The profile showed WILD CARD THREE TIMES. player_stats_computed is meant to
// emit one rollup per category — the row where subcategory is null — and it
// emitted three the app could not tell apart, because null, '' and undefined
// all read as "no subcategory" while remaining separate rows.
//
// Merging cannot under-report and is the identity when there is only one
// rollup, which is why it is the right answer rather than picking one of the
// three.
// ============================================
describe('mergedCategoryRows', () => {
  const row = (category, subcategory, met, mastered, games = 0) =>
    ({ category, subcategory, questions_met: met, questions_mastered: mastered, games_played: games });

  it('collapses several falsy-subcategory rows for one category into one', () => {
    const merged = mergedCategoryRows([
      row('wild-card', null, 10, 5, 1),
      row('wild-card', '', 6, 3, 2),
      row('wild-card', undefined, 4, 1, 1),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].category).toBe('wild-card');
    expect(merged[0].questions_met).toBe(20);
    expect(merged[0].questions_mastered).toBe(9);
    expect(merged[0].games_played).toBe(4);
  });

  it('leaves a single rollup per category untouched', () => {
    const stats = [row('history', null, 12, 9), row('science', null, 4, 1)];
    const merged = mergedCategoryRows(stats);
    expect(merged).toHaveLength(2);
    expect(merged.map(m => m.questions_met).sort((a, b) => a - b)).toEqual([4, 12]);
  });

  it('ignores subcategory rows entirely, which are counted elsewhere', () => {
    const merged = mergedCategoryRows([
      row('history', null, 10, 5),
      row('history', 'ancient', 6, 3),
      row('history', 'medieval', 4, 2),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].questions_met).toBe(10);
  });

  it('copes with nothing', () => {
    expect(mergedCategoryRows([])).toEqual([]);
    expect(mergedCategoryRows(null)).toEqual([]);
  });

  // The totals on the profile card run over these rows. Three wild-card rows
  // meant games, wins and questions were all inflated, not just the list.
  it('does not multiply a category into the totals', () => {
    const merged = mergedCategoryRows([
      row('wild-card', null, 10, 5, 3),
      row('wild-card', '', 0, 0, 0),
      row('wild-card', null, 0, 0, 0),
    ]);
    const totalGames = merged.reduce((s, r) => s + (r.games_played || 0), 0);
    expect(totalGames).toBe(3);
  });
});

// ============================================
// tierProgress — where you stand, and what it takes to move up
//
// A rank is accuracy x log2(questions met) against fixed thresholds. That is
// a defensible rule and completely unguessable from outside: the owner asked
// where their ranks were and how to improve them, and nothing in the app
// answered either. A progression nobody can see is not a progression.
// ============================================
describe('tierProgress', () => {
  const row = (met, mastered) => ({ questions_met: met, questions_mastered: mastered });

  it('says nothing when there is nothing to say', () => {
    expect(tierProgress(null)).toBe(null);
    expect(tierProgress({})).toBe(null);
    expect(tierProgress(row(0, 0))).toBe(null);
  });

  // Below the volume gate there is NO rank at any accuracy. Three perfect
  // answers is not a rank, and telling somebody they are close on accuracy
  // alone would be a lie they then fail to cash in.
  it('gives no rank below the question minimum, however perfect', () => {
    const p = tierProgress(row(3, 3));
    expect(p.tier).toBe(null);
    expect(p.next).toBe('Apprentice');
    expect(p.met).toBe(3);
    expect(p.required).toBe(20);
    // 17 more gets them to 20 questions AND over the threshold.
    expect(p.needed).toBe(17);
  });

  it('counts the volume gate alone when accuracy is already enough', () => {
    expect(tierProgress(row(19, 19)).needed).toBe(1);
  });

  it('reports the rank held and the one above it', () => {
    const p = tierProgress(row(20, 20));
    expect(p.tier).toBe('Apprentice');
    expect(p.next).toBe('Scholar');
    expect(p.needed).toBe(3);
  });

  it('asks for more when accuracy is lower', () => {
    const strong = tierProgress(row(20, 20));
    const weaker = tierProgress(row(20, 15));
    expect(weaker.tier).toBe('Apprentice');
    expect(weaker.needed).toBeGreaterThan(strong.needed);
  });

  it('gives no rank when the score is under the first threshold', () => {
    const p = tierProgress(row(20, 8));
    expect(p.tier).toBe(null);
    expect(p.next).toBe('Apprentice');
    expect(p.needed).toBeGreaterThan(0);
  });

  it('stops at the top', () => {
    const p = tierProgress(row(100, 100));
    expect(p.tier).toBe('Oracle');
    expect(p.next).toBe(null);
    expect(p.needed).toBe(0);
  });

  // The number has to be one a player can actually act on. If it were an
  // approximation they would answer that many and not move, which is worse
  // than saying nothing.
  it('the count it gives actually reaches the next rank', () => {
    for (const [met, mastered] of [[20, 20], [20, 15], [20, 8], [30, 22], [50, 31]]) {
      const p = tierProgress(row(met, mastered));
      if (!p.next || p.needed == null) continue;
      const after = tierProgress(row(met + p.needed, mastered + p.needed));
      const reached = after.tier;
      expect(reached, `${met}/${mastered} +${p.needed} reached ${reached}, wanted ${p.next}`).toBeTruthy();
      expect(TIER_ORDER.indexOf(reached)).toBeGreaterThanOrEqual(TIER_ORDER.indexOf(p.next));
    }
  });

  it('one fewer than it asks for is not enough', () => {
    const p = tierProgress(row(20, 20));
    const justShort = tierProgress(row(20 + p.needed - 1, 20 + p.needed - 1));
    expect(justShort.tier).toBe('Apprentice');
  });
});

// ============================================
// planCelebration — one celebration per batch, scaled to rarity
//
// Unlocking a title was a console.debug line for as long as the title system
// has existed, so every reward in the game was invisible at the moment it was
// earned. RARITY_CELEBRATION had been written, exported, and wired to nothing
// — which is also why nobody noticed it had no entry for 'epic', though three
// words carry that rarity.
// ============================================
describe('planCelebration', () => {
  const u = (word, rarity, extra = {}) =>
    ({ wordId: word.toLowerCase(), word, rarity, level: 1, isNew: true, isUpgrade: false, ...extra });

  it('says nothing when nothing was unlocked', () => {
    expect(planCelebration([])).toBe(null);
    expect(planCelebration(null)).toBe(null);
    expect(planCelebration([{ rarity: 'common' }])).toBe(null); // no word — nothing to show
  });

  it('scales the tier to the rarity', () => {
    expect(planCelebration([u('Brave', 'common')]).tier).toBe('toast');
    expect(planCelebration([u('Mighty', 'rare')]).tier).toBe('results');
    expect(planCelebration([u('Phantom', 'legendary')]).tier).toBe('fullscreen');
  });

  // Antiquity, Dynasty and Revolution are epic, and the table had no key for
  // them, so every lookup returned undefined and they would have celebrated as
  // nothing at all.
  it('handles epic, which the table used to have no entry for', () => {
    expect(planCelebration([u('Antiquity', 'epic')]).tier).toBe('fullscreen');
  });

  // This case used 'mythic' as its example of an unknown rarity, which was
  // true and should have been alarming: mythic is a real tier that twelve
  // words in the game carry, and the table had no entry for it. The example
  // has to be a rarity that genuinely does not exist, or the test quietly
  // asserts that a real reward celebrates as nothing.
  it('falls back to the quietest tier for a rarity it does not know', () => {
    expect(planCelebration([u('Odd', 'nonsense')]).tier).toBe('toast');
  });

  it('gives the whole of a subject the loudest celebration there is', () => {
    expect(planCelebration([u('Whole', 'mythic')]).tier).toBe('fullscreen');
  });

  // ONE celebration for the batch. Reaching Apprentice in a category can trip
  // several commons at once, and six overlays in a row is a queue to dismiss
  // rather than a reward.
  it('gives one celebration for a batch, led by the rarest', () => {
    const plan = planCelebration([
      u('Brave', 'common'), u('Phantom', 'legendary'), u('Mighty', 'rare'),
    ]);
    expect(plan.tier).toBe('fullscreen');
    expect(plan.lead.word).toBe('Phantom');
    expect(plan.count).toBe(3);
    expect(plan.others).toHaveLength(2);
  });

  it('leads with a brand-new word over an upgrade of the same rarity', () => {
    const plan = planCelebration([
      u('Brave', 'rare', { isNew: false, isUpgrade: true, level: 2 }),
      u('Mighty', 'rare'),
    ]);
    expect(plan.lead.word).toBe('Mighty');
  });

  it('keeps the level on an upgrade, so the card can say so', () => {
    const plan = planCelebration([u('Brave', 'common', { isNew: false, isUpgrade: true, level: 3 })]);
    expect(plan.lead.isUpgrade).toBe(true);
    expect(plan.lead.level).toBe(3);
  });
});

// ============================================
// NO WORD MAY BE DEFINED TWICE
//
// TITLE_WORDS is a plain object literal, so two entries sharing a key is not an
// error — the later one silently REPLACES the earlier, and the earlier word
// ceases to exist. That happened: `eternal` was defined in slot 2 and again in
// slot 3, and the slot 2 version (a legendary, the top reward for modern
// history) could never be earned by anyone. Nothing failed, nothing logged, and
// the gallery simply showed one fewer card than the file describes.
//
// THIS HAS TO READ THE SOURCE. By the time the module is imported the duplicate
// is already gone — the object holds one entry and looks perfectly healthy — so
// no check against TITLE_WORDS could ever see it. Same reason
// tests/phase-guards.test.js reads js/game/ as text.
// ============================================
describe('the word list itself', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'js', 'titles.js'), 'utf8');
  const keys = [...src.matchAll(/^ {2}([a-zA-Z_][\w]*):\s*\{\s*$/gm)].map(m => m[1]);

  it('found the entries it is meant to be checking', () => {
    // A GUARD ON THE GUARD. If the file is reformatted and this pattern stops
    // matching, every assertion below would pass over an empty list and report a
    // clean bill of health for any amount of duplication.
    expect(keys.length).toBeGreaterThanOrEqual(30);
    expect(keys).toContain('eternalModern');
  });

  it('defines no key twice', () => {
    const seen = new Set();
    const duplicated = keys.filter(k => seen.size === seen.add(k).size);
    expect(duplicated, 'these silently overwrite an earlier word, which then cannot be earned').toEqual([]);
  });

  it('every key in the source survives into the exported object', () => {
    // The other half of the same fault: a key present in the file but missing
    // from TITLE_WORDS means something ate it.
    const missing = keys.filter(k => !TITLE_WORDS[k]);
    expect(missing).toEqual([]);
    expect(Object.keys(TITLE_WORDS).length).toBe(keys.length);
  });
});

// ============================================
// COUNT-BASED UNLOCKS
//
// The rule the title rebuild moves to: questions you currently GET RIGHT in a
// topic, against a frozen target. See "The agreed shape of titles" in CLAUDE.md.
// ============================================
describe('count-based unlocks', () => {
  const stats = [
    // A rollup row per category AND a row per subcategory — exactly what
    // player_stats_computed emits, including the double-counting trap.
    { category: 'history', subcategory: null,      questions_met: 140, questions_mastered: 73 },
    { category: 'history', subcategory: 'ancient', questions_met: 60,  questions_mastered: 31 },
    { category: 'history', subcategory: 'modern',  questions_met: 80,  questions_mastered: 42 },
    { category: 'science', subcategory: null,      questions_met: 20,  questions_mastered: 8 },
  ];

  it('reads one topic', () => {
    expect(rightIn(stats, 'history', 'ancient')).toBe(31);
    expect(rightIn(stats, 'history', 'modern')).toBe(42);
  });

  // THE DOUBLE-COUNT TRAP. The rollup already contains the subcategories, so
  // adding every row gives 73 + 31 + 42 = 146 for somebody who knows 73.
  it('takes the rollup for a whole subject, never the sum of everything', () => {
    expect(rightIn(stats, 'history')).toBe(73);
  });

  it('is zero for a subject never played', () => {
    expect(rightIn(stats, 'food')).toBe(0);
    expect(rightIn(stats, 'history', 'medieval')).toBe(0);
  });

  it('awards a word when the count reaches the frozen target', () => {
    const word = {
      slot: 2, word: 'Chronicles', rarity: 'uncommon', hint: null,
      unlock: { type: 'count', condition: { category: 'history', subcategory: 'ancient', right: 28 } },
    };
    const before = { ...TITLE_WORDS };
    try {
      TITLE_WORDS.__test_count = word;
      const got = evaluateUnlocks(stats, {}, [], {});
      expect(got.find(c => c.wordId === '__test_count')?.level).toBe(1);
    } finally {
      delete TITLE_WORDS.__test_count;
      Object.assign(TITLE_WORDS, before);
    }
  });

  it('withholds it when the count falls short', () => {
    const word = {
      slot: 2, word: 'Antiquity', rarity: 'epic', hint: null,
      unlock: { type: 'count', condition: { category: 'history', subcategory: 'ancient', right: 45 } },
    };
    try {
      TITLE_WORDS.__test_short = word;
      const got = evaluateUnlocks(stats, {}, [], {});
      expect(got.find(c => c.wordId === '__test_short')).toBeUndefined();
    } finally {
      delete TITLE_WORDS.__test_short;
    }
  });

  // ONCE EARNED, KEPT FOREVER. A count CAN fall — get wrong something you used
  // to know — and a collectible that evaporates for forgetting one question is
  // a bad collectible. evaluateUnlocks only ever reports INCREASES, so nothing
  // downstream is ever told to take a word away.
  it('never reports a word going backwards', () => {
    const word = {
      slot: 2, word: 'Chronicles', rarity: 'uncommon', hint: null,
      unlock: { type: 'count', condition: { category: 'history', subcategory: 'ancient', right: 28 } },
    };
    try {
      TITLE_WORDS.__test_keep = word;
      const poorer = stats.map(s =>
        s.subcategory === 'ancient' ? { ...s, questions_mastered: 2 } : s);
      const got = evaluateUnlocks(poorer, {}, [{ word_id: '__test_keep', level: 1 }], {});
      expect(got.find(c => c.wordId === '__test_keep')).toBeUndefined();
    } finally {
      delete TITLE_WORDS.__test_keep;
    }
  });
});

describe('describing what a word requires', () => {
  const label = k => ({ ancient: 'Ancient History', history: 'History' }[k] || k);

  it('states a count plainly', () => {
    expect(describeRequirement({
      unlock: { type: 'count', condition: { category: 'history', subcategory: 'ancient', right: 28 } },
    }, label)).toBe('Get 28 questions right in Ancient History');
  });

  it('handles the milestone family', () => {
    expect(describeRequirement({ unlock: { type: 'milestone', condition: { stat: 'wins', value: 5 } } }))
      .toBe('Win 5 games');
    expect(describeRequirement({ unlock: { type: 'contribution', condition: { stat: 'questionsFlagged', value: 10 } } }))
      .toBe('Report 10 bad questions');
  });

  // A SECRET STAYS SECRET. Returning a blank string here would render an empty
  // line that reads as a bug; null lets the caller say "secret" instead.
  it('says nothing about a secret', () => {
    expect(describeRequirement({ unlock: { type: 'hidden', condition: { stat: 'nightOwl' } } })).toBeNull();
  });

  it('describes the legacy rank words without pretending they are clear', () => {
    expect(describeRequirement({
      unlock: { type: 'mastery', condition: { anyCategory: 'Scholar' } },
    })).toBe('Reach Scholar in any subject');
  });

  // EVERY REAL WORD MUST SAY SOMETHING, or the gallery goes back to being a
  // wall of blanks. The only exceptions are the three deliberate secrets.
  it('covers every word in the game', () => {
    const silent = Object.entries(TITLE_WORDS)
      .filter(([, w]) => w.hint !== null && describeRequirement(w) === null)
      .map(([id]) => id);
    expect(silent).toEqual([]);
  });
});

describe('owner-written words from the database', () => {
  afterEach(() => clearWordOverlay());
  const row = (sub, tier, word, target) => ({
    category: 'science', subcategory: sub, tier, word, target_right: target,
  });

  it('adds a word at a slot that exists', () => {
    expect(applyWordOverlay([row('space', 'uncommon', 'Starbound', 22)])).toBe(1);
    const id = overlayWordId('science', 'space', 'uncommon');
    expect(TITLE_WORDS[id].word).toBe('Starbound');
    expect(describeRequirement(TITLE_WORDS[id])).toBe('Get 22 questions right in space');
  });

  // THE TARGET IS THE ROW'S, NOT RECOMPUTED. It was frozen when the owner wrote
  // the word, so growing the bank can never move somebody's goal further away.
  // Recomputing here would also cost about fifty counting requests on every
  // profile load, for a number that is not allowed to change.
  it('takes the frozen target from the row', () => {
    applyWordOverlay([row('space', 'uncommon', 'Starbound', 22)]);
    const id = overlayWordId('science', 'space', 'uncommon');
    expect(TITLE_WORDS[id].unlock.condition.right).toBe(22);

    // The same slot rewritten at a different target keeps the new one: the
    // owner re-freezing is a deliberate act, and this is how it lands.
    applyWordOverlay([row('space', 'uncommon', 'Starbound', 35)]);
    expect(TITLE_WORDS[id].unlock.condition.right).toBe(35);
  });

  // A ROW WITH NO USABLE TARGET IS IGNORED, not rendered as an unearnable card.
  // A word nobody can earn is the exact promise this system must never make.
  it('ignores a row with no usable target', () => {
    expect(applyWordOverlay([
      row('space', 'legendary', 'Nope', null),
      row('space', 'legendary', 'Nope', 0),
      { category: 'science', subcategory: 'space', tier: 'epic', word: 'Nope' },
    ])).toBe(0);
  });

  it('ignores blank text and a missing category', () => {
    expect(applyWordOverlay([
      row(null, 'common', '   ', 10),
      { category: '', tier: 'common', word: 'Orphan', target_right: 10 },
    ])).toBe(0);
  });

  it('clears cleanly and leaves the code words alone', () => {
    const before = Object.keys(TITLE_WORDS).length;
    applyWordOverlay([row('space', 'epic', 'Voidwise', 65)]);
    expect(Object.keys(TITLE_WORDS).length).toBe(before + 1);
    clearWordOverlay();
    expect(Object.keys(TITLE_WORDS).length).toBe(before);
    expect(TITLE_WORDS.history).toBeDefined();
  });

  // THE ID MUST NOT DEPEND ON THE TEXT, or correcting a typo would take the
  // word away from everybody who had already earned it.
  it('keeps the same id when the word is rewritten', () => {
    applyWordOverlay([row('space', 'uncommon', 'Starbound', 22)]);
    const id = overlayWordId('science', 'space', 'uncommon');
    applyWordOverlay([row('space', 'uncommon', 'Stellar', 22)]);
    expect(TITLE_WORDS[id].word).toBe('Stellar');
    expect(Object.keys(TITLE_WORDS).filter(k => k.startsWith('w:science:space:uncommon')).length).toBe(1);
  });

  // A SUBJECT WORD AND A TOPIC WORD ARE DIFFERENT SLOTS even at the same tier,
  // because a null subcategory is its own slot. Collapsing them would let one
  // silently overwrite the other.
  it('keeps a subject word and a topic word apart', () => {
    applyWordOverlay([
      row(null, 'common', 'Science', 10),
      row('space', 'common', 'Orbital', 10),
    ]);
    expect(TITLE_WORDS[overlayWordId('science', null, 'common')].word).toBe('Science');
    expect(TITLE_WORDS[overlayWordId('science', 'space', 'common')].word).toBe('Orbital');
  });
});
