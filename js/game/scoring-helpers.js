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
