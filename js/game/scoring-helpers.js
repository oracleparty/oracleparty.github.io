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
 * Answers that belong to the game currently being played.
 *
 * A ROOM OUTLIVES A GAME. Play Again keeps the room and draws a new set of
 * questions, so the previous game's answers have to be deleted — and there are
 * several ways that does not happen:
 *
 *   * migration 049 revoked DELETE on `answers`, so until 051 is applied the
 *     clear-out is refused silently (no error, zero rows);
 *   * the clear-out is host-gated, so a room that returns to the lobby without
 *     its host never runs it at all.
 *
 * Whatever the reason, the symptom is the same and it is invisible: everybody
 * starts the next game already holding the points they won in the last one.
 *
 * `answers.question_id` records which question a row was actually about, so a
 * stale row can be recognised structurally rather than trusted to have been
 * deleted. A row is kept when the room's question at that round number is the
 * one it names.
 *
 * KEPT, not dropped, when we cannot tell: no question list loaded yet (a
 * hot-join, mid-fetch), a round number the list does not reach, or a row with
 * no question_id. Dropping a real answer costs somebody their score; keeping a
 * stale one is the bug this guards against, and every other layer is also
 * trying to prevent it.
 *
 * COVERED BY UNIT TESTS ONLY, and that is a deliberate admission rather than an
 * oversight. A scenario check was written for it — seed a previous game's
 * answer, play a second game, require it not to score — and it passed just as
 * happily with this function stubbed out to return everything. The seeded row
 * did not survive to the moment the scoreboard is computed, and no RPC removed
 * it, so the check was measuring nothing. A check that cannot fail looks like
 * coverage and is worse than none, so it was deleted (the same call as the
 * final-wager guards in CLAUDE.md). tests/scoring.test.js pins the behaviour
 * directly, including every "cannot tell" case.
 */
export function answersForCurrentGame(answers, questions) {
  const rows = answers || [];
  if (!Array.isArray(questions) || questions.length === 0) return rows;
  const idAt = questions.map(q => (q && q.id != null ? String(q.id) : null));
  return rows.filter(a => {
    const expected = idAt[a.question_number];
    if (!expected) return true;
    if (a.question_id == null || a.question_id === '') return true;
    return String(a.question_id) === expected;
  });
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
 *
 * This runs on every reconnect, so it decides which wagers a returning player
 * is offered. It must agree with what the live game already spent, or a refresh
 * hands back numbers that are gone.
 *
 * Skips:
 *  - final wager round (question_number >= totalQuestions) — separate wager
 *    space (0/10/20)
 *  - __WAGER_LOCKED__ — a placeholder written when a final wager is chosen, not
 *    an answer to anything
 *  - disqualified questions — the wager really is refunded there, by
 *    handleDisqualifyRound
 *
 * A BLANK ANSWER IS COUNTED. It used to be skipped, and that was the bug behind
 * "upon players refreshing their bet values were reset" from a playtest: a
 * missed round burns the player's lowest unused wager — that is the rule that
 * makes going away neither cheaper nor dearer than being present and wrong —
 * so a rebuild that gave it back let a refresh buy the wager a second time and
 * spend some other value twice. The skip made sense when the host wrote wager=1
 * for every non-submitter, because counting six identical 1s would have been
 * nonsense; since insertBlankAnswers started giving each player their own
 * lowest unused value, the blank carries a real, distinct wager and skipping it
 * is what loses information.
 */
export function buildUsedWagersMap(myAnswers, totalQuestions, disqualifiedSet) {
  const usedWagers = new Map();
  for (const a of myAnswers) {
    if (a.question_number >= totalQuestions) continue;
    const submitted = (a.submitted_answer || '').trim();
    if (submitted === '__WAGER_LOCKED__') continue;
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
  // A TIE TAKES THE LOWEST LEVEL AS THE FLOOR, and this is the opposite of
  // modalDifficulty on purpose. The two answer different questions:
  // modalDifficulty asks "which single level should the wheel appear to settle
  // on", and breaking that toward the harder one is a deliberate, tested
  // choice. This asks "what could the result possibly BE", and a tie means
  // more than one level genuinely could be.
  //
  // Taking the highest tied level here was never decided — it was inherited
  // from modalDifficulty's loop when this function was extracted — and in a
  // two-player game it is the common case, not an edge one: any two people who
  // disagree produce a tie. One Easy vote and one Hard vote collapsed the floor
  // to Hard, which made the outcome certain, which left ONE pill on the wheel.
  // The owner reported the wheel not cycling, for the second time.
  //
  // It also made a tie no tie at all: the Easy voter's vote did nothing, every
  // time. Now both stay in play and pickWeightedDifficulty weights them
  // equally, which is what a tied vote should mean.
  let floorIdx = 0;
  for (let i = 0; i < order.length; i++) {
    if (counts[i] === max) { floorIdx = i; break; }
  }
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
