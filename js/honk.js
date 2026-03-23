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
// Duck quack — nasal two-tone burst synthesized with Web Audio
let honkAudioCtx = null;
function playHonk() {
  try {
    if (!honkAudioCtx) honkAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const ctx = honkAudioCtx;
    const now = ctx.currentTime;

    // Primary quack tone — nasal square wave dropping in pitch
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = 'square';
    osc1.frequency.setValueAtTime(680, now);
    osc1.frequency.exponentialRampToValueAtTime(400, now + 0.12);
    gain1.gain.setValueAtTime(0.25, now);
    gain1.gain.linearRampToValueAtTime(0.28, now + 0.03);
    gain1.gain.exponentialRampToValueAtTime(0.01, now + 0.12);
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.12);

    // Harmonic overtone for nasal "quack" character
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = 'sawtooth';
    osc2.frequency.setValueAtTime(1360, now);
    osc2.frequency.exponentialRampToValueAtTime(800, now + 0.10);
    gain2.gain.setValueAtTime(0.08, now);
    gain2.gain.exponentialRampToValueAtTime(0.01, now + 0.10);
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.start(now);
    osc2.stop(now + 0.10);
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

// --- Vibration ---
function vibrateDevice() {
  try { navigator.vibrate(200); } catch (_) {}
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

      // If I'm the honked player, react!
      if (targetId === localPlayerId) {
        playHonk();
        spawnGooseEmoji();
        vibrateDevice();
      }
    })
    .subscribe();
}

/**
 * Send a honk to a target player.
 */
export function sendHonk(targetPlayerId) {
  if (!honkChannel) return;
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
