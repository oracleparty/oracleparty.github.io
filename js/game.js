// ============================================
// Oracle Party — Game
// Gameplay loop: question (with wager) → submit → reveal (live) → repeat
// ============================================

import { $, transitionScreens, escapeHtml, renderAvatar, showToast, navigateWithFade, navigateWithFadeReplace } from './utils.js';
import { logger } from './logger.js';
import { COUNTDOWN_DELAY_MS, COUNTDOWN_STEP_MS, COUNTDOWN_TRANSITION_MS, COUNTDOWN_FINISH_MS, SCORE_ANIMATE_MS, SCORE_REORDER_DELAY_MS, SCORE_PRE_ANIMATE_DELAY_MS, AUTO_PROCEED_TICK_MS, LOBBY_POLL_INTERVAL, STALE_CHECK_INTERVAL, STATE_SYNC_INTERVAL, STALE_TIMEOUT_MS, PLAYER_INIT_WAIT_MS, PLAYER_READY_CONFIRM_MS } from './constants.js';
import {
  addPlayer,
  fetchPlayers,
  fetchQuestionsByCategory,
  fetchQuestionsByIds,
  fetchQuestionByDifficulty,
  createDifficultyVoteChannel,
  supabase,
  updateGameState,
  saveQuestionIds,
  submitAnswer,
  fetchAnswersForQuestion,
  updateAnswerJudgment,
  fetchAllAnswers,
  fetchRoom,
  sendMessage,
  updateRoomStatus,
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
  fetchQuestionFeedback,
  insertGamePlay,
  completeGamePlay,
  archiveChatMessages,
  deleteAnswersByRoom,
  reassignPlayerAnswers,
  appendUsedQuestionIds,
  insertGameHistoryEntry,
  upsertQuestionHistory,
  fetchPlayerStats,
  fetchTitleUnlocks,
  upsertTitleUnlock,
  demoteCohost,
  fetchAllOpenQuestions,
  fetchExclusiveWildCardQuestions
} from './supabase.js';
import { getDisplayName, ensureDisplayName, initAuth, getCurrentUser, showSignUpModal } from './auth.js';
import { evaluateUnlocks, hasReachedApprentice } from './titles.js';
import { initHonkSystem, destroyHonkSystem } from './honk.js';
import { initTypingIndicator, destroyTypingIndicator } from './typing.js';
import { updatePresence } from './presence.js';
import { resolveSubcategoryIcon } from './categories.js';
import {
  state, canControlGame, getCategoryLabel,
  resolveFieldMap, getQuestionText, getCorrectAnswer, getAlternates, getDifficulty, getFunFact,
  _flagMenuCloseHandler, setFlagMenuCloseHandler,
  _isLeaving, setIsLeaving,
  _lastScoresRenderedForQuestion, setLastScoresRendered,
  _countdownActive, setCountdownActive,
  _deferredPhase, setDeferredPhase,
  _screenTransitioning, setScreenTransitioning,
  _qbFeedback, setQbFeedback,
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
// SCORES SCREEN (animated reveal)
// ============================================

async function handleShowScores() {
  // Apply locally first so the host doesn't depend on Realtime echo
  state.gamePhase = 'scores_reveal';
  state.onRevealScreen = false;
  showScoresScreen();
  // Broadcast to other clients
  await updateGameState(state.room.id, { game_phase: 'scores_reveal' });
}

async function showScoresScreen() {
  // Guard: prevent rendering the same question's scores twice
  if (state.currentQuestion === _lastScoresRenderedForQuestion) return;
  setLastScoresRendered(state.currentQuestion);

  state.onRevealScreen = false;

  // Track this question as shown (for question browser)
  if (!state.shownQuestionIndices.includes(state.currentQuestion)) {
    state.shownQuestionIndices.push(state.currentQuestion);
  }

  $('#scores-category').textContent = getCategoryLabel();
  $('#scores-progress').textContent = state.isFinalWagerRound
    ? 'Final Question'
    : `Question ${state.currentQuestion + 1} of ${state.totalQuestions}`;

  // Calculate new scores
  await updateScores();

  // If previousScores is empty (reconnect), skip animation — show final scores directly
  const hasPreviousScores = Object.keys(state.previousScores).length > 0;

  // Sort players by previous ranking (or current if no previous)
  const sortScores = hasPreviousScores ? state.previousScores : state.scores;
  const sorted = [...state.players].sort((a, b) =>
    (sortScores[b.id] || 0) - (sortScores[a.id] || 0)
  );

  const list = $('#scores-animated-list');
  list.innerHTML = sorted.map(p => {
    const prevScore = hasPreviousScores ? (state.previousScores[p.id] || 0) : (state.scores[p.id] || 0);
    const newScore = state.scores[p.id] || 0;
    const delta = newScore - prevScore;
    const deltaSign = delta > 0 ? '+' : '';
    const deltaClass = delta > 0 ? 'score-anim-row__delta--positive' :
                       delta < 0 ? 'score-anim-row__delta--negative' :
                       'score-anim-row__delta--zero';
    const avatarHtml = renderAvatar({ displayName: p.display_name, avatarColor: p.avatar_color, avatarEmoji: p.avatar_emoji });
    const titleHtml = p.title ? `<span class="player-title">${escapeHtml(p.title)}</span>` : '';

    const isMe = String(p.id) === String(state.room.playerId);
    const honks = getHonkCount(p.id);
    const honkBadge = `<span class="honk-badge" data-honk-player="${p.id}" style="${honks > 0 ? '' : 'display:none'}">${honks}</span>`;
    const honkBtn = isMe ? '' : `<button class="honk-btn" data-honk-target="${p.id}" aria-label="Quack">&#x1F986;</button>`;

    return `
      <div class="score-anim-row${state.awayTimestamps.has(String(p.id)) ? ' score-anim-row--away' : ''}" data-player-id="${p.id}" data-new-score="${newScore}" ${p.user_id ? `data-profile-user-id="${p.user_id}"` : ''}>
        <div class="avatar-wrap">
          ${avatarHtml}
          ${honkBadge}
        </div>
        <div class="name-stack">
          <span class="score-anim-row__name">${escapeHtml(p.display_name)}${p.is_host ? ' <span class="badge badge--host">Host</span>' : ''}</span>
          ${titleHtml}
        </div>
        ${honkBtn}
        <span class="score-anim-row__delta ${deltaClass}">${deltaSign}${delta}</span>
        <span class="score-anim-row__score" data-from="${prevScore}" data-to="${newScore}">${prevScore}</span>
      </div>
    `;
  }).join('');


  const currentScreen = document.querySelector('.screen.active');
  const scoresScreen = $('#scores-screen');
  if (currentScreen && currentScreen !== scoresScreen) {
    transitionScreens(currentScreen, scoresScreen).then(showChatBar);
  } else {
    showChatBar();
  }

  showHostSettingsGear();

  // Auto-animate scores for everyone (including host) — no manual trigger
  const btn = $('#btn-scores-action');
  btn.classList.add('hidden');
  if (hasPreviousScores) {
    setTimeout(() => animateScores(), SCORE_PRE_ANIMATE_DELAY_MS);
  } else {
    showFinalScoresState();
  }

  // Host: show "Edit Scores" button to review/correct past judgments
  const editBtn = $('#btn-edit-scores');
  if (canControlGame() && state.currentQuestion > 0) {
    editBtn.classList.remove('hidden');
    editBtn.onclick = showScoreEditSheet;
  } else {
    editBtn.classList.add('hidden');
  }
}

function animateScores() {
  const btn = $('#btn-scores-action');
  if (btn) {
    btn.disabled = true;
    btn.style.opacity = '0.5';
  }

  const rows = document.querySelectorAll('.score-anim-row');
  const scoreEls = document.querySelectorAll('.score-anim-row__score');

  // Phase 1: Count animation
  const duration = SCORE_ANIMATE_MS;
  const startTime = performance.now();

  function easeOut(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  function countStep(now) {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const eased = easeOut(progress);

    scoreEls.forEach(el => {
      const from = parseInt(el.dataset.from, 10);
      const to = parseInt(el.dataset.to, 10);
      const current = Math.round(from + (to - from) * eased);
      el.textContent = current;
    });

    if (progress < 1) {
      requestAnimationFrame(countStep);
    } else {
      // Phase 2: Reorder animation after a brief pause
      setTimeout(() => reorderRows(), SCORE_REORDER_DELAY_MS);
    }
  }

  requestAnimationFrame(countStep);
}

function reorderRows() {
  const container = $('#scores-animated-list');
  const rows = Array.from(container.querySelectorAll('.score-anim-row'));
  if (rows.length === 0) return;

  // FLIP Step 1 (First): Record current positions keyed by player ID
  const firstPositions = {};
  rows.forEach(row => {
    firstPositions[row.dataset.playerId] = row.getBoundingClientRect().top;
  });

  // Sort rows by new score descending and re-append in new order
  const sorted = [...rows].sort((a, b) =>
    parseInt(b.dataset.newScore, 10) - parseInt(a.dataset.newScore, 10)
  );
  sorted.forEach(row => container.appendChild(row));

  // FLIP Step 2 (Last): Record new positions, apply inverse transform
  sorted.forEach(row => {
    const pid = row.dataset.playerId;
    const lastTop = row.getBoundingClientRect().top;
    const delta = firstPositions[pid] - lastTop;
    if (delta !== 0) {
      row.style.transition = 'none';
      row.style.transform = `translateY(${delta}px)`;
    }
  });

  // FLIP Step 3 (Invert → Play): Remove inverse transform with transition
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      sorted.forEach(row => {
        row.style.transition = 'transform 0.6s cubic-bezier(0.4, 0, 0.2, 1)';
        row.style.transform = '';
      });
    });
  });

  // After transition completes, show next button
  setTimeout(() => showNextButtonOnScores(), 700);
}

