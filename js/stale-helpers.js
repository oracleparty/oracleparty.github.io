// ============================================
// Oracle Party — Stale Player Detection Helpers
// Pure functions used by both lobby.js and game/phases.js.
// Extracted so logic can be unit-tested independently of Supabase/DOM.
// ============================================

import { DISCONNECTED_TIMEOUT_MS, STALE_TIMEOUT_MS } from './constants.js';

/**
 * Return true if a player's DB record indicates they should be removed.
 *
 * Two thresholds:
 *   disconnectedTimeoutMs — fast-path: beacon fired (tab close/navigation)
 *   staleTimeoutMs        — slow-path: heartbeat stopped (internet loss/crash)
 *
 * IMPORTANT: last_seen_at = null is treated as epoch 0 (~56-year silence),
 * which always exceeds both thresholds. Players must have last_seen_at set
 * at insert time (see addPlayer) to avoid being immediately kicked.
 */
export function isPlayerStale(
  player,
  now = Date.now(),
  disconnectedTimeoutMs = DISCONNECTED_TIMEOUT_MS,
  staleTimeoutMs = STALE_TIMEOUT_MS
) {
  const lastSeen = player.last_seen_at ? new Date(player.last_seen_at).getTime() : 0;
  const silenceMs = now - lastSeen;
  const threshold = player.disconnected_at ? disconnectedTimeoutMs : staleTimeoutMs;
  return silenceMs >= threshold;
}

/**
 * Return list of player IDs this client should remove from the DB.
 *
 * Rules:
 *   - Never remove ourselves (myPlayerId)
 *   - Stale non-host players: only the host removes them
 *   - Stale host: only the earliest connected non-stale player removes them
 *     (deterministic — exactly one client acts)
 *
 * @param {Array}  players              - Full player list
 * @param {string} myPlayerId           - This client's player ID
 * @param {boolean} isHost              - Whether this client is the host
 * @param {number} [now]                - Current timestamp (injectable for tests)
 * @param {number} [disconnectedTimeoutMs]
 * @param {number} [staleTimeoutMs]
 * @returns {string[]}  Player IDs to call removePlayer() on
 */
export function getStaleKickDecisions(
  players,
  myPlayerId,
  isHost,
  now = Date.now(),
  disconnectedTimeoutMs = DISCONNECTED_TIMEOUT_MS,
  staleTimeoutMs = STALE_TIMEOUT_MS
) {
  const toRemove = [];

  for (const p of players) {
    const id = String(p.id);
    if (id === String(myPlayerId)) continue;
    if (!isPlayerStale(p, now, disconnectedTimeoutMs, staleTimeoutMs)) continue;

    if (p.is_host) {
      // Stale host: only the earliest connected player acts (deterministic)
      const connected = players
        .filter(pl => !isPlayerStale(pl, now, disconnectedTimeoutMs, disconnectedTimeoutMs) && !pl.disconnected_at)
        .sort((a, b) => new Date(a.joined_at || 0) - new Date(b.joined_at || 0));
      if (connected[0] && String(connected[0].id) === String(myPlayerId)) {
        toRemove.push(id);
      }
    } else if (isHost) {
      toRemove.push(id);
    }
  }

  return toRemove;
}
