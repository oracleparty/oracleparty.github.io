import { describe, it, expect } from 'vitest';
import { shouldSyncPhase, isStaleRoomEvent, screenStillFits } from '../js/game/phase-order.js';

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

// ============================================
// isStaleRoomEvent — a room event describing a moment already passed
// ============================================
describe('isStaleRoomEvent', () => {
  const at = (phase, q) => ({ currentPhase: phase, currentQuestion: q });
  const from = (phase, q) => ({ incomingPhase: phase, incomingQuestion: q });
  const ev = (cur, inc) => isStaleRoomEvent({ ...at(...cur), ...from(...inc) });

  it('refuses an earlier phase in the SAME round — the reported drag-back', () => {
    // scenario-badnetwork's own trace, at a 1500ms round trip.
    expect(ev(['scores_reveal', 0], ['answer_reveal', 0])).toBe(true);
  });

  it('refuses an event from a round we have already left', () => {
    expect(ev(['question', 3], ['scores_reveal', 2])).toBe(true);
  });

  it('LETS THE NEXT ROUND THROUGH, which is what broke both earlier attempts', () => {
    // scores_reveal -> question ranks backwards on the phase list, and a guard
    // that consulted the list here would stall every game after round one.
    expect(ev(['scores_reveal', 0], ['question', 1])).toBe(false);
  });

  it('lets an ordinary forward move through', () => {
    expect(ev(['question', 2], ['reveal', 2])).toBe(false);
    expect(ev(['reveal', 2], ['answer_reveal', 2])).toBe(false);
  });

  it('lets the same phase through, so the existing same-phase guards decide', () => {
    expect(ev(['question', 1], ['question', 1])).toBe(false);
  });

  it('lets the FINAL round reveal through, the bug the exception exists for', () => {
    expect(ev(['final_question', 5], ['reveal', 5])).toBe(false);
    expect(ev(['final_question', 5], ['answer_reveal', 5])).toBe(false);
  });

  it('lets the final round build through in order', () => {
    expect(ev(['difficulty_vote', 5], ['final_wager', 5])).toBe(false);
    expect(ev(['final_wager', 5], ['final_question', 5])).toBe(false);
    expect(ev(['final_question', 5], ['results', 5])).toBe(false);
  });

  it('fails OPEN on a phase it has never heard of', () => {
    expect(ev(['question', 1], ['brand_new_phase', 1])).toBe(false);
    expect(ev(['loading', 1], ['reveal', 1])).toBe(false);
  });

  it('fails OPEN when a round number is missing', () => {
    expect(isStaleRoomEvent({
      incomingPhase: 'question', incomingQuestion: undefined,
      currentPhase: 'question', currentQuestion: 1,
    })).toBe(false);
  });

  it('a hot-joiner at question 0 is not told the room is stale', () => {
    expect(ev(['loading', 0], ['question', 4])).toBe(false);
  });
});

// ============================================
// The final round's SCOREBOARD, which the first version of the exception missed
// ============================================
describe('the final round runs past the end of the list, all the way to results', () => {
  it('a phone on the final question may follow the room to the scoreboard', () => {
    // handleShowScores writes scores_reveal after EVERY reveal, the final round
    // included, and leaves current_question alone. With scores_reveal missing
    // from the exception a client still on final_question refused it and sat
    // there — the same fault the reveal itself used to have.
    expect(shouldSyncPhase('final_question', 'scores_reveal')).toBe(true);
    expect(shouldSyncPhase('final_wager', 'scores_reveal')).toBe(true);
  });

  it('and the room event carrying it is not called stale', () => {
    expect(isStaleRoomEvent({
      incomingPhase: 'scores_reveal', incomingQuestion: 5,
      currentPhase: 'final_question', currentQuestion: 5,
    })).toBe(false);
  });

  it('a PREVIOUS round\'s scoreboard is still stale, because the round number says so', () => {
    expect(isStaleRoomEvent({
      incomingPhase: 'scores_reveal', incomingQuestion: 4,
      currentPhase: 'final_question', currentQuestion: 5,
    })).toBe(true);
  });

  it('results is still reachable from the final question', () => {
    expect(shouldSyncPhase('final_question', 'results')).toBe(true);
  });

  it('an ordinary round is unchanged', () => {
    expect(shouldSyncPhase('question', 'scores_reveal')).toBe(true);
    expect(shouldSyncPhase('scores_reveal', 'answer_reveal')).toBe(false);
    expect(shouldSyncPhase('scores_reveal', 'question')).toBe(false);
  });
});

// ============================================
// screenStillFits
//
// The reveal and the scoreboard each fetch BEFORE they switch the screen. On a
// slow link the phone can move on while that read is out, and the late screen
// then covered the one that belongs to where the phone really is. Reported from
// a real game on 2026-10-23: a friend left on the scoreboard while the room was
// asking question 2, until the host pressed Reveal.
// ============================================
describe('screenStillFits', () => {
  const fits = (screen, phase, question, renderedFor, submitted = false) =>
    screenStillFits({ screen, phase, question, renderedFor, submitted });

  it('lets the scoreboard up while the phone is still on that round\'s scores', () => {
    expect(fits('scores-screen', 'scores_reveal', 0, 0)).toBe(true);
  });

  // THE REPORTED BUG. The scoreboard for question 1 came back after question 2
  // had arrived and drawn itself.
  it('does not put a scoreboard over the next question', () => {
    expect(fits('scores-screen', 'question', 1, 0)).toBe(false);
  });

  it('does not put a scoreboard up once its round has moved past scores', () => {
    expect(fits('scores-screen', 'final_wager', 4, 4)).toBe(false);
    expect(fits('scores-screen', 'results', 5, 5)).toBe(false);
  });

  it('lets the reveal up on its own round\'s reveal phases', () => {
    expect(fits('reveal-screen', 'reveal', 2, 2)).toBe(true);
    expect(fits('reveal-screen', 'answer_reveal', 2, 2)).toBe(true);
  });

  // After Submit a player waits on the reveal screen while the room is still
  // asking the question. Refusing that would leave somebody who has answered
  // staring at a question they can no longer change.
  it('lets the reveal up during the question once this phone has answered', () => {
    expect(fits('reveal-screen', 'question', 2, 2, true)).toBe(true);
    expect(fits('reveal-screen', 'final_question', 5, 5, true)).toBe(true);
  });

  it('does not cover a question this phone has not answered', () => {
    expect(fits('reveal-screen', 'question', 2, 2, false)).toBe(false);
  });

  it('does not put a finished round\'s reveal over the scoreboard or the next question', () => {
    expect(fits('reveal-screen', 'scores_reveal', 2, 2, true)).toBe(false);
    expect(fits('reveal-screen', 'question', 3, 2, false)).toBe(false);
    expect(fits('reveal-screen', 'question', 3, 2, true)).toBe(false);
  });
});
