// ============================================
// Oracle Party — Join Game Flow
// ============================================

import { $, $$, escapeHtml, showToast, navigateWithFade, navigateWithFadeReplace } from './utils.js';
import { findRoomByCode, fetchPublicRooms, addPlayer, claimSeat, cleanupOrphanedRooms,
         fetchHostReputations, describeHostReputation } from './supabase.js';
import { getDisplayName, ensureDisplayName, ensureAnonymousIdentity, initAuth, getCurrentUser, getAuthUserId, recallSeat } from './auth.js';
import { initThemeToggle } from './theme.js';
import { CATEGORY_META, resolveCategoryLabel } from './categories.js';
import { logger } from './logger.js';

// host user id -> reputation row, built up across refreshes. See loadPublicGames.
const _hostReps = new Map();
import { PUBLIC_GAMES_REFRESH, PULL_REFRESH_THRESHOLD, MIN_HOST_RATINGS } from './constants.js';

// DOM refs
const codeInput = $('#code-input');
const btnJoin = $('#btn-join');
const joinError = $('#join-error');
const publicGamesEl = $('#public-games');
const publicGamesEmpty = $('#public-games-empty');

let refreshInterval = null;

// --- Init ---
async function init() {
  // Cancel the boot-guard timer in <head> — JS module chain is alive.
  window.__appReady = true;
  if (window.__appBootGuard) clearTimeout(window.__appBootGuard);
  document.body.style.opacity = '1';
  try {
    await Promise.all([ensureDisplayName(), initAuth()]);
  } catch (err) {
    logger.error('Join', 'init error', err);
  }
  attachListeners();
  initThemeToggle();
  // Show skeleton rows while loading public games
  publicGamesEl.innerHTML = Array(3).fill('<div class="skeleton skeleton-row"></div>').join('');
  if (publicGamesEmpty) publicGamesEmpty.classList.add('hidden');
  loadPublicGames().catch(e => {
    logger.warn('Join', 'loadPublicGames failed', e);
    $$('.skeleton', publicGamesEl).forEach(el => el.remove());
    if (publicGamesEmpty) publicGamesEmpty.classList.remove('hidden');
  });

  // Auto-join from URL param (e.g. join.html?code=ABCD from friends list).
  // Sanitize: keep only A-Z, max 4 chars. Without this, a malformed link
  // (?code=abcdef) bypasses the input's maxlength and ends up as 6 chars in
  // the field, which fails validation with a confusing error.
  const urlCodeRaw = new URLSearchParams(window.location.search).get('code');
  const urlCode = urlCodeRaw ? urlCodeRaw.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4) : null;
  if (urlCode) {
    codeInput.value = urlCode;
    history.replaceState(null, '', window.location.pathname);
    if (urlCode.length === 4) {
      handleJoinByCode();
      return;
    }
    // Less than 4 chars — let user see the prefilled value and complete it
  }

  // Refresh public games every 10s
  refreshInterval = setInterval(loadPublicGames, PUBLIC_GAMES_REFRESH);

  // Trap browser back button — always go to index.html
  history.pushState({ page: 'join' }, '');
  window.addEventListener('popstate', () => { window.location.href = 'index.html'; });
}

// --- Listeners ---
function attachListeners() {
  $('#btn-back-home').addEventListener('click', () => {
    clearInterval(refreshInterval);
    navigateWithFade('index.html');
  });

  // Only allow letters in code input
  codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 4);
    joinError.textContent = '';
  });

  // Join via button
  btnJoin.addEventListener('click', handleJoinByCode);

  // Join via Enter key
  codeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleJoinByCode();
  });

  // Public game row clicks (event delegation)
  publicGamesEl.addEventListener('click', (e) => {
    const row = e.target.closest('.public-game-row');
    if (!row) return;
    const code = row.dataset.code;
    if (code) joinRoom(code);
  });
}

// --- Join by code entry ---
async function handleJoinByCode() {
  const code = codeInput.value.trim();
  if (code.length !== 4) {
    joinError.textContent = 'Enter a 4-letter room code';
    return;
  }
  await joinRoom(code);
}

