// ============================================
// Oracle Party — Game
// Gameplay loop: question (with wager) → submit → reveal (live) → repeat
// ============================================

import { $, transitionScreens, escapeHtml, renderAvatar, showToast, navigateWithFade, navigateWithFadeReplace } from './utils.js';
import { logger } from './logger.js';
import { COUNTDOWN_DELAY_MS, COUNTDOWN_STEP_MS, COUNTDOWN_TRANSITION_MS, COUNTDOWN_FINISH_MS, LOBBY_POLL_INTERVAL, STALE_CHECK_INTERVAL, STATE_SYNC_INTERVAL, STALE_TIMEOUT_MS, PLAYER_INIT_WAIT_MS, PLAYER_READY_CONFIRM_MS } from './constants.js';
import {
  addPlayer,
  fetchPlayers,
  fetchQuestionsByCategory,
  fetchQuestionsByIds,
  supabase,
  updateGameState,
  fetchAnswersForQuestion,
  fetchAllAnswers,
  fetchRoom,
  sendMessage,
  subscribeToRoom,
  subscribeToAnswers,
  subscribeToMessages,
  unsubscribe,
  getServerTimeOffset,
  createPresenceChannel,
  removePlayer,
  removePlayerBeacon,
  deleteRoom,
  deleteRoomBeacon,
  promoteToHost,
  subscribeToPlayers,
  insertGamePlay,
  reassignPlayerAnswers,
  appendUsedQuestionIds,
  demoteCohost,
  fetchAllOpenQuestions,
  fetchExclusiveWildCardQuestions
} from './supabase.js';
import { getDisplayName, ensureDisplayName, initAuth, getCurrentUser } from './auth.js';
import { initHonkSystem, sendHonk, destroyHonkSystem } from './honk.js';
import { initTypingIndicator, destroyTypingIndicator } from './typing.js';
import { updatePresence } from './presence.js';
import {
  state, canControlGame, getCategoryLabel,
  resolveFieldMap, getQuestionText, getCorrectAnswer, getAlternates, getDifficulty, getFunFact,
  _flagMenuCloseHandler, setFlagMenuCloseHandler,
  _isLeaving, setIsLeaving,
  setLastScoresRendered,
  _countdownActive, setCountdownActive,
  _deferredPhase, setDeferredPhase,
  _screenTransitioning, setScreenTransitioning,
  _staleCheckCount, setStaleCheckCount,
  _syncInFlight, setSyncInFlight,
} from './game/state.js';
import {
  repositionChatBar, showChatBar, hideChatBar, closeChatDrawer,
  attachChatListeners, loadChatMessages, handleNewMessage,
  _appendLocalChatNotice, addGameSystemMessage, handleSendGameChat,
  updateTypingUI,
} from './game/chat.js';
import {
  initHostSettingsPanel, showHostSettingsGear, hideHostSettingsGear,
  resetReturnConfirm, registerCleanup as registerHostCleanup,
} from './game/host.js';
import {
  showQuestionScreen, doSubmitAnswer, startTimer,
  registerShowRevealScreen, registerRevealHelpers,
} from './game/question.js';
import {
  showRevealScreen, renderRevealAnswers, enableRevealButton,
  enableNextQuestion, updateRevealButtonText, handleJudgmentOverride,
  doReveal, updateHonkBadges, handleNextQuestion, initFeedbackListeners,
  registerScoresRef as registerRevealScoresRef,
} from './game/reveal.js';
import {
  handleShowScores, showScoresScreen, showFinalWagerScreen,
  showResultsScreen, updateScores, handlePlayAgain, clearAutoProceed,
  updateFinalWagerPlayerList, handleRevealFinalQuestion, showScoreEditSheet,
  registerCleanup as registerScoresCleanup,
  registerShowQuestionScreen as registerScoresShowQuestionScreen,
  registerHandleNextQuestion as registerScoresHandleNextQuestion,
} from './game/scores.js';

// ============================================
// INIT
// ============================================

