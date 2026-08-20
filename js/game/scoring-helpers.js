// ============================================
// Oracle Party — Scoring Helpers
// Pure functions for score calculation, wager selection, vote tallying.
// ============================================

/**
 * Compute points earned for a single answer.
 * Regular rounds: correct = +wager, incorrect = 0.
 * Final wager: correct = +wager, incorrect = -wager.
 */
export function computeScoreEarned(isCorrect, wager, isFinalWagerRound) {
  return isCorrect ? wager : (isFinalWagerRound ? -wager : 0);
}

/**
 * Find the lowest unused wager value (1..totalQuestions).
 * Returns 1 as fallback if all wagers are used.
 */
export function findNextAvailableWager(usedWagers, totalQuestions) {
  for (let i = 1; i <= totalQuestions; i++) {
    if (!usedWagers.has(i)) return i;
  }
  return 1;
}

/**
 * Count difficulty votes from a { playerId: difficulty } map.
 */
export function tallyDifficultyVotes(votes) {
  const tally = { easy: 0, medium: 0, hard: 0 };
  for (const d of Object.values(votes || {})) {
    if (tally[d] !== undefined) tally[d]++;
  }
  return tally;
}

/**
 * Compute scores from an array of answer records.
 * Each answer has { player_id, score_earned }.
 */
export function computeScoresFromAnswers(answers, players) {
  const scores = {};
  for (const p of players) scores[p.id] = 0;
  for (const a of answers) {
    scores[a.player_id] = (scores[a.player_id] || 0) + (a.score_earned || 0);
  }
  return scores;
}

/**
 * Detect disqualified questions from answer data.
 * A question is treated as disqualified when every answer has score_earned=0
 * AND is_correct=false. Note: this misclassifies "everyone got it wrong"
 * rounds as disqualified — chat-message replay is the more authoritative
 * signal during normal play (see chat.js dqMatch handler).
 */
export function buildDisqualifiedSet(allAnswers) {
  const byQ = {};
  for (const a of allAnswers) {
    if (!byQ[a.question_number]) byQ[a.question_number] = [];
    byQ[a.question_number].push(a);
  }
  const disq = new Set();
  for (const [qNum, answers] of Object.entries(byQ)) {
    if (answers.length > 0 && answers.every(a => !a.is_correct && (a.score_earned || 0) === 0)) {
      disq.add(parseInt(qNum, 10));
    }
  }
  return disq;
}

/**
 * Reconstruct a player's regular-round usedWagers map from their answers.
 * Skips:
 *  - final wager round (question_number >= totalQuestions) — separate wager space (0/10/20)
 *  - auto-submitted blanks (empty submitted_answer) — host writes wager=1 for non-submitters
 *  - disqualified questions — wager is refunded
 */
export function buildUsedWagersMap(myAnswers, totalQuestions, disqualifiedSet) {
  const usedWagers = new Map();
  for (const a of myAnswers) {
    if (a.question_number >= totalQuestions) continue;
    const submitted = (a.submitted_answer || '').trim();
    if (!submitted || submitted === '__WAGER_LOCKED__') continue;
    if (disqualifiedSet && disqualifiedSet.has(a.question_number)) continue;
    if (a.wager) usedWagers.set(a.wager, !!a.is_correct);
  }
  return usedWagers;
}

/**
 * Compute the displayed "most-voted" difficulty. Ties resolve to the HIGHER
 * difficulty (e.g. 2 easy + 2 medium → medium). Returns null if no votes.
 */
export function modalDifficulty(tally) {
  const order = ['easy', 'medium', 'hard'];
  const counts = order.map(d => tally[d] || 0);
  const max = Math.max(...counts);
  if (max === 0) return null;
  let idx = 0;
  for (let i = 0; i < order.length; i++) if (counts[i] === max) idx = i;
  return order[idx];
}

/**
 * Every difficulty the final question could actually turn out to be, given
 * the votes — the most-voted level and everything harder, since the vote acts
 * as a floor. With no votes at all, anything is possible.
 *
 * This exists so the slot-machine wheel and the thing that picks the winner
 * cannot disagree about what is on the table. The wheel used to cycle all
 * three regardless of votes, which teased levels that could never come up; the
 * fix for that made it cycle only the VOTED levels, which was wrong in the
 * other direction — a room where everyone picks Easy has all three genuinely
 * in play, and showing one pill meant the wheel stopped spinning at all in the
 * commonest case of a small room agreeing. Possible outcomes is the set that
 * is both honest and dramatic.
 */
export function allowedDifficulties(tally) {
  const order = ['easy', 'medium', 'hard'];
  const counts = order.map(d => (tally && tally[d]) || 0);
  const max = Math.max(...counts);
  if (max === 0) return [...order];
  let floorIdx = 0;
  for (let i = 0; i < order.length; i++) if (counts[i] === max) floorIdx = i;
  return order.slice(floorIdx);
}

/**
 * Pick the actual final-question difficulty from a vote tally.
 *
 * The vote acts as a FLOOR: the result can never be EASIER than the most-
 * voted level. (If everyone votes Hard, you get Hard.) Above the floor,
 * each allowed difficulty's weight is its vote count, with a 0.1 minimum so
 * unvoted-but-allowed levels keep a small comedic chance of springing up.
 *
 *   votes={easy:3,medium:0,hard:0}  → floor=easy → ~94% easy, ~3% medium, ~3% hard
 *   votes={easy:0,medium:3,hard:0}  → floor=medium → ~97% medium, ~3% hard
 *   votes={easy:0,medium:0,hard:5}  → floor=hard → 100% hard
 *   no votes                        → uniform over all three
 *
 * Pass `randFn` to make this deterministic in tests.
 */
export function pickWeightedDifficulty(tally, randFn = Math.random) {
  const allowed = allowedDifficulties(tally);
  if (allowed.length === 3 && Math.max(...['easy', 'medium', 'hard'].map(d => tally[d] || 0)) === 0) {
    return allowed[Math.floor(randFn() * 3)];
  }
  const weights = allowed.map(d => Math.max(tally[d] || 0, 0.1));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = randFn() * total;
  for (let i = 0; i < allowed.length; i++) {
    r -= weights[i];
    if (r <= 0) return allowed[i];
  }
  return allowed[allowed.length - 1];
}
