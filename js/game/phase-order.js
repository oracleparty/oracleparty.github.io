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

/** The phases that END a round, wherever in the list they happen to sit. */
const REVEAL_PHASES = ['reveal', 'answer_reveal'];

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
