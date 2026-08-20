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
// Unlock the audio context on the first tap anywhere on the page by
// playing a tiny silent WAV via a SEPARATE disposable Audio element.
// This avoids touching honkAudio (no muted/paused state that could
// interfere if the first user interaction is a honk button tap).
const _SILENT_WAV = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
let _audioUnlocked = false;
function _unlockAudio() {
  if (_audioUnlocked) return;
  _audioUnlocked = true;
  const tmp = new Audio(_SILENT_WAV);
  tmp.play().catch(() => {});
  document.removeEventListener('touchstart', _unlockAudio, true);
  document.removeEventListener('click', _unlockAudio, true);
}
document.addEventListener('touchstart', _unlockAudio, true);
document.addEventListener('click', _unlockAudio, true);

/** Suppress honk sounds + animations (e.g. during question phase). */
export function setHonkMuted(muted) { _honkMuted = muted; }

function playHonk() {
  // Clone the Audio element so rapid honks OVERLAP rather than interrupt
  // each other. The previous "currentTime = 0; play()" pattern restarted
  // the single shared element on every tap, so a 10-tap spam played 10
  // cut-off halves of the sound. Cloning lets each honk play to completion
  // in parallel — comedic chorus instead of stuttered one-shot.
  const a = honkAudio.cloneNode();
  a.volume = 1.0;
  a.play().catch(() => {});
}

// --- Animation ---
function spawnGooseEmoji() {
  // No throttle — rapid spam should produce a flock. Randomize position,
  // rotation, and scale on each spawn so a 10-honk burst looks like ducks
  // raining across the screen instead of one duck flickering in place.
  const el = document.createElement('div');
  el.className = 'honk-goose';
  el.textContent = '🦆'; // duck emoji 🦆
  const x = 15 + Math.random() * 70;     // 15%–85% horizontally
  const y = 25 + Math.random() * 50;     // 25%–75% vertically
  const rot = (Math.random() - 0.5) * 60; // ±30°
  const scale = 0.6 + Math.random() * 0.7; // 0.6–1.3×
  el.style.cssText = `
    position: fixed;
    top: ${y}%;
    left: ${x}%;
    font-size: 4rem;
    z-index: 9999;
    pointer-events: none;
    transform: translate(-50%, -50%) rotate(${rot}deg) scale(${scale});
    animation: honk-bounce 0.6s ease-out forwards;
  `;
  document.body.appendChild(el);
  el.addEventListener('animationend', () => el.remove());
}

/**
 * Shake the honker's avatar wherever they are on screen.
 *
 * from_id has always been in the broadcast payload and nothing read it, so a
 * honk arrived from nobody in particular — you got quacked at and had no idea
 * who did it. Every screen that lists players already tags its rows with
 * data-player-id (lobby, reveal, scores, final wager, results), so the sender
 * can be found without any screen knowing about honks.
 *
 * Restarting the animation needs the class removed and the layout flushed
 * before it goes back on; without the reflow the browser coalesces the two
 * changes and a second honk during the first one does nothing at all — which
 * is precisely when someone is spamming and most wants to see it.
 */
function jiggleHonker(fromId) {
  if (!fromId) return;
  const rows = document.querySelectorAll(`[data-player-id="${CSS.escape(String(fromId))}"]`);
  for (const row of rows) {
    const target = row.querySelector('.avatar') || row;
    target.classList.remove('honk-jiggle');
    void target.offsetWidth;
    target.classList.add('honk-jiggle');
    target.addEventListener('animationend', () => target.classList.remove('honk-jiggle'), { once: true });
  }
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

      // Update count and UI immediately — no debounce, honk spam is fun
      honkCounts[targetId] = (honkCounts[targetId] || 0) + 1;
      if (onCountUpdate) onCountUpdate(targetId, honkCounts[targetId]);

      // Everyone sees WHO honked, not just the person hit — the count badge
      // already updates on every device, so the room already knows a honk
      // happened; this says who. Silent, so it stays out of the way.
      if (!_honkMuted) jiggleHonker(payload.from_id);

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
  // Play sound + spawn duck immediately for the sender so there's no
  // broadcast round-trip delay AND the sender sees their own spam-fire
  // (broadcast handler only renders ducks for the targeted player).
  if (!_honkMuted) {
    playHonk();
    spawnGooseEmoji();
    // The sender's own avatar too, so the feedback is immediate rather than
    // waiting on the broadcast round trip — the same reason the duck is local.
    jiggleHonker(localPlayerId);
  }
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