function showFinalScoresState() {
  // Show scores in final order (no animation)
  const container = $('#scores-animated-list');
  const rows = Array.from(container.querySelectorAll('.score-anim-row'));

  // Update displayed scores to final values
  rows.forEach(row => {
    const scoreEl = row.querySelector('.score-anim-row__score');
    if (scoreEl) scoreEl.textContent = scoreEl.dataset.to;
  });

  // Sort by new score
  rows.sort((a, b) => parseInt(b.dataset.newScore, 10) - parseInt(a.dataset.newScore, 10));
  rows.forEach(row => container.appendChild(row));

  showNextButtonOnScores();
}

function showNextButtonOnScores() {
  // Clear any previous auto-proceed timer
  clearAutoProceed();

  if (!canControlGame()) {
    // Non-host/non-cohost: show "Waiting for host..." message
    $('#scores-waiting-host').classList.remove('hidden');
    requestAnimationFrame(repositionChatBar);
    return;
  }
  $('#scores-waiting-host').classList.add('hidden');
  const btn = $('#btn-scores-action');
  const isLast = state.currentQuestion >= state.totalQuestions - 1;

  let actionFn;
  if (isLast && !state.isFinalWagerRound) {
    btn.textContent = 'Final Wager';
    actionFn = handleFinalWager;
  } else if (state.isFinalWagerRound) {
    btn.textContent = 'Show Results';
    actionFn = handleShowResults;
  } else {
    btn.textContent = 'Next Question';
    actionFn = handleNextQuestion;
  }

  btn.onclick = () => { clearAutoProceed(); actionFn(); };
  btn.disabled = false;
  btn.style.opacity = '1';
  btn.classList.remove('hidden');
  // Use subtle secondary style instead of big primary CTA
  btn.classList.remove('btn-primary');
  btn.classList.add('btn-secondary');

  // Footer content changed — reposition chat toggle above it
  requestAnimationFrame(repositionChatBar);

  // Start auto-proceed countdown if enabled (host-only to prevent double-fire with co-host)
  if (state.room.isHost && state.autoProceedSeconds > 0) {
    startAutoProceed(state.autoProceedSeconds, actionFn);
  }
}

function startAutoProceed(seconds, actionFn) {
  clearAutoProceed();
  let remaining = seconds;
  const indicator = $('#auto-proceed-indicator');
  if (indicator) {
    indicator.classList.remove('hidden');
    indicator.textContent = remaining;
  }
  state.autoProceedTimerId = setInterval(() => {
    remaining--;
    if (indicator) indicator.textContent = remaining;
    if (remaining <= 0) {
      clearAutoProceed();
      actionFn();
    }
  }, AUTO_PROCEED_TICK_MS);
}

function clearAutoProceed() {
  if (state.autoProceedTimerId) {
    clearInterval(state.autoProceedTimerId);
    state.autoProceedTimerId = null;
  }
  const indicator = $('#auto-proceed-indicator');
  if (indicator) indicator.classList.add('hidden');
}



async function handleFinalWager() {
  state.gamePhase = 'final_wager';
  state.isFinalWagerRound = true;
  showFinalWagerScreen();
  await updateGameState(state.room.id, { game_phase: 'final_wager' });
}

async function handleShowResults() {
  state.gamePhase = 'results';
  showResultsScreen();
  await updateGameState(state.room.id, { game_phase: 'results' });
}

