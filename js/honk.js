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

// Mobile browsers require a user gesture before playing audio.
// Unlock the audio context on the first tap anywhere on the page.
let _audioUnlocked = false;
function _unlockAudio() {
  if (_audioUnlocked) return;
  _audioUnlocked = true;
  honkAudio.volume = 0;
  honkAudio.play().then(() => {
    honkAudio.pause();
    honkAudio.currentTime = 0;
    honkAudio.volume = 1.0;
  }).catch(() => {});
  document.removeEventListener('touchstart', _unlockAudio, true);
  document.removeEventListener('click', _unlockAudio, true);
}
document.addEventListener('touchstart', _unlockAudio, true);
document.addEventListener('click', _unlockAudio, true);

/** Suppress honk sounds + animations (e.g. during question phase). */
export function setHonkMuted(muted) { _honkMuted = muted; }

function playHonk() {
  if (_honkMuted) return;
  // Reuse single Audio instance — reset and replay instead of cloning
  honkAudio.currentTime = 0;
  honkAudio.play().catch(() => {});
}

// --- Animation ---
let _lastGooseTime = 0;
function spawnGooseEmoji() {
  // Throttle: max one animation per 300ms to prevent DOM overload from rapid honks
  const now = Date.now();
  if (now - _lastGooseTime < 300) return;
  _lastGooseTime = now;
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
let _countUpdateTimer = null;
const _pendingCountTargets = new Set();

export function initHonkSystem(roomId, playerId, onCountUpdate) {
  // Reset counts for new game/session
  for (const key in honkCounts) delete honkCounts[key];
  localPlayerId = String(playerId);

  honkChannel = createHonkChannel(roomId);
  honkChannel
    .on('broadcast', { event: 'honk' }, ({ payload }) => {
      const targetId = String(payload.target_id);

      // Update count instantly (in memory)
      honkCounts[targetId] = (honkCounts[targetId] || 0) + 1;

      // Debounce UI update — batch rapid honks into one render per 100ms.
      // Track ALL targets that received honks, not just the last one.
      _pendingCountTargets.add(targetId);
      if (!_countUpdateTimer) {
        _countUpdateTimer = setTimeout(() => {
          _countUpdateTimer = null;
          if (onCountUpdate) {
            for (const tid of _pendingCountTargets) {
              onCountUpdate(tid, honkCounts[tid]);
            }
          }
          _pendingCountTargets.clear();
        }, 100);
      }

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
