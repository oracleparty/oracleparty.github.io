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
  answersForCurrentGame,
  countAnswersFrom,
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
// allowedDifficulties + pickWeightedDifficulty
//
// THE UPSET IS ALWAYS 1 IN 20. The owner's rule, replacing one where the odds
// moved around: an unvoted level used to carry a fixed WEIGHT of 0.1 against
// the raw vote counts, so a surprise got rarer the more people voted (8.4% each
// in a room of one, 4.5% with two, 3.1% with three) and vanished entirely when
// a room agreed on Hard, because the vote was also a FLOOR and nothing sat
// above it.
//
// Now the voted levels share 95% in proportion to their votes, and the levels
// nobody voted for share 5% between them. The floor is gone with it, so every
// level is always reachable — which is why the wheel honestly shows three.
//
// These tests replace six that pinned the floor. They were not wrong when
// written; the design under them changed, and a test that goes on asserting a
// rule the owner has replaced is a test that will be "fixed" back into the old
// behaviour by somebody trusting it.
// ============================================
describe('allowedDifficulties', () => {
  it('is every level, whatever the room voted — nothing is impossible now', () => {
    for (const tally of [{ easy: 3 }, { medium: 2 }, { hard: 4 }, { easy: 1, hard: 1 }, {}, null]) {
      expect(allowedDifficulties(tally)).toEqual(['easy', 'medium', 'hard']);
    }
  });

  it('never offers a level pickWeightedDifficulty cannot produce', () => {
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
      for (let i = 0; i < 20000; i++) seen.add(pickWeightedDifficulty(tally));
      for (const d of seen) expect(allowed.has(d)).toBe(true);
      // ...and every pill on the wheel must be reachable, or it is a tease.
      for (const d of allowed) expect(seen.has(d)).toBe(true);
    }
  });
});

describe('pickWeightedDifficulty', () => {
  const fixed = (v) => () => v;
  // Share of N trials that came out as `want`.
  const rate = (tally, want, n = 60000) => {
    let hits = 0;
    for (let i = 0; i < n; i++) if (pickWeightedDifficulty(tally) === want) hits++;
    return hits / n;
  };

  // THE HEADLINE RULE, and it is checked at several room sizes precisely
  // because the old rule's upset shrank as votes piled up. One number
  // everywhere is the whole point.
  it('gives an unvoted level the same 5% however many people voted', () => {
    for (const votes of [1, 2, 3, 8]) {
      const upset = rate({ easy: votes }, 'medium') + rate({ easy: votes }, 'hard');
      expect(upset).toBeGreaterThan(0.035);
      expect(upset).toBeLessThan(0.065);
    }
  });

  // ONE voter deliberately: this is where the old fixed-weight rule was most
  // wrong, handing each unvoted level 8.3%. At four voters it happened to land
  // near 2.4% and a check written there could not tell the two rules apart.
  it('splits the 5% evenly when two levels went unvoted — 2.5% each', () => {
    expect(rate({ easy: 1 }, 'medium')).toBeGreaterThan(0.015);
    expect(rate({ easy: 1 }, 'medium')).toBeLessThan(0.035);
    expect(rate({ easy: 1 }, 'hard')).toBeGreaterThan(0.015);
    expect(rate({ easy: 1 }, 'hard')).toBeLessThan(0.035);
  });

  // THREE against three, not one against one. With a single vote each side the
  // old rule also produced ~4.8% here and a check could not tell them apart;
  // with three it produced ~1.6%, because the upset was a fixed weight against
  // a growing pile of votes rather than a fixed share.
  it('gives the whole 5% to the one level nobody picked', () => {
    expect(rate({ easy: 3, hard: 3 }, 'medium')).toBeGreaterThan(0.035);
    expect(rate({ easy: 3, hard: 3 }, 'medium')).toBeLessThan(0.065);
    // ...and the vote is still an even split of what is left.
    expect(rate({ easy: 3, hard: 3 }, 'easy')).toBeGreaterThan(0.42);
    expect(rate({ easy: 3, hard: 3 }, 'easy')).toBeLessThan(0.53);
  });

  // THE FLOOR IS GONE. A room unanimous on Hard used to be a certainty — one
  // pill, no surprise available — which is the asymmetry the owner removed:
  // voting Hard opted you out of the upset entirely.
  it('lets a room unanimous on Hard still be surprised', () => {
    const upset = rate({ hard: 5 }, 'easy') + rate({ hard: 5 }, 'medium');
    expect(upset).toBeGreaterThan(0.035);
    expect(upset).toBeLessThan(0.065);
  });

  it('lets a room unanimous on Medium still fall to Easy', () => {
    expect(rate({ medium: 4 }, 'easy')).toBeGreaterThan(0.015);
    expect(rate({ medium: 4 }, 'easy')).toBeLessThan(0.035);
  });

  // The votes still count against each other in proportion; only the leftover
  // 5% is fixed.
  it('splits the 95% in proportion to the votes', () => {
    expect(rate({ easy: 2, hard: 1 }, 'easy')).toBeGreaterThan(0.58);
    expect(rate({ easy: 2, hard: 1 }, 'easy')).toBeLessThan(0.69);
    expect(rate({ easy: 2, hard: 1 }, 'hard')).toBeGreaterThan(0.27);
    expect(rate({ easy: 2, hard: 1 }, 'hard')).toBeLessThan(0.37);
  });

  // NOTHING LEFT TO BE SURPRISED BY. A room that voted for every level gets no
  // upset, which is correct rather than an edge case.
  it('has no upset to give when every level got a vote', () => {
    const tally = { easy: 1, medium: 1, hard: 1 };
    for (const d of ['easy', 'medium', 'hard']) {
      expect(rate(tally, d)).toBeGreaterThan(0.30);
      expect(rate(tally, d)).toBeLessThan(0.37);
    }
  });

  it('with no votes, picks uniformly across all three', () => {
    expect(pickWeightedDifficulty({}, fixed(0))).toBe('easy');
    expect(pickWeightedDifficulty({}, fixed(0.5))).toBe('medium');
    expect(pickWeightedDifficulty({}, fixed(0.99))).toBe('hard');
  });
});


