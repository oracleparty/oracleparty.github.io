// ============================================
// Oracle Party — Lobby
// Persistent hub with Realtime chat, players, game start
// ============================================

import { $, escapeHtml, getAvatarHue } from './utils.js';
import {
  addPlayer,
  fetchPlayers,
  fetchMessages,
  sendMessage,
  removePlayer,
  removePlayerBeacon,
  deleteRoom,
  deleteRoomBeacon,
  toggleReady,
  updateRoomStatus,
  updateGameState,
  subscribeToPlayers,
  subscribeToMessages,
  subscribeToRoom,
  unsubscribe,
  createPresenceChannel
} from './supabase.js';
import { getDisplayName, ensureDisplayName } from './auth.js';

// Category display config
const CATEGORY_META = {
  'history':          { icon: '\u23F3', label: 'History' },
  'science':          { icon: '\u2697\uFE0F', label: 'Science' },
  'nature':           { icon: '\uD83C\uDF3F', label: 'Nature' },
  'arts-literature':  { icon: '\uD83D\uDCDC', label: 'Arts & Literature' },
  'culture-society':  { icon: '\uD83C\uDFDB\uFE0F', label: 'Culture & Society' },
  'pop-culture':      { icon: '\uD83C\uDFAC', label: 'Pop Culture' },
  'world-geography':  { icon: '\uD83D\uDDFA\uFE0F', label: 'World Geography' },
  'technology':       { icon: '\u26A1', label: 'Technology' },
  'sports':           { icon: '\uD83C\uDFC6', label: 'Sports' },
  'food':             { icon: '\uD83C\uDF7D\uFE0F', label: 'Food & Drink' },
  'logic':            { icon: '\uD83E\uDDE9', label: 'Logic' },
  'wild-card':        { icon: '\uD83C\uDFB2', label: 'Wild Card' }
};

// --- State ---
let room = null;
let players = [];
let isReady = false;
let isLeaving = false;
let channels = [];
let presenceChannel = null;
let awayPlayers = new Set();

// --- DOM refs ---
const lobbyCategory = $('#lobby-category');
const lobbyCode = $('#lobby-code');
const playerListEl = $('#player-list');
const playerCountEl = $('#player-count');
const chatMessagesEl = $('#chat-messages');
const chatInput = $('#chat-input');
const btnSend = $('#btn-send');
const btnStartGame = $('#btn-start-game');
const btnReady = $('#btn-ready');
const btnCopyCode = $('#btn-copy-code');
const btnLeave = $('#btn-leave');
const btnSettings = $('#btn-settings');
const settingsModal = $('#settings-modal');
const btnCloseSettings = $('#btn-close-settings');
const settingsCategoryGrid = $('#settings-category-grid');

// --- Init ---
async function init() {
  await ensureDisplayName();

  // Load room from sessionStorage
  const stored = sessionStorage.getItem('oracle_party_room');
  if (!stored) {
    window.location.href = 'index.html';
    return;
  }

  room = JSON.parse(stored);

  // Render static info
  updateCategoryDisplay();
  lobbyCode.textContent = room.code;

  // Show correct action button
  if (room.isHost) {
    btnStartGame.classList.remove('hidden');
    btnSettings.classList.remove('hidden');
  } else {
    btnReady.classList.remove('hidden');
  }

  // Load existing data
  await Promise.all([
    loadPlayers(),
    loadMessages()
  ]);

  // Ensure current player exists (may have been removed by a stale beacon on refresh)
  await ensureCurrentPlayer();

  // Subscribe to Realtime
  const playerChannel = subscribeToPlayers(room.id, handlePlayerChange);
  const messageChannel = subscribeToMessages(room.id, handleNewMessage);
  const roomChannel = subscribeToRoom(room.id, handleRoomChange);
  channels = [playerChannel, messageChannel, roomChannel];

  // Presence tracking (away/active state)
  presenceChannel = createPresenceChannel(room.id);
  presenceChannel
    .on('presence', { event: 'sync' }, () => {
      const ps = presenceChannel.presenceState();
      awayPlayers.clear();
      for (const key of Object.keys(ps)) {
        for (const p of ps[key]) {
          if (p.is_away) awayPlayers.add(String(p.player_id));
        }
      }
      renderPlayers();
    })
    .subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await presenceChannel.track({ player_id: room.playerId, is_away: false });
      }
    });
  channels.push(presenceChannel);

  document.addEventListener('visibilitychange', handleVisibilityChange);

  attachListeners();

  // System message
  addSystemMessage(`You joined the lobby`);
}

