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
  allowedDifficulties,
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

  // This test used to assert the opposite, and the opposite was the bug.
  //
  // A missed round burns the player's lowest unused wager — the rule that makes
  // going away neither cheaper nor dearer than being present and wrong. This
  // function runs on every reconnect and decides which wagers a returning
  // player is offered, so handing the blank's wager back let a refresh buy it
  // twice and spend some other value twice over. Reported from a playtest as
  // "upon players refreshing their bet values were reset".
  //
  // Skipping was right when the host wrote wager=1 for every non-submitter,
  // because counting six identical 1s would have been nonsense. Since
  // insertBlankAnswers began giving each player their OWN lowest unused value,
  // the blank carries a real, distinct wager and skipping it loses information.
  it('counts a blank answer — a missed round still spends a wager', () => {
    const answers = [
      { question_number: 0, wager: 1, is_correct: false, submitted_answer: '' },
      { question_number: 1, wager: 2, is_correct: true,  submitted_answer: 'oslo' },
    ];
    const map = buildUsedWagersMap(answers, 5, new Set());
    expect(map.has(1)).toBe(true);
    expect(map.get(1)).toBe(false); // spent, and scored nothing
    expect(map.has(2)).toBe(true);
    // The next wager offered must be 3, not 1 — 1 is gone.
    expect(findNextAvailableWager(map, 5)).toBe(3);
  });

  it('still skips the final-wager placeholder, which is not an answer', () => {
    const answers = [
      { question_number: 0, wager: 1, is_correct: false, submitted_answer: '__WAGER_LOCKED__' },
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

  // Deliberately the OPPOSITE of allowedDifficulties. This picks the single
  // level the wheel appears to settle on before any comedic switch; that one
  // answers what the result could possibly be, where a tie means more than one
  // thing genuinely could happen.
  it('breaks ties toward the higher difficulty', () => {
    expect(modalDifficulty({ easy: 2, medium: 2, hard: 0 })).toBe('medium');
    expect(modalDifficulty({ easy: 0, medium: 2, hard: 2 })).toBe('hard');
    expect(modalDifficulty({ easy: 1, medium: 1, hard: 1 })).toBe('hard');
  });
});

// ============================================
// allowedDifficulties
//
// This is what the slot-machine wheel cycles through, and it has been wrong in
// both directions. It first cycled all three levels regardless of votes, which
// teased outcomes that could not happen; the fix made it cycle only the VOTED
// levels, which stopped it spinning at all whenever a small room agreed — the
// bug reported from a real two-player game as "it doesn't cycle, it just
// chooses". The set that is both honest and dramatic is the set of possible
// outcomes, so this asserts it agrees with pickWeightedDifficulty exactly.
// ============================================
describe('allowedDifficulties', () => {
  it('all-Easy leaves every level in play, so the wheel has three to spin', () => {
    expect(allowedDifficulties({ easy: 3, medium: 0, hard: 0 }))
      .toEqual(['easy', 'medium', 'hard']);
  });

  it('all-Medium drops Easy — it is below the floor and cannot come up', () => {
    expect(allowedDifficulties({ easy: 0, medium: 2, hard: 0 }))
      .toEqual(['medium', 'hard']);
  });

  it('all-Hard is a certainty, and a wheel that spins would be lying', () => {
    expect(allowedDifficulties({ easy: 0, medium: 0, hard: 4 })).toEqual(['hard']);
  });

  it('no votes leaves everything open', () => {
    expect(allowedDifficulties({})).toEqual(['easy', 'medium', 'hard']);
    expect(allowedDifficulties(null)).toEqual(['easy', 'medium', 'hard']);
  });

  // The wheel collapsing to a single pill is what "it doesn't cycle" looks
  // like, and in a TWO-PLAYER game a tie is the common case rather than an
  // edge one: any two people who disagree produce one. Taking the highest
  // tied level made the outcome certain and killed the spin — and made the
  // lower voter's vote do nothing at all, every time.
  it('a tie keeps every tied level in play, so the wheel still spins', () => {
    expect(allowedDifficulties({ easy: 1, medium: 0, hard: 1 }))
      .toEqual(['easy', 'medium', 'hard']);
    expect(allowedDifficulties({ easy: 0, medium: 2, hard: 2 }))
      .toEqual(['medium', 'hard']);
    expect(allowedDifficulties({ easy: 1, medium: 1, hard: 1 }))
      .toEqual(['easy', 'medium', 'hard']);
  });

  // allowedDifficulties answers what can HAPPEN, and for a room unanimous on
  // hard the answer really is one thing.
  //
  // The WHEEL no longer follows it. The owner settled that separately: it now
  // spins through all three whatever the room voted, because a slot machine
  // showing symbols it will not land on is not lying, it is a slot machine.
  // The reels are theatre; the landing is this function.
  it('reports one level when the room is unanimous on hard', () => {
    expect(allowedDifficulties({ easy: 0, medium: 0, hard: 3 })).toEqual(['hard']);
  });

  it('never returns a level pickWeightedDifficulty cannot actually produce', () => {
    const tallies = [
      { easy: 3, medium: 0, hard: 0 },
      { easy: 0, medium: 2, hard: 0 },
      { easy: 0, medium: 0, hard: 4 },
      { easy: 1, medium: 2, hard: 1 },
      { easy: 2, medium: 2, hard: 0 },
      {},
    ];
    for (const tally of tallies) {
      const allowed = new Set(allowedDifficulties(tally));
      const seen = new Set();
      for (let i = 0; i < 4000; i++) seen.add(pickWeightedDifficulty(tally));
      // Every outcome the picker produces must be on the wheel...
      for (const d of seen) expect(allowed.has(d)).toBe(true);
      // ...and every pill on the wheel must be reachable, or it is a tease.
      for (const d of allowed) expect(seen.has(d)).toBe(true);
    }
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
