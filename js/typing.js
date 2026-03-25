// ============================================
// Oracle Party — Typing Indicator
// Lightweight broadcast-only (no DB writes).
// Shows "[name] is typing..." in the chat drawer.
// ============================================

import { createTypingChannel, unsubscribe } from './supabase.js';

let channel = null;
let localPlayerId = null;
let localDisplayName = null;
let sendThrottleId = null;        // prevents flooding: 1 event per second max
let activeTypers = new Map();     // playerId → { name, timeoutId }
let onUpdate = null;              // callback(typerNames: string[])

/**
 * Initialize typing indicator for a room.
 * @param {string} roomId
 * @param {string} playerId - local player's ID
 * @param {string} displayName - local player's display name
 * @param {Function} updateCallback - called with array of typing player names
 */
export function initTypingIndicator(roomId, playerId, displayName, updateCallback) {
  localPlayerId = String(playerId);
  localDisplayName = displayName;
  onUpdate = updateCallback;
  activeTypers.clear();

  channel = createTypingChannel(roomId);
  channel
    .on('broadcast', { event: 'typing' }, ({ payload }) => {
      const id = String(payload.player_id);
      if (id === localPlayerId) return; // self: false should prevent this, but guard anyway

      // Reset timeout for this player
      const existing = activeTypers.get(id);
      if (existing) clearTimeout(existing.timeoutId);

      const timeoutId = setTimeout(() => {
        activeTypers.delete(id);
        emitUpdate();
      }, 3000);

      activeTypers.set(id, { name: payload.player_name, timeoutId });
      emitUpdate();
    })
    .subscribe();
}

/**
 * Call on every keystroke in the chat input.
 * Throttled: sends at most one broadcast per second.
 */
export function notifyTyping() {
  if (!channel || sendThrottleId) return;

  channel.send({
    type: 'broadcast',
    event: 'typing',
    payload: { player_id: localPlayerId, player_name: localDisplayName }
  });

  sendThrottleId = setTimeout(() => { sendThrottleId = null; }, 1000);
}

/**
 * Cleanup — call when leaving the room.
 */
export function destroyTypingIndicator() {
  if (channel) {
    unsubscribe(channel);
    channel = null;
  }
  if (sendThrottleId) {
    clearTimeout(sendThrottleId);
    sendThrottleId = null;
  }
  for (const [, { timeoutId }] of activeTypers) {
    clearTimeout(timeoutId);
  }
  activeTypers.clear();
  onUpdate = null;
}

function emitUpdate() {
  if (!onUpdate) return;
  onUpdate(Array.from(activeTypers.values()).map(t => t.name));
}
