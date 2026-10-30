import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TITLE_WORDS,
  RARITY_CELEBRATION,
  RARITY_ORDER,
  evaluateUnlocks,
  hasEarnedARank, subjectRanks, rankIndexBySubject, rankRule,
  buildDisplayTitle,
  categoryRollupRows, rowProficiency, sumProficiency, rightIn, describeRequirement, applyWordOverlay, clearWordOverlay, overlayWordId, applyLiveTargets,
  mergedCategoryRows,
  planCelebration,
} from '../js/titles.js';

// ============================================
// computeCategoryTiers
// ============================================

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

  // THE RANK LADDER (owner, 2026-10-30): a rank word is the step of the same
  // name reached in ANY subject; Eternal is Oracle (Mythic) in three.
  const SIZES = {
    science: { subjectSize: 300, sizes: { 'human-body': 151, elements: 103, space: 86 } },
    history: { subjectSize: 40, sizes: {} },
    nature:  { subjectSize: 40, sizes: {} },
    food:    { subjectSize: 40, sizes: {} },
  };
  const row = (category, subcategory, right) =>
    ({ category, subcategory, questions_met: right, questions_mastered: right });

  it('unlocks Caveman at 10 right in a subject, and nothing above it', () => {
    const changes = evaluateUnlocks([row('science', null, 10)], {}, [], { hour: 12, sizes: SIZES });
    const ids = changes.map(c => c.wordId);
    expect(ids).toContain('caveman');
    expect(ids).not.toContain('hermit');
  });

  it('unlocks Hermit at a quarter of one topic (capped at 25)', () => {
    const stats = [row('science', null, 30), row('science', 'human-body', 25)];
    const ids = evaluateUnlocks(stats, {}, [], { hour: 12, sizes: SIZES }).map(c => c.wordId);
    expect(ids).toEqual(expect.arrayContaining(['caveman', 'hermit']));
    expect(ids).not.toContain('hippie');
  });

  it('unlocks Oracle only for the whole subject, and Eternal only in three', () => {
    const twoSubjects = [row('history', null, 40), row('nature', null, 40)];
    let ids = evaluateUnlocks(twoSubjects, {}, [], { hour: 12, sizes: SIZES }).map(c => c.wordId);
    expect(ids).toContain('oracle');
    expect(ids.filter(id => id === 'eternal')).toEqual([]);
    ids = evaluateUnlocks([...twoSubjects, row('food', null, 40)], {}, [], { hour: 12, sizes: SIZES }).map(c => c.wordId);
    expect(ids).toContain('eternal');
  });

  it('the old Apprentice / Scholar / Master words are gone', () => {
    for (const id of ['apprentice', 'scholar', 'master']) expect(TITLE_WORDS[id]).toBeUndefined();
    expect(Object.values(TITLE_WORDS).filter(w => w.unlock?.type === 'mastery')).toEqual([]);
  });

  it('the Title Builder opens at the first rank — 10 right in any one subject', () => {
    expect(hasEarnedARank([])).toBe(false);
    expect(hasEarnedARank([row('science', null, 9)])).toBe(false);
    expect(hasEarnedARank([row('science', null, 10)])).toBe(true);
  });

  it('a subject the player has never touched has no rank, not a zero', () => {
    const ranks = rankIndexBySubject([row('science', null, 12)], SIZES);
    expect(ranks.science).toBe(0);
    expect(ranks.history).toBe(-1);
    expect(subjectRanks([row('science', null, 12)], SIZES).science.next).toEqual({ tier: 'uncommon', needed: 22 });
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

  // THIS TEST USED TO ASSERT THE BUG, and it read as a deliberate design:
  // "falls back to raw ID for unknown word IDs". The raw id is a slot key, so
  // what it pinned was a player being shown to the whole lobby as
  // "w:science::rare".
  //
  // Not a hypothetical fallback either — owner-written words do not exist in
  // TITLE_WORDS until applyWordOverlay has run, and initAuth builds and caches
  // this title before that fetch. Every page load, for every written word.
  //
  // A test that describes the wrong behaviour confidently is worse than no test:
  // it is why the fix looked like a regression rather than a repair.
  it('drops an unknown word rather than printing its id', () => {
    expect(buildDisplayTitle({
      title_builder_unlocked: true,
      title_slot1: 'nonexistent',
      title_slot2: null,
      title_slot3: null,
    })).toBe('Novice');
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

  it('describes each rank by its rule, and Eternal by its count', () => {
    expect(describeRequirement(TITLE_WORDS.caveman)).toBe('Get 10 questions right in any subject');
    expect(describeRequirement(TITLE_WORDS.hippie)).toBe('Get half of any topic right (at most 100)');
    expect(describeRequirement(TITLE_WORDS.oracle)).toBe('Get every question in a subject right');
    expect(describeRequirement(TITLE_WORDS.eternal)).toBe('Reach Oracle in 3 subjects');
    expect(rankRule('nonsense')).toBeNull();
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

  // AN OWNER-WRITTEN WORD IS NOT A SECRET, and the gallery decided that from
  // `!word.hint` until 2026-08-30. The overlay gives written words `hint: ''`
  // because their requirement is stated outright, and an empty string is falsy
  // — so the moment the owner filled the framework, all ~86 of their words
  // would have rendered as "?" / "Find it yourself".
  //
  // The rule the screen uses is "can we DESCRIBE it", which cannot make that
  // mistake. This pins both halves of it.
  it('is never mistaken for a secret, however empty its hint is', () => {
    applyWordOverlay([row('space', 'epic', 'Voidwise', 65)]);
    const w = TITLE_WORDS[overlayWordId('science', 'space', 'epic')];
    expect(w.hint, 'the overlay still writes an empty hint').toBe('');
    expect(describeRequirement(w), 'a written word must always say what it needs').toBeTruthy();
    expect(!describeRequirement(w) && !w.hint, 'would render as a secret').toBe(false);
  });

  it('still treats a genuinely hidden word as a secret', () => {
    const w = TITLE_WORDS.phantom;
    expect(w.hint).toBeNull();
    expect(describeRequirement(w)).toBeNull();
    expect(!describeRequirement(w) && !w.hint, 'phantom must stay a secret').toBe(true);
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

// ============================================
// WHAT THE CELEBRATION SAYS IT WAS FOR
//
// The card used to show only the word. That is the complaint the owner has
// raised about this system more than any other — they could not tell what any
// word was for — and it bites hardest on the SIGN-IN path, which fires on
// arrival with no game behind it. A word appearing on the front page out of
// nowhere is the least explicable moment in the app.
//
// Two things must NOT get a reason, and both are easy to break by widening the
// line that adds one.
// ============================================
describe('the celebration explains itself', () => {
  let showCelebration;
  beforeAll(async () => {
    ({ showCelebration } = await import('../js/celebration.js'));
  });
  afterEach(() => { document.getElementById('title-celebration')?.remove(); });

  const show = u => {
    showCelebration(planCelebration([u]));
    return document.getElementById('title-celebration')?.textContent || '';
  };

  it('says what earned a first unlock', () => {
    const text = show({ wordId: 'science', word: 'Science', rarity: 'common', level: 1, isNew: true });
    expect(text).toContain('Science');
    expect(text).toMatch(/10 questions right/i);
  });

  // A SECRET STAYS SECRET. Spoiling it at the moment it lands takes the whole
  // point of it away, and describeRequirement returning null is what says so.
  it('says nothing for a secret', () => {
    const w = TITLE_WORDS.phantom;
    expect(w.hint, 'phantom is meant to be a secret').toBeNull();
    expect(describeRequirement(w)).toBeNull();
    const text = show({ wordId: 'phantom', word: 'Phantom', rarity: w.rarity, level: 1, isNew: true });
    expect(text).toContain('Phantom');
    expect(text).not.toMatch(/midnight|between/i);
  });

  // AN UPGRADE MUST NOT SHOW THE BASE REQUIREMENT. describeRequirement states
  // the level-1 condition, and a level is a multiple of it — so a Level 2 card
  // reading "Win 10 games in a row" describes something the player passed a
  // while ago. Saying nothing is better than saying something false.
  it('says nothing for an upgrade, because the base requirement is not what happened', () => {
    expect(describeRequirement(TITLE_WORDS.relentless)).toMatch(/10 games/i);
    const text = show({ wordId: 'relentless', word: 'Relentless', rarity: 'rare', level: 2, isUpgrade: true });
    expect(text).toContain('Relentless');
    expect(text).toContain('Level 2');
    expect(text).not.toMatch(/10 games/i);
  });
});

// ============================================
// EDITING A WORD THAT IS ALREADY IN USE
//
// The owner asked directly: is it safe to change a title somebody is wearing?
// It is, and this pins WHY — the unlock key is the SLOT (w:category:sub:tier),
// which carries no text, so renaming the word keeps it for everybody who earned
// it. That is what makes placeholders safe to ship at all.
//
// The same question found the dangerous half. An owner-written word does not
// exist in TITLE_WORDS until applyWordOverlay has run, and initAuth builds and
// CACHES the display title before that fetch — so on every page load an
// owner-written word resolved to nothing. The old fallback printed the raw id,
// and that cached string is copied onto the players row and read by the whole
// lobby for a game. Invisible while title_words is empty; certain the moment
// the owner writes one.
// ============================================
describe('editing a title word that is already in use', () => {
  const id = overlayWordId('science', null, 'rare');
  const wearer = { title_builder_unlocked: true, title_slot1: null, title_slot2: id, title_slot3: null };
  const row = (word) => ([{
    id: 'r1', slot: 2, category: 'science', subcategory: null, tier: 'rare',
    word, target_right: 100, is_placeholder: false,
  }]);

  afterEach(() => clearWordOverlay());

  it('keeps the unlock when the owner renames the word', () => {
    applyWordOverlay(row('Luminous'));
    expect(buildDisplayTitle(wearer)).toBe('Luminous');
    // A rename is a delete and an insert, so the DATABASE row id changes. The
    // slot key must not.
    clearWordOverlay();
    applyWordOverlay(row('Radiant'));
    expect(buildDisplayTitle(wearer)).toBe('Radiant');
    expect(overlayWordId('science', null, 'rare')).toBe(id);
  });

  it('never prints a slot key as somebody’s title', () => {
    // Before the overlay loads, which is every page boot.
    expect(buildDisplayTitle(wearer)).not.toContain('w:');
    expect(buildDisplayTitle(wearer)).toBe('Novice');
    // And after the owner deletes a word somebody is wearing.
    applyWordOverlay(row('Luminous'));
    clearWordOverlay();
    expect(buildDisplayTitle(wearer)).not.toContain('w:');
  });

  it('drops only the part it cannot resolve, keeping the rest', () => {
    // A title is up to three words. One unresolved word must not take the
    // other two down with it — that would turn a missing word into a lost
    // title.
    applyWordOverlay(row('Luminous'));
    const mixed = {
      title_builder_unlocked: true,
      title_slot1: 'brave',              // defined in code
      title_slot2: id,                   // from the overlay
      title_slot3: 'w:nope::mythic',     // does not exist
    };
    const text = buildDisplayTitle(mixed);
    expect(text).toContain('Luminous');
    expect(text).not.toContain('w:');
  });
});


// GOALS FOLLOW THE TOPIC'S SIZE TODAY (owner, 2026-10-30), and the number saved
// with a word is only the fallback for when the sizes cannot be read.
describe('live goals', () => {
  afterEach(() => { applyLiveTargets(null); clearWordOverlay(); });
  const row = { slot: 2, category: 'science', subcategory: 'human-body', tier: 'rare', word: 'Pulse', target_right: 40 };
  const sizesAt = n => ({ science: { subjectSize: n + 100, sizes: { 'human-body': n } } });
  const goal = () => TITLE_WORDS[overlayWordId('science', 'human-body', 'rare')].unlock.condition.right;

  it('moves the goal with the topic, capped', () => {
    applyWordOverlay([row]);
    applyLiveTargets(sizesAt(151));
    expect(goal()).toBe(76);
    applyLiveTargets(sizesAt(400));
    expect(goal()).toBe(100);
  });

  it('falls back to the saved goal when sizes are unknown', () => {
    applyWordOverlay([row]);
    applyLiveTargets(sizesAt(151));
    applyLiveTargets(null);
    expect(goal()).toBe(40);
  });

  it('keeps a code word on its saved goal when its topic is under the floor', () => {
    const chronicles = Object.values(TITLE_WORDS).find(w => w.word === 'Chronicles');
    const saved = chronicles.unlock.condition.right;
    applyLiveTargets({ history: { subjectSize: 700, sizes: { ancient: 58 } } });
    expect(chronicles.unlock.condition.right).toBe(saved);
  });
});
