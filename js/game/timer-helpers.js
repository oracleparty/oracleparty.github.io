// ============================================
// Oracle Party — Timer Helpers
// Pure functions for server-synced time calculations.
// ============================================

/**
 * Compute seconds remaining on the question timer.
 * Uses server time offset for cross-client synchronization.
 */
export function getServerTimeLeft(questionStartedAt, serverTimeOffset, timerSeconds) {
  if (!questionStartedAt) return timerSeconds;
  const startMs = new Date(questionStartedAt).getTime();
  const nowServerMs = Date.now() + serverTimeOffset;
  const elapsedMs = nowServerMs - startMs;
  return Math.max(0, timerSeconds - elapsedMs / 1000);
}

/**
 * Compute milliseconds elapsed since countdown started.
 * Uses server time offset for cross-client synchronization.
 */
export function getCountdownElapsed(countdownStartedAt, serverTimeOffset) {
  if (!countdownStartedAt) return 0;
  const startMs = new Date(countdownStartedAt).getTime();
  const nowServerMs = Date.now() + serverTimeOffset;
  return nowServerMs - startMs;
}
