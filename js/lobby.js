// ============================================
// Oracle Party — Lobby
// Persistent hub with Realtime chat, players, game start
// ============================================

import { $, escapeHtml, renderAvatar, showToast, navigateWithFade, navigateWithFadeReplace, notifyConnectionLost, notifyConnectionRestored } from './utils.js';
import { logger } from './logger.js';
import { presenceNeedsRebuild } from './presence-health.js';
import { STALE_TIMEOUT_MS, DISCONNECTED_TIMEOUT_MS, HOST_HANDOVER_MS, HEARTBEAT_DB_INTERVAL_MS, LOBBY_PLAYER_DEBOUNCE_MS, HOST_WAIT_TIMEOUT_MS, CHAT_FLASH_MS, CHAT_MSG_DELAY_MS,
         BOT_DISPLAY_NAME, BOT_AVATAR_COLOR, BOT_AVATAR_EMOJI, MAX_BOTS_PER_ROOM, AWAY_GRACE_MS } from './constants.js';
import {
  addPlayer,
  claimSeat,
  addBot,
  fetchRoomScores,
  fetchPlayers,
  fetchMessages,
  sendMessage,
  removePlayer,
  removePlayerBeacon,
  markDisconnectedBeacon,
  playerHeartbeat,
  deleteRoom,
  deleteRoomBeacon,
  leaveRoomBeacon,
  serverFunctionsMissing,
  leaveRoomOnServer,
  sweepRoomsOnServer,
  promoteToHost,
  demoteHost,
  promoteToCohost,
  demoteCohost,
  toggleReady,
  updateRoomStatus,
  updateGameState,
  setPhaseOnServer,
  fetchRoom,
  subscribeToPlayers,
  subscribeToMessages,
  subscribeToRoom,
  unsubscribe,
  createPresenceChannel,
  fetchPlayerStatsBatch,
  fetchQuestionCount,
  toggleMessageHeart,
  fetchAllOpenQuestionCount,
  fetchExclusiveWildCardCount
} from './supabase.js';
import { getDisplayName, ensureDisplayName, ensureAnonymousIdentity, initAuth, getCurrentUser, getAuthUserId, rememberChatCutoff, rememberSeat, recallSeat } from './auth.js';
import { initHonkSystem, sendHonk, getHonkCount, destroyHonkSystem } from './honk.js';
import { initTypingIndicator, notifyTyping, destroyTypingIndicator } from './typing.js';
import { attachProfileCardHandler } from './profile.js';
import { updatePresence } from './presence.js';
import { computeCategoryTiers } from './titles.js';
import { initThemeToggle } from './theme.js';
import { CATEGORY_META, resolveCategoryLabel, resolveSubcategoryIcon, findSubcategoryNode } from './categories.js';

// --- State ---
let room = null;
let players = [];
let isReady = false;
let lobbySheetNavStack = [];
let isLeaving = false;
let channels = [];
let presenceChannel = null;
let presenceReady = false;
let awayTimestamps = new Map(); // player ID → Date.now() when first seen as away
let awayRecheckId = null;       // re-renders once the youngest away player crosses the grace

/**
 * Should the lobby SAY this player is away? (AWAY_GRACE_MS)
 *
 * The game page has the same rule in js/game/state.js — the lobby keeps its own
 * presence map, so it needs its own reader, and both are written against the
 * same constant rather than against two numbers that can drift.
 *
 * Presence flips the instant a phone backgrounds, so a glance at a notification
 * used to grey somebody out in front of the whole lobby. Nothing that ACTS on
 * absence reads this: the stale sweep and host promotion both go through
 * last_seen_at.
 */
function isPlayerAway(id) {
  const since = awayTimestamps.get(String(id));
  return since !== undefined && (Date.now() - since) >= AWAY_GRACE_MS;
}

/**
 * Presence only syncs on CHANGE, so a player who goes away and stays away would
 * never be shown as away at all without this — the sync that recorded them
 * lands while they are still inside the grace, and nothing looks again.
 */
function scheduleAwayRecheck() {
  clearTimeout(awayRecheckId);
  awayRecheckId = null;
  let soonest = Infinity;
  for (const since of awayTimestamps.values()) {
    const left = AWAY_GRACE_MS - (Date.now() - since);
    if (left > 0 && left < soonest) soonest = left;
  }
  if (soonest === Infinity) return;
  awayRecheckId = setTimeout(() => { awayRecheckId = null; renderPlayers(); }, soonest + 50);
}
let playerPollInterval = null;
let presenceHeartbeatId = null;
let dbHeartbeatId = null;

// --- DOM refs ---
const lobbyCategory = $('#lobby-category');
const lobbyCode = $('#lobby-code');
const hostListEl = $('#host-list');
const playerListEl = $('#player-list');
const chatMessagesEl = $('#chat-drawer-messages');
const chatInput = $('#chat-drawer-input');
const btnSend = $('#btn-chat-send');
const btnStartGame = $('#btn-start-game');
const btnAddBot = $('#btn-add-bot');
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
  // Cancel the boot-guard timer in <head> — JS module chain is alive.
  window.__appReady = true;
  if (window.__appBootGuard) clearTimeout(window.__appBootGuard);
  document.body.style.opacity = '1';
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

  // Load existing data.
  //
  // PLAYERS FIRST, NOT CONCURRENTLY. Chat avatars are looked up in the player
  // list, so running these together is a race: whichever resolves first wins,
  // and when the messages won every bubble fell back to a plain letter and
  // people's chosen faces vanished from their own messages. Reported after a
  // real game, on returning to the lobby via Play Again. refreshChatAvatars()
  // still covers player data that arrives later than this — a tier load, or
  // somebody joining — but the common case no longer depends on who is quicker.
  await loadPlayers();
  await loadMessages();

  // loadMessages scrolls chat to bottom — reset page to top so user sees room card first
  const scrollArea = document.querySelector('.lobby-scroll');
  if (scrollArea) scrollArea.scrollTop = 0;

  // Ensure current player exists (may have been removed by a stale beacon on refresh)
  await ensureCurrentPlayer();

  // Write the seat down durably. This only ever happened on the game page, so
  // somebody who sat in a lobby and closed the tab left no record of which row
  // was theirs — and claimSeat, which will not touch a still-alive same-name
  // row in case it belongs to a stranger, had no way to recognise them. They
  // came back as a second copy of themselves. localStorage, so it survives the
  // browser closing rather than just a refresh.
  rememberSeat(room.id, room.playerId);

  // Validate room still exists (may have been deleted while player was away)
  const { data: currentRoom } = await fetchRoom(room.id);
  if (!currentRoom) {
    sessionStorage.removeItem('oracle_party_room');
    window.location.href = 'index.html';
    return;
  }

  // If we explicitly came from a game ending (Play Again / Quit / "Return to Lobby"
  // notice), trust the flag over the DB read. The host's lobby-reset write may still
  // be in flight; bouncing back to game.html when game_phase is already 'lobby' lands
  // us in a dead game with no recovery (host would inadvertently start a new game,
  // non-host would hang on the loading screen waiting for question_ids).
  const isReturningFromGame = !!sessionStorage.getItem('oracle_party_returning_from_game');
  if (currentRoom.status === 'playing' && !isReturningFromGame) {
    window.location.replace('game.html');
    return;
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
  buildPresenceChannel();

  // Heartbeat: re-announce presence, and REBUILD the channel if it has died.
  // See buildPresenceChannel — re-announcing on a dead channel is what left a
  // returning player greyed out to the whole room, and the room greyed out to
  // them.
  presenceHeartbeatId = setInterval(beatPresence, LOBBY_PLAYER_DEBOUNCE_MS);

  // DB heartbeat: update last_seen_at every 15s for stale detection.
  // Also sends an immediate heartbeat to clear any disconnected_at from a prior refresh.
  playerHeartbeat(room.playerId).catch(() => {});
  dbHeartbeatId = setInterval(() => {
    playerHeartbeat(room.playerId).catch(() => {});
  }, HEARTBEAT_DB_INTERVAL_MS);

  document.addEventListener('visibilitychange', handleVisibilityChange);

  attachListeners();

  // Honk system
  initHonkSystem(room.id, room.playerId, () => {
    renderPlayers();
  });

  // Honk / transfer / co-host click handling (event delegation).
  //
  // Attached to BOTH lists. renderPlayers() puts hosts and co-hosts in
  // hostListEl and everyone else in playerListEl, so a player moves between
  // containers the moment they are promoted. With the listener only on
  // playerListEl, the Demote button — which by definition only ever appears in
  // hostListEl — was never wired to anything, and neither were a co-host's
  // honk and transfer-host buttons. Promoting worked once and demoting was
  // impossible.
  const handlePlayerListClick = (e) => {
    const honkBtn = e.target.closest('.honk-btn');
    if (honkBtn) {
      sendHonk(honkBtn.dataset.honkTarget);
      return;
    }
    const transferBtn = e.target.closest('.transfer-host-btn');
    if (transferBtn) {
      handleTransferHost(transferBtn.dataset.transferId, transferBtn.dataset.transferName);
      return;
    }
    const cohostBtn = e.target.closest('.cohost-btn');
    if (cohostBtn) {
      handleCohostToggle(cohostBtn.dataset.cohostId, cohostBtn.dataset.cohostName, cohostBtn.classList.contains('cohost-btn--demote'));
      return;
    }
    const removeBot = e.target.closest('.remove-bot-btn');
    if (removeBot) {
      handleRemoveBot(removeBot.dataset.removeBotId);
    }
  };
  playerListEl.addEventListener('click', handlePlayerListClick);
  hostListEl.addEventListener('click', handlePlayerListClick);

  // Profile card on player tap (pass roomId for instant-add)
  attachProfileCardHandler(playerListEl, () => players, room.id, () => room.playerId);
  attachProfileCardHandler(hostListEl, () => players, room.id, () => room.playerId);

  // Track presence as "in lobby"
  updatePresence({ activity: 'lobby', roomId: room.id, roomCode: room.code, category: room.category });

  // Typing indicator
  initTypingIndicator(room.id, room.playerId, getDisplayName(), updateTypingUI);

  // Room session leaderboard (cumulative scores across games in this room).
  //
  // Read from the ROOM, not from sessionStorage. The old copy died with the tab
  // — somebody who left and came back saw nothing — and every device kept its
  // own tally built from whatever games that device happened to witness, so two
  // people could read different numbers off the same lobby. Needs migration 038;
  // until it is applied fetchRoomScores returns {} and this section simply does
  // not appear, exactly as it does for a room whose first game is unfinished.
  renderRoomScores(room.id);

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
    setTimeout(flashChatBar, CHAT_FLASH_MS);
  } else {
    addSystemMessage('You joined the lobby');
  }
  initThemeToggle();
}

