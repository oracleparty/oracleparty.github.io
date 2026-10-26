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
//
// A HONK YOU RECEIVE PLAYS WITH NO GESTURE AT ALL — it arrives over Realtime —
// and that is the case the old unlock could never cover. It played a silent WAV
// through a separate throwaway <audio>, and every honk then played through a
// brand-new clone. iOS Safari's gesture rule is per media ELEMENT, so the clone
// made inside a broadcast handler was never unlocked and its play() was
// rejected, into a catch that swallowed it. Reported 2026-10-26, two iPhones:
// each person heard their OWN honks (played inside the tap) and never the
// other's. A lead from how the code reads, not a measurement — nothing here can
// run iOS Safari.
//
// Web Audio unlocks per CONTEXT instead: resume one AudioContext inside a tap
// and every later sound through it plays, whatever started it. So a received
// honk goes through Web Audio. The sender keeps the <audio> path — it is inside
// the tap, it already works, and it behaves exactly as before.
//
// iOS can suspend or "interrupt" the context (a call, a backgrounded tab), so
// every tap asks for it to resume while it is not running.
const _SILENT_WAV = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
let _audioUnlocked = false;
let _ctx = null;
let _honkBuffer = null;
let _honkBufferLoading = null;

function _audioContext() {
  if (_ctx) return _ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  try { _ctx = new AC(); } catch { _ctx = null; }
  return _ctx;
}

function _loadHonkBuffer() {
  if (_honkBuffer || _honkBufferLoading || !_ctx) return;
  _honkBufferLoading = fetch('honk.mp3')
    .then(r => r.arrayBuffer())
    // The callback form, because older Safari's decodeAudioData returns no promise.
    .then(data => new Promise((resolve, reject) => _ctx.decodeAudioData(data, resolve, reject)))
    .then(buf => { _honkBuffer = buf; })
    .catch(() => { _honkBufferLoading = null; });
}

function _unlockAudio() {
  if (!_audioUnlocked) {
    _audioUnlocked = true;
    const tmp = new Audio(_SILENT_WAV);
    tmp.play().catch(() => {});
  }
  const ctx = _audioContext();
  if (!ctx) return;
  if (ctx.state !== 'running') {
    ctx.resume().catch(() => {});
    // A one-sample buffer played inside the tap is what iOS counts as starting
    // the context; resume() alone has not always been enough there.
    try {
      const src = ctx.createBufferSource();
      src.buffer = ctx.createBuffer(1, 1, 22050);
      src.connect(ctx.destination);
      src.start(0);
    } catch { /* nothing to unlock with — the <audio> path still stands */ }
  }
  _loadHonkBuffer();
}
// Kept on for the life of the page, not removed after the first tap: a context
// iOS suspends later has to be resumed by a later tap.
document.addEventListener('touchstart', _unlockAudio, true);
document.addEventListener('click', _unlockAudio, true);

/** Suppress honk sounds + animations (e.g. during question phase). */
export function setHonkMuted(muted) { _honkMuted = muted; }

function playHonk({ received = false } = {}) {
  if (received && _ctx && _honkBuffer && _ctx.state === 'running') {
    try {
      // A fresh source per honk, so rapid honks overlap rather than cut off.
      const src = _ctx.createBufferSource();
      src.buffer = _honkBuffer;
      src.connect(_ctx.destination);
      src.start(0);
      return;
    } catch { /* fall through to the <audio> path */ }
  }
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
        playHonk({ received: true });
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
