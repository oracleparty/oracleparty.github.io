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

/**
 * IS THIS ROOM ROW'S CLOCK STAMP THE ONE FOR THE ROUND WE ARE ON?
 *
 * Realtime delivers the whole `rooms` row on every update, so a stamp arrives
 * attached to writes that have nothing to do with the clock. Two ways it can be
 * the wrong one, and both were reachable:
 *
 *   * the row names a DIFFERENT round than this phone is on — the write that
 *     announces the next question carries the last one's stamp, because the two
 *     are separate writes a second apart;
 *   * the row names OUR round but was written before this round began — the
 *     same window, seen from a phone that has already moved on.
 *
 * Taking either one starts the question with the previous round's clock, which
 * is a timer that opens with seconds left, or none.
 *
 * `roundEnteredAt` absent means this phone cannot judge — a reconnect, where
 * init.js has already read the room's real state — and there the stamp is
 * accepted, because the alternative is a returning player running no clock at
 * all while everybody else runs one.
 *
 * Pure, and unit tested: the live version of this ran inside a Realtime handler
 * where it could only be checked by playing a game.
 */
export function isStampForCurrentRound({ rowQuestion, myQuestion, stampedAt, roundEnteredAt, toleranceMs = 0 }) {
  if (!stampedAt) return false;
  // A round number of 0 is real and falsy, so this asks about ABSENCE.
  if (rowQuestion !== undefined && rowQuestion !== null
      && Number(rowQuestion) !== Number(myQuestion)) return false;
  if (!roundEnteredAt) return true;
  const stampMs = new Date(stampedAt).getTime();
  if (!Number.isFinite(stampMs)) return false;
  return stampMs >= roundEnteredAt - toleranceMs;
}
