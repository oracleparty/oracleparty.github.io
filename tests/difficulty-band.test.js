import { describe, it, expect } from 'vitest';
import { describeDifficulty, MIN_PLAYS_FOR_MEASURED_DIFFICULTY } from '../js/difficulty-band.js';

// The point of these is the SWITCH. There is essentially no play data yet — the
// last probe read game_plays at 9 rows — so a percentage would be noise for a
// long time. The stored difficulty covers that gap, and the measured one takes
// over silently once a question has actually been played enough to speak.

describe('describeDifficulty — before there is data', () => {
  it('uses the stored difficulty', () => {
    expect(describeDifficulty({ storedDifficulty: 'easy' }))
      .toMatchObject({ label: 'Easy', measured: false, detail: '' });
    expect(describeDifficulty({ storedDifficulty: 'hard' }))
      .toMatchObject({ label: 'Hard', measured: false });
  });

  it('accepts whatever case the column happens to hold', () => {
    expect(describeDifficulty({ storedDifficulty: 'MEDIUM' }).label).toBe('Medium');
  });

  // A handful of plays is exactly the case the owner flagged. It must not
  // produce a percentage.
  it('does not print a percentage from a handful of plays', () => {
    const d = describeDifficulty({ storedDifficulty: 'medium', timesAsked: 3, timesCorrect: 0 });
    expect(d.measured).toBe(false);
    expect(d.label).toBe('Medium');
    expect(d.detail).toBe('');
  });

  it('holds out until the very last play below the threshold', () => {
    const justUnder = MIN_PLAYS_FOR_MEASURED_DIFFICULTY - 1;
    expect(describeDifficulty({ storedDifficulty: 'easy', timesAsked: justUnder, timesCorrect: 0 }).measured)
      .toBe(false);
  });

  // Better an empty slot than an invented word.
  it('says nothing when there is no stored value and no data', () => {
    expect(describeDifficulty({})).toBe(null);
    expect(describeDifficulty()).toBe(null);
    expect(describeDifficulty({ storedDifficulty: 'nonsense' })).toBe(null);
  });
});

describe('describeDifficulty — once it has been played', () => {
  const played = (correct, asked = MIN_PLAYS_FOR_MEASURED_DIFFICULTY) =>
    describeDifficulty({ storedDifficulty: 'medium', timesAsked: asked, timesCorrect: correct });

  it('switches over at the threshold', () => {
    const d = played(10);
    expect(d.measured).toBe(true);
    expect(d.plays).toBe(MIN_PLAYS_FOR_MEASURED_DIFFICULTY);
  });

  it('bands by how many people get it right', () => {
    expect(played(20).label).toBe('Easy');       // 100%
    expect(played(15).label).toBe('Easy');       // 75%
    expect(played(14).label).toBe('Medium');     // 70%
    expect(played(10).label).toBe('Medium');     // 50%
    expect(played(9).label).toBe('Hard');        // 45%
    expect(played(5).label).toBe('Hard');        // 25%
    expect(played(4).label).toBe('Very Hard');   // 20%
    expect(played(0).label).toBe('Very Hard');   // 0%
  });

  // The stored value stops mattering once there is something real.
  it('overrides the stored difficulty', () => {
    const d = describeDifficulty({ storedDifficulty: 'easy', timesAsked: 40, timesCorrect: 2 });
    expect(d.label).toBe('Very Hard');
    expect(d.measured).toBe(true);
  });

  // The sample is part of the claim. "12%" and "12% of 20 plays" are different
  // statements and printing the first as if it were the second is how a number
  // built on nothing gets believed.
  it('always says what the percentage is based on', () => {
    const d = describeDifficulty({ storedDifficulty: 'hard', timesAsked: 37, timesCorrect: 12 });
    expect(d.detail).toMatch(/32%/);
    expect(d.detail).toMatch(/37 plays/);
  });

  // A host flipping judgements can in principle push times_correct past
  // times_asked, and an unclamped ratio would fall out of the bands entirely
  // and render nothing at all.
  it('survives more correct answers than plays', () => {
    const d = describeDifficulty({ storedDifficulty: 'easy', timesAsked: 20, timesCorrect: 25 });
    expect(d.label).toBe('Easy');
    expect(d.detail).toMatch(/100%/);
  });
});