// --- Core join logic ---
async function joinRoom(code) {
  btnJoin.classList.add('is-loading');
  btnJoin.textContent = '...';
  joinError.textContent = '';

  try {
    const { data: room, error } = await findRoomByCode(code);

    if (error || !room) {
      joinError.textContent = 'Room not found';
      showToast('Room not found — check the code', 'error');
      resetJoinButton();
      return;
    }

    const displayName = getDisplayName();
    // getAuthUserId(), NOT getCurrentUser(). Since invisible accounts (Slice
    // 8a) a guest has a real auth id too, and putting it on the seat is what
    // makes four things work:
    //
    //   * claimSeat becomes EXACT for a guest. Its guest rule is a heuristic —
    //     "a same-name row that is still alive might be somebody else" — and
    //     that guess is what let a returning guest be handed a second seat
    //     beside their own. An id is not a guess about who somebody is.
    //   * their play is remembered (record_round_history keys on user_id), so
    //     the game stops re-asking questions they already know, and all of it
    //     carries over the day they sign up because Supabase keeps the id.
    //   * a guest HOST can be rated (op_rate_host needs a host user id).
    //   * `players` becomes lockable at all, which is the whole point.
    //
    // It stays null when anonymous sign-ins are unavailable, and everything
    // then behaves exactly as it did before.
    const authUser = getCurrentUser();
    const userId = getAuthUserId();
    const extras = {};
    if (authUser?.profile) {
      extras.avatarColor = authUser.profile.avatar_color;
      extras.avatarEmoji = authUser.profile.avatar_emoji;
      extras.title = authUser.profile._cachedTitle || null;
    }
    // claimSeat, not addPlayer: joining used to add a row unconditionally, so
    // anybody whose unload beacon never fired — locked phone, lost signal —
    // came back as a SECOND copy of themselves, and from there the lobby's
    // rejoin path made a third and a fourth. See claimSeat.
    // AN IDENTITY IS ACQUIRED HERE, NOT ON PAGE LOAD. Taking a seat is the
    // first moment the database needs to tell this person from another one.
    // Take the id THIS call returns rather than one read earlier — the whole
    // point is that the identity may not have existed a moment ago.
    const seatUserId = await ensureAnonymousIdentity() || userId;
    const { data: player, error: playerErr } = await claimSeat({
      roomId: room.id, displayName, userId: seatUserId, isHost: false, extras,
      // Survives the browser closing, unlike sessionStorage. Without it a guest
      // who shut the tab and came straight back got a second row beside their
      // own still-alive one.
      priorPlayerId: recallSeat(room.id),
    });

    if (playerErr || !player) {
      joinError.textContent = 'Failed to join room. Try again.';
      showToast('Failed to join room', 'error');
      logger.error('Join', 'addPlayer failed', playerErr);
      resetJoinButton();
      return;
    }

    // DELIBERATELY NOT rememberSeat() HERE, and this cost a green test to
    // learn. Writing the new seat id at this point overwrites the OLD one —
    // and the old one is exactly what game.html needs a moment later to move a
    // returning player's answers onto their new row. With it, rejoining a game
    // in progress silently came back with the score wiped.
    //
    // The lobby and the game page both write it, and both do so AFTER any
    // reclaim has run, which is the only safe moment.

    // Store room + player data for lobby
    sessionStorage.setItem('oracle_party_room', JSON.stringify({
      id: room.id,
      code: room.code,
      hostName: room.host_name,
      category: room.category,
      subcategory: room.subcategory || null,
      isHost: false,
      playerId: player.id,
      settings: {
        whoCanJoin: room.who_can_join,
        questionsPerGame: room.questions_per_game,
        questionTimer: room.question_timer,
        autoProceed: room.auto_proceed || 0
      }
    }));

    clearInterval(refreshInterval);
    // If the game is already in progress, go straight to game.html (hot join)
    navigateWithFade(room.status === 'playing' ? 'game.html' : 'lobby.html');
  } catch (err) {
    logger.error('Join', 'Unexpected error', err);
    joinError.textContent = `Error: ${err.message}`;
    resetJoinButton();
  }
}

function resetJoinButton() {
  btnJoin.classList.remove('is-loading');
  btnJoin.textContent = 'Join';
}