// ============================================
// FINAL WAGER SCREEN
// ============================================

function showFinalWagerScreen() {
  state.isFinalWagerRound = true;

  $('#fw-category').textContent = getCategoryLabel();
  $('#fw-current-score').textContent = state.scores[state.room.playerId] || 0;

  const status = $('#fw-status');
  const revealBtn = $('#btn-fw-reveal');
  const options = document.querySelectorAll('.fw-option');

  // Render player wager list (initial "Waiting..." for all, then fetch actual state)
  renderFinalWagerPlayers();
  updateFinalWagerPlayerList();

  // Option buttons (0 / 10 / 20) — selection is changeable until lock-in
  const lockBtn = $('#btn-fw-lock');
  lockBtn.style.display = 'none';
  options.forEach(btn => {
    btn.classList.remove('fw-option--selected', 'fw-option--locked');
    btn.onclick = () => {
      if (state.finalWagerLocked) return;
      options.forEach(b => b.classList.remove('fw-option--selected'));
      btn.classList.add('fw-option--selected');
      state.finalWager = parseInt(btn.dataset.wager, 10);
      // Show lock-in button (player can change mind until they tap it)
      lockBtn.style.display = '';
    };
  });
  lockBtn.onclick = () => lockInFinalWager();

  if (state.finalWagerLocked) {
    // Already locked in (reconnect)
    status.classList.remove('hidden');
    options.forEach(btn => {
      btn.classList.add('fw-option--locked');
      if (parseInt(btn.dataset.wager, 10) === state.finalWager) {
        btn.classList.add('fw-option--selected');
      }
    });
  } else {
    status.classList.add('hidden');
  }

  // Host/cohost: show reveal button ONLY after they've locked in their own wager
  if (canControlGame()) {
    revealBtn.onclick = handleRevealFinalQuestion;
    if (state.finalWagerLocked) {
      revealBtn.classList.remove('hidden');
    } else {
      revealBtn.classList.add('hidden');
    }
  } else {
    revealBtn.classList.add('hidden');
  }

  // Inline difficulty vote — set up vote buttons
  state.difficultyVotes = {};
  const dvOptions = document.querySelectorAll('#final-wager-screen .dv-option');
  dvOptions.forEach(btn => {
    btn.classList.remove('dv-option--selected');
    btn.onclick = () => {
      dvOptions.forEach(b => b.classList.remove('dv-option--selected'));
      btn.classList.add('dv-option--selected');
      state.difficultyVotes[state.room.playerId] = btn.dataset.difficulty;
      _renderInlineDvTally();
      if (state.difficultyVoteChannel) {
        state.difficultyVoteChannel.send({
          type: 'broadcast', event: 'vote',
          payload: { playerId: state.room.playerId, difficulty: btn.dataset.difficulty }
        });
      }
    };
  });

  // Broadcast channel for difficulty votes
  if (state.difficultyVoteChannel) supabase.removeChannel(state.difficultyVoteChannel);
  state.difficultyVoteChannel = createDifficultyVoteChannel(state.room.id);
  state.difficultyVoteChannel
    .on('broadcast', { event: 'vote' }, ({ payload }) => {
      if (payload?.playerId && payload?.difficulty) {
        state.difficultyVotes[payload.playerId] = payload.difficulty;
        _renderInlineDvTally();
      }
    })
    .subscribe();

  // Show initial tally (empty rows with labels)
  _renderInlineDvTally();

  // Close chat drawer before hiding the bar — prevents the drawer from
  // staying open and covering final wager content
  closeChatDrawer();
  hideChatBar();

  // Transition
  const currentScreen = document.querySelector('.screen.active');
  const fwScreen = $('#final-wager-screen');
  if (currentScreen && currentScreen !== fwScreen && !_screenTransitioning) {
    setScreenTransitioning(true);
    transitionScreens(currentScreen, fwScreen).finally(() => { setScreenTransitioning(false); });
  }

  showHostSettingsGear();
}

async function lockInFinalWager() {
  if (state.finalWagerLocked) return;
  state.finalWagerLocked = true;

  $('#fw-status').classList.remove('hidden');
  document.querySelectorAll('.fw-option').forEach(b => b.classList.add('fw-option--locked'));

  // Host/co-host: now show the reveal button (was hidden until wager locked)
  if (canControlGame()) {
    $('#btn-fw-reveal').classList.remove('hidden');
  }

  // Submit placeholder so others see the wager via Realtime
  const q = state.questions[state.totalQuestions];
  await submitAnswer({
    roomId: state.room.id,
    playerId: state.room.playerId,
    questionNumber: state.totalQuestions,
    questionId: q ? q.id : null,
    wager: state.finalWager,
    submittedAnswer: '__WAGER_LOCKED__',
    isCorrect: false,
    scoreEarned: 0
  });
}

function renderFinalWagerPlayers(lockedWagers) {
  const wagers = lockedWagers || {};
  const sorted = [...state.players].sort((a, b) =>
    (state.scores[b.id] || 0) - (state.scores[a.id] || 0)
  );

  $('#fw-player-list').innerHTML = sorted.map(p => {
    const avatarHtml = renderAvatar({ displayName: p.display_name, avatarColor: p.avatar_color, avatarEmoji: p.avatar_emoji });
    const titleHtml = p.title ? `<span class="player-title">${escapeHtml(p.title)}</span>` : '';
    const score = state.scores[p.id] || 0;
    const wagerVal = wagers[String(p.id)];
    const wagerDisplay = wagerVal !== undefined
      ? `<span class="fw-player-row__wager">${wagerVal}</span>`
      : `<span class="fw-player-row__wager fw-player-row__wager--waiting">Waiting...</span>`;

    const isMe = String(p.id) === String(state.room.playerId);
    const honkBtn = isMe ? '' : `<button class="honk-btn" data-honk-target="${p.id}" aria-label="Quack">&#x1F986;</button>`;

    return `
      <div class="fw-player-row" data-player-id="${p.id}" ${p.user_id ? `data-profile-user-id="${p.user_id}"` : ''}>
        ${avatarHtml}
        <div class="name-stack">
          <span class="fw-player-row__name">${escapeHtml(p.display_name)}</span>
          ${titleHtml}
        </div>
        ${honkBtn}
        <span class="fw-player-row__score">${score}</span>
        ${wagerDisplay}
      </div>
    `;
  }).join('');

  // Wire honk buttons on final wager player list
  $('#fw-player-list').addEventListener('click', (e) => {
    const btn = e.target.closest('.honk-btn');
    if (btn) sendHonk(btn.dataset.honkTarget);
  });
}