async function init() {
  document.body.style.opacity = '1';
  // Load room data synchronously so back button works even during init
  const stored = sessionStorage.getItem('oracle_party_room');
  if (!stored) {
    window.location.href = 'index.html';
    return;
  }

  state.room = JSON.parse(stored);
  state.totalQuestions = state.room.settings?.questionsPerGame || 10;
  state.timerSeconds = state.room.settings?.questionTimer || 30;
  state.autoProceedSeconds = state.room.settings?.autoProceed || 0;

  // Set up back button handler IMMEDIATELY (before any async work)
  // so pressing back always goes to index.html, even during slow init
  history.replaceState({ inGame: true }, '');
  history.pushState({ inGame: true }, '');
  window.addEventListener('popstate', handleBackButton);
  // Safari bfcache: if this page is restored from cache after navigating away, go home
  window.addEventListener('pageshow', (e) => { if (e.persisted) { cleanup(); window.location.href = 'index.html'; } });

  await Promise.all([ensureDisplayName(), initAuth()]);

  // Calibrate clock offset between client and server
  state.serverTimeOffset = await getServerTimeOffset();

  state.players = await fetchPlayers(state.room.id);

  // Validate room still exists (may have been deleted while player was away)
  const { data: roomCheck } = await fetchRoom(state.room.id);
  if (!roomCheck) {
    sessionStorage.removeItem('oracle_party_room');
    window.location.href = 'index.html';
    return;
  }

  // If current player is missing (e.g. removePlayerBeacon fired on refresh), re-add them
  // Room existence already validated above — safe to re-add
  const me = state.players.find(p => String(p.id) === String(state.room.playerId));
  if (!me) {
    const displayName = getDisplayName();

    // Before creating a new row, check if a player with the same display name already
    // exists — this happens when the page reloads before removePlayerBeacon completes
    // (pull-to-refresh on iOS, slow beacon, bfcache restore, etc.).
    const existingByName = state.players.find(p => p.display_name === displayName);
    if (existingByName) {
      // Reconnect to the existing row — update our local player ID reference only
      state.room.playerId = existingByName.id;
      sessionStorage.setItem('oracle_party_room', JSON.stringify(state.room));
      // state.players already reflects the current DB state — no re-fetch needed
    } else {
      // Beacon already fired (player row deleted). Record the old ID so we can still
      // recover wagers from answers that reference it, then create a fresh row.
      const prevPlayerId = state.room.playerId;
      const authUser = getCurrentUser();
      const rejoinUserId = authUser?.user?.id || null;
      const extras = {};
      if (authUser?.profile) {
        extras.avatarColor = authUser.profile.avatar_color;
        extras.avatarEmoji = authUser.profile.avatar_emoji;
        extras.title = authUser.profile._cachedTitle || null;
      }
      const { data: rejoinedPlayer } = await addPlayer(state.room.id, displayName, state.room.isHost, rejoinUserId, extras);
      if (rejoinedPlayer) {
        state.room.playerId = rejoinedPlayer.id;
        sessionStorage.setItem('oracle_party_room', JSON.stringify(state.room));
        state.players = await fetchPlayers(state.room.id);

        // Migrate orphaned answers from old player to new player so
        // updateScores() attributes them correctly and the scoreboard
        // shows the right totals.
        await reassignPlayerAnswers(state.room.id, prevPlayerId, rejoinedPlayer.id);

        // Rebuild used wagers from the migrated answers (now under new player ID).
        // initHostGame / applyGameState will also rebuild, but this is a safety net
        // in case that code path is skipped (e.g. lobby-status room on reconnect).
        const allAnswers = await fetchAllAnswers(state.room.id);
        const myAnswers = allAnswers.filter(a => String(a.player_id) === String(rejoinedPlayer.id));
        for (const a of myAnswers) {
          if (a.wager) state.usedWagers.set(a.wager, !!a.is_correct);
        }
      }
    }
  }

  // Detect co-host status from player record
  const myPlayer = state.players.find(p => String(p.id) === String(state.room.playerId));
  if (myPlayer?.is_cohost) {
    state.room.isCohost = true;
    sessionStorage.setItem('oracle_party_room', JSON.stringify(state.room));
  }

  for (const p of state.players) {
    state.scores[p.id] = 0;
  }

  const roomCh = subscribeToRoom(state.room.id, handleRoomChange);
  const answerCh = subscribeToAnswers(state.room.id, handleAnswerChange);
  const msgCh = subscribeToMessages(state.room.id, handleNewMessage);
  const playerCh = subscribeToPlayers(state.room.id, handlePlayerChange);
  state.channels = [roomCh, answerCh, msgCh, playerCh];

  // Presence tracking (away/active state)
  state.presenceChannel = createPresenceChannel(state.room.id, String(state.room.playerId));
  state.presenceChannel
    .on('presence', { event: 'sync' }, () => {
      const ps = state.presenceChannel.presenceState();
      // Build set of connected + active player IDs
      const connectedActive = new Set();
      for (const key of Object.keys(ps)) {
        for (const p of ps[key]) {
          if (!p.is_away) connectedActive.add(String(p.player_id));
        }
      }
      // Track when each player first went away (preserve existing timestamps)
      const newAway = new Map();
      for (const p of state.players) {
        const id = String(p.id);
        if (!connectedActive.has(id)) {
          newAway.set(id, state.awayTimestamps.get(id) || Date.now());
        }
      }
      state.awayTimestamps = newAway;
      checkStalePresence();
      // Update away classes on visible rows without full re-render
      document.querySelectorAll('#reveal-answers .answer-row').forEach(row => {
        row.classList.toggle('answer-row--away', state.awayTimestamps.has(String(row.dataset.playerId)));
      });
      document.querySelectorAll('#scores-animated-list .score-anim-row').forEach(row => {
        row.classList.toggle('score-anim-row--away', state.awayTimestamps.has(String(row.dataset.playerId)));
      });
      document.querySelectorAll('#results-list .results-row').forEach(row => {
        row.classList.toggle('results-row--away', state.awayTimestamps.has(String(row.dataset.playerId)));
      });
      document.querySelectorAll('#fw-player-list .fw-player-row').forEach(row => {
        row.classList.toggle('fw-player-row--away', state.awayTimestamps.has(String(row.dataset.playerId)));
      });
    })
    .subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        state.presenceReady = true;
        await state.presenceChannel.track({ player_id: state.room.playerId, is_away: document.hidden });
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        state.presenceReady = false;
      }
    });
  state.channels.push(state.presenceChannel);
  document.addEventListener('visibilitychange', handleVisibilityChange);

  // Heartbeat: re-track presence every 15s so transient failures self-heal
  state.presenceHeartbeatId = setInterval(() => {
    if (state.presenceChannel) {
      state.presenceChannel.track({ player_id: state.room.playerId, is_away: document.hidden })
        .catch(() => {});
    }
  }, LOBBY_POLL_INTERVAL);

  // Poll for stale disconnected players (auto-kick after 5 min)
  state.stalePollId = setInterval(checkStalePresence, STALE_CHECK_INTERVAL);

  // Periodic sync to catch missed Realtime messages after brief disconnections
  state._syncIntervalId = setInterval(syncToCurrentState, STATE_SYNC_INTERVAL);

  loadChatMessages();
  attachChatListeners();
  initFeedbackListeners();

  // Typing indicator
  initTypingIndicator(state.room.id, state.room.playerId, getDisplayName(), updateTypingUI);

  // Honk system
  initHonkSystem(state.room.id, state.room.playerId, () => {
    // Re-render visible player rows to update honk badges
    updateHonkBadges();
  });

  // Honk click handler (event delegation on scores + results containers)
  // Note: #reveal-answers is NOT included here because renderRevealAnswers()
  // clones the container (destroying this listener). It attaches its own.
  for (const sel of ['#scores-animated-list', '#results-list']) {
    const el = document.querySelector(sel);
    if (el) el.addEventListener('click', (e) => {
      const btn = e.target.closest('.honk-btn');
      if (!btn) return;
      sendHonk(btn.dataset.honkTarget);
    });
  }

  // Profile card on player tap (scores + results containers)
  for (const sel of ['#scores-animated-list', '#results-list', '#fw-player-list']) {
    const el = document.querySelector(sel);
    if (el) attachProfileCardHandler(el, () => state.players, state.room.id);
  }

  // Track presence as "in game"
  updatePresence({ activity: 'game', roomId: state.room.id, category: state.room.category });

  if (state.room.isHost || state.room.isCohost) {
    await initHostGame();
    if (state.room.isHost) initHostSettingsPanel();
  } else {
    await initPlayerGame();
  }
}

async function initHostGame() {
  // Check if there's already a game in progress (host refreshed mid-game)
  const { data: roomData } = await fetchRoom(state.room.id);
  if (roomData && roomData.question_ids && roomData.question_ids.length > 0 && roomData.game_phase && roomData.game_phase !== 'lobby') {
    // Reconnect to existing game
    // question_ids has N+1 entries (N regular + 1 final wager)
    state.totalQuestions = Math.max(1, roomData.question_ids.length - 1);
    state.questions = await fetchQuestionsByIds(roomData.question_ids);
    if (state.questions.length > 0) resolveFieldMap(state.questions[0]);
    state.currentQuestion = roomData.current_question || 0;

    // Detect final wager phases
    if (['final_wager', 'final_question'].includes(roomData.game_phase)) {
      state.isFinalWagerRound = true;
    }

    // Rebuild used wagers from existing answers (clear first to prevent stale data)
    state.usedWagers = new Map();
    const allAnswers = await fetchAllAnswers(state.room.id);
    const myAnswers = allAnswers.filter(a => a.player_id === state.room.playerId);
    for (const a of myAnswers) {
      state.usedWagers.set(a.wager, !!a.is_correct);
    }
    // Recover final wager value if locked in
    const fwAnswer = myAnswers.find(a => a.question_number === state.totalQuestions);
    if (fwAnswer) {
      state.finalWager = fwAnswer.wager;
      state.finalWagerLocked = true;
    }

    if (roomData.question_started_at) {
      state.questionStartedAt = roomData.question_started_at;
    }

    // If reconnecting to countdown, skip straight to question
    if (roomData.game_phase === 'countdown') {
      await updateGameState(state.room.id, { game_phase: 'question', current_question: 0 });
      handlePhaseTransition('question');
    } else {
      handlePhaseTransition(roomData.game_phase);
    }
    return;
  }

  // Fetch used question IDs for repeat prevention (persists across Play Again cycles)
  const { data: roomForExclude } = await fetchRoom(state.room.id);
  const excludeIds = roomForExclude?.used_question_ids || [];

  // Collect logged-in player user IDs for smart question selection
  const playerUserIds = state.players.map(p => p.user_id).filter(Boolean);

  // Fetch totalQuestions + 1 (extra for final wager round) with smart selection
  const subcategory = state.room.subcategory || null;
  let questions;
  if (subcategory === '__all_questions__') {
    questions = await fetchAllOpenQuestions(state.totalQuestions + 1, excludeIds, playerUserIds);
  } else if (subcategory === '__true_wild_card__') {
    questions = await fetchExclusiveWildCardQuestions(state.totalQuestions + 1, excludeIds);
  } else {
    questions = await fetchQuestionsByCategory(state.room.category, state.totalQuestions + 1, excludeIds, playerUserIds, subcategory);
  }

  if (questions.length === 0) {
    $('#game-loading .game-loading__text').textContent = 'No questions found for this category.';
    return;
  }

  // If we got fewer than requested, adjust totalQuestions (the extra is for final wager)
  if (questions.length <= state.totalQuestions) {
    state.totalQuestions = Math.max(1, questions.length - 1);
  }
  state.questions = questions;
  resolveFieldMap(questions[0]);

  const questionIds = questions.map(q => q.id);

  // Track these question IDs as used (persists across Play Again — no repeats)
  appendUsedQuestionIds(state.room.id, questionIds);
  const countdownStartedAt = new Date(Date.now() + state.serverTimeOffset).toISOString();
  state.countdownStartedAt = countdownStartedAt;
  await updateGameState(state.room.id, {
    question_ids: questionIds,
    game_phase: 'countdown',
    current_question: 0,
    countdown_started_at: countdownStartedAt
  });

  state.gamePhase = 'countdown';
  showCountdownScreen();
}

