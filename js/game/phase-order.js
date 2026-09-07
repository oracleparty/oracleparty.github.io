// ============================================
// Oracle Party — Phase Order
//
// One question, asked in one place: a phone that was BACKGROUNDED has just
// re-read the room. Should it move to the phase the room reports?
//
// NO IMPORTS, so it can be unit tested in Node. Everything in js/game/ pulls
// the Supabase client from esm.sh and the test runner cannot load it, which is
// why this rule lived inline in init.js and went unchecked.
// ============================================

/**
 * The phases a game passes through, in the order a SINGLE ROUND passes them.
 *
 * THIS IS NOT A GRAPH AND MUST NOT BECOME ONE. A game's rounds cycle —
 * question, reveal, scores, question again — so no flat list can describe the
 * whole thing. CLAUDE.md records two attempts to write a phase graph, one flat
 * and one per-round, and each made the game unplayable at one specific moment:
 * a wrong entry does not fail loudly, it silently discards the one event that
 * mattered. This list is only ever consulted WITHIN one round number, which is
 * the only place it is meaningful.
 */
const PHASE_ORDER = [
  'countdown', 'question', 'reveal', 'answer_reveal', 'scores_reveal',
  'difficulty_vote', 'final_wager', 'final_question', 'results',
];

/** The final round's own phases, which sit at the END of that list. */
const FINAL_ROUND_PHASES = ['difficulty_vote', 'final_wager', 'final_question'];

/**
 * The phases that END a round, wherever in the list they happen to sit.
 *
 * `scores_reveal` BELONGS HERE and was missing, which is the same bug this
 * exception exists for, one step further along. After EVERY reveal — the final
 * round included — the advance button reads "Show Scores" and writes
 * `game_phase = 'scores_reveal'` without touching the question number
 * (`handleShowScores` in scores.js). So the final round really does run
 * `final_question -> reveal -> answer_reveal -> scores_reveal -> results`, and
 * with only the first two listed, a phone sitting on `final_question` refused
 * the scoreboard as backwards and sat there — exactly what it used to do to the
 * reveal itself.
 */
const REVEAL_PHASES = ['reveal', 'answer_reveal', 'scores_reveal'];

/**
 * May a returning phone move from `current` to the room's `incoming` phase?
 *
 * The rule is "do not sync BACKWARDS": a stale read must not drag a client to
 * an earlier phase than it has already reached.
 *
 * THE FINAL ROUND RUNS PAST THE END OF THE LIST, and that was a real bug. A
 * round's reveal comes after its question — but on the final round the question
 * is `final_question` (index 7) while the reveal is `reveal` (2) or
 * `answer_reveal` (3). So a phone backgrounded across the final question came
 * back, read the room's real phase, and refused it as backwards: it sat on the
 * final question through the whole reveal — nobody's answers, no verdicts, no
 * host rating — and only escaped when the room reached `results`.
 *
 * That is stated here as the ONE EXCEPTION rather than by reordering the list,
 * because reordering it breaks the regular rounds that currently work.
 *
 * Unknown phases fail OPEN. A phase this list has never heard of is more likely
 * to be new than to be stale, and refusing it would freeze a screen — the
 * failure this whole function exists to prevent.
 */
export function shouldSyncPhase(current, incoming) {
  if (!incoming || incoming === current) return false;

  // A round's reveal is never backwards from that round's own question.
  if (FINAL_ROUND_PHASES.includes(current) && REVEAL_PHASES.includes(incoming)) return true;

  const currentIdx = PHASE_ORDER.indexOf(current);
  const incomingIdx = PHASE_ORDER.indexOf(incoming);
  if (currentIdx === -1 || incomingIdx === -1) return true;
  return incomingIdx > currentIdx;
}

/**
 * Is this room event describing a moment this client has already passed?
 *
 * REPORTED FROM A LIVE GAME: "during a live round, one of the later questions
 * was buggy and jumped to a different screen then back to the question."
 *
 * `handleRoomChange` applied every room event unconditionally — the phase AND
 * `state.currentQuestion`. Realtime does not guarantee order or timeliness, so
 * an event that left the server before the one already applied could arrive
 * after it and drag the screen backwards. `scenario-badnetwork` recorded
 * exactly that at a 1500ms round trip:
 *
 *     phase-in answer_reveal   a STALE event, 1500ms late, arrives while the
 *                              client is already on scores_reveal, and drags
 *                              the screen back to the reveal
 *
 * CLAUDE.md has carried that finding as "established and NOT fixed" since,
 * because the two previous attempts at a phase guard each made the game
 * unplayable at one specific moment. This is deliberately narrower than both:
 *
 *   * A ROUND NUMBER THAT IS BEHIND OURS can only be an echo of the past. The
 *     room never goes back a round — Play Again resets it to 0, and both
 *     paths to that (status 'lobby', and the new-game notice) are intercepted
 *     by the caller before this is asked.
 *   * WITHIN ONE ROUND, and only there, the phase list is meaningful, so a
 *     strictly earlier phase for the SAME round number is stale.
 *
 * EVERYTHING ELSE IS LET THROUGH, including the case that broke both earlier
 * attempts: `scores_reveal` -> `question` for the next round carries a HIGHER
 * question number, so the phase list is never consulted and the round advances
 * exactly as before.
 *
 * The failure direction is recoverable by construction: syncToCurrentState
 * re-reads the room and applies it without asking this, so a client that ever
 * did wrongly refuse an event is corrected by the next poll rather than stuck.
 */
export function isStaleRoomEvent({ incomingPhase, incomingQuestion, currentPhase, currentQuestion }) {
  const haveNumbers = Number.isInteger(incomingQuestion) && Number.isInteger(currentQuestion);

  // A round we have already left.
  if (haveNumbers && incomingQuestion < currentQuestion) return true;

  // Within one round, an earlier phase than the one we are on.
  const sameRound = !haveNumbers || incomingQuestion === currentQuestion;
  if (!sameRound) return false;
  if (!incomingPhase || !currentPhase) return false;
  if (incomingPhase === currentPhase) return false;
  return !shouldSyncPhase(currentPhase, incomingPhase);
}
