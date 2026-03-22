// ============================================
// Oracle Party — Join Game Flow
// ============================================

import { $, $$ } from './utils.js';
import { findRoomByCode, fetchPublicRooms, addPlayer } from './supabase.js';
import { getDisplayName, ensureDisplayName } from './auth.js';

// Category display config (shared with host.js)
const CATEGORY_META = {
  'history':          { icon: '\u23F3', label: 'History' },
  'science':          { icon: '\u2697\uFE0F', label: 'Science' },
  'nature':           { icon: '\uD83C\uDF3F', label: 'Nature' },
  'arts-literature':  { icon: '\uD83D\uDCDC', label: 'Arts & Lit' },
  'culture-society':  { icon: '\uD83C\uDFDB\uFE0F', label: 'Culture' },
  'pop-culture':      { icon: '\uD83C\uDFAC', label: 'Pop Culture' },
  'world-geography':  { icon: '\uD83D\uDDFA\uFE0F', label: 'Geography' },
  'technology':       { icon: '\u26A1', label: 'Technology' },
  'sports':           { icon: '\uD83C\uDFC6', label: 'Sports' },
  'food':             { icon: '\uD83C\uDF7D\uFE0F', label: 'Food & Drink' },
  'logic':            { icon: '\uD83E\uDDE9', label: 'Logic' },
  'wild-card':        { icon: '\uD83C\uDFB2', label: 'Wild Card' }
};

// DOM refs
const codeInput = $('#code-input');
const btnJoin = $('#btn-join');
const joinError = $('#join-error');
const publicGamesEl = $('#public-games');
const publicGamesEmpty = $('#public-games-empty');

let refreshInterval = null;

// --- Init ---
async function init() {
  try {
    await ensureDisplayName();
  } catch (err) {
    console.error('[Join] ensureDisplayName error:', err);
  }
  attachListeners();
  loadPublicGames();

  // Refresh public games every 10s
  refreshInterval = setInterval(loadPublicGames, 10000);
}

// --- Listeners ---
function attachListeners() {
  $('#btn-back-home').addEventListener('click', () => {
    clearInterval(refreshInterval);
    window.location.href = 'index.html';
  });

  // Only allow digits in code input
  codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.replace(/\D/g, '').slice(0, 6);
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
  if (code.length !== 6) {
    joinError.textContent = 'Enter a 6-digit room code';
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
      joinError.textContent = 'Room not found or game already started';
      resetJoinButton();
      return;
    }

    const displayName = getDisplayName();
    const { data: player, error: playerErr } = await addPlayer(room.id, displayName, false);

    if (playerErr || !player) {
      joinError.textContent = 'Failed to join room. Try again.';
      console.error('[Join] addPlayer failed:', playerErr);
      resetJoinButton();
      return;
    }

    // Store room + player data for lobby
    sessionStorage.setItem('oracle_party_room', JSON.stringify({
      id: room.id,
      code: room.code,
      hostName: room.host_name,
      category: room.category,
      isHost: false,
      playerId: player.id,
      settings: {
        whoCanJoin: room.who_can_join,
        questionsPerGame: room.questions_per_game,
        questionTimer: room.question_timer
      }
    }));

    clearInterval(refreshInterval);
    window.location.href = 'lobby.html';
  } catch (err) {
    console.error('[Join] Unexpected error:', err);
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
  const rooms = await fetchPublicRooms();

  if (rooms.length === 0) {
    publicGamesEmpty.textContent = 'No public games right now';
    publicGamesEmpty.style.display = '';
    // Remove any existing rows
    $$('.public-game-row', publicGamesEl).forEach(el => el.remove());
    return;
  }

  publicGamesEmpty.style.display = 'none';

  // Remove old rows
  $$('.public-game-row', publicGamesEl).forEach(el => el.remove());

  const fragment = document.createDocumentFragment();
  for (const room of rooms) {
    const meta = CATEGORY_META[room.category] || { icon: '?', label: room.category };
    const row = document.createElement('button');
    row.className = 'public-game-row';
    row.dataset.code = room.code;
    row.innerHTML = `
      <span class="public-game-row__icon">${meta.icon}</span>
      <div class="public-game-row__info">
        <div class="public-game-row__host">${escapeHtml(room.host_name)}'s game</div>
        <div class="public-game-row__category">${meta.label}</div>
      </div>
      <div class="public-game-row__meta">
        <div class="public-game-row__code">${room.code}</div>
        <div class="public-game-row__players">${room.player_count} player${room.player_count !== 1 ? 's' : ''}</div>
      </div>
    `;
    fragment.appendChild(row);
  }
  publicGamesEl.appendChild(fragment);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// --- Start ---
init();
