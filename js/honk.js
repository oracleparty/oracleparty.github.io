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
// A HONK YOU RECEIVE PLAYS WITH NO GESTURE AT ALL — it arrives over Realtime.
// iOS Safari's gesture rule is per media ELEMENT, so the old code, which played
// every honk through a brand-new clone, had its received honks rejected into a
// catch that swallowed them. Reported 2026-10-26, two iPhones: each person heard
// their OWN honks (played inside the tap) and never the other's. A lead from how
// the code reads, not a measurement — nothing here can run iOS Safari.
//
// So a small POOL of <audio> elements is unlocked inside the first taps (played
// muted, then paused), and a received honk plays through one of those. An
// element that has played inside a gesture may play again later without one.
//
// WHY <audio> AND NOT WEB AUDIO, which was the first version of this fix (one
// deploy, 20261026c): on an iPhone, Web Audio OBEYS THE SILENT SWITCH and an
// <audio> element does not. The sender's own honk has always been an <audio>
// element — which is why the owner could hear their own honks — so Web Audio
// would have made a received honk quieter than a sent one on any silenced phone.
// The owner's call (2026-10-26): honks are a game sound somebody chose to play
// with, not a notification, so they ignore the switch. Web Audio stays only as a
// fallback for a pool element that is somehow still locked.
//
// iOS can suspend the context (a call, a backgrounded tab), so every tap asks it
// to resume, and the pool is topped up on later taps too.
const POOL_SIZE = 4;
const SEND_POOL_SIZE = 8;
const _sendPool = [];      // the sender's own honks, played inside the tap
let _sendNext = 0;
const _pool = [];          // unlocked <audio> elements, round-robin
let _poolNext = 0;
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

function _unlockPoolElement() {
  const el = honkAudio.cloneNode();
  // `volume` is ignored on iOS (always 1), so silence the unlock with `muted`.
  el.muted = true;
  const p = el.play();
  const done = () => {
    try { el.pause(); el.currentTime = 0; } catch { /* nothing to reset */ }
    el.muted = false;
    _pool.push(el);
  };
  if (p && typeof p.then === 'function') p.then(done).catch(() => { /* still locked; a later tap tries again */ });
  else done();
}

function _unlockAudio() {
  if (_pool.length < POOL_SIZE) {
    for (let i = _pool.length; i < POOL_SIZE; i++) _unlockPoolElement();
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

// --- When honks are quiet ---
//
// Three separate switches, and keeping them separate is the design:
//
//   _honkMuted   the game's own rule: no honks while somebody is ANSWERING
//                (hideChatBar sets it on the question screen). Sound, ducks and
//                avatar shake are all dropped, not queued.
//   _chaos       the host's room-wide Chaos mode lifts that rule entirely.
//   _soundOff    one player's own choice, saved on their phone. SOUND ONLY —
//                the ducks and the shake still appear, so a muted player still
//                sees the chaos everybody else is hearing. It can only ever make
//                things quieter: it never turns anything on.
let _chaos = false;
const SOUND_OFF_KEY = 'oracle_party_honk_sound_off';
let _soundOff = false;
try { _soundOff = localStorage.getItem(SOUND_OFF_KEY) === '1'; } catch { /* private mode */ }

/** Suppress honks while somebody is answering. Chaos mode overrides it. */
export function setHonkMuted(muted) { _honkMuted = muted; }

/** The host's room-wide Chaos mode: honks are never held back by the phase. */
export function setHonkChaos(on) { _chaos = !!on; }
export function isHonkChaos() { return _chaos; }

function _phaseQuiet() { return _honkMuted && !_chaos; }

export function isHonkSoundOff() { return _soundOff; }
export function setHonkSoundOff(off) {
  _soundOff = !!off;
  try { localStorage.setItem(SOUND_OFF_KEY, _soundOff ? '1' : '0'); } catch { /* not saved; still applies to this page */ }
}

/**
 * Wire a speaker button that toggles this player's honk sound. The label is a
 * word as well as an icon — a bare glyph is a guess.
 */
export function attachHonkSoundToggle(btn) {
  if (!btn || btn.dataset.honkSoundWired) return;
  btn.dataset.honkSoundWired = '1';
  const paint = () => {
    btn.textContent = _soundOff ? '🔇' : '🔊';
    btn.setAttribute('aria-pressed', String(_soundOff));
    btn.setAttribute('aria-label', _soundOff ? 'Honk sound off — tap to turn on' : 'Honk sound on — tap to turn off');
    btn.title = _soundOff ? 'Honk sound off' : 'Honk sound on';
  };
  paint();
  btn.addEventListener('click', (e) => {
    // The game's chat bar opens the chat on any click inside it.
    e.stopPropagation();
    setHonkSoundOff(!_soundOff);
    paint();
  });
}

function playHonk({ received = false } = {}) {
  if (_soundOff) return;
  if (received) {
    const el = _pool.length ? _pool[_poolNext++ % _pool.length] : null;
    if (el) {
      try { el.currentTime = 0; } catch { /* not seekable yet */ }
      const p = el.play();
      if (p && typeof p.catch === 'function') {
        p.catch(() => _playThroughContext());
      }
      return;
    }
    if (_playThroughContext()) return;
  }
  // A ROUND-ROBIN of a few elements so rapid honks OVERLAP rather than
  // interrupt each other. A single shared element restarted on every tap, so a
  // 10-tap spam played 10 cut-off halves of the sound.
  //
  // It used to CLONE A NEW ELEMENT PER TAP, and that is the reported "quacks
  // start lagging after about a hundred" (2026-10-27, Chaos mode): every clone
  // is a media player of its own, none was ever reused, and a phone's media
  // stack slows as they pile up. Eight in rotation is a chorus at any speed a
  // thumb can manage — the oldest is restarted, which nobody can hear under
  // seven others. A lead from reading, not a measurement on an iPhone.
  let a = _sendPool[_sendNext % SEND_POOL_SIZE];
  if (!a) { a = honkAudio.cloneNode(); _sendPool[_sendNext % SEND_POOL_SIZE] = a; }
  _sendNext++;
  try { a.currentTime = 0; } catch { /* not seekable yet */ }
  a.volume = 1.0;
  a.play().catch(() => {});
}

/** Web Audio fallback for a received honk. Obeys the iPhone silent switch. */
function _playThroughContext() {
  if (!(_ctx && _honkBuffer && _ctx.state === 'running')) return false;
  try {
    const src = _ctx.createBufferSource();
    src.buffer = _honkBuffer;
    src.connect(_ctx.destination);
    src.start(0);
    return true;
  } catch { return false; }
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
      if (!_phaseQuiet()) jiggleHonker(payload.from_id);

      // If I'm the honked player, react! (skip sound+animation when muted)
      if (targetId === localPlayerId && !_phaseQuiet()) {
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
  if (!_phaseQuiet()) {
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
 * Repaint every honk count badge on the page in place.
 *
 * The ONE thing a honk changes in a player list. The lobby used to redraw the
 * whole list on every honk, on every phone — so spamming rebuilt the rows under
 * people's fingers (a button replaced between touchstart and click never fires)
 * and cut every avatar shake short. Every list tags its badge with
 * data-honk-player, so this needs to know nothing about which screen it is on.
 */
export function updateHonkBadges() {
  document.querySelectorAll('.honk-badge[data-honk-player]').forEach(badge => {
    const count = getHonkCount(badge.dataset.honkPlayer);
    if (count > 0) {
      badge.textContent = count;
      badge.style.display = '';
    } else {
      badge.style.display = 'none';
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