// --- Event Listeners ---
function attachListeners() {
  // Copy code
  btnCopyCode.addEventListener('click', async () => {
    const joinUrl = `${window.location.origin}${window.location.pathname.replace(/[^/]*$/, '')}join.html?code=${room.code}`;
    try {
      // Try native share first on mobile
      if (navigator.share) {
        await navigator.share({ title: 'Join my Oracle Party game!', text: `Join with code ${room.code}`, url: joinUrl });
        return;
      }
      await navigator.clipboard.writeText(joinUrl);
      const hint = btnCopyCode.querySelector('.lobby-room__card-hint');
      if (hint) hint.textContent = 'link copied!';
      btnCopyCode.classList.add('copied');
      showToast('Join link copied!', 'success');
      setTimeout(() => {
        if (hint) hint.textContent = 'tap to copy';
        btnCopyCode.classList.remove('copied');
      }, CHAT_MSG_DELAY_MS);
    } catch {
      // Fallback: no-op, code is visible
    }
  });

  // Chat send

  btnSend.addEventListener('click', handleSendMessage);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleSendMessage();
  });
  chatInput.addEventListener('input', notifyTyping);

  // Heart button click handler (event delegation)
  chatMessagesEl.addEventListener('click', async (e) => {
    const heartBtn = e.target.closest('.heart-btn');
    if (!heartBtn) return;
    e.stopPropagation();
    // Per-button busy guard: rapid double-taps would otherwise fire two
    // toggleMessageHeart RPCs that race on the same read-then-write and
    // converge to the WRONG state (final tap intent lost). Lock until the
    // current RPC resolves.
    if (heartBtn.dataset.busy === '1') return;
    heartBtn.dataset.busy = '1';
    const bubble = heartBtn.closest('.chat-bubble');
    const msgId = bubble?.dataset.msgId;
    if (!msgId) { heartBtn.dataset.busy = '0'; return; }
    // Optimistic toggle
    const iHearted = heartBtn.classList.contains('hearted');
    heartBtn.classList.toggle('hearted', !iHearted);
    const countEl = bubble.querySelector('.heart-count');
    let count = parseInt(countEl.textContent, 10) || 0;
    count += iHearted ? -1 : 1;
    countEl.textContent = count;
    countEl.classList.toggle('hidden', count <= 0);
    // Persist
    try { await toggleMessageHeart(msgId, getDisplayName()); }
    finally { heartBtn.dataset.busy = '0'; }
  });

  // Ready toggle (non-host)
  btnReady.addEventListener('click', handleToggleReady);

  // Start game (host)
  btnStartGame.addEventListener('click', handleStartGame);

  // Add a practice bot (host)
  if (btnAddBot) btnAddBot.addEventListener('click', handleAddBot);

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
  // liveHosts(), not "does any row carry the flag": an abandoned row satisfies
  // the second perfectly, and a room whose only host is a ghost never promotes
  // anybody, so nobody present can start the game. That is exactly what a live
  // game reported.
  if (humanPlayers().length > 0 && liveHosts().length === 0) {
    await handleHostPromotion();
  }
}

/**
 * Everyone in the room who is not a bot.
 *
 * Used everywhere the question is really "is anybody still here" — who can
 * inherit the host role, and whether leaving empties the room. A bot cannot
 * hold a lobby open on its own: if the last person walks out, a room with a
 * bot in it would otherwise survive forever with nobody in it.
 */
function humanPlayers() {
  return players.filter(p => !p.is_bot);
}

/**
 * Has this player been heard from recently enough to count as here?
 *
 * A missing timestamp means "cannot tell", and cannot-tell counts as HERE —
 * the same rule the stale sweep uses. Treating absence of evidence as evidence
 * of absence once had hosts kicking every player seconds after they joined.
 */
function isPresentInLobby(p) {
  const raw = p.last_seen_at || p.joined_at;
  if (!raw) return true;
  return (Date.now() - new Date(raw).getTime()) < STALE_TIMEOUT_MS;
}

/**
 * A host who is ACTUALLY HERE.
 *
 * The room used to ask `players.some(p => p.is_host)`, which a dead row
 * satisfies perfectly. Reported from a live game: two abandoned copies of one
 * player held the crown, so the room believed it had a host, promotion never
 * ran, and the only real person in the lobby was shown "Ready Up" with no way
 * to start the game. A host nobody can reach is not a host.
 */
function liveHosts() {
  return players.filter(p => p.is_host && !p.is_bot && isPresentInLobby(p));
}

/**
 * Am I the one who should act on behalf of a room with no reachable host?
 *
 * Earliest joiner among those present, so every client picks the same person
 * without needing to agree with each other first.
 */