// ============================================
// answersForCurrentGame
//
// A room outlives a game. Play Again keeps the room and draws new questions, so
// the last game's answers have to go — and there are ways that does not happen
// (a revoked DELETE policy before migration 051; a room returning to the lobby
// without its host, since the clear-out is host-gated). The symptom is silent
// and identical either way: everybody starts the next game already holding the
// points they won in the last one.
// ============================================
describe('answersForCurrentGame', () => {
  const questions = [{ id: 'qA' }, { id: 'qB' }, { id: 'qC' }];

  it("drops a previous game's answers, which sit on the same round numbers", () => {
    const rows = [
      { question_number: 0, question_id: 'qA', score_earned: 3 },   // this game
      { question_number: 0, question_id: 'old-1', score_earned: 9 }, // last game
      { question_number: 1, question_id: 'old-2', score_earned: 7 },
    ];
    expect(answersForCurrentGame(rows, questions)).toEqual([rows[0]]);
  });

  it('keeps every answer that belongs to the game being played', () => {
    const rows = [
      { question_number: 0, question_id: 'qA' },
      { question_number: 1, question_id: 'qB' },
      { question_number: 2, question_id: 'qC' },
    ];
    expect(answersForCurrentGame(rows, questions)).toHaveLength(3);
  });

  // Dropping a real answer costs somebody their score, so every "cannot tell"
  // case keeps the row. Same rule as a missing last_seen_at meaning "here".
  it('keeps everything when no question list has loaded yet', () => {
    const rows = [{ question_number: 0, question_id: 'anything' }];
    expect(answersForCurrentGame(rows, [])).toEqual(rows);
    expect(answersForCurrentGame(rows, null)).toEqual(rows);
    expect(answersForCurrentGame(rows, undefined)).toEqual(rows);
  });

  it('keeps a round the loaded list does not reach', () => {
    const rows = [{ question_number: 9, question_id: 'qZ' }];
    expect(answersForCurrentGame(rows, questions)).toEqual(rows);
  });

  it('keeps a row that names no question at all', () => {
    const rows = [
      { question_number: 0, question_id: null },
      { question_number: 1, question_id: '' },
      { question_number: 2 },
    ];
    expect(answersForCurrentGame(rows, questions)).toHaveLength(3);
  });

  it('compares as strings, so a numeric id is not dropped by its type', () => {
    const rows = [{ question_number: 0, question_id: 7 }];
    expect(answersForCurrentGame(rows, [{ id: '7' }])).toEqual(rows);
  });

  it('survives an empty answer list', () => {
    expect(answersForCurrentGame([], questions)).toEqual([]);
    expect(answersForCurrentGame(null, questions)).toEqual([]);
  });
});


