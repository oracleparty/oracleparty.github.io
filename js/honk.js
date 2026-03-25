// ============================================
// Oracle Party — Honk System
// Duck quack for fun. Broadcast via Supabase Realtime.
// ============================================

import { createHonkChannel, unsubscribe } from './supabase.js';

// --- State ---
const honkCounts = {}; // playerId → count (in-memory, resets per session)
let honkChannel = null;
let localPlayerId = null;

// --- Audio ---
// Honk sound effect from MP3 file
const honkAudio = new Audio('honk.mp3');
honkAudio.preload = 'auto';
let _honkMuted = false;

/** Suppress honk sounds + animations (e.g. during question phase). */
export function setHonkMuted(muted) { _honkMuted = muted; }

function playHonk() {
  if (_honkMuted) return;
  try {
    // Clone the audio so overlapping honks don't cut each other off
    const sound = honkAudio.cloneNode();
    sound.volume = 1.0;
    sound.play();
  } catch (_) { /* audio not available */ }
}

// --- Animation ---
function spawnGooseEmoji() {
  const el = document.createElement('div');
  el.className = 'honk-goose';
  el.textContent = '\uD83E\uDD86'; // duck emoji 🦆
  el.style.cssText = `
    position: fixed;
    top: 50%;
    left: 50%;
    font-size: 4rem;
    z-index: 9999;
    pointer-events: none;
    animation: honk-bounce 0.6s ease-out forwards;
    transform: translate(-50%, -50%);
  `;
  document.body.appendChild(el);
  el.addEventListener('animationend', () => el.remove());
}

/**
 * Initialize the honk system for a room.
 * @param {string} roomId
 * @param {string} playerId - local player's ID
 * @param {Function} onCountUpdate - callback(playerId, newCount) for UI updates
 */
export function initHonkSystem(roomId, playerId, onCountUpdate) {
  // Reset counts for new game/session
  for (const key in honkCounts) delete honkCounts[key];
  localPlayerId = String(playerId);

  honkChannel = createHonkChannel(roomId);
  honkChannel
    .on('broadcast', { event: 'honk' }, ({ payload }) => {
      const targetId = String(payload.target_id);
      const fromId = String(payload.from_id);

      // Update count
      honkCounts[targetId] = (honkCounts[targetId] || 0) + 1;
      if (onCountUpdate) onCountUpdate(targetId, honkCounts[targetId]);

      // If I'm the honked player, react! (skip sound+animation when muted)
      if (targetId === localPlayerId && !_honkMuted) {
        playHonk();
        spawnGooseEmoji();
      }
    })
    .subscribe();
}

/**
 * Send a honk to a target player.
 */
export function sendHonk(targetPlayerId) {
  if (!honkChannel) return;
  // Play sound immediately for the sender so there's no broadcast delay
  playHonk();
  honkChannel.send({
    type: 'broadcast',
    event: 'honk',
    payload: {
      target_id: targetPlayerId,
      from_id: localPlayerId
    }
  });
}

/**
 * Get current honk count for a player.
 */
export function getHonkCount(playerId) {
  return honkCounts[String(playerId)] || 0;
}

/**
 * Cleanup honk channel.
 */
export function destroyHonkSystem() {
  if (honkChannel) {
    unsubscribe(honkChannel);
    honkChannel = null;
  }
}