function iAmTheCaretaker() {
  const present = humanPlayers().filter(isPresentInLobby)
    .sort((a, b) => new Date(a.joined_at || 0) - new Date(b.joined_at || 0));
  return present.length > 0 && String(present[0].id) === String(room.playerId);
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

// Tier colour now comes from CSS via data-tier, not an inline style.
//
// These were badge colours, chosen to sit on a badge's own background. Moving
// the tier under the player's name turned them into bare text on the row, and
// measured against the light theme they came out at 2.5:1 — legible on a
// desk, not on a phone in daylight. An inline style also cannot respond to the
// theme, so one value had to serve white, dark grey and black backgrounds.

function _renderPlayerItem(p, { showRoleBadge = false } = {}) {
  const badges = [];
  const away = isPlayerAway(p.id);
  if (showRoleBadge) {
    if (p.is_host) badges.push('<span class="badge badge--host">Host</span>');
    if (p.is_cohost) badges.push('<span class="badge badge--cohost">Co-Host</span>');
  }
  // AWAY IS A WORD, not only a fade.
  //
  // Fading to 40% was the entire signal, and a playtest could not read it: it
  // looks equally like away, gone, disabled, or still loading. The owner asked
  // for a label, and it goes in the READY SLOT rather than beside it — a badge
  // added to this row is what overflowed it by 71px in August, and ready state
  // is exactly the thing that stops mattering once somebody's phone is asleep.
  //
  // Host and co-host DO get it, even though they get no ready badge: a host
  // being away is the most consequential fact in the lobby, because the game
  // cannot start without them.
  if (away && !p.is_bot) {
    badges.push('<span class="badge badge--away">Away</span>');
  } else if (p.is_ready && !p.is_host && !p.is_cohost) {
    // Ready state is lobby state, and it is meaningless for the people who run
    // the lobby — "Not Ready" was already suppressed for them, so showing them
    // "Ready" was inconsistent as well as wasteful.
    badges.push('<span class="badge badge--ready">Ready</span>');
  } else if (!p.is_ready && !p.is_host && !p.is_cohost) {
    // A DOT, NOT THE WIDEST WORDS IN THE ROW.
    //
    // "Not Ready" measured 81px and sat on nearly every row nearly all the
    // time, because not-ready is where everybody starts. Nothing else in this
    // row can yield — the badge strip is `flex: 0 0 auto` and .name-stack has a
    // hard 72px floor — so those 81px came straight out of the name and title.
    // Measured at 375px: the row is 327px wide and its contents needed 329px,
    // with the name box pinned at exactly its floor. That is the reported "the
    // players list is too wide, can't see my friend's full title, and Not Ready
    // is cut off".
    //
    // The signal anybody actually scans a lobby for is who IS ready, and that
    // still says "Ready" in words. Its absence is the other half, and a dot
    // carries it in 14px instead of 81. Labelled for screen readers and given a
    // title so a long-press still explains it.
    badges.push('<span class="badge badge--not-ready" role="img" aria-label="Not ready" title="Not ready"></span>');
  }
  // A bot carries one badge and nothing else. It has no ready state to report
  // (it is always ready), no tier and no title, so the row stays inside the
  // budget that the co-host overflow taught us to respect.
  if (p.is_bot) {
    badges.length = 0;
    badges.push('<span class="badge badge--bot">Bot</span>');
  }

  const isMe = String(p.id) === String(room.playerId);
  const nameDisplay = escapeHtml(p.display_name) + (isMe ? ' (You)' : '');

  const avatarHtml = renderAvatar({ displayName: p.display_name, avatarColor: p.avatar_color, avatarEmoji: p.avatar_emoji });

  // Tier and title sit UNDER the name, not in the badge strip.
  //
  // Measured at 375px: a signed-in player promoted to co-host while ready
  // carried three badges — Co-Host 75px, tier 66px, Ready 54px — and the badge
  // strip is `flex: 0 0 auto` while .name-stack has a hard 72px floor, so
  // nothing in the row could absorb the shortfall. The row overflowed by 56px
  // and the whole page became draggable sideways on a phone. Guests have no
  // tier, which is why the robot playtests never saw it and a real signed-in
  // game always did.
  //
  // Down here both can truncate with an ellipsis instead, and the badge strip
  // is bounded to one role badge or one ready badge.
  const tier = _playerTiers[p.user_id];
  const tierHtml = tier
    ? `<span class="player-tier" data-tier="${escapeHtml(String(tier).toLowerCase())}">${escapeHtml(tier)}</span>`
    : '';
  const titleText = p.title ? `<span class="player-title">${escapeHtml(p.title)}</span>` : '';
  // Always rendered, even when empty. A signed-in player has a tier and a
  // guest does not, so rows would otherwise be 44px or 50px depending on who
  // was in them and the list would look ragged. The empty span reserves the
  // second line so every row is the same height.
  // THE TIER YIELDS BEFORE THE TITLE DOES. `.player-tier` was `flex: 0 0 auto`,
  // so it took its 63px of a 141px line and the TITLE truncated — measured at
  // 375px, the title needed 96px and got 72. That is "can't even see my
  // friend's full title", and it is the row-level fault one level down: two
  // things on a line and only one of them able to give way.
  //
  // Moving the tier up beside the name was tried and measured WORSE: the name
  // then truncated instead ("QuizMasterMax" 74px of 98px), and the name is the
  // one thing on this row nobody can do without. Shrink order is the fix, not
  // relocation — see .player-tier in the stylesheet.
  const titleHtml = `<span class="name-substack">${tierHtml}${titleText}</span>`;
  const profileAttr = p.user_id ? `data-profile-user-id="${p.user_id}"` : '';
  const honks = getHonkCount(p.id);
  const honkBadge = `<span class="honk-badge" data-honk-player="${p.id}" style="${honks > 0 ? '' : 'display:none'}">${honks}</span>`;
  // No honking at a bot — there is nobody on the other end to startle.
  const honkBtn = (isMe || p.is_bot) ? '' : `<button class="honk-btn" data-honk-target="${p.id}" aria-label="Quack">&#x1F986;</button>`;
  // Host actions are icons, not words. Measured at 375px, the word buttons
  // ("Co-Host" 65px + "Transfer" 73px) plus the honk button and a status badge
  // left ZERO pixels for the player's name, which collapsed to nothing. Icons
  // keep every row on one line and the same height, so the list stays even.
  // aria-label carries the meaning for screen readers.
  //
  // A bot gets neither. Host and co-host are for humans: a bot cannot start a
  // game, advance a phase or judge an answer, so a room in its hands is a
  // frozen room. Its only control is the host's remove button.
  const transferBtn = (room.isHost && !isMe && !p.is_host && !p.is_bot)
    ? `<button class="icon-btn transfer-host-btn" data-transfer-id="${p.id}" data-transfer-name="${escapeHtml(p.display_name)}" aria-label="Make ${escapeHtml(p.display_name)} the host" title="Make host">&#x1F451;</button>`
    : '';
  const removeBotBtn = (room.isHost && p.is_bot)
    ? `<button class="icon-btn remove-bot-btn" data-remove-bot-id="${p.id}" aria-label="Remove ${escapeHtml(p.display_name)}" title="Remove bot">&#x2715;</button>`
    : '';
  let cohostBtn = '';
  if (room.isHost && !isMe && !p.is_host && !p.is_bot) {
    if (p.is_cohost) {
      cohostBtn = `<button class="icon-btn cohost-btn cohost-btn--demote" data-cohost-id="${p.id}" data-cohost-name="${escapeHtml(p.display_name)}" aria-label="Remove ${escapeHtml(p.display_name)} as co-host" title="Remove co-host">&#x2605;</button>`;
    } else {
      cohostBtn = `<button class="icon-btn cohost-btn" data-cohost-id="${p.id}" data-cohost-name="${escapeHtml(p.display_name)}" aria-label="Make ${escapeHtml(p.display_name)} co-host" title="Make co-host">&#x2606;</button>`;
    }
  }

  return `
    <div class="player-item${away ? ' player-item--away' : ''}" ${profileAttr}>
      <div class="avatar-wrap">
        ${avatarHtml}
        ${honkBadge}
      </div>
      <div class="name-stack">
        <span class="player-item__name">${nameDisplay}</span>
        ${titleHtml}
      </div>
      ${honkBtn}
      ${cohostBtn}
      ${transferBtn}
      ${removeBotBtn}
      <span class="player-item__badges">${badges.join('')}</span>
    </div>
  `;
}

/**
 * Put people's faces back on chat messages that were drawn before the player
 * list existed. Runs after every render of that list, which is the moment the
 * information arrives.
 *
 * Only touches bubbles that are currently showing the letter fallback, so it
 * costs nothing on the common path and cannot undo a correct avatar.
 */
function refreshChatAvatars() {
  if (!chatMessagesEl || players.length === 0) return;
  for (const bubble of chatMessagesEl.querySelectorAll('.chat-bubble[data-author]')) {
    const holder = bubble.querySelector('.chat-bubble__header');
    if (!holder) continue;
    const player = players.find(p => p.display_name === bubble.dataset.author);
    if (!player || (!player.avatar_emoji && !player.avatar_color)) continue;
    const current = holder.querySelector('.avatar');
    if (current && current.textContent.trim() === (player.avatar_emoji || '').trim()) continue;
    const nameEl = holder.querySelector('.chat-bubble__name');
    holder.innerHTML = renderAvatar({
      displayName: bubble.dataset.author,
      avatarColor: player.avatar_color || null,
      avatarEmoji: player.avatar_emoji || null,
      extraClass: 'avatar--chat',
    }) + (nameEl ? nameEl.outerHTML : '');
  }
}

function renderPlayers() {
  const hosts = players.filter(p => p.is_host || p.is_cohost);
  const others = players.filter(p => !p.is_host && !p.is_cohost);

  // Render host/cohost section
  hostListEl.innerHTML = hosts.map(p => _renderPlayerItem(p, { showRoleBadge: true })).join('');

  // Render regular players (or waiting message if only host)
  if (others.length === 0) {
    playerListEl.innerHTML = '<div class="empty-state" style="padding:var(--space-sm) 0"><p class="empty-state__subtext">Waiting for players to join...</p></div>';
  } else {
    playerListEl.innerHTML = others.map(p => _renderPlayerItem(p)).join('');
  }

  // Update start game button state (host needs 2+ players)
  if (room.isHost) {
    btnStartGame.disabled = players.length < 2;
    btnStartGame.style.opacity = players.length < 2 ? '0.5' : '1';
  }

  renderAddBotButton();
  // The player list is the source of chat avatars, so this is the moment any
  // message drawn before it arrived can get its face back.
  refreshChatAvatars();
}

/**
 * The host's "add a practice bot" button.
 *
 * Host only, and only in the lobby. A bot exists because a person put it
 * there — there are no bot-only rooms and no bots that appear on their own.
 * Once the room is at MAX_BOTS_PER_ROOM the button goes away; removal is the
 * ✕ on the bot's own row, so add and remove are never both offered at once.
 */
function renderAddBotButton() {
  if (!btnAddBot) return;
  const botCount = players.filter(p => p.is_bot).length;
  const show = room.isHost && botCount < MAX_BOTS_PER_ROOM;
  btnAddBot.classList.toggle('hidden', !show);
}

let _isAddingBot = false;
async function handleAddBot() {
  if (!room.isHost || _isAddingBot) return;
  if (players.filter(p => p.is_bot).length >= MAX_BOTS_PER_ROOM) return;
  _isAddingBot = true;
  btnAddBot.disabled = true;
  try {
    const { data, error } = await addBot(room.id, BOT_DISPLAY_NAME, {
      avatarColor: BOT_AVATAR_COLOR,
      avatarEmoji: BOT_AVATAR_EMOJI
    });
    // addBot already toasts on failure (reportWriteFailure). Nothing more to
    // say here — but do NOT touch the local list, or the lobby would show a
    // bot that the database refused.
    if (error || !data) return;
    if (!players.some(p => String(p.id) === String(data.id))) {
      players.push(data);
      sortPlayers();
    }
    renderPlayers();
    // No chat notice. The bot appearing in the player list IS the notification,
    // and a system message for something the host just did themselves is noise
    // in a pane that is 34vh tall — it pushes real conversation up for no
    // information anybody lacked.
  } finally {
    _isAddingBot = false;
    btnAddBot.disabled = false;
  }
}

async function handleRemoveBot(botId) {
  if (!room.isHost) return;
  const { error } = await removePlayer(botId, room.id, room.playerId);
  if (error) {
    showToast("Couldn't remove the bot", 'error');
    return;
  }
  players = players.filter(p => String(p.id) !== String(botId));
  renderPlayers();
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

        // Detect host/cohost changes for this player
        if (String(payload.new.id) === String(room.playerId)) {
          if (payload.new.is_host && !room.isHost) {
            room.isHost = true;
            room.isCohost = false;
            sessionStorage.setItem('oracle_party_room', JSON.stringify(room));
            activateHostUI();
            addSystemMessage('You are now the host');
          } else if (!payload.new.is_host && room.isHost) {
            room.isHost = false;
            sessionStorage.setItem('oracle_party_room', JSON.stringify(room));
            deactivateHostUI();
          }
          // Co-host status changes
          if (payload.new.is_cohost && !room.isCohost) {
            room.isCohost = true;
            sessionStorage.setItem('oracle_party_room', JSON.stringify(room));
            addSystemMessage('You are now co-host');
          } else if (!payload.new.is_cohost && room.isCohost) {
            room.isCohost = false;
            sessionStorage.setItem('oracle_party_room', JSON.stringify(room));
          }
        }
        renderPlayers();
      }
    } else if (event === 'DELETE' && payload.old) {
      const deletedId = String(payload.old.id);

      // Remove the player from local list
      players = players.filter(p => String(p.id) !== deletedId);

      // If room is now empty, delete it (cleanup zombie rooms).
      // A bot left behind does not count as somebody being here.
      //
      // Through the server since migration 048 revoked DELETE on `rooms` —
      // the direct call below it had become a silent no-op. op_sweep_rooms
      // applies the same rule (no HUMAN left) and decides it in one statement,
      // so two clients reacting to the same departure cannot race.
      if (humanPlayers().length === 0) {
        const served = await sweepRoomsOnServer();
        if (!served.ok) await deleteRoom(room.id);
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
    logger.error('Lobby', 'handlePlayerChange error', err);
    // Fallback: full re-fetch on any error
    await loadPlayers();
  }
}

