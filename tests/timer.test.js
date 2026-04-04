import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getServerTimeLeft, getCountdownElapsed } from '../js/game/timer-helpers.js';

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
