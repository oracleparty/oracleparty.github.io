import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getServerTimeLeft, getCountdownElapsed, isStampForCurrentRound } from '../js/game/timer-helpers.js';

// ============================================
// getServerTimeLeft
// ============================================
describe('getServerTimeLeft', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('returns full timerSeconds when questionStartedAt is null', () => {
    expect(getServerTimeLeft(null, 0, 30)).toBe(30);
  });

  it('returns full timerSeconds when questionStartedAt is undefined', () => {
    expect(getServerTimeLeft(undefined, 0, 30)).toBe(30);
  });

  it('returns ~timerSeconds when just started', () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const startedAt = new Date(now).toISOString();
    const result = getServerTimeLeft(startedAt, 0, 30);
    expect(result).toBeCloseTo(30, 0);
  });

  it('returns ~half when half elapsed', () => {
    const now = Date.now();
    const startedAt = new Date(now - 15000).toISOString(); // 15s ago
    vi.setSystemTime(now);
    const result = getServerTimeLeft(startedAt, 0, 30);
    expect(result).toBeCloseTo(15, 0);
  });

  it('returns 0 when fully elapsed (clamped)', () => {
    const now = Date.now();
    const startedAt = new Date(now - 60000).toISOString(); // 60s ago
    vi.setSystemTime(now);
    const result = getServerTimeLeft(startedAt, 0, 30);
    expect(result).toBe(0);
  });

  it('accounts for positive server time offset', () => {
    const now = Date.now();
    const startedAt = new Date(now).toISOString();
    vi.setSystemTime(now);
    // Server is 10s ahead → effectively 10s has elapsed
    const result = getServerTimeLeft(startedAt, 10000, 30);
    expect(result).toBeCloseTo(20, 0);
  });

  it('accounts for negative server time offset', () => {
    const now = Date.now();
    const startedAt = new Date(now - 10000).toISOString(); // 10s ago
    vi.setSystemTime(now);
    // Server is 5s behind → effectively only 5s elapsed
    const result = getServerTimeLeft(startedAt, -5000, 30);
    expect(result).toBeCloseTo(25, 0);
  });
});

// ============================================
// getCountdownElapsed
// ============================================
describe('getCountdownElapsed', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('returns 0 when countdownStartedAt is null', () => {
    expect(getCountdownElapsed(null, 0)).toBe(0);
  });

  it('returns 0 when countdownStartedAt is undefined', () => {
    expect(getCountdownElapsed(undefined, 0)).toBe(0);
  });

  it('returns ~0 when just started', () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const startedAt = new Date(now).toISOString();
    const result = getCountdownElapsed(startedAt, 0);
    expect(result).toBeCloseTo(0, -1); // within 10ms
  });

  it('returns ~2000 when started 2 seconds ago', () => {
    const now = Date.now();
    const startedAt = new Date(now - 2000).toISOString();
    vi.setSystemTime(now);
    const result = getCountdownElapsed(startedAt, 0);
    expect(result).toBeCloseTo(2000, -1);
  });

  it('accounts for positive server time offset', () => {
    const now = Date.now();
    const startedAt = new Date(now - 1000).toISOString(); // 1s ago
    vi.setSystemTime(now);
    // Server is 500ms ahead → effectively 1500ms elapsed
    const result = getCountdownElapsed(startedAt, 500);
    expect(result).toBeCloseTo(1500, -1);
  });
});

// ============================================
// isStampForCurrentRound
//
// The rule that decides whether the clock stamp on an arriving room row belongs
// to the round this phone is on. Realtime sends the whole row on every update,
// so a stamp turns up attached to writes that have nothing to do with the
// clock, and the two ways it can be the wrong one each cost a real game:
// "question 4 started with only 4 seconds left".
// ============================================

describe('isStampForCurrentRound', () => {
  const T = 1_700_000_000_000;                       // when we entered the round
  const iso = ms => new Date(ms).toISOString();

  const fresh = { rowQuestion: 3, myQuestion: 3, stampedAt: iso(T + 900), roundEnteredAt: T };

  it('takes the stamp written for the round we are on', () => {
    expect(isStampForCurrentRound(fresh)).toBe(true);
  });

  it('refuses a stamp the row carries for a DIFFERENT round', () => {
    // The write that announces question 4 still holds question 3's stamp.
    expect(isStampForCurrentRound({ ...fresh, rowQuestion: 4, myQuestion: 3 })).toBe(false);
  });

  it('refuses a stamp from before we entered this round', () => {
    // Same round number, but written 40s ago — the previous round's clock,
    // arriving on an unrelated room write in the gap before this one is stamped.
    expect(isStampForCurrentRound({ ...fresh, stampedAt: iso(T - 40_000) })).toBe(false);
  });

  it('absorbs clock skew up to the tolerance, and no further', () => {
    const justBefore = { ...fresh, stampedAt: iso(T - 3_000) };
    expect(isStampForCurrentRound({ ...justBefore, toleranceMs: 5_000 })).toBe(true);
    expect(isStampForCurrentRound({ ...justBefore, toleranceMs: 1_000 })).toBe(false);
  });

  it('treats round 0 as a real round, not as an absent one', () => {
    // 0 is falsy, and a truthiness test here would accept round 0's stamp for
    // every round in the game.
    expect(isStampForCurrentRound({ ...fresh, rowQuestion: 0, myQuestion: 5 })).toBe(false);
    expect(isStampForCurrentRound({ ...fresh, rowQuestion: 0, myQuestion: 0 })).toBe(true);
  });

  it('compares round numbers across types', () => {
    // current_question arrives from the database; state.currentQuestion is a
    // local number. Everywhere else in this app that mismatch was a silent
    // no-match rather than an error.
    expect(isStampForCurrentRound({ ...fresh, rowQuestion: '3', myQuestion: 3 })).toBe(true);
  });

  it('accepts when we cannot judge — a reconnect', () => {
    // init.js has already read the room's real state. Refusing here would leave
    // a returning player running no clock while everybody else runs one.
    expect(isStampForCurrentRound({ ...fresh, roundEnteredAt: null, stampedAt: iso(T - 40_000) })).toBe(true);
  });

  it('refuses an absent or unreadable stamp', () => {
    expect(isStampForCurrentRound({ ...fresh, stampedAt: null })).toBe(false);
    expect(isStampForCurrentRound({ ...fresh, stampedAt: 'not a date' })).toBe(false);
  });

  it('ignores the round number when the row does not carry one', () => {
    expect(isStampForCurrentRound({ ...fresh, rowQuestion: undefined })).toBe(true);
    expect(isStampForCurrentRound({ ...fresh, rowQuestion: null })).toBe(true);
  });
});