async function updateFinalWagerPlayerList() {
  const answers = await fetchAnswersForQuestion(state.room.id, state.totalQuestions);
  const wagers = {};
  for (const a of answers) {
    if (a.submitted_answer === '__WAGER_LOCKED__') {
      wagers[String(a.player_id)] = a.wager;
    }
  }
  renderFinalWagerPlayers(wagers);
}

function _renderInlineDvTally() {
  const screen = document.getElementById('final-wager-screen');
  if (!screen) return;
  const groups = { easy: [], medium: [], hard: [] };
  for (const [pid, diff] of Object.entries(state.difficultyVotes || {})) {
    if (groups[diff]) groups[diff].push(pid);
  }
  for (const diff of ['easy', 'medium', 'hard']) {
    const container = screen.querySelector(`[data-dv-avatars="${diff}"]`);
    if (!container) continue;
    if (groups[diff].length === 0) {
      container.innerHTML = '';
      continue;
    }
    container.innerHTML = groups[diff].map(pid => {
      const p = state.players.find(pl => String(pl.id) === String(pid));
      if (!p) return '';
      const emoji = p.avatar_emoji || p.display_name?.[0]?.toUpperCase() || '?';
      const bg = p.avatar_color || '#78716C';
      return `<span style="display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:${bg};font-size:12px;color:#fff;">${emoji}</span>`;
    }).join('');
  }
}

async function handleRevealFinalQuestion() {
  // Tally inline difficulty votes and try to fetch a matching question
  const tally = { easy: 0, medium: 0, hard: 0 };
  for (const d of Object.values(state.difficultyVotes || {})) {
    if (tally[d] !== undefined) tally[d]++;
  }
  const total = tally.easy + tally.medium + tally.hard;
  const w = total === 0
    ? { easy: 1, medium: 1, hard: 1 }
    : { easy: tally.easy || 0.1, medium: tally.medium || 0.1, hard: tally.hard || 0.1 };
  const wt = w.easy + w.medium + w.hard;
  const r = Math.random() * wt;
  const winner = r < w.easy ? 'easy' : r < w.easy + w.medium ? 'medium' : 'hard';
  state.votedDifficulty = winner;

  // Try to fetch a question matching the voted difficulty (optional — pre-fetched is fallback)
  try {
    const usedIds = state.questions.map(q => q.id);
    const q = await fetchQuestionByDifficulty(state.room.category, winner, usedIds, state.room.subcategory || null);
    if (q) state.questions[state.totalQuestions] = q;
  } catch (e) { /* Use pre-fetched question */ }

  // Clean up vote channel
  if (state.difficultyVoteChannel) { try { supabase.removeChannel(state.difficultyVoteChannel); } catch (e) {} state.difficultyVoteChannel = null; }

  // Advance to final question — apply locally first
  state.isFinalWagerRound = true;
  state.currentQuestion = state.totalQuestions;
  state.gamePhase = 'final_question';
  state.hasSubmitted = false;
  state.onRevealScreen = false;
  state.resultsRevealed = false;
  state.timerExpired = false;
  state.currentAnswers = [];
  state.previousScores = {};
  state.questionStartedAt = null;
  state.currentWager = state.finalWager || 0;
  $('#reveal-answers').innerHTML = '';

  showQuestionScreen();

  // Broadcast to other players — include question_ids so non-host gets the updated question
  const questionIds = state.questions.map(qn => qn.id);
  await updateGameState(state.room.id, {
    game_phase: 'final_question',
    current_question: state.totalQuestions,
    question_ids: questionIds
  });
}

// ============================================
// SCORE EDIT (Host Only)
// ============================================

function showScoreEditSheet() {
  const sheet = $('#score-edit-sheet');
  const listEl = $('#score-edit-question-list');
  const answersEl = $('#score-edit-answers');

  answersEl.style.display = 'none';
  listEl.style.display = '';

  const maxQ = Math.min(state.currentQuestion + 1, state.questions.length);
  listEl.innerHTML = '';
  for (let i = 0; i < maxQ; i++) {
    const q = state.questions[i];
    if (!q) continue;
    const text = getQuestionText(q);
    const truncated = text.length > 50 ? text.slice(0, 50) + '\u2026' : text;
    const row = document.createElement('button');
    row.className = 'score-edit-row';
    row.innerHTML = `<span class="score-edit-row__num">Q${i + 1}</span> <span class="score-edit-row__text">${escapeHtml(truncated)}</span>`;
    row.onclick = () => openScoreEditQuestion(i);
    listEl.appendChild(row);
  }

  $('#score-edit-backdrop').onclick = () => sheet.classList.remove('active');
  sheet.classList.add('active');
}

async function openScoreEditQuestion(questionNumber) {
  const listEl = $('#score-edit-question-list');
  const answersEl = $('#score-edit-answers');

  listEl.style.display = 'none';
  answersEl.style.display = '';
  answersEl.innerHTML = '<p style="text-align:center; color: var(--color-text-muted);">Loading...</p>';

  const answers = await fetchAnswersForQuestion(state.room.id, questionNumber);
  const q = state.questions[questionNumber];

  answersEl.innerHTML = `
    <div style="margin-bottom: var(--space-md);">
      <button class="btn btn-secondary" id="score-edit-back" style="font-size: var(--text-xs); padding: var(--space-xs) var(--space-sm);">&larr; Back</button>
      <strong style="margin-left: var(--space-sm);">Q${questionNumber + 1}: ${escapeHtml(getCorrectAnswer(q))}</strong>
    </div>
  `;

  for (const player of state.players) {
    const answer = answers.find(a => String(a.player_id) === String(player.id));
    if (!answer) continue;

    const isCorrect = answer.is_correct || false;
    const submittedText = (answer.submitted_answer || '').trim();
    const displayText = (!submittedText || submittedText === '__WAGER_LOCKED__') ? 'No answer' : escapeHtml(submittedText);
    const colorClass = isCorrect ? 'answer-row__answer--correct' : 'answer-row__answer--incorrect';

    const row = document.createElement('div');
    row.className = 'answer-row';
    row.dataset.answerId = answer.id;
    row.innerHTML = `
      <div class="answer-row__top">
        ${renderAvatar({ displayName: player.display_name, avatarColor: player.avatar_color, avatarEmoji: player.avatar_emoji })}
        <span class="answer-row__name">${escapeHtml(player.display_name)}</span>
        <span class="answer-row__wager ${isCorrect ? 'answer-row__wager--correct' : 'answer-row__wager--incorrect'}">${answer.wager}</span>
        <div class="answer-toggle ${isCorrect ? 'answer-toggle--correct' : 'answer-toggle--incorrect'} answer-toggle--host" data-answer-id="${answer.id}" data-question-number="${questionNumber}" data-player-name="${escapeHtml(player.display_name)}">
          <div class="answer-toggle__thumb"></div>
        </div>
      </div>
      <div class="answer-row__bottom">
        <span class="answer-row__answer ${colorClass}">${displayText}</span>
      </div>
    `;
    answersEl.appendChild(row);
  }

  $('#score-edit-back').onclick = () => {
    answersEl.style.display = 'none';
    listEl.style.display = '';
  };

  answersEl.onclick = async (e) => {
    const toggle = e.target.closest('.answer-toggle--host');
    if (!toggle) return;

    const answerId = toggle.dataset.answerId;
    const qNum = parseInt(toggle.dataset.questionNumber, 10);
    const playerName = toggle.dataset.playerName;
    const answer = answers.find(a => String(a.id) === String(answerId));
    if (!answer) return;

    const newCorrect = !answer.is_correct;
    const isFinal = qNum >= state.totalQuestions;
    const newScore = newCorrect ? answer.wager : (isFinal ? -answer.wager : 0);

    answer.is_correct = newCorrect;
    answer.score_earned = newScore;

    await updateAnswerJudgment(answerId, newCorrect, newScore);

    // Update mastery for the affected player
    const player = state.players.find(p => String(p.id) === String(answer.player_id));
    if (player?.user_id && answer.question_id) {
      upsertQuestionHistory(player.user_id, answer.question_id, newCorrect);
    }

    await updateScores();
    openScoreEditQuestion(qNum);
    setLastScoresRendered(-1);
    showScoresScreen();

    const sign = newScore >= 0 ? '+' : '';
    await sendMessage(state.room.id, 'System',
      `Host changed Q${qNum + 1}: ${playerName} marked ${newCorrect ? 'correct' : 'incorrect'} (${sign}${newScore} points)`
    );
  };
}