async function initPlayerGame() {
  let roomData = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    const { data } = await fetchRoom(state.room.id);
    if (data && data.question_ids && data.question_ids.length > 0 && data.game_phase) {
      roomData = data;
      break;
    }
    await new Promise(r => setTimeout(r, PLAYER_INIT_WAIT_MS));
  }

  if (!roomData || !roomData.question_ids) {
    $('#game-loading .game-loading__text').textContent = 'Waiting for host...';
    // Keep polling — Realtime handleRoomChange may also catch it, but this is a safety net
    state._hotJoinPollId = setInterval(async () => {
      const { data } = await fetchRoom(state.room.id);
      if (!data) {
        // Room was deleted — stop polling and go home
        clearInterval(state._hotJoinPollId);
        state._hotJoinPollId = null;
        sessionStorage.removeItem('oracle_party_room');
        window.location.href = 'index.html';
        return;
      }
      if (data.question_ids && data.question_ids.length > 0 && data.game_phase) {
        clearInterval(state._hotJoinPollId);
        state._hotJoinPollId = null;
        await applyGameState(data);
      }
    }, PLAYER_READY_CONFIRM_MS);
    return;
  }

  await applyGameState(roomData);
}

/**
 * Apply fetched room data to local state and transition to the correct phase.
 * Used by both initPlayerGame (initial load) and hot-join fallback poll.
 */
async function applyGameState(roomData) {
  // question_ids has N+1 entries (N regular + 1 final wager)
  state.totalQuestions = Math.max(1, roomData.question_ids.length - 1);
  state.questions = await fetchQuestionsByIds(roomData.question_ids);

  if (state.questions.length > 0) {
    resolveFieldMap(state.questions[0]);
  }

  state.currentQuestion = roomData.current_question || 0;

  // Build list of questions shown so far (for question browser on reconnect)
  state.shownQuestionIndices = [];
  for (let i = 0; i <= state.currentQuestion; i++) {
    state.shownQuestionIndices.push(i);
  }

  // Detect final wager phases
  if (['final_wager', 'final_question'].includes(roomData.game_phase)) {
    state.isFinalWagerRound = true;
  }

  // Rebuild used wagers from existing answers (clear first to prevent stale data)
  state.usedWagers = new Map();
  const allAnswers = await fetchAllAnswers(state.room.id);
  const myAnswers = allAnswers.filter(a => a.player_id === state.room.playerId);
  for (const a of myAnswers) {
    state.usedWagers.set(a.wager, !!a.is_correct);
  }

  // Rebuild disqualified questions: detect questions where ALL answers have score_earned=0
  state.disqualifiedQuestions = new Set();
  const answersByQ = {};
  for (const a of allAnswers) {
    if (!answersByQ[a.question_number]) answersByQ[a.question_number] = [];
    answersByQ[a.question_number].push(a);
  }
  for (const [qNum, answers] of Object.entries(answersByQ)) {
    if (answers.length > 0 && answers.every(a => !a.is_correct && (a.score_earned || 0) === 0)) {
      state.disqualifiedQuestions.add(parseInt(qNum, 10));
    }
  }

  // Recover final wager value if locked in
  const fwAnswer = myAnswers.find(a => a.question_number === state.totalQuestions);
  if (fwAnswer) {
    state.finalWager = fwAnswer.wager;
    state.finalWagerLocked = true;
  }

  // Store server timer start for reconnect scenarios
  if (roomData.question_started_at) {
    state.questionStartedAt = roomData.question_started_at;
  }
  if (roomData.countdown_started_at) {
    state.countdownStartedAt = roomData.countdown_started_at;
  }

  // Hydrate scores from DB so existing players' scores are correct
  await updateScores();

  handlePhaseTransition(roomData.game_phase);
}

// ============================================
// PLAYER CHANGE HANDLER
// ============================================

async function handlePlayerChange(payload) {
  const event = payload.eventType;

  if (event === 'DELETE' && payload.old) {
    const deletedId = String(payload.old.id);

    // Remove player from local state
    state.players = state.players.filter(p => String(p.id) !== deletedId);
    delete state.scores[deletedId];

    // If room is now empty, delete it (cleanup zombie rooms)
    if (state.players.length === 0) {
      await deleteRoom(state.room.id);
      return;
    }

    // BUG 2 FIX: Don't rely on payload.old.is_host — Supabase default REPLICA
    // IDENTITY only sends the primary key in OLD for DELETE events. Instead check
    // if any remaining player has is_host=true. If not, promote the next player.
    const hasHost = state.players.some(p => p.is_host);
    if (!hasHost) {
      const cohost = state.players.find(p => p.is_cohost);
      let nextHost;
      if (cohost) {
        nextHost = cohost;
      } else {
        const sorted = [...state.players].sort((a, b) => {
          const ta = a.joined_at ? new Date(a.joined_at) : Infinity;
          const tb = b.joined_at ? new Date(b.joined_at) : Infinity;
          return ta - tb;
        });
        nextHost = sorted[0];
      }

      if (String(nextHost.id) === String(state.room.playerId)) {
        state.room.isHost = true;
        sessionStorage.setItem('oracle_party_room', JSON.stringify(state.room));
        // Update local player state immediately so host badge renders
        const localIdx = state.players.findIndex(p => String(p.id) === String(state.room.playerId));
        if (localIdx !== -1) state.players[localIdx].is_host = true;
        await promoteToHost(state.room.id, state.room.playerId, getDisplayName());
        // Show host controls for current phase WITHOUT re-triggering phase logic
        // (handlePhaseTransition can cause auto-submits, screen transitions, etc.)
        _activateHostControlsForCurrentPhase();
        // Notify all players about the host transfer
        sendMessage(state.room.id, 'System', `${getDisplayName()} is now the host`);
      }
    }
  } else if (event === 'UPDATE' && payload.new) {
    const idx = state.players.findIndex(p => String(p.id) === String(payload.new.id));
    if (idx !== -1) {
      state.players[idx] = payload.new;
    }
    // Detect host/co-host changes for this player
    if (String(payload.new.id) === String(state.room.playerId)) {
      if (payload.new.is_cohost && !state.room.isCohost) {
        state.room.isCohost = true;
        sessionStorage.setItem('oracle_party_room', JSON.stringify(state.room));
      } else if (!payload.new.is_cohost && state.room.isCohost) {
        state.room.isCohost = false;
        sessionStorage.setItem('oracle_party_room', JSON.stringify(state.room));
      }
    }
  } else if (event === 'INSERT' && payload.new) {
    if (!state.players.some(p => String(p.id) === String(payload.new.id))) {
      state.players.push(payload.new);
      if (!state.scores[payload.new.id]) state.scores[payload.new.id] = 0;
    }
  }
}

