// ============================================
// Oracle Party — Lobby
// Persistent hub with Realtime chat, players, game start
// ============================================

import { $, escapeHtml, renderAvatar } from './utils.js';
import {
  addPlayer,
  fetchPlayers,
  fetchMessages,
  sendMessage,
  removePlayer,
  removePlayerBeacon,
  deleteRoom,
  deleteRoomBeacon,
  promoteToHost,
  toggleReady,
  updateRoomStatus,
  updateGameState,
  fetchRoom,
  subscribeToPlayers,
  subscribeToMessages,
  subscribeToRoom,
  unsubscribe,
  createPresenceChannel,
  fetchPlayerStatsBatch
} from './supabase.js';
import { getDisplayName, ensureDisplayName, initAuth, getCurrentUser } from './auth.js';
import { initHonkSystem, sendHonk, getHonkCount, destroyHonkSystem } from './honk.js';
import { initTypingIndicator, notifyTyping, destroyTypingIndicator } from './typing.js';
import { attachProfileCardHandler } from './profile.js';
import { updatePresence } from './presence.js';
import { computeCategoryTiers } from './titles.js';
import { initThemeToggle } from './theme.js';

// Category display config
const CATEGORY_META = {
  'history':          { icon: '\u23F3', label: 'History', subcategories: [
    { key: 'ancient', icon: '\uD83C\uDFDB\uFE0F', label: 'Ancient' },
    { key: 'medieval', icon: '\uD83D\uDEE1\uFE0F', label: 'Medieval' },
    { key: 'early-modern', icon: '\uD83D\uDD2D', label: 'Early Modern' },
    { key: 'modern', icon: '\uD83D\uDE80', label: 'Modern' },
  ]},
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
let presenceReady = false;
let awayTimestamps = new Map(); // player ID → Date.now() when first seen as away
let playerPollInterval = null;
let presenceHeartbeatId = null;

// --- DOM refs ---
const lobbyCategory = $('#lobby-category');
const lobbyCode = $('#lobby-code');
const playerListEl = $('#player-list');
const playerCountEl = $('#player-count');
const chatMessagesEl = $('#chat-drawer-messages');
const chatInput = $('#chat-drawer-input');
const btnSend = $('#btn-chat-send');
const btnStartGame = $('#btn-start-game');
const btnReady = $('#btn-ready');
const btnCopyCode = $('#btn-copy-code');
const btnLeave = $('#btn-leave');
const btnSettings = $('#btn-settings');
const settingsModal = $('#settings-modal');
const btnCloseSettings = $('#btn-close-settings');
const settingsCategoryGrid = $('#settings-category-grid');

// Player tier badges (user_id → tier string)
let _playerTiers = {};

// Chat bar state
let chatOpen = false;
let unreadCount = 0;
let chatEchoPending = 0;

// --- Init ---
async function init() {
  await Promise.all([ensureDisplayName(), initAuth()]);

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

  // Validate room still exists (may have been deleted while player was away)
  const { data: currentRoom } = await fetchRoom(room.id);
  if (!currentRoom) {
    sessionStorage.removeItem('oracle_party_room');
    window.location.href = 'index.html';
    return;
  }

  // If game is already in progress, redirect — BUT if returning from Play Again,
  // the host may still be resetting the room. Wait briefly and re-check.
  if (currentRoom.status === 'playing') {
    if (sessionStorage.getItem('oracle_party_returning_from_game')) {
      // Host is likely still running deleteAnswersByRoom + updateGameState + updateRoomStatus.
      // Wait 2 seconds and re-check before bouncing back to game.
      await new Promise(r => setTimeout(r, 2000));
      const { data: recheck } = await fetchRoom(room.id);
      if (!recheck) { sessionStorage.removeItem('oracle_party_room'); window.location.href = 'index.html'; return; }
      if (recheck.status === 'playing') {
        // Still playing after 2s — this is a real in-progress game, not a race
        window.location.replace('game.html');
        return;
      }
      // Status changed to 'lobby' — stay here
    } else {
      window.location.replace('game.html');
      return;
    }
  }

  // Subscribe to Realtime (with status monitoring)
  const playerChannel = subscribeToPlayers(room.id, handlePlayerChange);
  const messageChannel = subscribeToMessages(room.id, handleNewMessage);
  const roomChannel = subscribeToRoom(room.id, handleRoomChange);
  channels = [playerChannel, messageChannel, roomChannel];

  // Poll players as fallback + check for stale disconnected players
  playerPollInterval = setInterval(() => {
    loadPlayers();
    checkStalePresence();
  }, 8000);

  // Presence tracking (away/active state)
  presenceChannel = createPresenceChannel(room.id, String(room.playerId));
  presenceChannel
    .on('presence', { event: 'sync' }, () => {
      const ps = presenceChannel.presenceState();
      // Build set of connected + active player IDs
      const connectedActive = new Set();
      for (const key of Object.keys(ps)) {
        for (const p of ps[key]) {
          if (!p.is_away) connectedActive.add(String(p.player_id));
        }
      }
      // Track when each player first went away (preserve existing timestamps)
      const newAway = new Map();
      for (const p of players) {
        const id = String(p.id);
        if (!connectedActive.has(id)) {
          newAway.set(id, awayTimestamps.get(id) || Date.now());
        }
      }
      awayTimestamps = newAway;
      renderPlayers();
      checkStalePresence();
    })
    .subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        presenceReady = true;
        await presenceChannel.track({ player_id: room.playerId, is_away: document.hidden });
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        presenceReady = false;
      }
    });
  channels.push(presenceChannel);

  // Heartbeat: re-track presence every 15s so transient failures self-heal
  presenceHeartbeatId = setInterval(() => {
    if (presenceChannel) {
      presenceChannel.track({ player_id: room.playerId, is_away: document.hidden })
        .catch(() => {});
    }
  }, 15000);

  document.addEventListener('visibilitychange', handleVisibilityChange);

  attachListeners();

  // Honk system
  initHonkSystem(room.id, room.playerId, () => {
    renderPlayers();
  });

  // Honk click handler (event delegation)
  playerListEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.honk-btn');
    if (!btn) return;
    sendHonk(btn.dataset.honkTarget);
  });

  // Profile card on player tap (pass roomId for instant-add)
  attachProfileCardHandler(playerListEl, () => players, room.id);

  // Track presence as "in lobby"
  updatePresence({ activity: 'lobby', roomId: room.id, roomCode: room.code, category: room.category });

  // Typing indicator
  initTypingIndicator(room.id, room.playerId, getDisplayName(), updateTypingUI);

  // Position chat bar below header
  repositionChatBar();

  // Room session leaderboard (cumulative scores across games in this room)
  const roomScoresKey = `oracle_party_room_scores_${room.id}`;
  const roomScores = JSON.parse(sessionStorage.getItem(roomScoresKey) || '{}');
  if (Object.keys(roomScores).length > 0) {
    const scoresSection = $('#room-scores');
    const scoresList = $('#room-scores-list');
    if (scoresSection && scoresList) {
      scoresSection.style.display = '';
      const sorted = Object.entries(roomScores).sort((a, b) => b[1] - a[1]);
      scoresList.innerHTML = sorted.map(([name, score], i) => {
        const isMe = name === getDisplayName();
        return `<div class="room-score-row${isMe ? ' room-score-row--me' : ''}">
          <span class="room-score-row__rank">${i + 1}</span>
          <span class="room-score-row__name">${escapeHtml(name)}</span>
          <span class="room-score-row__score">${score} pts</span>
        </div>`;
      }).join('');
    }
  }

  // System message — detect if returning from a game
  // BUG 1 FIX: When returning via Play Again, show a clear message so the chat
  // doesn't look "empty". Chat messages are loaded from DB (they're preserved),
  // but the chat drawer is closed by default. This message makes it visible
  // that the lobby is active and chat history is intact.
  if (sessionStorage.getItem('oracle_party_returning_from_game')) {
    sessionStorage.removeItem('oracle_party_returning_from_game');
    addSystemMessage('Game ended — back in lobby');
    // BUG 1 FIX: Flash the chat bar so returning players notice chat is preserved.
    // The drawer is closed by default after navigation, so messages feel "gone".
    setTimeout(flashChatBar, 500);
  } else {
    addSystemMessage('You joined the lobby');
  }
  initThemeToggle();
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

  // Chat bar + drawer
  $('#chat-bar').addEventListener('click', toggleChatDrawer);
  btnSend.addEventListener('click', handleSendMessage);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleSendMessage();
  });
  chatInput.addEventListener('input', notifyTyping);

  // Ready toggle (non-host)
  btnReady.addEventListener('click', handleToggleReady);

  // Start game (host)
  btnStartGame.addEventListener('click', handleStartGame);

  // Leave
  btnLeave.addEventListener('click', handleLeave);

  // Settings modal (host only — listeners attached idempotently so promotion works)
  if (room.isHost) {
    attachSettingsListeners();
  }

  // Trap browser back button — replace host/join.html in history so back always goes to index
  history.replaceState({ inLobby: true }, '');
  history.pushState({ inLobby: true }, '');
  window.addEventListener('popstate', handleBackButton);
  // Safari bfcache: if this page is restored from cache after navigating away, go home
  window.addEventListener('pageshow', (e) => { if (e.persisted) { cleanup(); window.location.href = 'index.html'; } });

  // Cleanup + remove player on page unload (tab close / disconnect)
  window.addEventListener('beforeunload', handleUnload);
  window.addEventListener('pagehide', handleUnload);
}