// ============================================
// (Difficulty vote is now inline on the final wager screen)

// ============================================
// RESULTS SCREEN
// ============================================

// (Dead difficulty vote code removed — vote is now inline on final wager screen)


async function showResultsScreen() {
  if (state.timerId) {
    clearInterval(state.timerId);
    state.timerId = null;
  }
  state.onRevealScreen = false;

  await updateScores();

  // Mark game play as completed (fire-and-forget, guard against re-entry)
  if (!state._gamePlayCompleted) {
    state._gamePlayCompleted = true;
    completeGamePlay({
      roomId: state.room.id,
      playerId: state.room.playerId,
      finalScore: state.scores[state.room.playerId] || 0
    });
    // Archive chat messages before room might be deleted
    await archiveChatMessages(state.room.id);

    // Write game_history and evaluate title unlocks for authenticated users.
    // player_stats is now a computed view — no manual writes needed.
    // Stats are derived automatically from question_history + game_history.
    const authUser = getCurrentUser();
    if (authUser) {
      const uid = authUser.user.id;
      const cat = state.room.category;
      const allAnswers = await fetchAllAnswers(state.room.id);
      const myAnswers = allAnswers.filter(a => String(a.player_id) === String(state.room.playerId));
      // Exclude disqualified questions from stats
      const validAnswers = myAnswers.filter(a => !state.disqualifiedQuestions.has(a.question_number));
      const correctCount = validAnswers.filter(a => a.is_correct).length;
      const totalAnswered = validAnswers.length;
      const sortedForPlacement = [...state.players].sort((a, b) => (state.scores[b.id] || 0) - (state.scores[a.id] || 0));
      const placement = sortedForPlacement.findIndex(p => String(p.id) === String(state.room.playerId)) + 1;
      const sub = state.room.subcategory || null;
      // Fire-and-forget — don't block results rendering
      insertGameHistoryEntry({
        userId: uid, roomId: state.room.id, category: cat,
        subcategory: sub,
        score: state.scores[state.room.playerId] || 0,
        placement, totalPlayers: state.players.length
      });
      // Per-question mastery is written in real-time during doReveal().

      // Title system: evaluate unlocks from computed stats
      fetchPlayerStats(uid).then(async freshStats => {
        const unlocks = await fetchTitleUnlocks(uid);
        const context = {
          hour: new Date().getHours(),
          perfectGame: correctCount === totalAnswered && totalAnswered > 0
        };
        const newUnlocks = evaluateUnlocks(freshStats, authUser.profile, unlocks, context);
        for (const u of newUnlocks) {
          await upsertTitleUnlock(uid, u.wordId, u.level);
        }
        // Check if Title Builder should unlock (first Apprentice)
        if (!authUser.profile.title_builder_unlocked && hasReachedApprentice(freshStats)) {
          await supabase.from('profiles').update({ title_builder_unlocked: true }).eq('user_id', uid);
        }
        // (Phase 4 will add celebration display here)
        if (newUnlocks.length > 0) {
          logger.debug('Titles', 'New unlocks', newUnlocks.map(u => u.word + ' L' + u.level));
        }
      }).catch(err => logger.warn('Titles', 'Evaluation failed', err));
    }
  }

  // Room session cumulative scores (for lobby leaderboard)
  // Guard: only write once per game to prevent score doubling on re-render
  if (!state._cumulativeScoresWritten) {
    state._cumulativeScoresWritten = true;
    const roomScoresKey = `oracle_party_room_scores_${state.room.id}`;
    const cumulative = JSON.parse(sessionStorage.getItem(roomScoresKey) || '{}');
    for (const p of state.players) {
      cumulative[p.display_name] = (cumulative[p.display_name] || 0) + (state.scores[p.id] || 0);
    }
    sessionStorage.setItem(roomScoresKey, JSON.stringify(cumulative));
  }

  $('#results-category').textContent = getCategoryLabel();

  // Sort players by final score
  const sorted = [...state.players].sort((a, b) =>
    (state.scores[b.id] || 0) - (state.scores[a.id] || 0)
  );

  // Get final wager deltas
  const allAnswers = await fetchAllAnswers(state.room.id);
  const fwAnswers = allAnswers.filter(a => a.question_number === state.totalQuestions);

  // Winner celebration
  const winner = sorted[0];
  if (winner) {
    const winnerAvatar = renderAvatar({ displayName: winner.display_name, avatarColor: winner.avatar_color, avatarEmoji: winner.avatar_emoji, size: '48px' });
    $('#results-winner').innerHTML = `
      <div class="results-winner__badge">🏆</div>
      ${winnerAvatar}
      <div class="results-winner__name">${escapeHtml(winner.display_name)}</div>
      <div class="results-winner__score">${state.scores[winner.id] || 0} points</div>
    `;
  }

  // Scoreboard
  const PLACE_LABELS = ['1st', '2nd', '3rd'];
  $('#results-list').innerHTML = sorted.map((p, i) => {
    const fwAnswer = fwAnswers.find(a => String(a.player_id) === String(p.id));
    const fwDelta = fwAnswer ? fwAnswer.score_earned : 0;
    const fwSign = fwDelta > 0 ? '+' : '';
    const fwClass = fwDelta > 0 ? 'score-anim-row__delta--positive' :
                    fwDelta < 0 ? 'score-anim-row__delta--negative' :
                    'score-anim-row__delta--zero';
    const avatarHtml = renderAvatar({ displayName: p.display_name, avatarColor: p.avatar_color, avatarEmoji: p.avatar_emoji });
    const titleHtml = p.title ? `<span class="player-title">${escapeHtml(p.title)}</span>` : '';
    const placeLabel = PLACE_LABELS[i] || `${i + 1}th`;
    const placeClass = i < 3 ? `results-row__place--${PLACE_LABELS[i]}` : '';

    const isMe = String(p.id) === String(state.room.playerId);
    const honks = getHonkCount(p.id);
    const honkBadge = `<span class="honk-badge" data-honk-player="${p.id}" style="${honks > 0 ? '' : 'display:none'}">${honks}</span>`;
    const honkBtn = isMe ? '' : `<button class="honk-btn" data-honk-target="${p.id}" aria-label="Quack">&#x1F986;</button>`;

    return `
      <div class="results-row" data-player-id="${p.id}" ${p.user_id ? `data-profile-user-id="${p.user_id}"` : ''}>
        <span class="results-row__place ${placeClass}">${placeLabel}</span>
        <div class="avatar-wrap">
          ${avatarHtml}
          ${honkBadge}
        </div>
        <div class="name-stack">
          <span class="results-row__name">${escapeHtml(p.display_name)}${p.is_host ? ' <span class="badge badge--host">Host</span>' : ''}</span>
          ${titleHtml}
        </div>
        ${honkBtn}
        <span class="results-row__fw-delta ${fwClass}">${fwSign}${fwDelta}</span>
        <span class="results-row__score">${state.scores[p.id] || 0}</span>
      </div>
    `;
  }).join('');


  const currentScreen = document.querySelector('.screen.active');
  const resultsScreen = $('#results-screen');
  if (currentScreen && currentScreen !== resultsScreen) {
    transitionScreens(currentScreen, resultsScreen).then(showChatBar);
  } else {
    showChatBar();
  }

  showHostSettingsGear();

  // Button handlers
  $('#btn-play-again').onclick = handlePlayAgain;
  $('#btn-quit-game').onclick = handleQuitGame;
  $('#btn-review-questions').onclick = handleReviewQuestions;

  // Mastery gained — show for logged-in players
  const authUser = getCurrentUser();
  if (authUser) {
    const myCorrect = allAnswers.filter(a =>
      String(a.player_id) === String(state.room.playerId) && a.is_correct &&
      a.submitted_answer && a.submitted_answer !== '__WAGER_LOCKED__'
    );
    if (myCorrect.length > 0) {
      const masteryEl = document.createElement('div');
      masteryEl.className = 'results-mastery';
      masteryEl.innerHTML = `
        <div class="results-mastery__summary">\u2B50 Mastered ${myCorrect.length} question${myCorrect.length > 1 ? 's' : ''}</div>
        <div class="results-mastery__detail" style="display:none;">
          ${myCorrect.map(a => {
            const q = state.questions.find(qu => qu.id === a.question_id);
            const qText = q ? getQuestionText(q) : 'Unknown question';
            const aText = q ? getCorrectAnswer(q) : a.submitted_answer;
            return `<div class="results-mastery__item"><span class="results-mastery__q">${escapeHtml(qText)}</span><span class="results-mastery__a">${escapeHtml(aText)}</span></div>`;
          }).join('')}
        </div>
      `;
      masteryEl.querySelector('.results-mastery__summary').onclick = () => {
        const detail = masteryEl.querySelector('.results-mastery__detail');
        detail.style.display = detail.style.display === 'none' ? '' : 'none';
      };
      // Remove any existing mastery element (prevents duplicates on re-render)
      document.querySelector('.results-mastery')?.remove();
      $('#results-list')?.after(masteryEl);
    }
  }

  // Guest sign-up nudges — personalized with actual session data
  if (!getCurrentUser() && !state._guestNudgeProcessed) {
    state._guestNudgeProcessed = true;

    const count = parseInt(localStorage.getItem('oracle_party_guest_games') || '0');
    localStorage.setItem('oracle_party_guest_games', String(count + 1));
    const gamesPlayed = count + 1;
    const resultsList = $('#results-list');

    // Compute personalized stats for the nudge
    const guestAnswers = allAnswers.filter(a => String(a.player_id) === String(state.room.playerId));
    const guestCorrect = guestAnswers.filter(a => a.is_correct).length;
    const guestTotal = guestAnswers.length;
    const guestAccuracy = guestTotal > 0 ? Math.round((guestCorrect / guestTotal) * 100) : 0;
    const guestScore = state.scores[state.room.playerId] || 0;
    const categoryLabel = CATEGORY_META[state.room.category]?.label || state.room.category;
    const isWinner = winner && String(winner.id) === String(state.room.playerId);

    // Rotating perks — pick a different benefit each nudge
    const personalizedPerk = {
      text: `Your stats from this game will be lost.`,
      stats: `${gamesPlayed} games played \u00B7 ${guestScore} points \u00B7 ${guestAccuracy}% accuracy in ${escapeHtml(categoryLabel)}`,
      isPersonalized: true
    };
    const genericPerks = [
      { text: 'Unlock OLED Black mode and more themes.' },
      { text: 'Save your stats and earn Oracle titles.' },
      { text: 'Add friends and see who\u2019s online.' },
      { text: 'Track your mastery across thousands of questions.' },
      { text: 'Customize your avatar with colors and emoji.' },
      { text: 'Compete on leaderboards.' }
    ];
    function pickPerk() {
      const lastPerk = sessionStorage.getItem('oracle_party_last_nudge_perk') || '';
      const nudgeCount = parseInt(sessionStorage.getItem('oracle_party_nudge_count') || '0');
      sessionStorage.setItem('oracle_party_nudge_count', String(nudgeCount + 1));
      // Guarantee personalized stats perk in first 3 nudges
      if (nudgeCount < 3 && nudgeCount === 0) {
        sessionStorage.setItem('oracle_party_last_nudge_perk', 'personalized');
        return personalizedPerk;
      }
      // Pick from generic pool, avoid repeating last shown
      const pool = genericPerks.filter(p => p.text !== lastPerk);
      const pick = pool[Math.floor(Math.random() * pool.length)];
      sessionStorage.setItem('oracle_party_last_nudge_perk', pick.text);
      return pick;
    }

    // Winner nudge — highest conversion moment (guest just won!)
    if (isWinner && !sessionStorage.getItem('oracle_party_winner_nudge_shown')) {
      sessionStorage.setItem('oracle_party_winner_nudge_shown', '1');
      const nudge = document.createElement('div');
      nudge.className = 'signup-nudge';
      nudge.innerHTML = `
        <p class="signup-nudge__text">\u{1F3C6} You won! Save your victory.</p>
        <p class="signup-nudge__stats">${guestScore} points \u00B7 ${guestAccuracy}% accuracy in ${escapeHtml(categoryLabel)}</p>
        <button class="btn btn-primary btn-block" id="nudge-signup-win">Create Account</button>
        <button class="signup-nudge__dismiss" id="nudge-dismiss-win">Maybe later</button>
      `;
      resultsList.parentNode.insertBefore(nudge, resultsList.nextSibling);
      $('#nudge-signup-win').onclick = async () => { await showSignUpModal(); if (getCurrentUser()) window.location.reload(); };
      $('#nudge-dismiss-win').onclick = () => nudge.remove();
    }
    // First-game nudge (once per session — personalized stats, strongest hook)
    else if (!sessionStorage.getItem('oracle_party_signup_nudge_shown')) {
      sessionStorage.setItem('oracle_party_signup_nudge_shown', '1');
      const perk = pickPerk();
      const nudge = document.createElement('div');
      nudge.className = 'signup-nudge';
      nudge.innerHTML = `
        <p class="signup-nudge__text">${perk.text}</p>
        ${perk.stats ? `<p class="signup-nudge__stats">${perk.stats}</p>` : ''}
        <button class="btn btn-primary btn-block" id="nudge-signup">Create Account</button>
        <button class="signup-nudge__dismiss" id="nudge-dismiss">Maybe later</button>
      `;
      resultsList.parentNode.insertBefore(nudge, resultsList.nextSibling);
      $('#nudge-signup').onclick = async () => { await showSignUpModal(); if (getCurrentUser()) window.location.reload(); };
      $('#nudge-dismiss').onclick = () => nudge.remove();
    }
    // Subsequent nudges (rotating perks)
    else if (gamesPlayed >= 3 && !localStorage.getItem('oracle_party_3game_nudge_dismissed')) {
      const perk = pickPerk();
      const nudge = document.createElement('div');
      nudge.className = 'signup-nudge';
      nudge.innerHTML = `
        <p class="signup-nudge__text">${perk.text}</p>
        ${perk.stats ? `<p class="signup-nudge__stats">${perk.stats}</p>` : ''}
        <button class="btn btn-primary btn-block" id="nudge-signup-3">Create Account</button>
        <button class="signup-nudge__dismiss" id="nudge-dismiss-3">Maybe later</button>
      `;
      resultsList.parentNode.insertBefore(nudge, resultsList.nextSibling);
      $('#nudge-signup-3').onclick = async () => { await showSignUpModal(); if (getCurrentUser()) window.location.reload(); };
      $('#nudge-dismiss-3').onclick = () => { nudge.remove(); localStorage.setItem('oracle_party_3game_nudge_dismissed', '1'); };
    }
  }
}

