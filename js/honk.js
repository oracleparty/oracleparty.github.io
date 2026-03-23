// ============================================
// Oracle Party — Honk System
// Goose honk for fun. Broadcast via Supabase Realtime.
// ============================================

import { createHonkChannel, unsubscribe } from './supabase.js';

// --- State ---
const honkCounts = {}; // playerId → count (in-memory, resets per session)
let honkChannel = null;
let localPlayerId = null;

// --- Audio ---
// Tiny goose honk as base64 WAV (sine wave ~400Hz, 150ms, generated procedurally)
let honkAudioCtx = null;
function playHonk() {
  try {
    if (!honkAudioCtx) honkAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const ctx = honkAudioCtx;
    const duration = 0.15;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(400, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(250, ctx.currentTime + duration);
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + duration);
  } catch (_) { /* audio not available */ }
}

// --- Animation ---
function spawnGooseEmoji() {
  const el = document.createElement('div');
  el.className = 'honk-goose';
  el.textContent = '\uD83E\uDDA2'; // goose emoji 🪿... actually let's use a standard one
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
