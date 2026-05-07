import { describe, it, expect } from 'vitest';
import {
  computeScoreEarned,
  findNextAvailableWager,
  tallyDifficultyVotes,
  computeScoresFromAnswers,
  buildDisqualifiedSet,
  buildUsedWagersMap,
  modalDifficulty,
  pickWeightedDifficulty,
} from '../js/game/scoring-helpers.js';

// ============================================
// computeScoreEarned
// ============================================
describe('computeScoreEarned', () => {
  it('awards wager points for correct regular answer', () => {
    expect(computeScoreEarned(true, 5, false)).toBe(5);
  });

  it('awards zero for incorrect regular answer', () => {
    expect(computeScoreEarned(false, 5, false)).toBe(0);
  });

  it('awards wager points for correct final wager', () => {
    expect(computeScoreEarned(true, 20, true)).toBe(20);
  });

  it('deducts wager points for incorrect final wager', () => {
    expect(computeScoreEarned(false, 20, true)).toBe(-20);
  });

  it('returns zero for zero wager regardless of correctness', () => {
    expect(computeScoreEarned(true, 0, false)).toBe(0);
    expect(computeScoreEarned(false, 0, true)).toBe(-0); // -0 in JS (0 wager negated)
  });
});

// ============================================
// findNextAvailableWager
// ============================================
describe('findNextAvailableWager', () => {
  it('returns 1 when no wagers are used', () => {
    expect(findNextAvailableWager(new Map(), 5)).toBe(1);
  });

  it('skips used wagers and returns next available', () => {
    const used = new Map([[1, true], [2, false]]);
    expect(findNextAvailableWager(used, 5)).toBe(3);
  });

  it('returns 1 as fallback when all wagers are used', () => {
    const used = new Map([[1, true], [2, true], [3, false]]);
    expect(findNextAvailableWager(used, 3)).toBe(1);
  });

  it('finds lowest gap in non-sequential usage', () => {
    const used = new Map([[1, true], [3, true], [5, false]]);
    expect(findNextAvailableWager(used, 5)).toBe(2);
  });
});

// ============================================
// tallyDifficultyVotes
// ============================================
describe('tallyDifficultyVotes', () => {
  it('returns zeros for empty/null votes', () => {
    expect(tallyDifficultyVotes({})).toEqual({ easy: 0, medium: 0, hard: 0 });
    expect(tallyDifficultyVotes(null)).toEqual({ easy: 0, medium: 0, hard: 0 });
  });

  it('counts votes correctly', () => {
    const votes = { p1: 'easy', p2: 'hard', p3: 'easy', p4: 'medium' };
    expect(tallyDifficultyVotes(votes)).toEqual({ easy: 2, medium: 1, hard: 1 });
  });

  it('ignores invalid difficulty values', () => {
    const votes = { p1: 'easy', p2: 'impossible', p3: 'hard' };
    expect(tallyDifficultyVotes(votes)).toEqual({ easy: 1, medium: 0, hard: 1 });
  });
});

// ============================================
// computeScoresFromAnswers
// ============================================
describe('computeScoresFromAnswers', () => {
  it('returns zeros for empty answers', () => {
    const players = [{ id: 'p1' }, { id: 'p2' }];
    expect(computeScoresFromAnswers([], players)).toEqual({ p1: 0, p2: 0 });
  });

  it('sums score_earned per player', () => {
    const players = [{ id: 'p1' }, { id: 'p2' }];
    const answers = [
      { player_id: 'p1', score_earned: 5 },
      { player_id: 'p1', score_earned: 3 },
      { player_id: 'p2', score_earned: -10 },
    ];
    expect(computeScoresFromAnswers(answers, players)).toEqual({ p1: 8, p2: -10 });
  });

  it('tracks unknown player_ids in answers', () => {
    const players = [{ id: 'p1' }];
    const answers = [
      { player_id: 'p1', score_earned: 5 },
      { player_id: 'p_unknown', score_earned: 3 },
    ];
    const scores = computeScoresFromAnswers(answers, players);
    expect(scores.p1).toBe(5);
    expect(scores.p_unknown).toBe(3);
  });
});

// ============================================
// buildDisqualifiedSet
// ============================================
describe('buildDisqualifiedSet', () => {
  it('returns empty set when no answers are all-zero', () => {
    const answers = [
      { question_number: 0, is_correct: true,  score_earned: 5 },
      { question_number: 0, is_correct: false, score_earned: 0 },
    ];
    expect(buildDisqualifiedSet(answers).size).toBe(0);
  });

  it('flags a question where every answer has is_correct=false and score=0', () => {
    const answers = [
      { question_number: 2, is_correct: false, score_earned: 0 },
      { question_number: 2, is_correct: false, score_earned: 0 },
    ];
    const set = buildDisqualifiedSet(answers);
    expect(set.has(2)).toBe(true);
  });

  it('returns numeric question keys (parsed from string)', () => {
    const answers = [{ question_number: 5, is_correct: false, score_earned: 0 }];
    const set = buildDisqualifiedSet(answers);
    expect(set.has(5)).toBe(true);
    expect(set.has('5')).toBe(false);
  });
});

