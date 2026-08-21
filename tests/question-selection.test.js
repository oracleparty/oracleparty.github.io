// ============================================
// Question selection buckets
//
// Nothing tested this before, and the rule was wrong in a way that could only
// be seen over months of play: the redemption pool never shrank. A question you
// missed once and have since learned read times_seen=2, times_correct=1 —
// "not right every time" so it could never be filed as mastered, and "wrong at
// least once" so it stayed eligible for the redemption draw for life. The same
// old questions kept resurfacing long after they were known, and the draw rate
// was never the cause.
//
// bucketQuestionsByHistory is pure and takes its history as an argument, so it
// can be tested without a database.
// ============================================
import { describe, it, expect } from 'vitest';
import { bucketQuestionsByHistory } from '../js/question-selection.js';

const Q = ['q1', 'q2', 'q3', 'q4'].map(id => ({ id }));
const at = (d) => new Date(Date.now() - d * 86400000).toISOString();

// One player's row for one question.
const row = (question_id, { seen, correct, last }) => ({
  user_id: 'u1', question_id,
  times_seen: seen, times_correct: correct, last_correct: last,
  last_seen_at: at(1),
});

describe('bucketQuestionsByHistory', () => {
  it('a question nobody signed in has met is fresh', () => {
    const b = bucketQuestionsByHistory(Q, [], ['u1']);
    expect(b.fresh.map(q => q.id).sort()).toEqual(['q1', 'q2', 'q3', 'q4']);
    expect(b.redemption).toHaveLength(0);
    expect(b.mastered).toHaveLength(0);
  });

  it('a question they currently get wrong is up for redemption', () => {
    const b = bucketQuestionsByHistory(Q, [row('q1', { seen: 1, correct: 0, last: false })], ['u1']);
    expect(b.redemption.map(q => q.id)).toEqual(['q1']);
  });

  it('LEARNING one moves it out of redemption for good', () => {
    // This is the whole bug. Wrong, then right: the attempt counters still say
    // "has been wrong", but they know it now.
    const learned = row('q1', { seen: 2, correct: 1, last: true });
    const b = bucketQuestionsByHistory(Q, [learned], ['u1']);
    expect(b.redemption.map(q => q.id)).toEqual([]);
    expect(b.mastered.map(q => q.id)).toEqual(['q1']);
  });

  it('and FORGETTING one brings it back', () => {
    // Right, then wrong. The mirror case — the pool has to shrink and grow.
    const forgotten = row('q1', { seen: 2, correct: 1, last: false });
    const b = bucketQuestionsByHistory(Q, [forgotten], ['u1']);
    expect(b.redemption.map(q => q.id)).toEqual(['q1']);
    expect(b.mastered.map(q => q.id)).toEqual([]);
  });

  it('one player still missing it keeps it in redemption for the room', () => {
    const h = [
      { ...row('q1', { seen: 3, correct: 3, last: true }) },
      { ...row('q1', { seen: 1, correct: 0, last: false }), user_id: 'u2' },
    ];
    const b = bucketQuestionsByHistory(Q, h, ['u1', 'u2']);
    expect(b.redemption.map(q => q.id)).toEqual(['q1']);
  });

  it('everyone knowing it sends it to the back of the queue', () => {
    const h = [
      row('q1', { seen: 1, correct: 1, last: true }),
      { ...row('q1', { seen: 4, correct: 2, last: true }), user_id: 'u2' },
    ];
    const b = bucketQuestionsByHistory(Q, h, ['u1', 'u2']);
    expect(b.mastered.map(q => q.id)).toEqual(['q1']);
    expect(b.redemption).toHaveLength(0);
  });

  it('falls back to the attempt counters when last_correct is null', () => {
    // Rows predating migration 016. Reading a null as "never knew it" would
    // dump every old row straight into redemption.
    const old = { user_id: 'u1', question_id: 'q1', times_seen: 2, times_correct: 2,
                  last_correct: null, last_seen_at: at(30) };
    const b = bucketQuestionsByHistory(Q, [old], ['u1']);
    expect(b.mastered.map(q => q.id)).toEqual(['q1']);
  });

  it('when a repeat is unavoidable it picks the stalest one', () => {
    const h = [
      { ...row('q1', { seen: 1, correct: 1, last: true }), last_seen_at: at(1) },
      { ...row('q2', { seen: 1, correct: 1, last: true }), last_seen_at: at(90) },
    ];
    const b = bucketQuestionsByHistory(Q, h, ['u1']);
    // Both mastered, so both are last resort — but the one seen 90 days ago
    // comes first. A forced repeat should at least feel like a while ago.
    expect(b.mastered.map(q => q.id)).toEqual(['q2', 'q1']);
  });
});