/**
 * Show host-only controls for the current game phase.
 * Called after mid-game host transfer instead of handlePhaseTransition(),
 * which would cause side effects (auto-submits, screen transitions).
 */
function _activateHostControlsForCurrentPhase() {
  const phase = state.gamePhase;

  if (phase === 'reveal' || phase === 'answer_reveal') {
    // Reveal screen: show Next Question / Reveal Results button
    const btn = $('#btn-next-question');
    if (btn) {
      btn.classList.remove('hidden');
      if (state.resultsRevealed) {
        btn.onclick = null; // Will be set by the scores advancement handler
      }
    }
    // Attach judgment override handler to reveal answers container
    const revealContainer = document.querySelector('#reveal-answers');
    if (revealContainer) {
      revealContainer.addEventListener('click', handleJudgmentOverride);
    }
  }

  if (phase === 'scores_reveal') {
    // Scores screen: show action button + edit scores
    const btn = $('#btn-scores-action');
    if (btn) btn.classList.remove('hidden');
    const editBtn = $('#btn-edit-scores');
    if (editBtn && state.currentQuestion > 0) {
      editBtn.classList.remove('hidden');
      editBtn.onclick = showScoreEditSheet;
    }
  }

  if (phase === 'final_wager') {
    // Final wager: show Reveal Question button (only if host locked their wager)
    const revealBtn = $('#btn-fw-reveal');
    if (revealBtn && state.finalWagerLocked) {
      revealBtn.classList.remove('hidden');
      revealBtn.onclick = handleRevealFinalQuestion;
    }
  }

  // difficulty_vote phase removed — no host controls needed for it

  // Show host settings gear + init panel for new host
  initHostSettingsPanel();
  showHostSettingsGear();
}

// ============================================
// ROOM CHANGE HANDLER
// ============================================

function handleRoomChange(payload) {
  // Room deleted (last player left) — kick to home
  if (payload.eventType === 'DELETE') {
    setIsLeaving(true); // Room already gone — prevent handleUnload beacon
    cleanup();
    sessionStorage.removeItem('oracle_party_room');
    window.location.href = 'index.html';
    return;
  }

  if (!payload.new) return;
  const { game_phase, current_question, question_ids, question_started_at, countdown_started_at, status, category, subcategory, question_timer, auto_proceed } = payload.new;

  // Sync category/subcategory if changed (host changed settings)
  if (category && state.room) state.room.category = category;
  if (subcategory !== undefined && state.room) state.room.subcategory = subcategory;

  // Sync timer/auto-proceed if host changed mid-game
  if (question_timer !== undefined && state.room?.settings) {
    state.timerSeconds = Number(question_timer) || 30;
    state.room.settings.questionTimer = state.timerSeconds;
  }
  if (auto_proceed !== undefined && state.room?.settings) {
    state.autoProceedSeconds = Number(auto_proceed) || 0;
    state.room.settings.autoProceed = state.autoProceedSeconds;
  }

  // BUG 2 FIX: When room status changes to 'lobby', DON'T auto-navigate all players.
  // Instead show an in-page notification so players can choose when to return.
  // This prevents the host's "Play Again" from yanking everyone out of the results screen.
  if (status === 'lobby') {
    _showLobbyReturnNotice();
    return;
  }

  // When host starts a NEW game while this player is still on results,
  // show a notification instead of auto-pulling them in.
  if (status === 'playing' && state.gamePhase === 'results') {
    _showNewGameNotice();
    return;
  }

  // Track server timer start timestamp
  if (question_started_at) {
    state.questionStartedAt = question_started_at;
  }

  // Track countdown start timestamp
  if (countdown_started_at) {
    state.countdownStartedAt = countdown_started_at;
  }

  // Non-host: when host writes question_started_at, reveal the question and start timer
  if (!state.room.isHost && question_started_at && state.gamePhase === 'question' && !state.hasSubmitted && !state.timerId) {
    revealQuestionAndStartTimer();
    return;
  }

  if (!state.room.isHost && question_ids && question_ids.length > 0 && state.questions.length === 0) {
    // First time receiving questions (initial load / hot-join)
    if (state._hotJoinPollId) { clearInterval(state._hotJoinPollId); state._hotJoinPollId = null; }
    state.totalQuestions = Math.max(1, question_ids.length - 1);
    fetchQuestionsByIds(question_ids).then(async qs => {
      state.questions = qs;
      if (qs.length > 0) resolveFieldMap(qs[0]);
      await updateScores();
      if (game_phase) handlePhaseTransition(game_phase);
    }).catch(() => {});
    return;
  }

  // Detect whether question_ids actually changed (e.g., difficulty vote replaced final question)
  const questionIdsChanged = !state.room.isHost && question_ids && question_ids.length > 0
    && state.questions.length > 0
    && (question_ids.length !== state.questions.length
        || question_ids.some((id, i) => state.questions[i]?.id !== id));

  if (current_question !== undefined) {
    state.currentQuestion = current_question;
  }

  // For final_question phase with changed question IDs, we MUST wait for the fetch
  // so showQuestionScreen() displays the correct (difficulty-matched) question.
  // Same blocking pattern as the initial-load fetch above.
  if (questionIdsChanged && (game_phase === 'final_question' || game_phase === 'difficulty_vote')) {
    fetchQuestionsByIds(question_ids).then(qs => {
      if (qs.length > 0) { state.questions = qs; resolveFieldMap(qs[0]); }
      if (game_phase) handlePhaseTransition(game_phase);
    }).catch(() => {
      // Fetch failed — proceed with old questions as fallback
      if (game_phase) handlePhaseTransition(game_phase);
    });
    return;
  }

  // For other phases, background fetch (non-blocking) is fine
  if (questionIdsChanged) {
    fetchQuestionsByIds(question_ids).then(qs => {
      if (qs.length > 0) { state.questions = qs; resolveFieldMap(qs[0]); }
    }).catch(() => {});
  }

  if (game_phase) handlePhaseTransition(game_phase);
}

/**
 * Show an in-page notice that the host returned to lobby.
 * Players can choose when to follow — they're not auto-yanked.
 */
