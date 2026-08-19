import { describe, it, expect } from 'vitest';
import { pickBotWager, chooseBotAnswer } from '../js/game/bot-logic.js';

// ============================================
// pickBotWager
//
// The rule that matters is "never spend the same wager twice" — values 1..N
// are each used exactly once, and a bot breaking that would let it score more
// than the game allows.
// ============================================
describe('pickBotWager', () => {
  it('only ever returns a wager that has not been spent', () => {
    const used = new Set([1, 2, 5]);
    // Every possible random draw, not a sample: with 7 questions and 3 spent
    // there are only 4 outcomes, so this is exhaustive rather than lucky.
    for (const r of [0, 0.24, 0.25, 0.49, 0.5, 0.74, 0.75, 0.99]) {
      const w = pickBotWager(used, 7, () => r);
      expect(used.has(w)).toBe(false);
      expect(w).toBeGreaterThanOrEqual(1);
      expect(w).toBeLessThanOrEqual(7);
    }
  });

  it('can reach every remaining wager', () => {
    const used = new Set([2]);
    const seen = new Set();
    for (const r of [0, 0.34, 0.67, 0.99]) seen.add(pickBotWager(used, 5, () => r));
    expect([...seen].sort()).toEqual([1, 3, 4, 5]);
  });

  it('returns the only wager left when one remains', () => {
    expect(pickBotWager(new Set([1, 2, 3, 5]), 5, () => 0.9)).toBe(4);
  });

  it('falls back to 1 when everything is spent', () => {
    expect(pickBotWager(new Set([1, 2, 3]), 3, () => 0.9)).toBe(1);
  });

  it('spends each wager exactly once across a whole game', () => {
    const used = new Set();
    const rand = () => 0.999;   // always the last remaining option
    for (let i = 0; i < 6; i++) {
      const w = pickBotWager(used, 6, rand);
      expect(used.has(w)).toBe(false);
      used.add(w);
    }
    expect([...used].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

// ============================================
// chooseBotAnswer
//
// The point of this function is that NO WRONG ANSWER IS EVER INVENTED. A miss
// comes from the question's own stored distractors, or it is blank.
// ============================================
describe('chooseBotAnswer', () => {
  const q = { correctAnswer: 'Paris', incorrectAnswers: ['Lyon', 'Marseille', 'Nice'] };

  it('answers correctly when the roll is under the accuracy', () => {
    const r = chooseBotAnswer(q, { accuracy: 0.5, rand: () => 0.49 });
    expect(r).toEqual({ text: 'Paris', isCorrect: true });
  });

  it('misses when the roll is at or above the accuracy', () => {
    const r = chooseBotAnswer(q, { accuracy: 0.5, rand: () => 0.5 });
    expect(r.isCorrect).toBe(false);
    expect(q.incorrectAnswers).toContain(r.text);
  });

  it('never invents a wrong answer — a miss is always one of the stored ones', () => {
    for (const r of [0.5, 0.6, 0.7, 0.8, 0.9, 0.99]) {
      const out = chooseBotAnswer(q, { accuracy: 0.5, rand: () => r });
      expect(out.isCorrect).toBe(false);
      expect(q.incorrectAnswers).toContain(out.text);
    }
  });

  it('answers blank when the question has no stored wrong answers', () => {
    const bare = { correctAnswer: 'Paris', incorrectAnswers: [] };
    expect(chooseBotAnswer(bare, { accuracy: 0.5, rand: () => 0.9 }))
      .toEqual({ text: '', isCorrect: false });
  });

  it('answers blank when incorrect_answers is missing or not an array', () => {
    expect(chooseBotAnswer({ correctAnswer: 'Paris' }, { accuracy: 0, rand: () => 0.9 }).text).toBe('');
    expect(chooseBotAnswer({ correctAnswer: 'Paris', incorrectAnswers: 'Lyon' }, { accuracy: 0, rand: () => 0.9 }).text).toBe('');
  });

  it('ignores blank and non-string entries in the stored wrong answers', () => {
    const messy = { correctAnswer: 'Paris', incorrectAnswers: ['', '   ', null, 42, 'Lyon'] };
    for (const r of [0.5, 0.75, 0.99]) {
      expect(chooseBotAnswer(messy, { accuracy: 0, rand: () => r }).text).toBe('Lyon');
    }
  });

  it('accuracy 0 never answers correctly and accuracy 1 always does', () => {
    for (const r of [0, 0.5, 0.999]) {
      expect(chooseBotAnswer(q, { accuracy: 0, rand: () => r }).isCorrect).toBe(false);
      expect(chooseBotAnswer(q, { accuracy: 1, rand: () => r }).isCorrect).toBe(true);
    }
  });

  it('lands near the stated accuracy over many draws', () => {
    // Not a test of Math.random — a test that the comparison is the right way
    // round. A flipped comparison would come out at 20%, not 80%.
    let hits = 0;
    for (let i = 0; i < 1000; i++) {
      if (chooseBotAnswer(q, { accuracy: 0.8, rand: () => i / 1000 }).isCorrect) hits++;
    }
    expect(hits).toBe(800);
  });
});
