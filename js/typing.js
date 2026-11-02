// ============================================
// Oracle Party — Typing Indicator
// Lightweight broadcast-only (no DB writes).
// Shows "[name] is typing..." in the chat drawer.
// ============================================

import { createTypingChannel, unsubscribe } from './supabase.js';
import { TYPING_TIMEOUT, TYPING_THROTTLE } from './constants.js';

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
  // Guard against double-init (e.g. Play Again flow)
  if (channel) destroyTypingIndicator();

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
      }, TYPING_TIMEOUT);

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

  sendThrottleId = setTimeout(() => { sendThrottleId = null; }, TYPING_THROTTLE);
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
  paintTypingAvatars();
  onUpdate = null;
}

function emitUpdate() {
  paintTypingAvatars();
  if (!onUpdate) return;
  onUpdate(Array.from(activeTypers.values()).map(t => t.name));
}

// ============================================
// THE TYPER'S FACE (owner, 2026-11-02: "a notification when someone is typing
// in chat so the host knows"). A neutral ring and a small dots badge on that
// player's avatar, on every screen that lists players — found the way the
// honk shake finds them, by data-player-id / data-profile-player-id, so no
// screen needs to know typing exists. Neutral on purpose: titles are coloured
// by rarity, and a blue ring would read as "Rare". The chat pane's own
// "X is typing…" line is unchanged.
//
// Rows are redrawn by Realtime at any moment, so while anybody is typing the
// marks are re-applied twice a second; with nobody typing, nothing runs.
// ============================================
let _paintTimer = null;

function avatarsFor(id) {
  const sel = `[data-player-id="${CSS.escape(id)}"], [data-profile-player-id="${CSS.escape(id)}"]`;
  const out = new Set();
  for (const el of document.querySelectorAll(sel)) {
    const av = el.classList.contains('avatar') ? el : el.querySelector('.avatar');
    if (av) out.add(av);
  }
  return out;
}

export function paintTypingAvatars() {
  if (typeof document === 'undefined') return;
  const typing = new Set();
  for (const id of activeTypers.keys()) for (const av of avatarsFor(id)) typing.add(av);
  for (const av of document.querySelectorAll('.avatar.is-typing')) {
    if (!typing.has(av)) av.classList.remove('is-typing');
  }
  for (const av of typing) av.classList.add('is-typing');
  if (activeTypers.size && !_paintTimer) {
    _paintTimer = setInterval(paintTypingAvatars, 500);
  } else if (!activeTypers.size && _paintTimer) {
    clearInterval(_paintTimer);
    _paintTimer = null;
  }
}
