// ============================================
// Oracle Party — Join Game Flow
// ============================================

import { $, $$, escapeHtml, showToast, navigateWithFade, navigateWithFadeReplace } from './utils.js';
import { findRoomByCode, fetchPublicRooms, addPlayer, cleanupOrphanedRooms } from './supabase.js';
import { getDisplayName, ensureDisplayName, initAuth, getCurrentUser } from './auth.js';
import { initThemeToggle } from './theme.js';
import { CATEGORY_META, resolveCategoryLabel } from './categories.js';
import { logger } from './logger.js';
import { PUBLIC_GAMES_REFRESH, PULL_REFRESH_THRESHOLD } from './constants.js';

// DOM refs
const codeInput = $('#code-input');
const btnJoin = $('#btn-join');
const joinError = $('#join-error');
const publicGamesEl = $('#public-games');
const publicGamesEmpty = $('#public-games-empty');

let refreshInterval = null;

// --- Init ---
async function init() {
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

  // Auto-join from URL param (e.g. join.html?code=ABCD from friends list)
  const urlCode = new URLSearchParams(window.location.search).get('code');
  if (urlCode) {
    codeInput.value = urlCode.toUpperCase();
    history.replaceState(null, '', window.location.pathname);
    handleJoinByCode();
    return;
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
    const authUser = getCurrentUser();
    const userId = authUser?.user?.id || null;
    const extras = {};
    if (authUser?.profile) {
      extras.avatarColor = authUser.profile.avatar_color;
      extras.avatarEmoji = authUser.profile.avatar_emoji;
      extras.title = authUser.profile._cachedTitle || null;
    }
    const { data: player, error: playerErr } = await addPlayer(room.id, displayName, false, userId, extras);

    if (playerErr || !player) {
      joinError.textContent = 'Failed to join room. Try again.';
      showToast('Failed to join room', 'error');
      logger.error('Join', 'addPlayer failed', playerErr);
      resetJoinButton();
      return;
    }

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

  const fragment = document.createDocumentFragment();
  for (const room of rooms) {
    const meta = CATEGORY_META[room.category] || { icon: '?', label: room.category };
    const catLabel = resolveCategoryLabel(room.category, room.subcategory);
    const row = document.createElement('button');
    row.className = 'public-game-row';
    row.dataset.code = room.code;
    row.innerHTML = `
      <span class="public-game-row__icon">${meta.icon}</span>
      <div class="public-game-row__info">
        <div class="public-game-row__host">${escapeHtml(room.host_name)}'s game</div>
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
