// ============================================
// Oracle Party — Scoring Helpers
// Pure functions for score calculation, wager selection, vote tallying.
// ============================================

import { DIFFICULTY_UPSET_CHANCE } from '../constants.js';

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
 * How many of the people CURRENTLY IN THE ROOM have answered.
 *
 * `state.currentAnswers.length >= state.players.length` was the test for "has
 * everybody answered", and migration 052 broke it. Until 052, an answer was
 * deleted along with its player row, so a departed player's answer disappeared
 * from the count at the same moment they disappeared from the player list, and
 * the two sides stayed in step by accident.
 *
 * 052 drops that key deliberately — it is what makes a rejoining player's score
 * recoverable — so an answer now OUTLIVES the seat. Three players, Alice
 * answers and leaves, Bob answers: two answers against two remaining players,
 * and the room concludes everybody is done while Carol is still typing. The
 * host is shown "Reveal Results" and the countdown hides itself.
 *
 * Counting only answers whose player is still here fixes it. Deduplicating by
 * player id costs nothing and closes the same gap from the other side.
 *
 * A __WAGER_LOCKED__ ROW IS NOT AN ANSWER, and leaving that out was the second
 * half of the same rule sitting in a different file. On the final question
 * lockInFinalWager writes that placeholder the moment somebody picks 0/10/20,
 * so every player holds a row before anyone has typed a word — which is exactly
 * the fault the 2026-08-20 playtest recorded as "the countdown hid itself on
 * the final question". `submittedCount` in reveal.js was written to fix it and
 * fixed it only on the reveal SCREEN; updateRevealButtonText and the Realtime
 * answer handler both went on counting rows, so on the last round of every game
 * the timer still vanished and the host was still told "Reveal Results" while
 * people were typing.
 *
 * The two guards are now one function rather than two half-rules that each
 * looked complete. THE SAME PATTERN ELSEWHERE is the standing instruction in
 * CLAUDE.md, and this is what it costs when only one site gets the fix.
 */
export function countAnswersFrom(answers, players) {
  const here = new Set((players || []).map(p => String(p.id)));
  const answered = new Set();
  for (const a of answers || []) {
    if ((a.submitted_answer || '').trim() === '__WAGER_LOCKED__') continue;
    const id = String(a.player_id);
    if (here.has(id)) answered.add(id);
  }
  return answered.size;
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

  // A THROWN-OUT ROUND SAYS SO NOW (migration 068), and the guess it replaces
  // was wrong far more often than it was right.
  //
  // A disqualified round refunds its wager, which is the whole point of
  // disqualifying — but nothing recorded that a round HAD been disqualified.
  // op_disqualify_round sets every answer in it to wrong-and-worth-nothing, and
  // this function inferred the disqualification back out of exactly that. A
  // round everybody simply got wrong looks identical. In a two-player game that
  // is ordinary, so every such round silently handed its wager back — and
  // 1..N are then no longer used exactly once.
  //
  // Reported: "it only said he bet 1, which he had already used."
  //
  // THE FALLBACK IS NOT COSMETIC. Migrations here are applied by hand, so "the
  // JavaScript is live and the SQL is not" is a real state, and in it every row
  // arrives WITHOUT the column. Reading a missing column as `false` would
  // quietly stop disqualification refunding anything and stop the reveal
  // suppressing a thrown-out round's scoring — a different bug, shipped to
  // cover this one. So it asks whether the column is THERE, and only guesses
  // when it is not.
  const knowsFlag = allAnswers.some(a => a && Object.hasOwn(a, 'disqualified'));

  const disq = new Set();
  for (const [qNum, answers] of Object.entries(byQ)) {
    const thrownOut = knowsFlag
      ? answers.some(a => a.disqualified === true)
      : answers.length > 0 && answers.every(a => !a.is_correct && (a.score_earned || 0) === 0);
    if (thrownOut) disq.add(parseInt(qNum, 10));
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
 * Every difficulty the final question could actually turn out to be.
 *
 * IT IS ALWAYS ALL THREE NOW, and that is a consequence of the owner's upset
 * rule rather than a shortcut. An unvoted level carries a fixed share of
 * DIFFICULTY_UPSET_CHANCE, so nothing is ever impossible and the wheel showing
 * three pills is the honest picture in every room.
 *
 * It used to be "the most-voted level and everything harder", because the vote
 * acted as a FLOOR. That had two consequences the owner did not want: a room
 * unanimous on Medium could never get Easy, and a room unanimous on Hard had no
 * surprise available at all — the wheel showed one pill and the outcome was
 * certain. The upset is the same 1 in 20 everywhere now, so the floor is gone.
 *
 * The function stays rather than being inlined: it is the one place that
 * answers "what can happen", and the wheel and the picker must not be able to
 * disagree about it. That was the whole reason it was extracted.
 */
export function allowedDifficulties(_tally) {
  return ['easy', 'medium', 'hard'];
}

/**
 * Pick the actual final-question difficulty from a vote tally.
 *
 * THE UPSET IS ALWAYS 1 IN 20. The levels somebody voted for share
 * (1 - DIFFICULTY_UPSET_CHANCE) in proportion to their votes; the levels
 * nobody voted for share DIFFICULTY_UPSET_CHANCE equally between them.
 *
 *   votes={easy:1}                  → easy 95%,  medium 2.5%, hard 2.5%
 *   votes={easy:3}                  → easy 95%,  medium 2.5%, hard 2.5%
 *   votes={easy:1,hard:1}           → easy 47.5%, hard 47.5%, medium 5%
 *   votes={easy:2,hard:1}           → easy 63.3%, hard 31.7%, medium 5%
 *   votes={hard:4}                  → hard 95%,  easy 2.5%,  medium 2.5%
 *   every level voted for           → proportional, no upset left to give
 *   no votes                        → uniform over all three
 *
 * WHY A FIXED SHARE RATHER THAN A FIXED WEIGHT. The old rule gave an unvoted
 * level a weight of 0.1 against the raw vote counts, so the surprise got rarer
 * the more people voted — 8.4% each in a room of one, 4.5% with two, 3.1% with
 * three — and vanished entirely when the room agreed on Hard, because the vote
 * was also a floor. The owner asked for one number that holds everywhere:
 * "that's a lot of games needed to be played, but not negligible."
 *
 * A ROOM THAT VOTED FOR EVERY LEVEL GETS NO UPSET, and that is correct rather
 * than an edge case: there is nothing left to be surprised by. The votes are
 * simply proportional.
 *
 * Pass `randFn` to make this deterministic in tests.
 */
export function pickWeightedDifficulty(tally, randFn = Math.random) {
  const order = ['easy', 'medium', 'hard'];
  const counts = order.map(d => (tally && tally[d]) || 0);
  const votes = counts.reduce((a, b) => a + b, 0);
  if (votes === 0) return order[Math.floor(randFn() * 3)];

  const unvoted = counts.filter(c => c === 0).length;
  const upsetEach = unvoted > 0 ? DIFFICULTY_UPSET_CHANCE / unvoted : 0;
  const votedShare = unvoted > 0 ? 1 - DIFFICULTY_UPSET_CHANCE : 1;
  const weights = counts.map(c => (c === 0 ? upsetEach : votedShare * (c / votes)));

  let r = randFn();
  for (let i = 0; i < order.length; i++) {
    r -= weights[i];
    if (r <= 0) return order[i];
  }
  return order[order.length - 1];
}