// ============================================
// countAnswersFrom
//
// "Has everybody answered?" used to be answers.length >= players.length, which
// worked only by accident: until migration 052 an answer was deleted along with
// its player row, so both sides shrank together. 052 drops that key on purpose
// — it is what lets a rejoining player recover their score — so an answer now
// outlives the seat, and the old test concludes the room is done while somebody
// is still typing.
// ============================================
describe('countAnswersFrom', () => {
  const players = [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }];

  it('ignores an answer left behind by somebody who has gone', () => {
    // Alice answered and left; only Bob of the two remaining has answered.
    const answers = [{ player_id: 'gone' }, { player_id: 'p1' }];
    expect(countAnswersFrom(answers, [{ id: 'p1' }, { id: 'p2' }])).toBe(1);
  });

  it('does not report everyone done while somebody is still typing', () => {
    const remaining = [{ id: 'p1' }, { id: 'p2' }];
    const answers = [{ player_id: 'gone' }, { player_id: 'p1' }];
    expect(countAnswersFrom(answers, remaining) >= remaining.length).toBe(false);
    // The old test, for contrast: 2 >= 2 — the bug this replaces.
    expect(answers.length >= remaining.length).toBe(true);
  });

  it('counts a player once however many rows they have', () => {
    const answers = [{ player_id: 'p1' }, { player_id: 'p1' }, { player_id: 'p2' }];
    expect(countAnswersFrom(answers, players)).toBe(2);
  });

  it('reaches the full count when everyone present has answered', () => {
    const answers = players.map(p => ({ player_id: p.id }));
    expect(countAnswersFrom(answers, players)).toBe(3);
  });

  it('compares as strings, so a numeric id still matches', () => {
    expect(countAnswersFrom([{ player_id: 7 }], [{ id: '7' }])).toBe(1);
  });

  it('survives empty and missing inputs', () => {
    expect(countAnswersFrom([], players)).toBe(0);
    expect(countAnswersFrom(null, players)).toBe(0);
    expect(countAnswersFrom([{ player_id: 'p1' }], null)).toBe(0);
  });

  // On the FINAL question lockInFinalWager writes __WAGER_LOCKED__ for every
  // player the moment they pick 0/10/20, so everybody holds a row before anyone
  // has typed a word. reveal.js had this guard in a private helper of its own
  // and countAnswersFrom did not, so updateRevealButtonText and the Realtime
  // answer handler both counted placeholders: on the last round of every game
  // the countdown vanished and the host was told "Reveal Results" while people
  // were still answering. Half a rule in each of two files.
  it('does not count a locked final wager as an answer', () => {
    const answers = players.map(p => ({ player_id: p.id, submitted_answer: '__WAGER_LOCKED__' }));
    expect(countAnswersFrom(answers, players)).toBe(0);
    expect(countAnswersFrom(answers, players) >= players.length).toBe(false);
  });

  it('counts the real answer that replaces a placeholder', () => {
    const answers = [
      { player_id: 'p1', submitted_answer: 'Paris' },
      { player_id: 'p2', submitted_answer: '__WAGER_LOCKED__' },
      { player_id: 'p3', submitted_answer: '  __WAGER_LOCKED__  ' },
    ];
    expect(countAnswersFrom(answers, players)).toBe(1);
  });

  it('still counts a deliberately blank answer, which is a real submission', () => {
    // A blank is what somebody who ran out of time actually has. Treating it as
    // "not answered" would hold the round open for a player the fill has
    // already closed out.
    const answers = players.map(p => ({ player_id: p.id, submitted_answer: '' }));
    expect(countAnswersFrom(answers, players)).toBe(3);
  });
});