// --- Event Listeners ---
function attachListeners() {
  // Copy code
  btnCopyCode.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(room.code);
      btnCopyCode.textContent = 'Copied!';
      btnCopyCode.classList.add('copied');
      setTimeout(() => {
        btnCopyCode.textContent = 'Copy';
        btnCopyCode.classList.remove('copied');
      }, 1500);
    } catch {
      // Fallback: select text
      btnCopyCode.textContent = room.code;
    }
  });

  // Send chat
  btnSend.addEventListener('click', handleSendMessage);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleSendMessage();
  });

  // Ready toggle (non-host)
  btnReady.addEventListener('click', handleToggleReady);

  // Start game (host)
  btnStartGame.addEventListener('click', handleStartGame);

  // Leave
  btnLeave.addEventListener('click', handleLeave);

  // Settings modal (host only)
  if (room.isHost) {
    btnSettings.addEventListener('click', openSettingsModal);
    btnCloseSettings.addEventListener('click', closeSettingsModal);

    // Close on overlay click
    settingsModal.addEventListener('click', (e) => {
      if (e.target === settingsModal) closeSettingsModal();
    });

    // Category selection
    settingsCategoryGrid.addEventListener('click', (e) => {
      const card = e.target.closest('.category-card');
      if (!card) return;
      settingsCategoryGrid.querySelectorAll('.category-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      handleSettingChange('category', card.dataset.category);
    });

    // Toggle groups
    settingsModal.querySelectorAll('.toggle-group').forEach(group => {
      group.addEventListener('click', (e) => {
        const option = e.target.closest('.toggle-option');
        if (!option) return;
        group.querySelectorAll('.toggle-option').forEach(o => o.classList.remove('active'));
        option.classList.add('active');
        const key = group.dataset.setting;
        let value = option.dataset.value;
        if (key === 'questionsPerGame' || key === 'questionTimer') {
          value = parseInt(value, 10);
        }
        handleSettingChange(key, value);
      });
    });
  }

  // Trap browser back button — clean leave instead of broken nav
  history.pushState({ inGame: true }, '');
  window.addEventListener('popstate', handleBackButton);

  // Cleanup + remove player on page unload (tab close / disconnect)
  window.addEventListener('beforeunload', handleUnload);
  window.addEventListener('pagehide', handleUnload);
}

// --- Players ---
async function loadPlayers() {
  players = await fetchPlayers(room.id);
  sortPlayers();
  renderPlayers();
}

function sortPlayers() {
  // Sort by join time ascending (host first)
  players.sort((a, b) => {
    const ta = a.joined_at ? new Date(a.joined_at) : Infinity;
    const tb = b.joined_at ? new Date(b.joined_at) : Infinity;
    return ta - tb;
  });
}

function renderPlayers() {
  playerCountEl.textContent = `(${players.length})`;

  playerListEl.innerHTML = players.map(p => {
    const badges = [];
    if (p.is_host) badges.push('<span class="badge badge--host">Host</span>');
    if (p.is_ready) {
      badges.push('<span class="badge badge--ready">Ready</span>');
    } else if (!p.is_host) {
      badges.push('<span class="badge badge--not-ready">Not Ready</span>');
    }
    const isMe = String(p.id) === String(room.playerId);
    const nameDisplay = escapeHtml(p.display_name) + (isMe ? ' (You)' : '');

    const hue = getAvatarHue(p.display_name);
    const initial = (p.display_name || '?')[0].toUpperCase();
    const isAway = awayPlayers.has(String(p.id));

    return `
      <div class="player-item${isAway ? ' player-item--away' : ''}">
        <div class="answer-row__avatar" style="background: hsl(${hue}, 45%, 45%)">${initial}</div>
        <span class="player-item__name">${nameDisplay}</span>
        <span class="player-item__badges">${badges.join('')}</span>
      </div>
    `;
  }).join('');

  // Update start game button state (host needs 2+ players)
  if (room.isHost) {
    btnStartGame.disabled = players.length < 2;
    btnStartGame.style.opacity = players.length < 2 ? '0.5' : '1';
  }
}