function _showLobbyReturnNotice() {
  const existing = document.getElementById('lobby-return-notice');
  if (existing) return; // Already showing

  // Safety: only show if results screen is active. If the room status changes
  // to 'lobby' during gameplay (shouldn't happen, but guard against it),
  // just auto-navigate instead of showing a notice on an invisible screen.
  const resultsScreen = document.querySelector('#results-screen');
  if (!resultsScreen || resultsScreen.style.display === 'none') {
    setIsLeaving(true);
    try { cleanup(); } catch (_) {}
    sessionStorage.setItem('oracle_party_returning_from_game', '1');
    navigateWithFadeReplace('lobby.html');
    return;
  }

  const notice = document.createElement('div');
  notice.id = 'lobby-return-notice';
  notice.className = 'signup-nudge';
  notice.style.margin = 'var(--space-md) var(--space-lg)';
  notice.innerHTML = `
    <p class="signup-nudge__text">Host returned to lobby</p>
    <button class="btn btn-primary btn-block" id="btn-return-lobby">Return to Lobby</button>
  `;

  // Insert into the visible results screen content area
  const resultsContent = document.querySelector('#results-screen .game-content');
  if (resultsContent) {
    resultsContent.appendChild(notice);
  } else {
    document.body.appendChild(notice);
  }

  document.getElementById('btn-return-lobby').onclick = () => {
    setIsLeaving(true);
    try { cleanup(); } catch (_) {}
    sessionStorage.setItem('oracle_party_returning_from_game', '1');
    navigateWithFadeReplace('lobby.html');
  };
}

/**
 * Show a notice that the host started a new game.
 * Players on the results screen can choose to join or stay.
 */
function _showNewGameNotice() {
  const existing = document.getElementById('new-game-notice');
  if (existing) return;

  const resultsScreen = document.querySelector('#results-screen');
  if (!resultsScreen || resultsScreen.style.display === 'none') {
    // Not on results — auto-navigate to join the new game
    setIsLeaving(true);
    cleanup();
    sessionStorage.setItem('oracle_party_returning_from_game', '1');
    navigateWithFadeReplace('lobby.html');
    return;
  }

  const notice = document.createElement('div');
  notice.id = 'new-game-notice';
  notice.className = 'signup-nudge';
  notice.style.margin = 'var(--space-md) var(--space-lg)';
  notice.innerHTML = `
    <p class="signup-nudge__text">Host started a new game</p>
    <button class="btn btn-primary btn-block" id="btn-join-new-game">Join</button>
  `;

  const resultsContent = resultsScreen.querySelector('.game-content');
  if (resultsContent) resultsContent.appendChild(notice);

  document.getElementById('btn-join-new-game').onclick = () => {
    setIsLeaving(true);
    cleanup();
    sessionStorage.setItem('oracle_party_returning_from_game', '1');
    navigateWithFadeReplace('lobby.html');
  };
}

/**
 * Reveal the hidden question elements and start the server-synced timer.
 * Called on non-host clients when they receive question_started_at from host.
 */
function revealQuestionAndStartTimer() {
  $('.question-card').style.visibility = '';
  $('#wager-grid').style.visibility = '';
  $('#answer-form').style.visibility = '';
  $('#wager-error').style.visibility = '';
  $('.timer').style.visibility = '';

  startTimer();
  $('#answer-input').focus({ preventScroll: true });
}

async function handlePhaseTransition(phase) {
  if (!phase) return; // guard against null/undefined game_phase

  // During countdown, defer other phase transitions until countdown completes
  if (_countdownActive && phase !== 'countdown') {
    setDeferredPhase(phase);
    return;
  }

  // 'question' phase with new current_question always resets
  if (phase === 'question') {
    // Guard: skip if we already processed this exact question transition
    if (state.gamePhase === 'question' && state._lastProcessedQuestion === state.currentQuestion) {
      return;
    }
    state._lastProcessedQuestion = state.currentQuestion;
    state.currentWager = null;
    state.wagerExplicitlySelected = false;
    state.hasSubmitted = false;
    state.onRevealScreen = false;
    state.resultsRevealed = false;
    state.timerExpired = false;
    state.currentAnswers = [];
    state.previousScores = {};
    // Clear stale reveal DOM from previous round
    $('#reveal-answers').innerHTML = '';
    // Reset scores guard on first question (new game / play again)
    if (state.currentQuestion === 0) {
      setLastScoresRendered(-1);
      state._gamePlayCompleted = false;
      state._cumulativeScoresWritten = false;
      state.usedWagers = new Map();
      state.disqualifiedQuestions = new Set();
      // Track game play start
      insertGamePlay({
        roomId: state.room.id,
        playerId: state.room.playerId,
        playerName: getDisplayName(),
        category: state.room.category,
        totalQuestions: state.totalQuestions
      });
    }
    // Clear stale questionStartedAt on normal transitions (not init reconnect)
    // Reconnects from init set questionStartedAt BEFORE calling handlePhaseTransition
    if (state.gamePhase !== 'loading') {
      state.questionStartedAt = null;
    }
    state.gamePhase = phase;

    // On reconnect (questionStartedAt present), check if we already answered
    if (state.questionStartedAt) {
      const qNum = state.currentQuestion;
      fetchAnswersForQuestion(state.room.id, qNum).then(answers => {
        const myAnswer = answers.find(a => a.player_id === state.room.playerId);
        if (myAnswer) {
          // Already submitted — go straight to reveal
          state.hasSubmitted = true;
          state.questionStartedAt = null;
          showRevealScreen();
        } else {
          showQuestionScreen();
        }
      });
    } else {
      showQuestionScreen();
    }
    return;
  }

  if (phase === state.gamePhase) return;
  state.gamePhase = phase;

  switch (phase) {
    case 'reveal':
      // Host skipped timer — stop local timer and auto-submit
      if (state.timerId) { clearInterval(state.timerId); state.timerId = null; }
      state.timerExpired = true;
      // Auto-select wager if none was explicitly selected
      if (!state.wagerExplicitlySelected) {
        if (state.isFinalWagerRound) {
          state.currentWager = state.finalWager || 20;
        } else {
          // Assign lowest available wager
          let found = false;
          for (let i = 1; i <= state.totalQuestions; i++) {
            if (!state.usedWagers.has(i)) { state.currentWager = i; found = true; break; }
          }
          if (!found) state.currentWager = 1;
        }
      }
      if (!state.hasSubmitted) {
        // BUG 2 FIX: Show "Time's up!" feedback so the player knows why their answer
        // was auto-submitted. Without this, the screen just jumps to reveal with no
        // explanation, making it feel like the game "skipped".
        const timerEl = document.querySelector('.timer');
        if (timerEl) { timerEl.textContent = "Time's up!"; timerEl.classList.add('timer--expired'); }
        const currentAnswer = ($('#answer-input')?.value || '').trim();
        await doSubmitAnswer(currentAnswer, { autoSubmit: true });
      } else if (!state.onRevealScreen) {
        showRevealScreen();
      }
      break;
    case 'answer_reveal':
      // Host clicked "Reveal Results" — stop local timer and show results
      if (state.timerId) { clearInterval(state.timerId); state.timerId = null; }
      state.timerExpired = true;
      // Auto-select wager if none was explicitly selected
      if (!state.wagerExplicitlySelected) {
        if (state.isFinalWagerRound) {
          state.currentWager = state.finalWager || 20;
        } else {
          // Assign lowest available wager
          let found = false;
          for (let i = 1; i <= state.totalQuestions; i++) {
            if (!state.usedWagers.has(i)) { state.currentWager = i; found = true; break; }
          }
          if (!found) state.currentWager = 1;
        }
      }
      state.resultsRevealed = true;
      if (!state.hasSubmitted) {
        // Auto-submit whatever the player has typed (host revealed early)
        const currentAnswer = ($('#answer-input')?.value || '').trim();
        await doSubmitAnswer(currentAnswer, { autoSubmit: true });
        // showRevealScreen() → doReveal() will follow since resultsRevealed is true
      } else if (!state.onRevealScreen) {
        showRevealScreen(); // will call doReveal() since resultsRevealed is true
      } else {
        // Already on reveal screen — re-fetch answers before revealing
        // (host's auto-submitted answers may not have arrived via Realtime yet)
        try {
          state.currentAnswers = await fetchAnswersForQuestion(state.room.id, state.currentQuestion);
        } catch (_) { /* doReveal's background fetch will retry */ }
        doReveal();
      }
      break;
    case 'scores_reveal':
      state.onRevealScreen = false;
      showScoresScreen();
      break;
    case 'countdown':
      showCountdownScreen();
      break;
    case 'final_wager':
      state.isFinalWagerRound = true;
      showFinalWagerScreen();
      break;
    case 'difficulty_vote':
      // Difficulty vote removed — treat as final_question
      state.isFinalWagerRound = true;
      // Fall through to final_question
    // eslint-disable-next-line no-fallthrough
    case 'final_question':
      // Duplicate-event guard is handled by the generic check at the top of
      // this function (line: if (phase === state.gamePhase) return;).
      // A previous guard here (`if (state.gamePhase === 'final_question') return`)
      // was ALWAYS true because state.gamePhase is set to `phase` before the
      // switch statement, causing non-host players to never see the final question.
      state.isFinalWagerRound = true;
      // Reset for the final question round (same resets as 'question' phase)
      state.currentWager = state.finalWager;
      state.wagerExplicitlySelected = true; // Final wager already locked in
      state.hasSubmitted = false;
      state.onRevealScreen = false;
      state.resultsRevealed = false;
      state.timerExpired = false;
      state.currentAnswers = [];
      state.previousScores = {};
      // Clear stale reveal DOM from previous round
      $('#reveal-answers').innerHTML = '';
      if (state.gamePhase !== 'loading') {
        state.questionStartedAt = null;
      }
      state.gamePhase = phase;
      showQuestionScreen();
      return; // already set gamePhase
    case 'results':
      showResultsScreen();
      break;
    default:
      break;
  }
}