/**
 * Handle host promotion when the current host leaves.
 * Co-host gets priority, otherwise the player with the lowest joined_at self-promotes.
 */
async function handleHostPromotion() {
  // Bots are never candidates: host and co-host are for humans, and a room
  // hosted by a bot is a room nobody can start, advance or judge. If only bots
  // are left there is nobody to promote.
  // Present humans only. Promoting somebody who is not there hands the crown
  // straight back to a ghost, which is how it ended up on one in the first
  // place. Falls back to every human if nobody looks present, because a room
  // with no host at all is worse than a host who may be about to return.
  const here = humanPlayers().filter(isPresentInLobby);
  const eligible = here.length > 0 ? here : humanPlayers();
  if (eligible.length === 0) return;

  // Prefer co-host, otherwise earliest player
  const cohost = eligible.find(p => p.is_cohost);
  let nextHost;
  if (cohost) {
    nextHost = cohost;
  } else {
    const sorted = [...eligible].sort((a, b) => {
      const ta = a.joined_at ? new Date(a.joined_at) : Infinity;
      const tb = b.joined_at ? new Date(b.joined_at) : Infinity;
      return ta - tb;
    });
    nextHost = sorted[0];
  }

  // Am I the one being promoted?
  if (String(nextHost.id) === String(room.playerId)) {
    // Cross-client race guard — re-fetch and bail if a host already exists.
    // Without this, two clients can race-promote themselves, ending up with
    // two hosts simultaneously.
    const fresh = await fetchPlayers(room.id);
    const freshLiveHost = fresh.some(p => {
      if (!p.is_host || p.is_bot) return false;
      const raw = p.last_seen_at || p.joined_at;
      if (!raw) return true;
      return (Date.now() - new Date(raw).getTime()) < STALE_TIMEOUT_MS;
    });
    // Same correction as the poll: a ghost holding the flag is not a host, and
    // bailing out for one is what left the room with nobody able to start.
    if (freshLiveHost) {
      players = fresh;
      sortPlayers();
      renderPlayers();
      return;
    }
    // THE SERVER DECIDES, AND IT CAN SAY NO. op_set_host_role declines when the
    // room already has a live host — which is the same race the fetch above
    // guards, one round trip later and with the database's own view. Claiming
    // the crown anyway gave this client host UI and a chat announcement while
    // the row said somebody else, and every advance it then tried would be
    // refused by op_may_advance: the "deputy with dead buttons" shape 062 was
    // written to end.
    const promoted = await promoteToHost(room.id, room.playerId, getDisplayName(), room.playerId);
    if (!promoted?.ok) {
      logger.info('Lobby', 'the server declined this promotion — somebody else already has it');
      players = await fetchPlayers(room.id);
      sortPlayers();
      renderPlayers();
      return;
    }
    room.isHost = true;
    room.isCohost = false;
    sessionStorage.setItem('oracle_party_room', JSON.stringify(room));
    // Update local player state immediately so badge renders
    const localIdx = players.findIndex(p => String(p.id) === String(room.playerId));
    if (localIdx !== -1) { players[localIdx].is_host = true; players[localIdx].is_cohost = false; }
    // Clear co-host flag if we were co-host
    if (nextHost.is_cohost) await demoteCohost(room.playerId, room.id, room.playerId);
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

function deactivateHostUI() {
  btnStartGame.classList.add('hidden');
  btnSettings.classList.add('hidden');
  btnReady.classList.remove('hidden');
}

let _isTransferring = false;
let _transferConfirmId = null;
let _transferConfirmTimer = null;

async function handleTransferHost(targetPlayerId, targetDisplayName) {
  if (!room.isHost || _isTransferring) return;
  // Tap-again-to-confirm. First tap on a Transfer button puts that row's
  // button into "Tap to confirm" state for 3 seconds; a second tap within
  // that window actually transfers. Tapping a different player's Transfer
  // resets to that player's confirm. Avoids one-tap accidental loss-of-host.
  const btn = document.querySelector(`.transfer-host-btn[data-transfer-id="${targetPlayerId}"]`);
  if (_transferConfirmId !== String(targetPlayerId)) {
    // Reset any prior pending confirmation
    if (_transferConfirmTimer) clearTimeout(_transferConfirmTimer);
    document.querySelectorAll('.transfer-host-btn').forEach(b => {
      b.textContent = 'Transfer';
      b.classList.remove('transfer-host-btn--confirm');
    });
    if (btn) {
      btn.textContent = 'Tap to confirm';
      btn.classList.add('transfer-host-btn--confirm');
    }
    _transferConfirmId = String(targetPlayerId);
    _transferConfirmTimer = setTimeout(() => {
      _transferConfirmId = null;
      _transferConfirmTimer = null;
      if (btn) {
        btn.textContent = 'Transfer';
        btn.classList.remove('transfer-host-btn--confirm');
      }
    }, 3000);
    return;
  }
  // Second tap — proceed
  if (_transferConfirmTimer) clearTimeout(_transferConfirmTimer);
  _transferConfirmId = null;
  _transferConfirmTimer = null;
  _isTransferring = true;
  try {
    // Demote self first, then promote target (serialized to avoid brief two-host state)
    // The caller is the CURRENT host handing the room over deliberately, so
    // the transfer is passed as coming from them — the server's other branch
    // (a leaderless room) must not be what lets this through.
    const promoted = await promoteToHost(room.id, targetPlayerId, targetDisplayName, room.playerId);
    // STOP IF THE CROWN DID NOT MOVE. Demoting anyway leaves the room with NO
    // host at all — the current host has given it up and the target never got
    // it — and nothing recovers that until a stale sweep notices.
    if (!promoted?.ok) {
      showToast("Couldn't transfer host — try again", 'error');
      return;
    }
    await demoteHost(room.playerId, room.id, targetPlayerId);

    // Update local state
    const myIdx = players.findIndex(p => String(p.id) === String(room.playerId));
    if (myIdx !== -1) players[myIdx].is_host = false;
    const targetIdx = players.findIndex(p => String(p.id) === String(targetPlayerId));
    if (targetIdx !== -1) players[targetIdx].is_host = true;

    room.isHost = false;
    sessionStorage.setItem('oracle_party_room', JSON.stringify(room));

    deactivateHostUI();
    renderPlayers();

    sendMessage(room.id, 'System', `${getDisplayName()} transferred host to ${targetDisplayName}`);
    addSystemMessage(`You transferred host to ${targetDisplayName}`);
  } catch (err) {
    logger.error('Lobby', 'handleTransferHost error', err);
  } finally {
    _isTransferring = false;
  }
}

let _isCohostToggling = false;
async function handleCohostToggle(playerId, displayName, isDemote) {
  if (!room.isHost || _isCohostToggling) return;
  _isCohostToggling = true;
  try {
    // ONLY CLAIM WHAT ACTUALLY LANDED.
    //
    // These four used to return nothing, so this marked the player co-host in
    // the local list AND announced it in chat regardless. op_set_host_role
    // DECLINES when the room's state does not allow it, and a decline came back
    // looking exactly like a success — so the host saw a badge nobody else had,
    // the chat said it happened, and the co-host got none of the powers.
    if (isDemote) {
      const res = await demoteCohost(playerId, room.id, room.playerId);
      if (!res?.ok) { showToast("Couldn't remove co-host", 'error'); return; }
      const idx = players.findIndex(p => String(p.id) === String(playerId));
      if (idx !== -1) players[idx].is_cohost = false;
      sendMessage(room.id, 'System', `${displayName} is no longer co-host`);
    } else {
      // Demote any existing co-host first (only one co-host at a time).
      // If THAT fails, stop: promoting on top of it would leave two.
      const existingCohost = players.find(p => p.is_cohost);
      if (existingCohost) {
        const cleared = await demoteCohost(existingCohost.id, room.id, room.playerId);
        if (!cleared?.ok) { showToast("Couldn't change co-host", 'error'); return; }
        existingCohost.is_cohost = false;
      }
      const res = await promoteToCohost(playerId, room.id, room.playerId);
      if (!res?.ok) {
        showToast("Couldn't make them co-host", 'error');
        renderPlayers();   // the demotion above may already have landed
        return;
      }
      const idx = players.findIndex(p => String(p.id) === String(playerId));
      if (idx !== -1) players[idx].is_cohost = true;
      sendMessage(room.id, 'System', `${displayName} is now co-host`);
    }
    renderPlayers();
  } catch (err) {
    logger.error('Lobby', 'handleCohostToggle error', err);
  } finally {
    _isCohostToggling = false;
  }
}

/** Attach settings modal event listeners (idempotent). */
function attachSettingsListeners() {
  if (attachSettingsListeners._done) return;
  attachSettingsListeners._done = true;

  btnSettings.addEventListener('click', openSettingsModal);
  const categoryTap = $('#btn-category-tap');
  if (categoryTap) {
    categoryTap.addEventListener('click', () => {
      if (room.isHost) openSettingsModal();
    });
  }
  btnCloseSettings.addEventListener('click', closeSettingsModal);
  settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) closeSettingsModal();
  });
  settingsCategoryGrid.addEventListener('click', (e) => {
    if (e.target.closest('#settings-category-tap')) {
      openLobbyCategorySheet();
    }
  });

  // Category bottom sheet — row taps (multi-level)
  $('#category-sheet-list').addEventListener('click', (e) => {
    const back = e.target.closest('[data-action="back"]');
    if (back) { lobbySheetDrillBack(); return; }

    const row = e.target.closest('.category-sheet-row');
    if (!row) return;
    const catName = row.dataset.category;
    const meta = CATEGORY_META[catName];

    // If row has subcategory attribute, check for children drill-down
    if (row.dataset.subcategory !== undefined) {
      if (row.dataset.hasChildren === '1') {
        const node = findSubcategoryNode(meta, row.dataset.subcategory);
        if (node?.children) {
          lobbySheetDrillIn(catName, node.children, node.label, node.key);
          return;
        }
      }
      // Leaf or "All" — select
      room.category = catName;
      room.subcategory = row.dataset.subcategory || null;
      lobbySheetNavStack = [];
      updateCategoryDisplay();
      renderSettingsCategories();
      sessionStorage.setItem('oracle_party_room', JSON.stringify(room));
      updateGameState(room.id, { category: catName, subcategory: room.subcategory });
      $('#category-sheet').classList.remove('active');
      return;
    }

    // Top-level category with subs — drill in
    if (meta?.subcategories?.length) {
      lobbySheetDrillIn(catName, meta.subcategories, meta.label, null);
      return;
    }

    // Wild-card special options — drill in
    if (meta?.wildCardOptions?.length) {
      renderLobbySheetWildCardOptions(catName, meta);
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
      if (key === 'questionsPerGame' || key === 'questionTimer' || key === 'autoProceed') {
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
  if (me) {
    // Player row exists — clear any disconnected_at from a prior refresh/unload.
    // The DB heartbeat in init() also does this, but doing it here too ensures
    // the stale check doesn't race-remove us before the heartbeat fires.
    if (me.disconnected_at) {
      playerHeartbeat(room.playerId).catch(() => {});
    }
    return;
  }

  // Verify room still exists before re-adding (don't resurrect zombie rooms)
  const { data: roomCheck } = await fetchRoom(room.id);
  if (!roomCheck) {
    sessionStorage.removeItem('oracle_party_room');
    window.location.href = 'index.html';
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
  const rejoinUserId = getAuthUserId();
  const extras = {};
  if (authUser?.profile) {
    extras.avatarColor = authUser.profile.avatar_color;
    extras.avatarEmoji = authUser.profile.avatar_emoji;
    extras.title = authUser.profile._cachedTitle || null;
  }
  // This used to adopt an existing row only when there was EXACTLY ONE match
  // and otherwise add another — so at two duplicates it made a third, at three
  // a fourth, and it could never get back to the single case it handled. One
  // person appeared in a live lobby three times over. claimSeat takes the seat
  // that is already yours and clears the copies.
  const seatUserId = await ensureAnonymousIdentity() || rejoinUserId;
  const { data: rejoinedPlayer, error: seatErr } = await claimSeat({
    roomId: room.id, displayName, userId: seatUserId, isHost: room.isHost, extras,
    // Exact when it is there, and it beats every guess claimSeat would make.
    priorPlayerId: room.playerId || recallSeat(room.id),
  });
  if (rejoinedPlayer) {
    // BELIEVE THE ROW, NOT sessionStorage.
    //
    // A host who was away long enough to be swept comes back with isHost still
    // true in their own storage while the room has promoted somebody else.
    // claimSeat now takes an ordinary seat in that case rather than asking for
    // a crown the database will refuse — and if the screen went on claiming the
    // crown anyway it would show host controls whose every write is refused,
    // which is the dead button migration 062 was written to end.
    room.isHost = !!rejoinedPlayer.is_host;
    room.playerId = rejoinedPlayer.id;
    sessionStorage.setItem('oracle_party_room', JSON.stringify(room));
    await loadPlayers();
  } else if (seatErr) {
    // Was discarded entirely. addPlayer toasts, so the player was told SOMETHING
    // — but nothing here knew the seat had not been taken, so the lobby went on
    // polling and re-rendering around a player who was not in the room.
    logger.error('Lobby', 'could not take a seat in this room', seatErr);
  }
}

// --- Inline Chat (always visible, no drawer toggle) ---

function repositionChatBar() { /* no-op — chat is inline */ }
function updateChatBarPreview() { /* no-op — no bar in lobby */ }
function flashChatBar() { /* no-op — no bar in lobby */ }

/**
 * Chat sent before this person walked in is not theirs to read.
 *
 * Anchored on their OWN player row's joined_at rather than the clock, so a
 * message that lands between joining and the chat pane loading is not lost.
 * rememberChatCutoff keeps the first value it is given for a room, so coming
 * back — a refresh, or returning from a game — still shows everything from a
 * room you were already in. See auth.js for what this does and does not do.
 */
function chatCutoff() {
  const me = players.find(p => String(p.id) === String(room.playerId));
  return rememberChatCutoff(room.id, me?.joined_at || null);
}

async function loadMessages() {
  const messages = await fetchMessages(room.id, chatCutoff());
  chatMessagesEl.innerHTML = '';
  for (const msg of messages) {
    if (msg.player_name === 'System') {
      addSystemMessage(msg.message);
    } else {
      appendChatMessage(msg.player_name, msg.message, msg.id, msg.hearts);
    }
  }
  scrollChatToBottom();
}

function handleNewMessage(payload) {
  if (!payload.new) return;

  // Handle UPDATE events (heart changes)
  if (payload.eventType === 'UPDATE') {
    const { id, hearts } = payload.new;
    if (!id) return;
    const bubble = chatMessagesEl.querySelector(`[data-msg-id="${id}"]`);
    if (bubble) updateHeartDisplay(bubble, hearts);
    return;
  }

  const { player_name, message, id, hearts } = payload.new;

  // Dedup: skip Realtime echoes of our own optimistic appends
  if (player_name === getDisplayName() && chatEchoPending > 0) {
    chatEchoPending--;
    // Assign real ID to optimistic bubble (first unassigned = earliest sent)
    if (id) {
      const first = chatMessagesEl.querySelector('.chat-bubble:not([data-msg-id])');
      if (first) first.dataset.msgId = id;
    }
    return;
  }

  if (player_name === 'System') {
    addSystemMessage(message);
  } else {
    appendChatMessage(player_name, message, id, hearts);
  }
  scrollChatToBottom();
}

function appendChatMessage(name, text, msgId = null, hearts = []) {
  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble';
  if (msgId) bubble.dataset.msgId = msgId;
  // Remember WHOSE bubble this is, so the avatar can be filled in later.
  //
  // The lookup below needs the player list, and the chat history is loaded
  // before that list has arrived when the lobby is re-entered after Play
  // Again — so every bubble fell back to a plain letter and somebody's chosen
  // face vanished from their own messages. Rejoining looked fine because the
  // order happens to be the other way round on a fresh arrival.
  bubble.dataset.author = name;
  const player = players.find(p => p.display_name === name);
  const chatAvatar = renderAvatar({ displayName: name, avatarColor: player?.avatar_color || null, avatarEmoji: player?.avatar_emoji || null, extraClass: 'avatar--chat' });
  const heartCount = Array.isArray(hearts) ? hearts.length : 0;
  const iHearted = Array.isArray(hearts) && hearts.includes(getDisplayName());
  bubble.innerHTML = `
    <div class="chat-bubble__header">${chatAvatar}<div class="chat-bubble__name">${escapeHtml(name)}</div></div>
    <div class="chat-bubble__body">
      <div class="chat-bubble__text">${escapeHtml(text)}</div>
      <div class="chat-bubble__hearts">
        <button class="heart-btn${iHearted ? ' hearted' : ''}" aria-label="Heart">&hearts;</button>
        <span class="heart-count${heartCount === 0 ? ' hidden' : ''}">${heartCount}</span>
      </div>
    </div>
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
  // Scroll the chat pane, NOT the lobby. This used to walk up to .lobby-scroll
  // and scroll the whole page, so every message dragged the room card, the
  // player list and the Start button up out of view.
  if (chatMessagesEl) chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

function updateHeartDisplay(bubble, hearts) {
  const arr = Array.isArray(hearts) ? hearts : [];
  const btn = bubble.querySelector('.heart-btn');
  const countEl = bubble.querySelector('.heart-count');
  if (!btn || !countEl) return;
  btn.classList.toggle('hearted', arr.includes(getDisplayName()));
  countEl.textContent = arr.length;
  countEl.classList.toggle('hidden', arr.length === 0);
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
    const { data } = await sendMessage(room.id, name, text);
    if (data?.id) {
      const first = chatMessagesEl.querySelector('.chat-bubble:not([data-msg-id])');
      if (first) first.dataset.msgId = data.id;
    }
  } catch (err) {
    logger.error('Lobby', 'sendMessage failed', err);
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
    logger.error('Lobby', 'toggleReady failed', err);
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
let _isStarting = false;
async function handleStartGame() {
  // Idempotency: rapid double-clicks would otherwise fire updateRoomStatus twice
  // and queue a second 5s navigation timeout that lands after we've already left.
  if (_isStarting) return;
  if (players.length < 2) {
    showToast('Need at least 2 players to start!', 'error');
    return;
  }
  _isStarting = true;
  btnStartGame.disabled = true;
  btnStartGame.classList.add('is-loading');
  btnStartGame.textContent = 'Starting...';

  try {
    // Clear any state left by a previous game before flipping the room to
    // playing, so the room is never simultaneously "playing" and phase
    // "lobby". The host's game init writes question_ids and the countdown
    // immediately after this.
    // The phase and the question number go through the server (060/061); the
    // rest is ordinary room data. NULL is not interchangeable with 'lobby'
    // here — syncToCurrentState returns early on a falsy phase and
    // handleRoomChange skips the transition entirely — so the function was
    // taught to CLEAR a phase rather than the app quietly substituting one.
    await updateGameState(room.id, {
      question_ids: [],
      question_started_at: null,
      countdown_started_at: null
    });
    if (!await setPhaseOnServer(room.id, room.playerId, null, null, 0)) {
      await updateGameState(room.id, { game_phase: null, current_question: 0 });
    }
    await updateRoomStatus(room.id, 'playing');
    // Realtime subscription triggers navigation for everyone including host.
    // Safety fallback: if Realtime doesn't fire within 5s, navigate directly.
    setTimeout(() => {
      if (!isLeaving) {
        logger.warn('Lobby', 'Realtime did not fire — navigating directly');
        isLeaving = true;
        cleanup();
        navigateWithFadeReplace('game.html');
      }
    }, 5000);
  } catch (err) {
    logger.error('Lobby', 'startGame failed', err);
    _isStarting = false;
    btnStartGame.disabled = false;
    btnStartGame.classList.remove('is-loading');
    btnStartGame.textContent = 'Start Game';
  }
}

// --- Settings Modal (host) ---
function updateCategoryDisplay() {
  const meta = CATEGORY_META[room.category] || { icon: '?', label: room.category };
  const icon = resolveSubcategoryIcon(room.category, room.subcategory);
  const iconEl = $('#lobby-category-icon');
  if (iconEl) iconEl.textContent = icon;

  // Show short label: just subcategory leaf name, or category name if no sub
  let shortLabel = meta.label;
  if (room.subcategory) {
    if (meta.wildCardOptions) {
      const opt = meta.wildCardOptions.find(o => o.key === room.subcategory);
      if (opt) shortLabel = opt.label;
    } else {
      const node = findSubcategoryNode(meta, room.subcategory);
      if (node) shortLabel = node.label;
    }
  }
  lobbyCategory.textContent = shortLabel;
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
  const icon = resolveSubcategoryIcon(room.category, room.subcategory);
  // Short label: just the leaf subcategory name
  let shortLabel = meta.label;
  if (room.subcategory) {
    if (meta.wildCardOptions) {
      const opt = meta.wildCardOptions.find(o => o.key === room.subcategory);
      if (opt) shortLabel = opt.label;
    } else {
      const node = findSubcategoryNode(meta, room.subcategory);
      if (node) shortLabel = node.label;
    }
  }
  settingsCategoryGrid.innerHTML = `
    <div class="category-sheet-row selected" id="settings-category-tap" style="cursor:pointer;">
      <span class="category-sheet-row__icon">${icon}</span>
      <span class="category-sheet-row__label">${shortLabel}</span>
      <span class="category-sheet-row__chevron">\u203A</span>
    </div>
  `;
}

function openLobbyCategorySheet() {
  lobbySheetNavStack = [];
  const sheet = $('#category-sheet');
  const list = $('#category-sheet-list');

  const allCats = Object.entries(CATEGORY_META);
  list.innerHTML = allCats.map(([name, meta]) => {
    const hasDrill = meta.subcategories?.length > 0 || meta.wildCardOptions?.length > 0;
    const isSelected = name === room.category;
    return `
      <div class="category-sheet-row${isSelected ? ' selected' : ''}" data-category="${name}">
        <span class="category-sheet-row__icon">${meta.emoji || meta.icon}</span>
        <span class="category-sheet-row__label">${meta.label}</span>
        ${hasDrill ? '<span class="category-sheet-row__chevron">\u203A</span>' : ''}
      </div>
    `;
  }).join('');

  sheet.classList.add('active');
  sheet.querySelector('.bottom-sheet__backdrop').onclick = () => sheet.classList.remove('active');
}

function lobbySheetDrillIn(catName, items, title, parentKey) {
  lobbySheetNavStack.push({ catName, items, title, parentKey });
  renderLobbySheetLevel(catName, items, title, parentKey);
}

function renderLobbySheetLevel(catName, items, title, parentKey) {
  const list = $('#category-sheet-list');
  const allSubcategory = parentKey || '';
  list.innerHTML = `
    <div class="category-sheet-back" data-action="back">\u2190 ${title}</div>
    <div class="category-sheet-row" data-category="${catName}" data-subcategory="${allSubcategory}">
      <span class="category-sheet-row__icon">${CATEGORY_META[catName]?.icon || '?'}</span>
      <span class="category-sheet-row__label">All ${title}</span>
    </div>
    ${items.map(s => `
      <div class="category-sheet-row" data-category="${catName}" data-subcategory="${s.key}" ${s.children ? 'data-has-children="1"' : ''}>
        <span class="category-sheet-row__icon">${s.emoji || s.icon}</span>
        <span class="category-sheet-row__label">${s.label}</span>
        <span class="category-sheet-row__count" data-sub-count="${s.key}"></span>
        ${s.children ? '<span class="category-sheet-row__chevron">\u203A</span>' : ''}
      </div>
    `).join('')}
  `;

  // Async-load subcategory question counts
  items.forEach(async (s) => {
    const count = await fetchQuestionCount(catName, s.key);
    const el = list.querySelector(`[data-sub-count="${s.key}"]`);
    if (el) el.textContent = `${count} Qs`;
  });
}

function renderLobbySheetWildCardOptions(catName, meta) {
  const list = $('#category-sheet-list');
  lobbySheetNavStack.push({ catName, items: null, title: meta.label, parentKey: null, isWildCard: true });
  list.innerHTML = `
    <div class="category-sheet-back" data-action="back">\u2190 ${meta.label}</div>
    ${meta.wildCardOptions.map(opt => `
      <div class="category-sheet-row" data-category="${catName}" data-subcategory="${opt.key}">
        <span class="category-sheet-row__icon">${opt.emoji || opt.icon}</span>
        <span class="category-sheet-row__label">${opt.label}</span>
        <span class="category-sheet-row__count" data-wc-count="${opt.key}"></span>
      </div>
    `).join('')}
  `;

  // Async-load counts
  fetchAllOpenQuestionCount().then(count => {
    const el = list.querySelector('[data-wc-count="__all_questions__"]');
    if (el) el.textContent = `${count} Qs`;
  });
  fetchExclusiveWildCardCount().then(count => {
    const el = list.querySelector('[data-wc-count="__true_wild_card__"]');
    if (el) el.textContent = `${count} Qs`;
  });
}

function lobbySheetDrillBack() {
  lobbySheetNavStack.pop();
  if (lobbySheetNavStack.length === 0) {
    openLobbyCategorySheet();
  } else {
    const prev = lobbySheetNavStack[lobbySheetNavStack.length - 1];
    renderLobbySheetLevel(prev.catName, prev.items, prev.title, prev.parentKey);
  }
}

function syncTogglesToSettings() {
  settingsModal.querySelectorAll('.toggle-group').forEach(group => {
    const key = group.dataset.setting;
    // Default autoProceed to 0 for rooms created before the feature existed
    const raw = room.settings[key];
    const currentValue = String(raw !== undefined && raw !== null ? raw : (key === 'autoProceed' ? 0 : ''));
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
    questionTimer: 'question_timer',
    autoProceed: 'auto_proceed'
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
    try { cleanup(); } catch (_) {}
    navigateWithFadeReplace('game.html');
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

    if (newRoom.auto_proceed !== undefined && newRoom.auto_proceed !== room.settings.autoProceed) {
      room.settings.autoProceed = newRoom.auto_proceed;
      changed = true;
    }

    if (changed) {
      sessionStorage.setItem('oracle_party_room', JSON.stringify(room));
    }
  }
}

// ============================================
// STALE PLAYER AUTO-KICK
// ============================================
// Uses last_seen_at (DB heartbeat) for reliable stale detection.
// Two thresholds:
//   - DISCONNECTED_TIMEOUT_MS (45s): player beacon fired (tab close / navigation)
//   - STALE_TIMEOUT_MS (3 min): player heartbeat stopped (internet loss / crash)

/**
 * Cumulative points across every game played in this room, newest total first.
 * Hidden entirely when there is nothing to show — a room on its first game, or
 * one where migration 038 has not been applied yet.
 */
async function renderRoomScores(roomId) {
  const scoresSection = $('#room-scores');
  const scoresList = $('#room-scores-list');
  if (!scoresSection || !scoresList) return;

  const roomScores = await fetchRoomScores(roomId).catch(() => ({}));
  const sorted = Object.entries(roomScores)
    .filter(([, score]) => typeof score === 'number')
    .sort((a, b) => b[1] - a[1]);

  if (sorted.length === 0) {
    scoresSection.style.display = 'none';
    return;
  }

  scoresSection.style.display = '';
  scoresList.innerHTML = sorted.map(([name, score], i) => {
    const isMe = name === getDisplayName();
    return `<div class="room-score-row${isMe ? ' room-score-row--me' : ''}">
      <span class="room-score-row__rank">${i + 1}</span>
      <span class="room-score-row__name">${escapeHtml(name)}</span>
      <span class="room-score-row__score">${score} pts</span>
    </div>`;
  }).join('');
}

function checkStalePresence() {
  const now = Date.now();

  // The whole mechanism rests on last_seen_at being refreshed by the heartbeat
  // every 15 seconds. If not one player has that column, the heartbeat is not
  // working at all (on the live database the column did not exist), and every
  // timestamp we could fall back to is frozen at join time — so everyone would
  // be judged stale a few minutes in and kicked while sitting there healthy.
  //
  // Removing players is destructive and cannot be undone by the player, so
  // when the evidence is unavailable the correct action is none.
  const heartbeatWorking = players.some(p => p.last_seen_at);
  if (!heartbeatWorking) return;

  for (const p of players) {
    const id = String(p.id);
    if (id === String(room.playerId)) continue; // Don't kick ourselves
    // A bot has no browser and sends no heartbeat, so its timestamps never
    // move. Judged like a player it would be swept out of the lobby a couple
    // of minutes after the host added it.
    if (p.is_bot) continue;

    // A missing timestamp means "we cannot tell", not "silent since 1970".
    // last_seen_at did not exist on the live players table, so this read as
    // undefined, silence computed as the whole Unix epoch, and the host kicked
    // every player on the first presence sync after they joined. Absence of
    // evidence must never be treated as evidence of absence.
    const lastSeenRaw = p.last_seen_at || p.joined_at;
    const lastSeen = lastSeenRaw ? new Date(lastSeenRaw).getTime() : 0;
    if (!lastSeen) continue;
    const silenceMs = now - lastSeen;
    const hasDisconnected = !!p.disconnected_at;

    // Fast path: beacon fired (tab close) + heartbeat stopped for 45s → remove
    // Slow path: no beacon but heartbeat stopped for 3 minutes → remove
    const threshold = hasDisconnected ? DISCONNECTED_TIMEOUT_MS : STALE_TIMEOUT_MS;
    if (silenceMs < threshold) continue;

    if (p.is_host) {
      // Stale host: earliest connected player kicks them (deterministic)
      const connected = players
        .filter(pl => {
          const raw = pl.last_seen_at || pl.joined_at;
          const ls = raw ? new Date(raw).getTime() : 0;
          // No timestamp: treat as connected rather than silently excluding them
          // from the promotion ballot, which would leave the room hostless.
          if (!ls) return true;
          return (now - ls) < DISCONNECTED_TIMEOUT_MS && !pl.disconnected_at;
        })
        .sort((a, b) => new Date(a.joined_at) - new Date(b.joined_at));
      if (connected[0] && String(connected[0].id) === String(room.playerId)) {
        removePlayer(id, room.id, room.playerId);
      }
    } else if (room.isHost || (liveHosts().length === 0 && iAmTheCaretaker())) {
      // Stale non-host: the host clears them — or, when no host is reachable,
      // the earliest person who IS here. Without that second clause the sweep
      // depended on a host to run and the host was the thing that had gone, so
      // a room full of abandoned rows had nobody left with the authority to
      // tidy them and simply stayed broken.
      removePlayer(id, room.id, room.playerId);
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
  // Bots do not keep a room alive. The last person out takes the room with
  // them, exactly as if they had been alone in it.
  //
  // The SERVER decides which of those it is (migration 048): counting locally
  // and then deleting is a race when two people quit at once — both see two
  // players, both conclude somebody else is staying, and the room survives
  // with nobody in it.
  const served = await leaveRoomOnServer(room.id, room.playerId);
  if (!served.ok) {
    // GET THE ROW OUT FIRST, whatever went wrong — removing yourself is allowed
    // by migration 057. The old shape took the deleteRoom branch when leaving as
    // the last player, and 048 makes that a silent no-op, so a failed leave left
    // the leaver listed in their own lobby.
    await removePlayer(room.playerId, room.id, room.playerId);
    // Deleting the room by hand only works before 048.
    if (served.unavailable && humanPlayers().length <= 1) {
      await deleteRoom(room.id);
    }
  }
  sessionStorage.removeItem('oracle_party_room');
  // Non-host goes to join page (find another game), host goes home
  navigateWithFade(room.isHost ? 'index.html' : 'join.html');
}

function handleBackButton() {
  isLeaving = true;
  cleanup();
  // Same shape as the game page's unload path. An unload cannot await, so it
  // reads what the ordinary awaited calls have already learned about the server
  // (serverFunctionsMissing), and UNKNOWN COUNTS AS PRESENT: guessing wrong that
  // way leaves a player row for the stale sweep, guessing wrong the other way
  // puts this phone back to deleting rooms on its own local count — the race
  // migration 048 removed. This branch was missed when 048 shipped, so backing
  // out of a lobby as the last player left the room behind.
  if (!serverFunctionsMissing()) {
    leaveRoomBeacon(room.id, room.playerId);
  } else if (humanPlayers().length <= 1) {
    deleteRoomBeacon(room.id);
  } else {
    removePlayerBeacon(room.playerId);
  }
  sessionStorage.removeItem('oracle_party_room');
  navigateWithFade(room.isHost ? 'index.html' : 'join.html');
}

function handleUnload() {
  if (isLeaving) return;
  // Soft disconnect: mark player as disconnected but DON'T delete.
  // If this is a refresh, the page will reload, find the player row via
  // sessionStorage, and clear disconnected_at via heartbeat.
  // If this is a tab close (sessionStorage gone), the stale check will
  // remove the player after DISCONNECTED_TIMEOUT_MS.
  if (room && room.playerId) {
    markDisconnectedBeacon(room.playerId);
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

// ============================================
// PRESENCE CHANNEL
//
// Built through a function because it has to be REBUILDABLE. A backgrounded
// phone has its WebSocket suspended, and supabase-js throws "tried to
// subscribe multiple times" on a channel that has already joined once — so a
// dead channel cannot be revived, only replaced.
//
// Before this, every track() failure was swallowed by `.catch(() => {})` and
// nothing checked whether the channel was still joined. A player who switched
// to another app and came back stayed greyed out for everybody, and saw
// everybody greyed out back. That symmetry is the tell: one-way state errors
// grey one person, a dead socket greys the whole room in both directions.
// ============================================

function buildPresenceChannel() {
  const channel = createPresenceChannel(room.id, String(room.playerId));
  presenceChannel = channel;

  channel
    .on('presence', { event: 'sync' }, () => {
      // Read from the channel this handler belongs to. A rebuild swaps
      // presenceChannel out, and a late sync from the dead one would otherwise
      // read the new channel's still-empty state and grey out the whole room.
      const ps = channel.presenceState();
      const connectedActive = new Set();
      for (const key of Object.keys(ps)) {
        for (const p of ps[key]) {
          if (!p.is_away) connectedActive.add(String(p.player_id));
        }
      }
      if (presenceChannel !== channel) return;

      const newAway = new Map();
      for (const p of players) {
        const id = String(p.id);
        // A bot joins no presence channel, so it is permanently "not connected"
        // and would sit in the lobby faded to 40% opacity — the signal that
        // says "this player's phone is asleep, don't wait for them" — while
        // being the one player that never keeps anybody waiting.
        if (p.is_bot) continue;
        if (!connectedActive.has(id)) {
          newAway.set(id, awayTimestamps.get(id) || Date.now());
        }
      }
      awayTimestamps = newAway;
      renderPlayers();
      scheduleAwayRecheck();
      checkStalePresence();
    })
    .subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        presenceReady = true;
        notifyConnectionRestored();
        await channel.track({ player_id: room.playerId, is_away: document.hidden })
          .catch(() => {});
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        presenceReady = false;
        notifyConnectionLost();
      }
    });

  if (!channels.includes(channel)) channels.push(channel);
  return channel;
}

/** One presence beat: rebuild if the channel is dead, otherwise re-announce. */
async function beatPresence() {
  if (!presenceChannel) return;
  if (presenceNeedsRebuild(presenceChannel)) {
    logger.warn('Lobby', 'presence channel died — rebuilding', { state: presenceChannel.state });
    const dead = presenceChannel;
    const at = channels.indexOf(dead);
    try { dead.unsubscribe(); } catch { /* already gone */ }
    if (at !== -1) channels.splice(at, 1);
    presenceChannel = null;
    buildPresenceChannel();
    return;
  }
  try {
    await presenceChannel.track({ player_id: room.playerId, is_away: document.hidden });
  } catch (err) {
    // Not swallowed. A failing track on a channel that still claims to be
    // joined is the case this fix exists for, and it used to be invisible.
    logger.warn('Lobby', 'presence track failed', err);
  }
}

async function handleVisibilityChange() {
  if (!presenceChannel) return;
  // Coming back is exactly when the channel is most likely to be dead, so heal
  // here rather than waiting up to 15s for the next beat — that wait is the
  // window a returning player spends still greyed out to everybody.
  beatPresence();
  if (document.hidden) return;
  // When tab becomes visible, send immediate DB heartbeat so other clients
  // see our last_seen_at refresh instantly (don't wait for the 15s interval).
  playerHeartbeat(room.playerId).catch(() => {});
  // Realtime doesn't replay missed events. If the room was deleted while we
  // were asleep, we'd be staring at a ghost lobby. Re-fetch and bail home if
  // the room is gone, or follow into game.html if status flipped to 'playing'.
  try {
    const { data: r } = await fetchRoom(room.id);
    if (!r) {
      isLeaving = true;
      cleanup();
      sessionStorage.removeItem('oracle_party_room');
      window.location.href = 'index.html';
    } else if (r.status === 'playing' && !isLeaving) {
      isLeaving = true;
      cleanup();
      navigateWithFadeReplace('game.html');
    }
  } catch (_) { /* transient — let polling catch it */ }
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
  clearInterval(dbHeartbeatId);
  dbHeartbeatId = null;
  for (const ch of channels) unsubscribe(ch);
  channels = [];
  presenceReady = false;
  presenceChannel = null;
  awayTimestamps.clear();
  clearTimeout(awayRecheckId);
  awayRecheckId = null;
}

// --- Start ---
init();