async function handlePlayerChange(payload) {
  const event = payload.eventType;

  // Apply change instantly from the payload (no DB round-trip)
  if (event === 'INSERT' && payload.new) {
    // Avoid duplicates (e.g. if we just re-added ourselves)
    if (!players.some(p => String(p.id) === String(payload.new.id))) {
      players.push(payload.new);
      sortPlayers();
      renderPlayers();
    }
  } else if (event === 'UPDATE' && payload.new) {
    const idx = players.findIndex(p => String(p.id) === String(payload.new.id));
    if (idx !== -1) {
      players[idx] = payload.new;
      renderPlayers();
    }
  } else if (event === 'DELETE' && payload.old) {
    // If the host left, kick everyone to home
    if (payload.old.is_host && String(payload.old.id) !== String(room.playerId)) {
      isLeaving = true;
      cleanup();
      sessionStorage.removeItem('oracle_party_room');
      window.location.href = 'index.html?msg=host_left';
      return;
    }
    players = players.filter(p => String(p.id) !== String(payload.old.id));
    renderPlayers();
  } else {
    // Fallback: full re-fetch for unknown event shapes
    await loadPlayers();
  }

  // If current player was removed (e.g. stale beacon from refresh), re-add
  await ensureCurrentPlayer();
}

/**
 * Check if the current player is in the fetched player list.
 * If missing, re-add them (handles page refresh where removePlayerBeacon
 * deleted the record) and update sessionStorage with the new player ID.
 */
async function ensureCurrentPlayer() {
  const me = players.find(p => String(p.id) === String(room.playerId));
  if (me) return;

  const displayName = getDisplayName();
  const { data: rejoinedPlayer } = await addPlayer(room.id, displayName, room.isHost);
  if (rejoinedPlayer) {
    room.playerId = rejoinedPlayer.id;
    sessionStorage.setItem('oracle_party_room', JSON.stringify(room));
    await loadPlayers();
  }
}

// --- Chat ---
async function loadMessages() {
  const messages = await fetchMessages(room.id);
  chatMessagesEl.innerHTML = '';
  for (const msg of messages) {
    appendChatMessage(msg.player_name, msg.message);
  }
  scrollChatToBottom();
}

function handleNewMessage(payload) {
  if (payload.new) {
    appendChatMessage(payload.new.player_name, payload.new.message);
    scrollChatToBottom();
  }
}

function appendChatMessage(name, text) {
  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble';
  bubble.innerHTML = `
    <div class="chat-bubble__name">${escapeHtml(name)}</div>
    <div class="chat-bubble__text">${escapeHtml(text)}</div>
  `;
  chatMessagesEl.appendChild(bubble);
}

function addSystemMessage(text) {
  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble chat-bubble--system';
  bubble.innerHTML = `<div class="chat-bubble__text">${escapeHtml(text)}</div>`;
  chatMessagesEl.appendChild(bubble);
  scrollChatToBottom();
}