// ============================================
// COUNTDOWN SCREEN
// ============================================

function showCountdownScreen() {
  setCountdownActive(true);
  setDeferredPhase(null);
  hideHostSettingsGear();

  const currentScreen = document.querySelector('.screen.active');
  const countdownScreen = $('#countdown-screen');
  if (currentScreen && currentScreen !== countdownScreen) {
    transitionScreens(currentScreen, countdownScreen, COUNTDOWN_TRANSITION_MS);
  } else {
    countdownScreen.style.display = '';
    void countdownScreen.offsetHeight;
    countdownScreen.classList.add('active');
  }

  const steps = ['3', '2', '1', 'GO!'];
  const DELAY_MS = COUNTDOWN_DELAY_MS;  // Brief pause before "3" so everyone sees the countdown screen
  const STEP_MS = COUNTDOWN_STEP_MS;   // Time each number stays on screen
  const TOTAL_MS = DELAY_MS + (steps.length * STEP_MS); // 4100ms
  let lastShownStep = -1;

  function getElapsedMs() {
    if (!state.countdownStartedAt) return 0;
    const startMs = new Date(state.countdownStartedAt).getTime();
    const nowServerMs = Date.now() + state.serverTimeOffset;
    return nowServerMs - startMs;
  }

  function finishCountdown() {
    setCountdownActive(false);

    // Host advances to first question
    if (state.room.isHost) {
      updateGameState(state.room.id, {
        game_phase: 'question',
        current_question: 0
      });
    } else if (_deferredPhase) {
      // Non-host: process any phase transition that arrived during countdown
      const deferred = _deferredPhase;
      setDeferredPhase(null);
      handlePhaseTransition(deferred);
    }
  }

  function tick() {
    const elapsed = getElapsedMs();

    // Countdown finished
    if (elapsed >= TOTAL_MS) {
      // Show GO! briefly if we haven't shown it yet
      if (lastShownStep < steps.length - 1) {
        showStep(steps.length - 1);
        setTimeout(finishCountdown, COUNTDOWN_FINISH_MS);
      } else {
        finishCountdown();
      }
      return;
    }

    // During initial delay, no step shown yet
    if (elapsed < DELAY_MS) {
      setTimeout(tick, Math.max(16, DELAY_MS - elapsed));
      return;
    }

    // Which step should we be on?
    const stepIndex = Math.min(Math.floor((elapsed - DELAY_MS) / STEP_MS), steps.length - 1);

    if (stepIndex > lastShownStep) {
      showStep(stepIndex);
    }

    // Schedule next tick — align to next step boundary for precision
    const nextStepAt = DELAY_MS + (stepIndex + 1) * STEP_MS;
    const delay = Math.max(16, nextStepAt - elapsed);
    setTimeout(tick, delay);
  }

  function showStep(stepIndex) {
    lastShownStep = stepIndex;

    // Replace element entirely — fresh DOM element always plays animation from scratch
    const container = document.querySelector('.countdown');
    const fresh = document.createElement('span');
    fresh.id = 'countdown-number';
    fresh.className = 'countdown__number' + (steps[stepIndex] === 'GO!' ? ' countdown__number--go' : '');
    fresh.textContent = steps[stepIndex];

    const old = container.querySelector('#countdown-number');
    if (old) container.removeChild(old);
    container.appendChild(fresh);
  }

  tick();
}



// ============================================
// ANSWER CHANGE HANDLER (Realtime)
// ============================================