async function handlePlayAgain() {
  setIsLeaving(true); // Player stays in room — prevent handleUnload from removing
  try { cleanup(); } catch (_) { /* Don't let cleanup errors block navigation */ }

  // Only the host resets the room status to 'lobby'.
  // Non-host players just navigate directly — they don't broadcast a status change
  // that would force ALL players out of the results screen.
  if (state.room?.isHost) {
    try {
      await Promise.all([
        deleteAnswersByRoom(state.room.id),
        updateGameState(state.room.id, {
          game_phase: 'lobby',
          current_question: 0,
          question_ids: [],
          question_started_at: null,
          countdown_started_at: null
        }),
        updateRoomStatus(state.room.id, 'lobby')
      ]);
    } catch (err) {
      logger.error('Game', 'handlePlayAgain host cleanup failed', err);
      showToast('Error resetting room — retrying...', 'error');
    }
  }

  sessionStorage.setItem('oracle_party_returning_from_game', '1');
  navigateWithFadeReplace('lobby.html');
}

async function handleQuitGame() {
  setIsLeaving(true);
  try { cleanup(); } catch (_) { /* Don't let cleanup errors block navigation */ }
  try {
    if (state.players.length <= 1) {
      await deleteRoom(state.room?.id);
    } else {
      await removePlayer(state.room?.playerId);
    }
  } catch (err) {
    logger.error('Game', 'handleQuitGame DB cleanup failed', err);
  }
  sessionStorage.removeItem('oracle_party_room');
  navigateWithFade('index.html');
}

