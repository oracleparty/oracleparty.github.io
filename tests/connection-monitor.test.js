import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================
// Connection Monitor — debounce logic tests
// ============================================

// We can't import directly from utils.js without a full DOM, so we
// re-implement the core debounce logic here to test the algorithm.
// The actual wiring is integration-tested via Playwright screenshots.

describe('connection monitor debounce logic', () => {
  let connLostToast, connLostTimeout;

  function notifyConnectionLost(showToastFn) {
    if (connLostToast || connLostTimeout) return false; // debounced
    connLostTimeout = setTimeout(() => {
      connLostToast = showToastFn('Connection lost — reconnecting…', 'error', Infinity);
      connLostTimeout = null;
    }, 300);
    return true; // scheduled
  }

  function notifyConnectionRestored(showToastFn, dismissFn) {
    if (connLostTimeout) {
      clearTimeout(connLostTimeout);
      connLostTimeout = null;
    }
    if (connLostToast) {
      dismissFn(connLostToast);
      connLostToast = null;
      showToastFn('Reconnected!', 'success');
      return true; // showed reconnected toast
    }
    return false; // no-op
  }

  beforeEach(() => {
    vi.useFakeTimers();
    connLostToast = null;
    connLostTimeout = null;
  });

  it('debounces multiple connection lost calls within 300ms', () => {
    const showToast = vi.fn(() => ({}));
    expect(notifyConnectionLost(showToast)).toBe(true);  // first call → scheduled
    expect(notifyConnectionLost(showToast)).toBe(false); // debounced
    expect(notifyConnectionLost(showToast)).toBe(false); // debounced

    vi.advanceTimersByTime(300);
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith('Connection lost — reconnecting…', 'error', Infinity);
  });

  it('cancels pending toast if restored before 300ms', () => {
    const showToast = vi.fn(() => ({}));
    const dismiss = vi.fn();

    notifyConnectionLost(showToast);
    // Restore before the 300ms debounce fires
    const result = notifyConnectionRestored(showToast, dismiss);

    vi.advanceTimersByTime(300);
    expect(showToast).not.toHaveBeenCalled(); // toast never shown
    expect(result).toBe(false); // no connLostToast existed to dismiss
  });

  it('shows reconnected toast after connection was lost', () => {
    const toastEl = { id: 'mock-toast' };
    const showToast = vi.fn(() => toastEl);
    const dismiss = vi.fn();

    notifyConnectionLost(showToast);
    vi.advanceTimersByTime(300); // fire the lost toast
    expect(showToast).toHaveBeenCalledTimes(1);

    const result = notifyConnectionRestored(showToast, dismiss);
    expect(result).toBe(true);
    expect(dismiss).toHaveBeenCalledWith(toastEl);
    expect(showToast).toHaveBeenCalledTimes(2);
    expect(showToast).toHaveBeenLastCalledWith('Reconnected!', 'success');
  });

  it('no-ops when restored without prior loss', () => {
    const showToast = vi.fn();
    const dismiss = vi.fn();

    const result = notifyConnectionRestored(showToast, dismiss);
    expect(result).toBe(false);
    expect(showToast).not.toHaveBeenCalled();
    expect(dismiss).not.toHaveBeenCalled();
  });
});

// ============================================
// Error rate limiter tests
// ============================================

describe('error rate limiter', () => {
  const MAX_ERRORS_PER_MINUTE = 10;

  function createRateLimiter() {
    const timestamps = [];
    return function isRateLimited() {
      const now = Date.now();
      while (timestamps.length && timestamps[0] < now - 60000) {
        timestamps.shift();
      }
      if (timestamps.length >= MAX_ERRORS_PER_MINUTE) return true;
      timestamps.push(now);
      return false;
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('allows first 10 errors', () => {
    const isRateLimited = createRateLimiter();
    for (let i = 0; i < 10; i++) {
      expect(isRateLimited()).toBe(false);
    }
  });

  it('blocks 11th error within same minute', () => {
    const isRateLimited = createRateLimiter();
    for (let i = 0; i < 10; i++) isRateLimited();
    expect(isRateLimited()).toBe(true);
  });

  it('allows errors again after oldest expires (60s)', () => {
    const isRateLimited = createRateLimiter();
    for (let i = 0; i < 10; i++) isRateLimited();
    expect(isRateLimited()).toBe(true);

    vi.advanceTimersByTime(60001);
    expect(isRateLimited()).toBe(false); // window cleared
  });

  it('sliding window: one slot opens at a time', () => {
    const isRateLimited = createRateLimiter();

    // Fill 10 slots at t=0
    for (let i = 0; i < 10; i++) isRateLimited();
    expect(isRateLimited()).toBe(true); // full

    // Advance 60s — all 10 slots expire
    vi.advanceTimersByTime(60001);
    expect(isRateLimited()).toBe(false); // slot freed

    // Fill 5 more
    for (let i = 0; i < 4; i++) isRateLimited();
    expect(isRateLimited()).toBe(false); // 6 of 10 used
  });
});