function handleAnswerChange(payload) {
  // Ignore answer changes on the scores screen
  if (state.gamePhase === 'scores_reveal') return;

  // During final wager screen, update the player wager list
  if (state.gamePhase === 'final_wager') {
    if (payload.eventType === 'INSERT' && payload.new && payload.new.submitted_answer === '__WAGER_LOCKED__') {
      updateFinalWagerPlayerList();
    }
    return;
  }

  if (!state.onRevealScreen) return;

  const event = payload.eventType;

  if (event === 'UPDATE' && payload.new) {
    // Update cached answer object
    const idx = state.currentAnswers.findIndex(a => String(a.id) === String(payload.new.id));
    if (idx !== -1) {
      const oldText = state.currentAnswers[idx].submitted_answer;
      state.currentAnswers[idx] = { ...state.currentAnswers[idx], ...payload.new };
      // If the answer TEXT changed (not just judgment), full re-render is needed.
      // This happens in the final wager round when the host's real answer replaces
      // the __WAGER_LOCKED__ placeholder via upsert (which fires UPDATE, not INSERT).
      if (payload.new.submitted_answer !== undefined && payload.new.submitted_answer !== oldText) {
        renderRevealAnswers(state.currentAnswers);
        return;
      }
    }
    // Update usedWagers if the judgment change affects the current player's wager
    if (idx !== -1) {
      const answer = state.currentAnswers[idx];
      if (String(answer.player_id) === String(state.room.playerId) && answer.wager) {
        state.usedWagers.set(answer.wager, !!answer.is_correct);
      }
    }
    // CSS-only patch for judgment changes (host override toggle)
    const answerId = String(payload.new.id);
    const row = document.querySelector(`#reveal-answers .answer-row[data-answer-id="${answerId}"]`);
    if (row && idx !== -1) {
      const answer = state.currentAnswers[idx];
      const isCorrect = answer.is_correct || false;
      // Patch answer text color
      const answerEl = row.querySelector('.answer-row__answer');
      if (answerEl && state.resultsRevealed) {
        answerEl.classList.toggle('answer-row__answer--correct', isCorrect);
        answerEl.classList.toggle('answer-row__answer--incorrect', !isCorrect);
      }
      // Patch wager badge color
      const wagerEl = row.querySelector('.answer-row__wager');
      if (wagerEl && state.resultsRevealed) {
        wagerEl.classList.toggle('answer-row__wager--correct', isCorrect);
        wagerEl.classList.toggle('answer-row__wager--incorrect', !isCorrect);
      }
      // Patch toggle switch (host only)
      const toggle = row.querySelector('.answer-toggle');
      if (toggle) {
        toggle.classList.toggle('answer-toggle--correct', isCorrect);
        toggle.classList.toggle('answer-toggle--incorrect', !isCorrect);
      }
      return;
    }
    // Fallback: full re-render
    renderRevealAnswers(state.currentAnswers);
    return;
  }

  if (event === 'INSERT' && payload.new) {
    // New answer submitted — only process if for current question
    if (payload.new.question_number !== state.currentQuestion) return;

    const existing = state.currentAnswers.findIndex(a => String(a.id) === String(payload.new.id));
    if (existing === -1) {
      state.currentAnswers.push(payload.new);
    } else {
      state.currentAnswers[existing] = payload.new;
    }
    renderRevealAnswers(state.currentAnswers);

    // Hide reveal timer once all players have submitted
    if (state.currentAnswers.length >= state.players.length) {
      const revealTimer = $('#reveal-timer');
      if (revealTimer) revealTimer.style.display = 'none';
    }

    // Host/co-host: check if all submitted → enable reveal button and update text
    if (canControlGame() && !state.resultsRevealed) {
      if (state.currentAnswers.length >= state.players.length) {
        enableRevealButton();
      }
      updateRevealButtonText();
    }
    return;
  }

  // Fallback for DELETE or unknown events: full re-fetch
  const fallbackQNum = state.currentQuestion;
  fetchAnswersForQuestion(state.room.id, fallbackQNum).then(answers => {
    if (state.currentQuestion !== fallbackQNum) return; // question changed, discard stale fetch
    state.currentAnswers = answers;
    renderRevealAnswers(answers);
  });
}

// STALE PLAYER AUTO-KICK (5 min disconnect → removed)
// ============================================
const STALE_TIMEOUT = STALE_TIMEOUT_MS; // 30 seconds — fast fallback for when unload beacons fail

async function checkStalePresence() {
  setStaleCheckCount(_staleCheckCount + 1);
  const now = Date.now();
  for (const [id, since] of state.awayTimestamps) {
    if (now - since < STALE_TIMEOUT) continue;
    if (id === String(state.room.playerId)) continue;

    const stalePlayer = state.players.find(p => String(p.id) === id);
    if (!stalePlayer) continue;

    if (stalePlayer.is_host) {
      // Stale host: earliest connected player kicks them (deterministic)
      const connected = state.players
        .filter(p => !state.awayTimestamps.has(String(p.id)))
        .sort((a, b) => new Date(a.joined_at) - new Date(b.joined_at));
      if (connected[0] && String(connected[0].id) === String(state.room.playerId)) {
        removePlayer(id);
      }
    } else if (state.room.isHost) {
      // Stale non-host: host kicks them
      removePlayer(id);
    }
  }

  // Fallback host promotion: Supabase Realtime DELETE events may not arrive
  // because the room_id filter can't match DELETE payloads (default REPLICA
  // IDENTITY only sends the primary key). Re-fetch players every 3rd call
  // to reduce DB load while still catching missed events.
  if (_staleCheckCount % 3 === 0) {
    const freshPlayers = await fetchPlayers(state.room.id);
    if (freshPlayers.length > 0) {
      state.players = freshPlayers;
    }
  }
  if (state.players.length > 0 && !state.players.some(p => p.is_host)) {
    // No host found — prefer co-host, otherwise earliest player
    const cohost = state.players.find(p => p.is_cohost);
    let nextHost;
    if (cohost) {
      nextHost = cohost;
    } else {
      const sorted = [...state.players].sort((a, b) => {
        const ta = a.joined_at ? new Date(a.joined_at) : Infinity;
        const tb = b.joined_at ? new Date(b.joined_at) : Infinity;
        return ta - tb;
      });
      nextHost = sorted[0];
    }
    if (String(nextHost.id) === String(state.room.playerId)) {
      // If we were co-host, clear that flag first
      if (state.room.isCohost) {
        state.room.isCohost = false;
        const localMe = state.players.findIndex(p => String(p.id) === String(state.room.playerId));
        if (localMe !== -1) state.players[localMe].is_cohost = false;
        demoteCohost(state.room.playerId).catch(e => logger.warn('Game', 'demoteCohost on promotion failed', e));
      }
      state.room.isHost = true;
      sessionStorage.setItem('oracle_party_room', JSON.stringify(state.room));
      const localIdx = state.players.findIndex(p => String(p.id) === String(state.room.playerId));
      if (localIdx !== -1) state.players[localIdx].is_host = true;
      await promoteToHost(state.room.id, state.room.playerId, getDisplayName());
      _activateHostControlsForCurrentPhase();
      sendMessage(state.room.id, 'System', `${getDisplayName()} is now the host`);
    }
  }
}

// ============================================
// QUESTION BROWSER (between-rounds bottom sheet)
// ============================================


// ============================================
// EXIT PATHS (player leaves the game permanently)
// ============================================
// Four ways a player leaves:
//   1. Quit button   → handleQuitGame()    → awaits DB delete, then navigates home
//   2. Browser back  → handleBackButton()  → fire-and-forget DB delete, navigates home
//   3. Tab close     → handleUnload()      → beacon delete (survives page teardown)
//   4. Room deleted  → handleRoomChange()  → navigates home (room already gone)
//
// Two non-leaving transitions (player stays in the room):
//   5. Play Again    → handlePlayAgain()   → navigates to lobby
//   6. Back to lobby → handleRoomChange()  → navigates to lobby
//
// _isLeaving prevents handleUnload from double-removing after an
// explicit leave or non-leaving transition.

function handleBackButton() {
  setIsLeaving(true);
  cleanup();
  if (state.room && state.room.playerId) {
    if (state.players.length <= 1) {
      deleteRoomBeacon(state.room.id);
    } else {
      removePlayerBeacon(state.room.playerId);
    }
  }
  sessionStorage.removeItem('oracle_party_room');
  window.location.href = 'index.html';
}

function handleUnload() {
  if (_isLeaving) return;
  // Send beacon FIRST — maximize chance it completes before browser tears down the page
  if (state.room && state.room.playerId) {
    if (state.players.length <= 1) {
      deleteRoomBeacon(state.room.id);
    } else {
      removePlayerBeacon(state.room.playerId);
    }
  }
  cleanup();
}

// Safari doesn't reliably fire beforeunload — pagehide is the fallback
window.addEventListener('beforeunload', handleUnload);
window.addEventListener('pagehide', handleUnload);

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
  if (!state.presenceChannel) return;
  // Always attempt to track — swallow errors so transient failures
  // don't permanently break away detection.
  state.presenceChannel.track({ player_id: state.room.playerId, is_away: document.hidden })
    .catch(() => {});

  if (document.hidden) {
    // Track that we went hidden — syncToCurrentState needs to know
    state._wasHidden = true;
    return;
  }

  // When tab becomes visible again, sync to current game state.
  // Supabase Realtime does NOT replay missed messages after a disconnect,
  // so we fetch from DB to catch up if the game advanced while we were away.
  if (state.room && state.gamePhase !== 'loading') {
    syncToCurrentState();
  }
}

