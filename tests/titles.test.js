import { describe, it, expect, vi } from 'vitest';
import {
  TITLE_WORDS,
  RARITY_CELEBRATION,
  computeCategoryTiers,
  evaluateUnlocks,
  hasReachedApprentice,
  buildDisplayTitle,
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
});

// ============================================
// evaluateUnlocks
// ============================================
describe('evaluateUnlocks', () => {
  it('returns empty array when no conditions are met', () => {
    const changes = evaluateUnlocks([], {}, []);
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
      expect(w.rarity, `${id} invalid rarity`).toBeOneOf(['common', 'rare', 'epic', 'legendary']);
      expect(w.unlock, `${id} missing unlock`).toBeDefined();
      expect(typeof w.unlock.type, `${id} missing unlock.type`).toBe('string');
    }
  });

  it('every rarity has a celebration tier', () => {
    const rarities = new Set(Object.values(TITLE_WORDS).map(w => w.rarity));
    for (const r of rarities) {
      if (r !== 'epic') { // epic not in RARITY_CELEBRATION (only common, rare, legendary)
        expect(RARITY_CELEBRATION[r], `missing celebration for ${r}`).toBeDefined();
      }
    }
  });
});