function scrollChatToBottom() {
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

async function handleSendMessage() {
  const text = chatInput.value.trim();
  if (!text) return;

  chatInput.value = '';
  const name = getDisplayName();
  await sendMessage(room.id, name, text);
}

// --- Ready Toggle ---
async function handleToggleReady() {
  isReady = !isReady;
  btnReady.textContent = isReady ? 'Not Ready' : 'Ready Up';
  btnReady.className = isReady
    ? 'btn btn-primary btn-block'
    : 'btn btn-secondary btn-block';

  // Immediately update local player list for instant feedback
  const me = players.find(p => String(p.id) === String(room.playerId));
  if (me) {
    me.is_ready = isReady;
    renderPlayers();
  }

  await toggleReady(room.playerId, isReady);
}

// --- Start Game (host) ---
async function handleStartGame() {
  if (players.length < 2) return;

  btnStartGame.classList.add('is-loading');
  btnStartGame.textContent = 'Starting...';

  await updateRoomStatus(room.id, 'playing');
  // Room subscription will trigger navigation for everyone including host
}

// --- Settings Modal (host) ---
function updateCategoryDisplay() {
  const meta = CATEGORY_META[room.category] || { icon: '?', label: room.category };
  lobbyCategory.textContent = `${meta.icon} ${meta.label}`;
}

function openSettingsModal() {
  renderSettingsCategories();
  syncTogglesToSettings();
  settingsModal.classList.add('active');
}

function closeSettingsModal() {
  settingsModal.classList.remove('active');
}

function renderSettingsCategories() {
  settingsCategoryGrid.innerHTML = Object.entries(CATEGORY_META).map(([name, meta]) => {
    const selected = name === room.category ? 'selected' : '';
    return `
      <button class="category-card ${selected}" data-category="${name}">
        <div class="category-card__icon">${meta.icon}</div>
        <div class="category-card__name">${meta.label}</div>
      </button>
    `;
  }).join('');
}

function syncTogglesToSettings() {
  settingsModal.querySelectorAll('.toggle-group').forEach(group => {
    const key = group.dataset.setting;
    const currentValue = String(room.settings[key]);
    group.querySelectorAll('.toggle-option').forEach(opt => {
      opt.classList.toggle('active', opt.dataset.value === currentValue);
    });
  });
}

async function handleSettingChange(key, value) {
  const columnMap = {
    category: 'category',
    whoCanJoin: 'who_can_join',
    questionsPerGame: 'questions_per_game',
    questionTimer: 'question_timer'
  };
  const column = columnMap[key];
  if (!column) return;

  // Update local state
  if (key === 'category') {
    room.category = value;
    updateCategoryDisplay();
  } else {
    room.settings[key] = value;
  }

  // Persist to sessionStorage
  sessionStorage.setItem('oracle_party_room', JSON.stringify(room));

  // Push to Supabase (triggers Realtime for other players)
  await updateGameState(room.id, { [column]: value });
}

// --- Room change handler ---
function handleRoomChange(payload) {
  // Room deleted (host left) — kick everyone to home
  if (payload.eventType === 'DELETE') {
    isLeaving = true;
    cleanup();
    sessionStorage.removeItem('oracle_party_room');
    window.location.href = 'index.html?msg=host_left';
    return;
  }

  const newRoom = payload.new;
  if (!newRoom) return;

  // Game start — navigate all players
  if (newRoom.status === 'playing') {
    isLeaving = true;
    cleanup();
    window.location.href = 'game.html';
    return;
  }

  // Settings changed (non-host players update from Realtime)
  if (!room.isHost) {
    let changed = false;

    if (newRoom.category && newRoom.category !== room.category) {
      room.category = newRoom.category;
      updateCategoryDisplay();
      const meta = CATEGORY_META[room.category] || { label: room.category };
      addSystemMessage(`Host changed category to ${meta.label}`);
      changed = true;
    }

    if (newRoom.who_can_join && newRoom.who_can_join !== room.settings.whoCanJoin) {
      room.settings.whoCanJoin = newRoom.who_can_join;
      changed = true;
    }

    if (newRoom.questions_per_game && newRoom.questions_per_game !== room.settings.questionsPerGame) {
      room.settings.questionsPerGame = newRoom.questions_per_game;
      addSystemMessage(`Host changed to ${room.settings.questionsPerGame} questions`);
      changed = true;
    }

    if (newRoom.question_timer && newRoom.question_timer !== room.settings.questionTimer) {
      room.settings.questionTimer = newRoom.question_timer;
      addSystemMessage(`Host changed timer to ${room.settings.questionTimer}s`);
      changed = true;
    }

    if (changed) {
      sessionStorage.setItem('oracle_party_room', JSON.stringify(room));
    }
  }
}

// --- Leave ---
async function handleLeave() {
  isLeaving = true;
  cleanup();
  if (room.isHost) {
    // Host leaving: delete the room (cascade-deletes players)
    await deleteRoom(room.id);
  } else {
    await removePlayer(room.playerId);
  }
  sessionStorage.removeItem('oracle_party_room');
  window.location.href = 'index.html';
}

// --- Browser back button ---
function handleBackButton() {
  handleLeave();
}

// --- Visibility change (away/presence) ---
function handleVisibilityChange() {
  if (presenceChannel) {
    presenceChannel.track({ player_id: room.playerId, is_away: document.hidden });
  }
}

// --- Unload ---
function handleUnload() {
  if (isLeaving) return;
  cleanup();
  if (room && room.isHost) {
    deleteRoomBeacon(room.id);
  } else if (room && room.playerId) {
    removePlayerBeacon(room.playerId);
  }
}

// --- Cleanup ---
function cleanup() {
  window.removeEventListener('popstate', handleBackButton);
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  for (const ch of channels) {
    unsubscribe(ch);
  }
  channels = [];
}

// --- Start ---
init();