/**
 * Fetch current room state from DB and sync local state if the game has
 * advanced (different question or phase). Handles both brief disconnections
 * and tab-hidden gaps where Realtime messages were missed.
 */
async function syncToCurrentState() {
  if (_syncInFlight) return; // Prevent overlapping syncs
  setSyncInFlight(true);
  try {
    const { data: roomData } = await fetchRoom(state.room.id);
    if (!roomData || !roomData.game_phase) return;

    // Room returned to lobby while we were away
    if (roomData.status === 'lobby') {
      setIsLeaving(true);
      cleanup();
      navigateWithFadeReplace('lobby.html');
      return;
    }

    const questionChanged = roomData.current_question !== undefined &&
                            roomData.current_question !== state.currentQuestion;

    const wasHidden = state._wasHidden;
    state._wasHidden = false;

    // Phase-only sync when returning from hidden tab.
    // Realtime may have missed messages while the tab was hidden, so we need
    // to catch up on phase transitions even if the question hasn't changed.
    if (!questionChanged) {
      // Only sync phase if we were actually hidden (missed Realtime messages)
      if (wasHidden && roomData.game_phase && roomData.game_phase !== state.gamePhase) {
        // Don't sync backwards — only advance to later phases.
        // This prevents a stale DB read from regressing local state.
        const PHASE_ORDER = ['countdown', 'question', 'reveal', 'answer_reveal', 'scores_reveal', 'difficulty_vote', 'final_wager', 'final_question', 'results'];
        const currentIdx = PHASE_ORDER.indexOf(state.gamePhase);
        const serverIdx = PHASE_ORDER.indexOf(roomData.game_phase);
        // If server phase isn't in our ordering (unknown phase), allow sync
        if (serverIdx > currentIdx || currentIdx === -1 || serverIdx === -1) {
          // Sync timestamps before transitioning
          if (roomData.question_started_at) state.questionStartedAt = roomData.question_started_at;
          if (roomData.countdown_started_at) state.countdownStartedAt = roomData.countdown_started_at;
          if (['final_wager', 'final_question', 'difficulty_vote'].includes(roomData.game_phase)) {
            state.isFinalWagerRound = true;
          }
          handlePhaseTransition(roomData.game_phase);
        }
      }
      return;
    }

    // Update local state to match server
    if (roomData.current_question !== undefined) {
      state.currentQuestion = roomData.current_question;
    }
    if (roomData.question_started_at) {
      state.questionStartedAt = roomData.question_started_at;
    }
    if (roomData.countdown_started_at) {
      state.countdownStartedAt = roomData.countdown_started_at;
    }
    if (['final_wager', 'final_question'].includes(roomData.game_phase)) {
      state.isFinalWagerRound = true;
    }

    // Reset per-question state if the question advanced
    if (questionChanged) {
      state.hasSubmitted = false;
      state.onRevealScreen = false;
      state.resultsRevealed = false;
      state.timerExpired = false;
      state.currentAnswers = [];
      state.currentWager = null;
      state.wagerExplicitlySelected = false;
      state.previousScores = {};

      // Rebuild usedWagers from DB (host may have auto-submitted wagers
      // for questions we missed while disconnected)
      const allAnswers = await fetchAllAnswers(state.room.id);
      const myAnswers = allAnswers.filter(a => String(a.player_id) === String(state.room.playerId));
      state.usedWagers = new Map();
      for (const a of myAnswers) {
        state.usedWagers.set(a.wager, !!a.is_correct);
      }

      // Rebuild disqualified questions from answer state
      state.disqualifiedQuestions = new Set();
      const answersByQ = {};
      for (const a of allAnswers) {
        if (!answersByQ[a.question_number]) answersByQ[a.question_number] = [];
        answersByQ[a.question_number].push(a);
      }
      for (const [qNum, answers] of Object.entries(answersByQ)) {
        if (answers.length > 0 && answers.every(a => !a.is_correct && (a.score_earned || 0) === 0)) {
          state.disqualifiedQuestions.add(parseInt(qNum, 10));
        }
      }

      // Rebuild question browser indices for missed questions
      state.shownQuestionIndices = [];
      for (let i = 0; i <= state.currentQuestion; i++) {
        state.shownQuestionIndices.push(i);
      }

      // Rebuild scores from DB
      await updateScores();

      // Set gamePhase to 'loading' so handlePhaseTransition preserves
      // questionStartedAt instead of clearing it (line 636). This mimics
      // the init reconnect path — without it, the player gets stuck on a
      // hidden question screen waiting for a timer start that already happened.
      state.gamePhase = 'loading';
    }

    handlePhaseTransition(roomData.game_phase);
  } catch (err) {
    logger.error('Game', 'syncToCurrentState failed', err);
  } finally {
    setSyncInFlight(false);
  }
}

// ============================================
// CLEANUP (shared teardown for all exit paths)
// ============================================

function cleanup() {
  window.removeEventListener('popstate', handleBackButton);
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  // (ResizeObserver removed — chat is now inline flex, no positioning needed)
  destroyHonkSystem();
  destroyTypingIndicator();
  if (state.timerId) {
    clearInterval(state.timerId);
    state.timerId = null;
  }
  if (state._timerGraceId) {
    clearTimeout(state._timerGraceId);
    state._timerGraceId = null;
  }
  if (state.stalePollId) {
    clearInterval(state.stalePollId);
    state.stalePollId = null;
  }
  if (state._hotJoinPollId) {
    clearInterval(state._hotJoinPollId);
    state._hotJoinPollId = null;
  }
  if (state._dvTimerId) { clearInterval(state._dvTimerId); state._dvTimerId = null;
  }
  if (state.presenceHeartbeatId) {
    clearInterval(state.presenceHeartbeatId);
    state.presenceHeartbeatId = null;
  }
  if (state._syncIntervalId) {
    clearInterval(state._syncIntervalId);
    state._syncIntervalId = null;
  }
  clearAutoProceed();
  hideHostSettingsGear();
  resetReturnConfirm();
  if (_flagMenuCloseHandler) {
    document.removeEventListener('click', _flagMenuCloseHandler);
    setFlagMenuCloseHandler(null);
  }
  if (state.difficultyVoteChannel) {
    supabase.removeChannel(state.difficultyVoteChannel);
    state.difficultyVoteChannel = null;
  }
  for (const ch of state.channels) unsubscribe(ch);
  state.channels = [];
  state.presenceReady = false;
  state.presenceChannel = null;
  state.awayTimestamps = new Map();
}

// ============================================
// START
// ============================================
registerHostCleanup(cleanup);
registerShowRevealScreen(showRevealScreen);
registerRevealHelpers({ enableNextQuestion, enableRevealButton, updateRevealButtonText });
registerRevealScoresRef({
  handleShowScores, updateScores, clearAutoProceed,
  showResultsScreen, handlePhaseTransition
});
registerScoresCleanup(cleanup);
registerScoresShowQuestionScreen(showQuestionScreen);
registerScoresHandleNextQuestion(handleNextQuestion);
init();