// --- Players ---
async function loadPlayers() {
  players = await fetchPlayers(room.id);
  sortPlayers();
  // Load tier badges for logged-in players (non-blocking)
  _loadPlayerTiers();
  renderPlayers();
  // Fallback host promotion: Supabase Realtime DELETE events may not arrive
  // because the room_id filter can't match DELETE payloads (default REPLICA
  // IDENTITY only sends the primary key). The 5-second poll catches this.
  if (players.length > 0 && !players.some(p => p.is_host)) {
    await handleHostPromotion();
  }
}

function sortPlayers() {
  // Sort by join time ascending (host first)
  players.sort((a, b) => {
    const ta = a.joined_at ? new Date(a.joined_at) : Infinity;
    const tb = b.joined_at ? new Date(b.joined_at) : Infinity;
    return ta - tb;
  });
}

async function _loadPlayerTiers() {
  const cat = room.category;
  const userIds = players.map(p => p.user_id).filter(Boolean);
  if (userIds.length === 0) return;
  try {
    const allStats = await fetchPlayerStatsBatch(userIds);
    // Group stats by user_id, compute tiers
    for (const uid of userIds) {
      const userStats = allStats.filter(s => s.user_id === uid);
      const tiers = computeCategoryTiers(userStats);
      if (tiers[cat]) _playerTiers[uid] = tiers[cat];
    }
    renderPlayers();
  } catch (e) { /* non-critical */ }
}

