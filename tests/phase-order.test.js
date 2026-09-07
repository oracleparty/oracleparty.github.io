import { describe, it, expect } from 'vitest';
import { shouldSyncPhase } from '../js/game/phase-order.js';

// ============================================
// shouldSyncPhase
//
// A phone that was BACKGROUNDED has re-read the room. Should it move to the
// phase the room reports?
//
// This rule lived inline in js/game/init.js and could not be tested there —
// everything in js/game/ pulls the Supabase client from esm.sh, so the module
// cannot be imported in Node. It had a real bug in it for as long as it has
// existed, and nothing could see it.
// ============================================
describe('shouldSyncPhase', () => {
  it('advances through a regular round', () => {
    expect(shouldSyncPhase('question', 'reveal')).toBe(true);
    expect(shouldSyncPhase('reveal', 'answer_reveal')).toBe(true);
    expect(shouldSyncPhase('answer_reveal', 'scores_reveal')).toBe(true);
    expect(shouldSyncPhase('countdown', 'question')).toBe(true);
  });

  it('refuses to go backwards within a round', () => {
    expect(shouldSyncPhase('scores_reveal', 'reveal')).toBe(false);
    expect(shouldSyncPhase('answer_reveal', 'question')).toBe(false);
    expect(shouldSyncPhase('results', 'scores_reveal')).toBe(false);
  });

  it('does nothing when the room is where we already are', () => {
    expect(shouldSyncPhase('question', 'question')).toBe(false);
    expect(shouldSyncPhase('final_question', 'final_question')).toBe(false);
  });

  // THE BUG. A round's reveal comes after its question — but on the final round
  // the question is `final_question` (index 7 of the order) while the reveal is
  // `reveal` (2) or `answer_reveal` (3), so the flat comparison called it
  // BACKWARDS. A phone backgrounded across the final question came back and sat
  // there through the entire reveal: nobody's answers, no verdicts, no host
  // rating. It only escaped when the room reached `results`.
  //
  // `wasHidden` is not a rare path — it fires on any backgrounding: a locked
  // phone, a notification, switching apps.
  it('follows the room out of the FINAL question into its reveal', () => {
    expect(shouldSyncPhase('final_question', 'reveal')).toBe(true);
    expect(shouldSyncPhase('final_question', 'answer_reveal')).toBe(true);
  });

  it('follows the room out of the other final-round phases too', () => {
    // The whole final round sits past the reveal phases in the order, so every
    // one of them had the same problem.
    for (const from of ['difficulty_vote', 'final_wager', 'final_question']) {
      expect(shouldSyncPhase(from, 'reveal')).toBe(true);
      expect(shouldSyncPhase(from, 'answer_reveal')).toBe(true);
    }
  });

  it('still advances through the final round in order', () => {
    expect(shouldSyncPhase('scores_reveal', 'difficulty_vote')).toBe(true);
    expect(shouldSyncPhase('difficulty_vote', 'final_wager')).toBe(true);
    expect(shouldSyncPhase('final_wager', 'final_question')).toBe(true);
    expect(shouldSyncPhase('final_question', 'results')).toBe(true);
  });

  // The exception is for a round's own reveal, not a licence to go anywhere.
  it('does not let the final round fall back to an earlier question phase', () => {
    expect(shouldSyncPhase('final_question', 'final_wager')).toBe(false);
    expect(shouldSyncPhase('final_wager', 'difficulty_vote')).toBe(false);
    expect(shouldSyncPhase('final_question', 'countdown')).toBe(false);
    expect(shouldSyncPhase('final_question', 'question')).toBe(false);
  });

  // FAIL OPEN. A phase this list has never heard of is likelier to be new than
  // stale, and refusing it would freeze a screen — the failure the whole
  // function exists to prevent.
  it('allows a phase it does not recognise', () => {
    expect(shouldSyncPhase('question', 'some_new_phase')).toBe(true);
    expect(shouldSyncPhase('a_phase_we_dropped', 'question')).toBe(true);
  });

  it('does nothing without an incoming phase', () => {
    expect(shouldSyncPhase('question', null)).toBe(false);
    expect(shouldSyncPhase('question', undefined)).toBe(false);
    expect(shouldSyncPhase('question', '')).toBe(false);
  });
});