// --- Public games ---
async function loadPublicGames() {
  await cleanupOrphanedRooms();
  const rooms = await fetchPublicRooms();

  // Clear skeleton loaders
  $$('.skeleton', publicGamesEl).forEach(el => el.remove());

  if (rooms.length === 0) {
    publicGamesEmpty.classList.remove('hidden');
    // Remove any existing rows
    $$('.public-game-row', publicGamesEl).forEach(el => el.remove());
    return;
  }

  publicGamesEmpty.classList.add('hidden');

  // Remove old rows
  $$('.public-game-row', publicGamesEl).forEach(el => el.remove());

  // THE HOST'S STANDING, FETCHED BEFORE THE LIST IS DRAWN — the whole reason
  // this exists is to be read BEFORE joining a stranger's room, rather than
  // after they have already affected your record. One batched call for every
  // room on screen.
  //
  // A host with no account, or no ratings yet, is absent from this map and
  // renders as "new host" — never as 0%. An unrated host and a disliked one
  // must not look alike, which is the same rule the admin panel's counts follow
  // where a failed count shows "?" and never "0".
  // ACCUMULATED, NOT REPLACED. This list refreshes every ten seconds, and a
  // transient failure returns an empty map — which would flip every host on
  // screen to "new host" and back again, telling somebody deciding whether to
  // join that a host with fifty games has none. Merging into what we already
  // know means a dropped request shows the last good answer instead of a wrong
  // one, and a host who genuinely has no ratings was never in the map anyway.
  for (const [id, rep] of await fetchHostReputations(rooms.map(r => r.host_user_id))) {
    _hostReps.set(id, rep);
  }
  const reps = _hostReps;

  const fragment = document.createDocumentFragment();
  for (const room of rooms) {
    const meta = CATEGORY_META[room.category] || { icon: '?', label: room.category };
    const catLabel = resolveCategoryLabel(room.category, room.subcategory);
    const rep = describeHostReputation(reps.get(room.host_user_id), MIN_HOST_RATINGS);
    const repHtml = rep
      ? `<span class="host-rep${rep.measured && rep.pct < 50 ? ' host-rep--poor' : ''}">${escapeHtml(rep.text)}</span>`
      : '<span class="host-rep host-rep--none">new host</span>';
    const row = document.createElement('button');
    row.className = 'public-game-row';
    row.dataset.code = room.code;
    row.innerHTML = `
      <span class="public-game-row__icon">${meta.emoji || meta.icon}</span>
      <div class="public-game-row__info">
        <div class="public-game-row__host">${escapeHtml(room.host_name)}'s game &middot; ${repHtml}</div>
        <div class="public-game-row__category">${catLabel} &middot; ${room.questions_per_game}Q &middot; ${room.question_timer}s</div>
      </div>
      <div class="public-game-row__meta">
        <div class="public-game-row__code">${room.code}</div>
        <div class="public-game-row__players">${room.player_count} player${room.player_count !== 1 ? 's' : ''}</div>
        ${room.status === 'playing' ? '<div class="public-game-row__status public-game-row__status--playing">In Progress</div>' : '<div class="public-game-row__status public-game-row__status--lobby">In Lobby</div>'}
      </div>
    `;
    fragment.appendChild(row);
  }
  publicGamesEl.appendChild(fragment);
}

// --- Pull-to-Refresh ---
const _pageContent = document.querySelector('.page-content');
let _ptrStartY = 0;
let _ptrActive = false;
let _ptrIndicator = null;

function createPtrIndicator() {
  const el = document.createElement('div');
  el.className = 'ptr-indicator';
  el.innerHTML = '<span class="ptr-indicator__text">Pull to refresh</span>';
  _pageContent.prepend(el);
  return el;
}

_pageContent.addEventListener('touchstart', (e) => {
  if (_pageContent.scrollTop <= 0) {
    _ptrStartY = e.touches[0].clientY;
    _ptrActive = true;
    if (!_ptrIndicator) _ptrIndicator = createPtrIndicator();
    // Disable transition during drag for immediate feedback
    _ptrIndicator.style.transition = 'none';
  }
}, { passive: true });

_pageContent.addEventListener('touchmove', (e) => {
  if (!_ptrActive) return;
  const dy = e.touches[0].clientY - _ptrStartY;
  if (dy < 0) { _ptrActive = false; return; }
  const pull = Math.min(dy, 80);
  _ptrIndicator.style.height = pull + 'px';
  _ptrIndicator.style.opacity = Math.min(pull / PULL_REFRESH_THRESHOLD, 1);
  _ptrIndicator.querySelector('.ptr-indicator__text').textContent =
    pull >= PULL_REFRESH_THRESHOLD ? 'Release to refresh' : 'Pull to refresh';
}, { passive: true });

_pageContent.addEventListener('touchend', () => {
  if (!_ptrActive) return;
  _ptrActive = false;
  const height = parseInt(_ptrIndicator.style.height) || 0;
  // Re-enable transition for smooth collapse
  _ptrIndicator.style.transition = '';
  if (height >= PULL_REFRESH_THRESHOLD) {
    _ptrIndicator.querySelector('.ptr-indicator__text').textContent = 'Refreshing...';
    _ptrIndicator.style.height = '40px';
    loadPublicGames().then(() => {
      _ptrIndicator.style.height = '0';
      _ptrIndicator.style.opacity = '0';
    }).catch(() => {
      _ptrIndicator.style.height = '0';
      _ptrIndicator.style.opacity = '0';
    });
  } else {
    _ptrIndicator.style.height = '0';
    _ptrIndicator.style.opacity = '0';
  }
});

// --- Start ---
init();
