import { describe, it, expect } from 'vitest';
import {
  cumulativeSeries, rankPlayers, podiumSlots, ordinal, glide, replayValueAt, replayEnd, barSize, PODIUM_TIMING,
} from '../js/game/podium-logic.js';

describe('cumulativeSeries', () => {
  it('starts at 0, adds each round, and ends with the final wager', () => {
    const answers = [
      { player_id: 'a', question_number: 0, score_earned: 3 },
      { player_id: 'a', question_number: 1, score_earned: 0 },
      { player_id: 'a', question_number: 2, score_earned: -10 },   // the final wager, round N
      { player_id: 'b', question_number: 1, score_earned: 2 },
    ];
    const s = cumulativeSeries(answers, ['a', 'b'], 2);
    expect(s.a).toEqual([0, 3, 3, -7]);
    expect(s.b).toEqual([0, 0, 2, 2]);
  });
  it('ignores rows outside the game', () => {
    const s = cumulativeSeries([{ player_id: 'a', question_number: 9, score_earned: 50 }], ['a'], 2);
    expect(s.a).toEqual([0, 0, 0, 0]);
  });
});

describe('ranking and where people stand', () => {
  const P = (id, sc) => ({ id, sc });
  const score = p => p.sc;
  it('ties share a place and the next place skips', () => {
    expect(rankPlayers([P(1, 9), P(2, 9), P(3, 4)], score)).toEqual([1, 1, 3]);
  });
  it('three or more stand silver, gold, bronze — gold in the middle', () => {
    const slots = podiumSlots([P('g', 30), P('s', 20), P('b', 10), P('x', 5)], score);
    expect(slots.map(s => s.player.id)).toEqual(['s', 'g', 'b']);
    expect(slots.map(s => s.medal)).toEqual([2, 1, 3]);
  });
  it('two players read left to right: gold first', () => {
    expect(podiumSlots([P('g', 30), P('s', 20)], score).map(s => s.medal)).toEqual([1, 2]);
  });
  it('a tie for first is two golds', () => {
    expect(podiumSlots([P('a', 9), P('b', 9), P('c', 1)], score).map(s => s.medal)).toEqual([1, 1, 3]);
  });
  it('ordinals', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101].map(ordinal))
      .toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '101st']);
  });
});

describe('the replay glides and never stops (the owner: "choppy")', () => {
  const ys = [0, 2, 2, 7, 7, 12, 18, 18, 25];   // flat stretches: wrong answers
  it('starts and ends exactly on the real scores', () => {
    expect(glide(ys, 0)).toBeCloseTo(0, 6);
    expect(glide(ys, ys.length - 1)).toBeCloseTo(25, 6);
  });
  it('keeps moving through every flat stretch', () => {
    const N = ys.length - 1;
    for (let i = 1; i <= 100; i++) {
      const step = glide(ys, i / 100 * N) - glide(ys, (i - 1) / 100 * N);
      expect(step).toBeGreaterThan(0);
    }
  });
  it('takes the same time for 8 questions as for 20', () => {
    const short = [0, 1, 2, 3, 4, 5, 6, 7, 8, 8];
    const long = [...Array(21).keys(), 20];
    const end = replayEnd();
    expect(replayValueAt(short, end)).toBeCloseTo(8, 6);
    expect(replayValueAt(long, end)).toBeCloseTo(20, 6);
    expect(replayValueAt(long, PODIUM_TIMING.LEAD + PODIUM_TIMING.RUN)).toBeCloseTo(20, 6);
  });
  it('the final wager lands exactly on the final score', () => {
    expect(replayValueAt([0, 4, 10, -10], replayEnd())).toBeCloseTo(-10, 6);
  });
});

describe('bar sizes: gold is fixed, everybody else in proportion', () => {
  const geo = { winner: 30, scale: 30, upPx: 200, downPx: 40 };
  it('the winner fills the whole step', () => {
    expect(barSize(30, geo)).toEqual({ up: 200, down: 0 });
  });
  it('half the points is half the height', () => {
    expect(barSize(15, geo).up).toBeCloseTo(100);
  });
  it('a negative hangs in the same proportion, and is not clamped to the screen', () => {
    expect(barSize(-60, geo)).toEqual({ up: 0, down: 400 });
  });
  it('when everybody is below zero the winner always hangs the same small drop', () => {
    const neg = { winner: -2, scale: 0, upPx: 200, downPx: 40 };
    expect(barSize(-2, neg).down).toBeCloseTo(40);
    expect(barSize(-8, neg).down).toBeCloseTo(160);
  });
});