// ============================================
// buildUsedWagersMap
// ============================================
describe('buildUsedWagersMap', () => {
  it('skips final wager round answers', () => {
    const answers = [
      { question_number: 0, wager: 3, is_correct: true,  submitted_answer: 'paris' },
      { question_number: 5, wager: 20, is_correct: false, submitted_answer: 'rome' }, // final wager
    ];
    const map = buildUsedWagersMap(answers, 5, new Set());
    expect(map.has(3)).toBe(true);
    expect(map.has(20)).toBe(false);
  });

  it('skips auto-submitted blanks (empty submitted_answer)', () => {
    const answers = [
      { question_number: 0, wager: 1, is_correct: false, submitted_answer: '' },
      { question_number: 1, wager: 2, is_correct: true,  submitted_answer: 'oslo' },
    ];
    const map = buildUsedWagersMap(answers, 5, new Set());
    expect(map.has(1)).toBe(false);
    expect(map.has(2)).toBe(true);
  });

  it('skips disqualified questions', () => {
    const answers = [
      { question_number: 0, wager: 1, is_correct: true,  submitted_answer: 'paris' },
      { question_number: 1, wager: 2, is_correct: false, submitted_answer: 'wrong' },
    ];
    const map = buildUsedWagersMap(answers, 5, new Set([1]));
    expect(map.has(1)).toBe(true);
    expect(map.has(2)).toBe(false);
  });

  it('skips __WAGER_LOCKED__ placeholders', () => {
    const answers = [
      { question_number: 0, wager: 10, is_correct: false, submitted_answer: '__WAGER_LOCKED__' },
    ];
    const map = buildUsedWagersMap(answers, 5, new Set());
    expect(map.has(10)).toBe(false);
  });

  it('preserves is_correct flag in the map', () => {
    const answers = [
      { question_number: 0, wager: 3, is_correct: true,  submitted_answer: 'paris' },
      { question_number: 1, wager: 5, is_correct: false, submitted_answer: 'wrong' },
    ];
    const map = buildUsedWagersMap(answers, 10, new Set());
    expect(map.get(3)).toBe(true);
    expect(map.get(5)).toBe(false);
  });
});

// ============================================
// modalDifficulty
// ============================================
describe('modalDifficulty', () => {
  it('returns null when no votes', () => {
    expect(modalDifficulty({ easy: 0, medium: 0, hard: 0 })).toBe(null);
  });

  it('picks the single most-voted', () => {
    expect(modalDifficulty({ easy: 3, medium: 1, hard: 0 })).toBe('easy');
    expect(modalDifficulty({ easy: 0, medium: 5, hard: 2 })).toBe('medium');
    expect(modalDifficulty({ easy: 0, medium: 0, hard: 2 })).toBe('hard');
  });

  it('breaks ties toward the higher difficulty', () => {
    expect(modalDifficulty({ easy: 2, medium: 2, hard: 0 })).toBe('medium');
    expect(modalDifficulty({ easy: 0, medium: 2, hard: 2 })).toBe('hard');
    expect(modalDifficulty({ easy: 1, medium: 1, hard: 1 })).toBe('hard');
  });
});

// ============================================
// pickWeightedDifficulty (deterministic via injected randFn)
// ============================================
describe('pickWeightedDifficulty', () => {
  // Helper: drive the function with a fixed sequence of "random" values.
  const fixed = (v) => () => v;

  it('respects the floor — all-Hard never goes Easy or Medium', () => {
    const tally = { easy: 0, medium: 0, hard: 5 };
    // No matter what r is, only "hard" should be in the candidate list.
    expect(pickWeightedDifficulty(tally, fixed(0))).toBe('hard');
    expect(pickWeightedDifficulty(tally, fixed(0.5))).toBe('hard');
    expect(pickWeightedDifficulty(tally, fixed(0.999))).toBe('hard');
  });

  it('respects the floor — all-Medium never goes Easy', () => {
    const tally = { easy: 0, medium: 4, hard: 0 };
    // Should be medium (overwhelmingly) or hard (small floor chance), never easy.
    for (const r of [0, 0.1, 0.5, 0.9, 0.99]) {
      const result = pickWeightedDifficulty(tally, fixed(r));
      expect(result === 'medium' || result === 'hard').toBe(true);
    }
  });

  it('with no votes, picks uniformly across all three', () => {
    expect(pickWeightedDifficulty({}, fixed(0))).toBe('easy');
    expect(pickWeightedDifficulty({}, fixed(0.5))).toBe('medium');
    expect(pickWeightedDifficulty({}, fixed(0.99))).toBe('hard');
  });

  it('weights toward the most-voted within allowed levels', () => {
    // 100 trials, easy:3 should win heavily over the 0.1-floor medium and hard.
    const tally = { easy: 3, medium: 0, hard: 0 };
    let easyCount = 0;
    for (let i = 0; i < 1000; i++) {
      if (pickWeightedDifficulty(tally) === 'easy') easyCount++;
    }
    // Probability ~ 3/3.2 = 93.75% — allow generous noise band
    expect(easyCount).toBeGreaterThan(850);
  });

  it('zero-vote levels at-or-above floor still get a small chance', () => {
    // tally = all medium; over many trials some hard outcomes should occur
    const tally = { easy: 0, medium: 5, hard: 0 };
    let hardCount = 0;
    for (let i = 0; i < 5000; i++) {
      if (pickWeightedDifficulty(tally) === 'hard') hardCount++;
    }
    // Probability ~ 0.1/5.1 ≈ 1.96% — over 5000 trials, expect ~98 hard wins
    expect(hardCount).toBeGreaterThan(20);
    expect(hardCount).toBeLessThan(300);
  });
});