async function handleReviewQuestions() {
  const overlay = $('#review-overlay');
  const list = $('#review-list');

  // Fetch player answers for the game
  const allAnswers = await fetchAllAnswers(state.room.id);
  const myAnswers = allAnswers.filter(a => a.player_id === state.room.playerId);

  // Build lookup: question_number → answer record
  const answerByQ = {};
  for (const a of myAnswers) {
    if (a.submitted_answer && a.submitted_answer !== '__WAGER_LOCKED__') {
      answerByQ[a.question_number] = a;
    }
  }

  // Always fetch latest feedback from DB (merges with any in-memory state)
  const ratings = await fetchQuestionFeedback(state.room.id, getDisplayName());
  for (const r of ratings) _qbFeedback[r.question_id] = r.feedback_type;

  // Build question list (all regular + final wager question)
  const totalQ = Math.min(state.questions.length, state.totalQuestions + 1);
  list.innerHTML = '';

  for (let i = 0; i < totalQ; i++) {
    const q = state.questions[i];
    if (!q) continue;

    const isFinal = i === state.totalQuestions;
    const label = isFinal ? 'Final Question' : `Question ${i + 1}`;
    const myAnswer = answerByQ[i];
    const existing = _qbFeedback[q.id] || null;

    let playerAnswerHtml = '';
    if (myAnswer) {
      const correctClass = myAnswer.is_correct
        ? 'review-item__player-answer--correct'
        : 'review-item__player-answer--incorrect';
      playerAnswerHtml = `<div class="review-item__player-answer ${correctClass}">${escapeHtml(myAnswer.submitted_answer)}</div>`;
    }

    // Host: show ALL player answers with toggle switches for score correction
    let hostAnswersHtml = '';
    if (canControlGame()) {
      const qAnswers = allAnswers.filter(a => a.question_number === i && a.submitted_answer && a.submitted_answer !== '__WAGER_LOCKED__');
      if (qAnswers.length > 0) {
        const isFinalWager = i === state.totalQuestions;
        hostAnswersHtml = '<div class="review-item__answers">' + qAnswers.map(a => {
          const player = state.players.find(p => p.id === a.player_id);
          const name = player ? escapeHtml(player.display_name) : 'Unknown';
          const isCorrect = a.is_correct || false;
          const toggleClass = isCorrect ? 'answer-toggle--correct' : 'answer-toggle--incorrect';
          const answerClass = isCorrect ? 'review-item__player-answer--correct' : 'review-item__player-answer--incorrect';
          return `<div class="review-answer-row" data-answer-id="${a.id}" data-question-idx="${i}" data-is-final="${isFinalWager}">
            <span class="review-answer-row__name">${name}</span>
            <span class="review-answer-row__text ${answerClass}">${escapeHtml(a.submitted_answer)}</span>
            <div class="answer-toggle ${toggleClass} answer-toggle--host" data-answer-id="${a.id}">
              <div class="answer-toggle__thumb"></div>
            </div>
          </div>`;
        }).join('') + '</div>';
      }
    }

    const item = document.createElement('div');
    const isFlagged = existing === 'thumbs_down' || existing === 'flag';
    item.className = 'review-item' + (isFlagged ? ' review-item--flagged' : '');
    item.innerHTML = `
      <div class="review-item__num">${label}</div>
      <div class="review-item__q">${escapeHtml(getQuestionText(q))}</div>
      <div class="review-item__a">${escapeHtml(getCorrectAnswer(q))}</div>
      ${canControlGame() ? hostAnswersHtml : playerAnswerHtml}
      <div class="review-item__feedback">
        <button class="feedback-btn${existing === 'thumbs_up' ? ' feedback-btn--active' : ''}" data-type="thumbs_up" data-qid="${q.id}" aria-label="Thumbs up">👍</button>
        <button class="feedback-btn${existing === 'thumbs_down' ? ' feedback-btn--active' : ''}" data-type="thumbs_down" data-qid="${q.id}" aria-label="Thumbs down">👎</button>
        <button class="feedback-btn${existing === 'flag' ? ' feedback-btn--active' : ''}" data-type="flag" data-qid="${q.id}" aria-label="Flag">🚩</button>
      </div>
    `;
    list.appendChild(item);
  }

  // Attach feedback handlers (synced with _qbFeedback)
  list.querySelectorAll('.feedback-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const type = btn.dataset.type;
      const qid = btn.dataset.qid;

      const reviewItem = btn.closest('.review-item');

      if (type === 'flag') {
        const wasActive = btn.classList.contains('feedback-btn--active');
        btn.classList.toggle('feedback-btn--active');
        if (!wasActive) {
          _qbFeedback[qid] = 'flag';
          upsertQuestionFeedback({
            questionId: qid,
            roomId: state.room.id,
            playerName: getDisplayName(),
            feedbackType: 'flag',
            flagReason: 'other'
          });
        } else {
          _qbFeedback[qid] = null;
          deleteQuestionFeedback({ questionId: qid, roomId: state.room.id, playerName: getDisplayName() });
        }
        // Update flagged highlight
        const fb = _qbFeedback[qid];
        reviewItem.classList.toggle('review-item--flagged', fb === 'flag' || fb === 'thumbs_down');
        return;
      }

      // Thumbs up/down toggle
      const otherType = type === 'thumbs_up' ? 'thumbs_down' : 'thumbs_up';
      const siblings = btn.parentElement.querySelectorAll('.feedback-btn');
      siblings.forEach(s => {
        if (s.dataset.type === otherType) s.classList.remove('feedback-btn--active');
      });
      btn.classList.toggle('feedback-btn--active');

      if (btn.classList.contains('feedback-btn--active')) {
        _qbFeedback[qid] = type;
        upsertQuestionFeedback({
          questionId: qid,
          roomId: state.room.id,
          playerName: getDisplayName(),
          feedbackType: type,
          flagReason: null
        });
      } else {
        _qbFeedback[qid] = null;
        deleteQuestionFeedback({ questionId: qid, roomId: state.room.id, playerName: getDisplayName() });
      }
      // Update flagged highlight
      const fb = _qbFeedback[qid];
      reviewItem.classList.toggle('review-item--flagged', fb === 'flag' || fb === 'thumbs_down');
    });
  });

  // Host/co-host: wire toggle handlers for score correction
  if (canControlGame()) {
    list.querySelectorAll('.answer-toggle--host').forEach(toggle => {
      toggle.addEventListener('click', async (e) => {
        e.stopPropagation();
        const answerId = toggle.dataset.answerId;
        const answer = allAnswers.find(a => String(a.id) === String(answerId));
        if (!answer) return;
        const row = toggle.closest('.review-answer-row');
        const isFinalWager = row?.dataset.isFinal === 'true';

        const newCorrect = !answer.is_correct;
        const newScore = newCorrect ? answer.wager : (isFinalWager ? -answer.wager : 0);

        // Update local state
        answer.is_correct = newCorrect;
        answer.score_earned = newScore;

        // Update toggle visual
        toggle.classList.toggle('answer-toggle--correct', newCorrect);
        toggle.classList.toggle('answer-toggle--incorrect', !newCorrect);

        // Update answer text color
        const textEl = row?.querySelector('.review-answer-row__text');
        if (textEl) {
          textEl.classList.toggle('review-item__player-answer--correct', newCorrect);
          textEl.classList.toggle('review-item__player-answer--incorrect', !newCorrect);
        }

        // Persist to DB then re-render results behind the overlay
        await updateAnswerJudgment(answerId, newCorrect, newScore);

        // Update mastery for the affected player
        const player = state.players.find(p => String(p.id) === String(answer.player_id));
        if (player?.user_id && answer.question_id) {
          upsertQuestionHistory(player.user_id, answer.question_id, newCorrect);
        }

        showResultsScreen();
      });
    });
  }

  overlay.classList.add('active');

  $('#btn-close-review').onclick = () => {
    overlay.classList.remove('active');
  };
}



// ============================================
// SCORES
// ============================================

async function updateScores() {
  const allAnswers = await fetchAllAnswers(state.room.id);
  state.scores = {};
  for (const p of state.players) {
    state.scores[p.id] = 0;
  }
  for (const a of allAnswers) {
    state.scores[a.player_id] = (state.scores[a.player_id] || 0) + (a.score_earned || 0);
  }
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

// _qbFeedback imported from game/state.js

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
init();