// Tier colors for lobby badges
const TIER_COLORS = { Novice: '#999', Apprentice: '#4ADE80', Scholar: '#60A5FA', Master: '#A78BFA', Oracle: '#C68A2E' };

function renderPlayers() {
  playerCountEl.textContent = `(${players.length})`;

  playerListEl.innerHTML = players.map(p => {
    const badges = [];
    if (p.is_host) badges.push('<span class="badge badge--host">Host</span>');
    // Tier badge for the selected category
    const tier = _playerTiers[p.user_id];
    if (tier) {
      const color = TIER_COLORS[tier] || '#999';
      badges.push(`<span class="badge badge--tier" style="color:${color};">${tier}</span>`);
    }
    if (p.is_ready) {
      badges.push('<span class="badge badge--ready">Ready</span>');
    } else if (!p.is_host) {
      badges.push('<span class="badge badge--not-ready">Not Ready</span>');
    }
    const isMe = String(p.id) === String(room.playerId);
    const nameDisplay = escapeHtml(p.display_name) + (isMe ? ' (You)' : '');

    const avatarHtml = renderAvatar({ displayName: p.display_name, avatarColor: p.avatar_color, avatarEmoji: p.avatar_emoji });
    const titleHtml = p.title ? `<span class="player-title">${escapeHtml(p.title)}</span>` : '';
    const profileAttr = p.user_id ? `data-profile-user-id="${p.user_id}"` : '';
    const isAway = awayTimestamps.has(String(p.id));
    const honks = getHonkCount(p.id);
    const honkBadge = `<span class="honk-badge" data-honk-player="${p.id}" style="${honks > 0 ? '' : 'display:none'}">${honks}</span>`;
    const honkBtn = isMe ? '' : `<button class="honk-btn" data-honk-target="${p.id}" aria-label="Quack">&#x1F986;</button>`;

    return `
      <div class="player-item${isAway ? ' player-item--away' : ''}" ${profileAttr}>
        <div class="avatar-wrap">
          ${avatarHtml}
          ${honkBadge}
        </div>
        <div class="name-stack">
          <span class="player-item__name">${nameDisplay}</span>
          ${titleHtml}
        </div>
        ${honkBtn}
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
  try {
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
      const deletedId = String(payload.old.id);

      // Remove the player from local list
      players = players.filter(p => String(p.id) !== deletedId);

      // If room is now empty, delete it (cleanup zombie rooms)
      if (players.length === 0) {
        await deleteRoom(room.id);
        return;
      }

      // BUG 2 FIX: Don't rely on payload.old.is_host — Supabase default REPLICA
      // IDENTITY only sends the primary key in OLD for DELETE events, so is_host
      // may be undefined. Instead check if any remaining player has is_host=true.
      // If not, the host was the one who left → promote the next player.
      const hasHost = players.some(p => p.is_host);
      if (!hasHost) {
        await handleHostPromotion();
      }
      renderPlayers();
    } else {
      // Fallback: full re-fetch for unknown event shapes
      await loadPlayers();
    }

    // If current player was removed (e.g. stale beacon from refresh), re-add
    await ensureCurrentPlayer();
  } catch (err) {
    console.error('[Lobby] handlePlayerChange error:', err);
    // Fallback: full re-fetch on any error
    await loadPlayers();
  }
}

/**
 * Handle host promotion when the current host leaves.
 * The player with the lowest joined_at self-promotes (deterministic across all clients).
 */
async function handleHostPromotion() {
  if (players.length === 0) return;

  // Sort by joined_at — first player is the new host
  const sorted = [...players].sort((a, b) => {
    const ta = a.joined_at ? new Date(a.joined_at) : Infinity;
    const tb = b.joined_at ? new Date(b.joined_at) : Infinity;
    return ta - tb;
  });
  const nextHost = sorted[0];

  // Am I the one being promoted?
  if (String(nextHost.id) === String(room.playerId)) {
    room.isHost = true;
    sessionStorage.setItem('oracle_party_room', JSON.stringify(room));
    // Update local player state immediately so badge renders
    const localIdx = players.findIndex(p => String(p.id) === String(room.playerId));
    if (localIdx !== -1) players[localIdx].is_host = true;
    await promoteToHost(room.id, room.playerId, getDisplayName());
    activateHostUI();
    renderPlayers();
    // Notify all players about the host transfer
    sendMessage(room.id, 'System', `${getDisplayName()} is now the host`);
    addSystemMessage('You are now the host');
  }
}

/**
 * Activate host UI controls for a newly promoted host.
 */
function activateHostUI() {
  btnStartGame.classList.remove('hidden');
  btnSettings.classList.remove('hidden');
  btnReady.classList.add('hidden');
  attachSettingsListeners();
}

/** Attach settings modal event listeners (idempotent). */
function attachSettingsListeners() {
  if (attachSettingsListeners._done) return;
  attachSettingsListeners._done = true;

  btnSettings.addEventListener('click', openSettingsModal);
  btnCloseSettings.addEventListener('click', closeSettingsModal);
  settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) closeSettingsModal();
  });
  settingsCategoryGrid.addEventListener('click', (e) => {
    if (e.target.closest('#settings-category-tap')) {
      openLobbyCategorySheet();
    }
  });

  // Category bottom sheet — row taps
  $('#category-sheet-list').addEventListener('click', (e) => {
    const back = e.target.closest('[data-action="back"]');
    if (back) { openLobbyCategorySheet(); return; }

    const row = e.target.closest('.category-sheet-row');
    if (!row) return;
    const catName = row.dataset.category;
    const meta = CATEGORY_META[catName];

    // Subcategory selection — set both category and subcategory in one update
    if (row.dataset.subcategory !== undefined) {
      room.category = catName;
      room.subcategory = row.dataset.subcategory || null;
      updateCategoryDisplay();
      renderSettingsCategories();
      sessionStorage.setItem('oracle_party_room', JSON.stringify(room));
      updateGameState(room.id, { category: catName, subcategory: room.subcategory });
      $('#category-sheet').classList.remove('active');
      return;
    }

    // Category with subs — drill in
    if (meta?.subcategories?.length) {
      showLobbyCategorySheetSubs(catName);
      return;
    }

    // Category without subs — select directly
    handleSettingChange('category', catName);
    renderSettingsCategories();
    $('#category-sheet').classList.remove('active');
  });
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

/**
 * Check if the current player is in the fetched player list.
 * If missing, re-add them (handles page refresh where removePlayerBeacon
 * deleted the record) and update sessionStorage with the new player ID.
 */
async function ensureCurrentPlayer() {
  const me = players.find(p => String(p.id) === String(room.playerId));
  if (me) return;

  // Verify room still exists before re-adding (don't resurrect zombie rooms)
  const { data: roomCheck } = await fetchRoom(room.id);
  if (!roomCheck) {
    sessionStorage.removeItem('oracle_party_room');
    window.location.href = 'index.html';
    return;
  }

  const displayName = getDisplayName();

  // Before creating a new entry, check if a player with the same display name already
  // exists — this happens when the page reloads before removePlayerBeacon completes
  // (pull-to-refresh on iOS, bfcache restore, slow beacon, etc.).
  const existingByName = players.find(p => p.display_name === displayName);
  if (existingByName) {
    room.playerId = existingByName.id;
    sessionStorage.setItem('oracle_party_room', JSON.stringify(room));
    return;
  }

  const authUser = getCurrentUser();
  const rejoinUserId = authUser?.user?.id || null;
  const extras = {};
  if (authUser?.profile) {
    extras.avatarColor = authUser.profile.avatar_color;
    extras.avatarEmoji = authUser.profile.avatar_emoji;
    extras.title = authUser.profile._cachedTitle || null;
  }
  const { data: rejoinedPlayer } = await addPlayer(room.id, displayName, room.isHost, rejoinUserId, extras);
  if (rejoinedPlayer) {
    room.playerId = rejoinedPlayer.id;
    sessionStorage.setItem('oracle_party_room', JSON.stringify(room));
    await loadPlayers();
  }
}

// --- Chat Bar + Drawer ---

function repositionChatBar() {
  const header = document.querySelector('.page-header');
  const footer = document.querySelector('.lobby-footer');
  const bar = $('#chat-bar');
  const drawer = $('#chat-drawer');
  if (!header) return;

  const headerH = header.offsetHeight;
  const barH = 40;
  bar.style.setProperty('--chat-bar-top', `${headerH}px`);
  drawer.style.setProperty('--chat-drawer-top', `${headerH + barH}px`);
  document.body.style.setProperty('--chat-bar-offset', `${barH + 4}px`);

  if (footer) {
    const footerH = footer.offsetHeight;
    drawer.style.setProperty('--chat-drawer-bottom', `${footerH > 0 ? footerH : 0}px`);
  }
}

function toggleChatDrawer() {
  chatOpen = !chatOpen;
  $('#chat-bar').classList.toggle('open', chatOpen);
  $('#chat-drawer').classList.toggle('open', chatOpen);

  if (chatOpen) {
    scrollChatToBottom();
    setTimeout(() => chatInput.focus(), 220);
    unreadCount = 0;
    const badge = $('#chat-bar-badge');
    badge.textContent = '0';
    badge.classList.add('hidden');
  }
}

function updateChatBarPreview(name, text) {
  const preview = $('#chat-bar-preview');
  if (!preview) return;
  const truncated = text.length > 35 ? text.slice(0, 35) + '\u2026' : text;
  preview.innerHTML = `<span class="chat-bar__preview-name">${escapeHtml(name)}:</span> ${escapeHtml(truncated)}`;
}

function flashChatBar() {
  const bar = $('#chat-bar');
  bar.classList.remove('chat-bar--flash');
  void bar.offsetHeight;
  bar.classList.add('chat-bar--flash');
}

async function loadMessages() {
  const messages = await fetchMessages(room.id);
  chatMessagesEl.innerHTML = '';
  for (const msg of messages) {
    appendChatMessage(msg.player_name, msg.message);
  }
  scrollChatToBottom();

  // Show latest message in bar preview
  if (messages.length > 0) {
    const last = messages[messages.length - 1];
    updateChatBarPreview(last.player_name, last.message);
  }
}

function handleNewMessage(payload) {
  if (!payload.new) return;
  const { player_name, message } = payload.new;

  // Dedup: skip Realtime echoes of our own optimistic appends
  if (player_name === getDisplayName() && chatEchoPending > 0) {
    chatEchoPending--;
    return;
  }

  appendChatMessage(player_name, message);
  scrollChatToBottom();
  updateChatBarPreview(player_name, message);

  // Badge + flash when drawer is closed
  if (!chatOpen) {
    unreadCount++;
    const badge = $('#chat-bar-badge');
    badge.textContent = unreadCount;
    badge.classList.remove('hidden');
    flashChatBar();
  }
}

function appendChatMessage(name, text) {
  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble';
  // Look up player for real avatar data (authenticated users get color+emoji)
  const player = players.find(p => p.display_name === name);
  const chatAvatar = renderAvatar({ displayName: name, avatarColor: player?.avatar_color || null, avatarEmoji: player?.avatar_emoji || null, extraClass: 'avatar--chat' });
  bubble.innerHTML = `
    <div class="chat-bubble__header">${chatAvatar}<div class="chat-bubble__name">${escapeHtml(name)}</div></div>
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
  // Update bar preview for system messages too
  updateChatBarPreview('System', text);
}

function scrollChatToBottom() {
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

async function handleSendMessage() {
  const text = chatInput.value.trim();
  if (!text) return;

  chatInput.value = '';
  const name = getDisplayName();
  // Optimistic append
  appendChatMessage(name, text);
  scrollChatToBottom();
  updateChatBarPreview(name, text);
  chatEchoPending++;
  try {
    await sendMessage(room.id, name, text);
  } catch (err) {
    console.error('[Lobby] sendMessage failed:', err);
    chatEchoPending = Math.max(0, chatEchoPending - 1);
    chatInput.value = text;
  }
}

function updateTypingUI(typerNames) {
  const el = $('#typing-indicator');
  if (!el) return;
  if (typerNames.length === 0) {
    el.classList.remove('active');
  } else {
    const text = typerNames.length === 1
      ? `${typerNames[0]} is typing\u2026`
      : typerNames.length === 2
        ? `${typerNames[0]} and ${typerNames[1]} are typing\u2026`
        : `${typerNames[0]} and ${typerNames.length - 1} others are typing\u2026`;
    el.textContent = text;
    el.classList.add('active');
  }
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

  try {
    await toggleReady(room.playerId, isReady);
  } catch (err) {
    console.error('[Lobby] toggleReady failed:', err);
    // Revert optimistic UI update
    isReady = !isReady;
    btnReady.textContent = isReady ? 'Not Ready' : 'Ready Up';
    btnReady.className = isReady
      ? 'btn btn-primary btn-block'
      : 'btn btn-secondary btn-block';
    if (me) {
      me.is_ready = isReady;
      renderPlayers();
    }
  }
}

// --- Start Game (host) ---
async function handleStartGame() {
  if (players.length < 2) return;

  btnStartGame.classList.add('is-loading');
  btnStartGame.textContent = 'Starting...';

  try {
    await updateRoomStatus(room.id, 'playing');
    // Room subscription will trigger navigation for everyone including host
  } catch (err) {
    console.error('[Lobby] startGame failed:', err);
    btnStartGame.classList.remove('is-loading');
    btnStartGame.textContent = 'Start Game';
  }
}

// --- Settings Modal (host) ---
function updateCategoryDisplay() {
  const meta = CATEGORY_META[room.category] || { icon: '?', label: room.category };
  let label = `${meta.icon} ${meta.label}`;
  if (room.subcategory && meta.subcategories) {
    const sub = meta.subcategories.find(s => s.key === room.subcategory);
    if (sub) label += ` \u2014 ${sub.label}`;
  }
  lobbyCategory.textContent = label;
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
  const meta = CATEGORY_META[room.category] || { icon: '?', label: room.category };
  let label = meta.label;
  if (room.subcategory && meta.subcategories) {
    const sub = meta.subcategories.find(s => s.key === room.subcategory);
    if (sub) label += ` \u2014 ${sub.label}`;
  }
  settingsCategoryGrid.innerHTML = `
    <div class="category-sheet-row selected" id="settings-category-tap" style="cursor:pointer;">
      <span class="category-sheet-row__icon">${meta.icon}</span>
      <span class="category-sheet-row__label">${label}</span>
      <span class="category-sheet-row__chevron">\u203A</span>
    </div>
  `;
}

function openLobbyCategorySheet() {
  const sheet = $('#category-sheet');
  const list = $('#category-sheet-list');

  const allCats = Object.entries(CATEGORY_META);
  list.innerHTML = allCats.map(([name, meta]) => {
    const hasSubs = meta.subcategories?.length > 0;
    const isSelected = name === room.category;
    return `
      <div class="category-sheet-row${isSelected ? ' selected' : ''}" data-category="${name}">
        <span class="category-sheet-row__icon">${meta.icon}</span>
        <span class="category-sheet-row__label">${meta.label}</span>
        ${hasSubs ? '<span class="category-sheet-row__chevron">\u203A</span>' : ''}
      </div>
    `;
  }).join('');

  sheet.classList.add('active');
  sheet.querySelector('.bottom-sheet__backdrop').onclick = () => sheet.classList.remove('active');
}

function showLobbyCategorySheetSubs(catName) {
  const meta = CATEGORY_META[catName];
  if (!meta?.subcategories) return;
  const list = $('#category-sheet-list');
  list.innerHTML = `
    <div class="category-sheet-back" data-action="back">\u2190 ${meta.label}</div>
    <div class="category-sheet-row" data-category="${catName}" data-subcategory="">
      <span class="category-sheet-row__icon">${meta.icon}</span>
      <span class="category-sheet-row__label">All ${meta.label}</span>
    </div>
    ${meta.subcategories.map(s => `
      <div class="category-sheet-row" data-category="${catName}" data-subcategory="${s.key}">
        <span class="category-sheet-row__icon">${s.icon}</span>
        <span class="category-sheet-row__label">${s.label}</span>
      </div>
    `).join('')}
  `;
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
    subcategory: 'subcategory',
    whoCanJoin: 'who_can_join',
    questionsPerGame: 'questions_per_game',
    questionTimer: 'question_timer'
  };
  const column = columnMap[key];
  if (!column) return;

  // Update local state
  if (key === 'category') {
    room.category = value;
    // Reset subcategory when category changes (subcategory may not apply to new category)
    room.subcategory = null;
    updateCategoryDisplay();
    // Persist subcategory reset to DB
    updateGameState(room.id, { subcategory: null });
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
  // Room deleted (last player left) — kick to home
  if (payload.eventType === 'DELETE') {
    isLeaving = true;
    cleanup();
    sessionStorage.removeItem('oracle_party_room');
    window.location.href = 'index.html';
    return;
  }

  const newRoom = payload.new;
  if (!newRoom) return;

  // Game start — navigate all players
  if (newRoom.status === 'playing') {
    isLeaving = true;
    cleanup();
    window.location.replace('game.html');
    return;
  }

  // Settings changed (non-host players update from Realtime)
  if (!room.isHost) {
    let changed = false;

    if (newRoom.category && newRoom.category !== room.category) {
      room.category = newRoom.category;
      room.subcategory = newRoom.subcategory || null;
      updateCategoryDisplay();
      const meta = CATEGORY_META[room.category] || { label: room.category };
      addSystemMessage(`Host changed category to ${meta.label}`);
      changed = true;
    }

    // Subcategory changed independently (same category, different sub)
    if (newRoom.subcategory !== undefined && newRoom.subcategory !== room.subcategory && !changed) {
      room.subcategory = newRoom.subcategory;
      updateCategoryDisplay();
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

// ============================================
// STALE PLAYER AUTO-KICK (5 min disconnect → removed)
// ============================================
const STALE_TIMEOUT = 30 * 1000; // 30 seconds — fast fallback for when unload beacons fail

function checkStalePresence() {
  const now = Date.now();
  for (const [id, since] of awayTimestamps) {
    if (now - since < STALE_TIMEOUT) continue;
    // Don't kick ourselves
    if (id === String(room.playerId)) continue;

    const stalePlayer = players.find(p => String(p.id) === id);
    if (!stalePlayer) continue;

    if (stalePlayer.is_host) {
      // Stale host: earliest connected player kicks them (deterministic)
      const connected = players
        .filter(p => !awayTimestamps.has(String(p.id)))
        .sort((a, b) => new Date(a.joined_at) - new Date(b.joined_at));
      if (connected[0] && String(connected[0].id) === String(room.playerId)) {
        removePlayer(id);
      }
    } else if (room.isHost) {
      // Stale non-host: host kicks them
      removePlayer(id);
    }
  }
}

// ============================================
// EXIT PATHS (player leaves the game permanently)
// ============================================
// Three ways a player leaves:
//   1. Leave button  → handleLeave()      → awaits DB delete, then navigates
//   2. Browser back  → handleBackButton()  → fire-and-forget DB delete, navigates immediately
//   3. Tab close     → handleUnload()      → beacon delete (survives page teardown)
//
// Two non-leaving transitions (player stays in the room):
//   4. Game starts   → handleRoomChange()  → navigates to game.html
//   5. Room deleted  → handleRoomChange()  → navigates to index.html
//
// isLeaving prevents handleUnload from double-removing after an
// explicit leave or non-leaving transition.

async function handleLeave() {
  isLeaving = true;
  cleanup();
  if (players.length <= 1) {
    await deleteRoom(room.id);
  } else {
    await removePlayer(room.playerId);
  }
  sessionStorage.removeItem('oracle_party_room');
  // Non-host goes to join page (find another game), host goes home
  window.location.href = room.isHost ? 'index.html' : 'join.html';
}

function handleBackButton() {
  isLeaving = true;
  cleanup();
  if (players.length <= 1) {
    deleteRoomBeacon(room.id);
  } else {
    removePlayerBeacon(room.playerId);
  }
  sessionStorage.removeItem('oracle_party_room');
  window.location.href = room.isHost ? 'index.html' : 'join.html';
}

function handleUnload() {
  if (isLeaving) return;
  // Send beacon FIRST — maximize chance it completes before browser tears down the page
  if (room && room.playerId) {
    if (players.length <= 1) {
      deleteRoomBeacon(room.id);
    } else {
      removePlayerBeacon(room.playerId);
    }
  }
  cleanup();
}

// ============================================
// AFK DETECTION (player temporarily inactive)
// ============================================
// Uses Supabase Realtime Presence (ephemeral, not DB).
// Each connected client tracks { player_id, is_away }.
//
// The sync handler compares presence against the DB players list:
//   - Connected + active tab  → normal icon
//   - Connected + hidden tab  → faded icon
//   - Disconnected (not in presence) → faded icon
//
// presenceReady guards .track() calls. On channel error it
// resets to false; on auto-reconnect subscribe fires again
// and re-tracks current visibility state (self-healing).

function handleVisibilityChange() {
  if (!presenceChannel) return;
  // Always attempt to track — swallow errors so transient failures
  // don't permanently break away detection.
  presenceChannel.track({ player_id: room.playerId, is_away: document.hidden })
    .catch(() => {});
}

// ============================================
// CLEANUP (shared teardown for all exit paths)
// ============================================

function cleanup() {
  window.removeEventListener('popstate', handleBackButton);
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  destroyHonkSystem();
  destroyTypingIndicator();
  clearInterval(playerPollInterval);
  playerPollInterval = null;
  clearInterval(presenceHeartbeatId);
  presenceHeartbeatId = null;
  for (const ch of channels) unsubscribe(ch);
  channels = [];
  presenceReady = false;
  presenceChannel = null;
  awayTimestamps.clear();
}

// --- Start ---
init();
