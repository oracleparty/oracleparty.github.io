// ============================================
// Oracle Party — Game
// Gameplay loop: question (with wager) → submit → reveal (live) → repeat
// ============================================

import { $, transitionScreens, escapeHtml, fuzzyMatch, getAvatarHue } from './utils.js';
import {
  addPlayer,
  fetchPlayers,
  fetchQuestionsByCategory,
  fetchQuestionsByIds,
  updateGameState,
  submitAnswer,
  fetchAnswersForQuestion,
  updateAnswerJudgment,
  fetchAllAnswers,
  fetchRoom,
  fetchMessages,
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
  upsertQuestionFeedback,
  deleteQuestionFeedback,
  fetchQuestionFeedback,
  insertGamePlay,
  incrementQuestionsAnswered,
  completeGamePlay,
  archiveChatMessages,
  deleteAnswersByRoom,
  reassignPlayerAnswers
} from './supabase.js';
import { getDisplayName, ensureDisplayName } from './auth.js';
import { initHonkSystem, sendHonk, getHonkCount, destroyHonkSystem } from './honk.js';

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
const state = {
  room: null,
  players: [],
  questions: [],
  currentQuestion: 0,
  gamePhase: 'loading',
  totalQuestions: 0,
  timerSeconds: 30,
  usedWagers: new Set(),
  currentWager: null,
  hasSubmitted: false,
  onRevealScreen: false,
  resultsRevealed: false,
  timerExpired: false,
  scores: {},
  previousScores: {},   // scores before current round (for animation delta)
  currentAnswers: [],   // cached answers for current question (avoids re-fetch)
  timerId: null,
  channels: [],
  chatOpen: false,
  serverTimeOffset: 0,  // serverTime - clientTime in ms
  questionStartedAt: null, // ISO timestamp from DB — single source of truth for timer
  presenceChannel: null,
  presenceReady: false,
  awayTimestamps: new Map(), // player ID → Date.now() when first seen as away
  feedbackFadeTimer: null,
  isFinalWagerRound: false,
  finalWager: 10,
  finalWagerLocked: false,
  countdownStartedAt: null,
  _lastProcessedQuestion: -1,
  stalePollId: null,
  presenceHeartbeatId: null,
  shownQuestionIndices: [],
  wagerExplicitlySelected: false,
  chatEchoPending: 0,
  unreadCount: 0,
  _hotJoinPollId: null,
  _gamePlayCompleted: false,
  _syncIntervalId: null
};

// Stored handler for document click (flag menu dismiss) — removed in cleanup()
let _flagMenuCloseHandler = null;

// Guard: prevent duplicate scores screen rendering
let _lastScoresRenderedForQuestion = -1;

// Guard: prevent double player removal on unload after explicit leave/quit
let _isLeaving = false;

// Guard: countdown active — defer phase transitions until complete
let _countdownActive = false;
let _deferredPhase = null;

// Guard: prevent overlapping screen transitions (causes flash/blink)
let _screenTransitioning = false;

// --- Question field name resolution ---
let FIELD_MAP = null;

function resolveFieldMap(question) {
  if (FIELD_MAP) return;
  FIELD_MAP = {
    text: question.question_text !== undefined ? 'question_text'
        : question.question !== undefined ? 'question'
        : question.text !== undefined ? 'text'
        : 'question_text',
    correct: question.correct_answer !== undefined ? 'correct_answer'
           : question.answer !== undefined ? 'answer'
           : 'correct_answer',
    alternates: question.acceptable_answers !== undefined ? 'acceptable_answers'
              : question.acceptable_alternates !== undefined ? 'acceptable_alternates'
              : question.alternates !== undefined ? 'alternates'
              : 'acceptable_answers',
    difficulty: question.difficulty !== undefined ? 'difficulty' : 'difficulty'
  };
}

function getQuestionText(q) { return q[FIELD_MAP.text] || ''; }
function getCorrectAnswer(q) { return q[FIELD_MAP.correct] || ''; }
function getAlternates(q) { return q[FIELD_MAP.alternates] || []; }
function getDifficulty(q) { return q[FIELD_MAP.difficulty] || 'medium'; }

// ============================================
// INIT
// ============================================

async function init() {
  // Load room data synchronously so back button works even during init
  const stored = sessionStorage.getItem('oracle_party_room');
  if (!stored) {
    window.location.href = 'index.html';
    return;
  }

  state.room = JSON.parse(stored);
  state.totalQuestions = state.room.settings?.questionsPerGame || 10;
  state.timerSeconds = state.room.settings?.questionTimer || 30;

  // Set up back button handler IMMEDIATELY (before any async work)
  // so pressing back always goes to index.html, even during slow init
  history.replaceState({ inGame: true }, '');
  history.pushState({ inGame: true }, '');
  window.addEventListener('popstate', handleBackButton);
  // Safari bfcache: if this page is restored from cache after navigating away, go home
  window.addEventListener('pageshow', (e) => { if (e.persisted) { cleanup(); window.location.href = 'index.html'; } });

  await ensureDisplayName();

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
      const { data: rejoinedPlayer } = await addPlayer(state.room.id, displayName, state.room.isHost);
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
          if (a.wager) state.usedWagers.add(a.wager);
        }
      }
    }
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
  }, 15000);

  // Poll for stale disconnected players (auto-kick after 5 min)
  state.stalePollId = setInterval(checkStalePresence, 10000);

  // Periodic sync to catch missed Realtime messages after brief disconnections
  state._syncIntervalId = setInterval(syncToCurrentState, 30000);

  loadChatMessages();
  attachChatListeners();
  initFeedbackListeners();

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

  if (state.room.isHost) {
    await initHostGame();
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

    // Rebuild used wagers from existing answers
    const allAnswers = await fetchAllAnswers(state.room.id);
    const myAnswers = allAnswers.filter(a => a.player_id === state.room.playerId);
    for (const a of myAnswers) {
      state.usedWagers.add(a.wager);
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

  // Fetch totalQuestions + 1 (extra for final wager round)
  const questions = await fetchQuestionsByCategory(state.room.category, state.totalQuestions + 1);

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
    await new Promise(r => setTimeout(r, 500));
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
    }, 3000);
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

  // Rebuild used wagers from existing answers
  const allAnswers = await fetchAllAnswers(state.room.id);
  const myAnswers = allAnswers.filter(a => a.player_id === state.room.playerId);
  for (const a of myAnswers) {
    state.usedWagers.add(a.wager);
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
    // Check local state for is_host BEFORE removing (payload.old may only have id
    // if table REPLICA IDENTITY is not FULL)
    const deletedId = String(payload.old.id);
    const localPlayer = state.players.find(p => String(p.id) === deletedId);
    const wasHost = localPlayer ? localPlayer.is_host : payload.old.is_host;

    // Remove player from local state
    state.players = state.players.filter(p => String(p.id) !== deletedId);
    delete state.scores[deletedId];

    // If room is now empty, delete it (cleanup zombie rooms)
    if (state.players.length === 0) {
      await deleteRoom(state.room.id);
      // handleRoomChange DELETE will fire and redirect everyone
      return;
    }

    // If the deleted player was the host, promote next player
    if (wasHost) {
      const sorted = [...state.players].sort((a, b) => {
        const ta = a.joined_at ? new Date(a.joined_at) : Infinity;
        const tb = b.joined_at ? new Date(b.joined_at) : Infinity;
        return ta - tb;
      });
      const nextHost = sorted[0];

      if (String(nextHost.id) === String(state.room.playerId)) {
        state.room.isHost = true;
        sessionStorage.setItem('oracle_party_room', JSON.stringify(state.room));
        // Update local player state immediately so host badge renders
        const localIdx = state.players.findIndex(p => String(p.id) === String(state.room.playerId));
        if (localIdx !== -1) state.players[localIdx].is_host = true;
        await promoteToHost(state.room.id, state.room.playerId, getDisplayName());
        // Re-render current phase to show host controls
        handlePhaseTransition(state.gamePhase);
      }
    }
  } else if (event === 'UPDATE' && payload.new) {
    const idx = state.players.findIndex(p => String(p.id) === String(payload.new.id));
    if (idx !== -1) {
      state.players[idx] = payload.new;
    }
  } else if (event === 'INSERT' && payload.new) {
    if (!state.players.some(p => String(p.id) === String(payload.new.id))) {
      state.players.push(payload.new);
      if (!state.scores[payload.new.id]) state.scores[payload.new.id] = 0;
    }
  }
}

// ============================================
// ROOM CHANGE HANDLER
// ============================================

function handleRoomChange(payload) {
  // Room deleted (last player left) — kick to home
  if (payload.eventType === 'DELETE') {
    _isLeaving = true; // Room already gone — prevent handleUnload beacon
    cleanup();
    sessionStorage.removeItem('oracle_party_room');
    window.location.href = 'index.html';
    return;
  }

  if (!payload.new) return;
  const { game_phase, current_question, question_ids, question_started_at, countdown_started_at, status } = payload.new;

  // Host returned everyone to lobby
  if (status === 'lobby') {
    _isLeaving = true; // Transitioning to lobby — prevent handleUnload beacon
    cleanup();
    window.location.href = 'lobby.html';
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

  if (!state.room.isHost && state.questions.length === 0 && question_ids && question_ids.length > 0) {
    // Clear hot-join fallback poll if running — Realtime delivered the data first
    if (state._hotJoinPollId) {
      clearInterval(state._hotJoinPollId);
      state._hotJoinPollId = null;
    }
    state.totalQuestions = Math.max(1, question_ids.length - 1);
    fetchQuestionsByIds(question_ids).then(async qs => {
      state.questions = qs;
      if (qs.length > 0) resolveFieldMap(qs[0]);
      await updateScores();
      if (game_phase) handlePhaseTransition(game_phase);
    });
    return;
  }

  if (current_question !== undefined) {
    state.currentQuestion = current_question;
  }

  if (game_phase) handlePhaseTransition(game_phase);
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
  $('#answer-input').focus();
}

async function handlePhaseTransition(phase) {
  if (!phase) return; // guard against null/undefined game_phase

  // During countdown, defer other phase transitions until countdown completes
  if (_countdownActive && phase !== 'countdown') {
    _deferredPhase = phase;
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
      _lastScoresRenderedForQuestion = -1;
      state._gamePlayCompleted = false;
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
      // Auto-select lowest available wager if none was explicitly selected
      if (!state.wagerExplicitlySelected && !state.isFinalWagerRound) {
        let found = false;
        for (let i = 1; i <= state.totalQuestions; i++) {
          if (!state.usedWagers.has(i)) { state.currentWager = i; found = true; break; }
        }
        if (!found) state.currentWager = state.currentQuestion + 1;
      }
      if (!state.hasSubmitted) {
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
      // Auto-select lowest available wager if none was explicitly selected
      if (!state.wagerExplicitlySelected && !state.isFinalWagerRound) {
        let found = false;
        for (let i = 1; i <= state.totalQuestions; i++) {
          if (!state.usedWagers.has(i)) { state.currentWager = i; found = true; break; }
        }
        if (!found) state.currentWager = state.currentQuestion + 1;
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
    case 'final_question':
      state.isFinalWagerRound = true;
      // Reset for the final question round (same resets as 'question' phase)
      state.currentWager = state.finalWager;
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
  _countdownActive = true;
  _deferredPhase = null;

  const currentScreen = document.querySelector('.screen.active');
  const countdownScreen = $('#countdown-screen');
  if (currentScreen && currentScreen !== countdownScreen) {
    transitionScreens(currentScreen, countdownScreen, 300);
  } else {
    countdownScreen.style.display = '';
    void countdownScreen.offsetHeight;
    countdownScreen.classList.add('active');
  }

  const steps = ['3', '2', '1', 'GO!'];
  const DELAY_MS = 500;  // Brief pause before "3" so everyone sees the countdown screen
  const STEP_MS = 900;   // Time each number stays on screen
  const TOTAL_MS = DELAY_MS + (steps.length * STEP_MS); // 4100ms
  let lastShownStep = -1;

  function getElapsedMs() {
    if (!state.countdownStartedAt) return 0;
    const startMs = new Date(state.countdownStartedAt).getTime();
    const nowServerMs = Date.now() + state.serverTimeOffset;
    return nowServerMs - startMs;
  }

  function finishCountdown() {
    _countdownActive = false;

    // Host advances to first question
    if (state.room.isHost) {
      updateGameState(state.room.id, {
        game_phase: 'question',
        current_question: 0
      });
    } else if (_deferredPhase) {
      // Non-host: process any phase transition that arrived during countdown
      const deferred = _deferredPhase;
      _deferredPhase = null;
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
        setTimeout(finishCountdown, 300);
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
// QUESTION SCREEN (with inline wager)
// ============================================

function showQuestionScreen() {
  const q = state.questions[state.currentQuestion];
  if (!q) return;

  const meta = CATEGORY_META[state.room.category] || { icon: '?', label: state.room.category };
  $('#question-category').textContent = `${meta.icon} ${meta.label}`;

  $('#question-text').textContent = getQuestionText(q);

  $('#answer-form').classList.remove('answer-input--submitted');
  $('#answer-input').value = '';
  $('#answer-input').disabled = false;
  $('#btn-submit-answer').disabled = true;
  $('#submit-status').classList.add('hidden');
  $('#wager-error').textContent = '';

  state.hasSubmitted = false;
  state.onRevealScreen = false;
  state.resultsRevealed = false;
  state.timerExpired = false;

  // Reset wager — player must explicitly select (skip for final wager — already set)
  if (!state.isFinalWagerRound) {
    state.currentWager = null;
  }
  state.wagerExplicitlySelected = false;

  if (state.isFinalWagerRound) {
    $('#question-progress').textContent = 'Final Question';
    // Use the wager already locked in on the final wager screen
    state.currentWager = state.finalWager || 0;
    $('#wager-grid').style.display = 'none';
    $('.wager-label').style.display = 'none';
    $('#wager-error').style.display = 'none';
  } else {
    $('#question-progress').textContent = `Question ${state.currentQuestion + 1} of ${state.totalQuestions}`;
    $('#wager-grid').style.display = '';
    $('.wager-label').style.display = '';
    $('#wager-error').style.display = '';
    renderWagerGrid(); // Must run AFTER state resets — auto-selects last remaining wager
  }
  hideChatToggle();

  // Determine if we should skip the sync buffer (reconnect with existing timer)
  const isReconnect = !!state.questionStartedAt;

  if (!isReconnect) {
    // Hide interactive elements during sync buffer
    $('.question-card').style.visibility = 'hidden';
    $('#wager-grid').style.visibility = 'hidden';
    $('#answer-form').style.visibility = 'hidden';
    $('#wager-error').style.visibility = 'hidden';
    $('.timer').style.visibility = 'hidden';
  }

  const currentScreen = document.querySelector('.screen.active');
  const questionScreen = $('#question-screen');
  if (currentScreen && currentScreen !== questionScreen && !_screenTransitioning) {
    _screenTransitioning = true;
    transitionScreens(currentScreen, questionScreen).finally(() => {
      _screenTransitioning = false;
    });
  } else if (!currentScreen || currentScreen === questionScreen) {
    questionScreen.style.display = '';
    void questionScreen.offsetHeight;
    questionScreen.classList.add('active');
  }

  if (isReconnect) {
    // Reconnect: skip sync buffer, resume timer from server timestamp
    startTimer();
    $('#answer-input').focus();
  } else {
    // Normal flow: 1-second sync buffer before revealing question
    setTimeout(async () => {
      // Host: write the server-authoritative timer start timestamp
      if (state.room.isHost) {
        const startedAt = new Date(Date.now() + state.serverTimeOffset).toISOString();
        state.questionStartedAt = startedAt;
        await updateGameState(state.room.id, { question_started_at: startedAt });
      }

      // Reveal everything
      $('.question-card').style.visibility = '';
      $('#wager-grid').style.visibility = '';
      $('#answer-form').style.visibility = '';
      $('#wager-error').style.visibility = '';
      $('.timer').style.visibility = '';

      // Start timer from server timestamp
      startTimer();

      // Focus the answer input for quick typing
      $('#answer-input').focus();
    }, 1000);
  }

  $('#btn-submit-answer').onclick = handleSubmitAnswer;
  $('#answer-input').oninput = () => {
    const hasText = $('#answer-input').value.length > 0;
    const wagerOk = state.isFinalWagerRound || state.wagerExplicitlySelected;
    $('#btn-submit-answer').disabled = !(hasText && wagerOk);
  };
  $('#answer-input').onkeydown = (e) => {
    if (e.key === 'Enter' && !state.hasSubmitted) {
      handleSubmitAnswer();
    }
  };
}

function renderWagerGrid() {
  const grid = $('#wager-grid');
  grid.innerHTML = '';

  for (let i = 1; i <= state.totalQuestions; i++) {
    const btn = document.createElement('button');
    btn.className = 'wager-btn';
    btn.textContent = i;
    btn.dataset.value = i;

    if (state.usedWagers.has(i)) {
      btn.classList.add('wager-btn--used');
    } else {
      btn.addEventListener('click', () => selectWager(i, btn));
    }

    grid.appendChild(btn);
  }

  // Auto-select if only one wager remains (prevents getting stuck on last question)
  const available = grid.querySelectorAll('.wager-btn:not(.wager-btn--used)');
  if (available.length === 1 && !state.wagerExplicitlySelected) {
    const onlyBtn = available[0];
    const val = parseInt(onlyBtn.dataset.value, 10);
    onlyBtn.classList.add('wager-btn--selected');
    state.currentWager = val;
    state.wagerExplicitlySelected = true;
  } else if (available.length === 0) {
    // Defensive: all exhausted — assign fallback so player can still submit
    state.currentWager = state.currentQuestion + 1;
    state.wagerExplicitlySelected = true;
    console.warn('[Game] All wagers exhausted, fallback to', state.currentWager);
  }
}

function selectWager(value, btnEl) {
  const prev = $('#wager-grid .wager-btn--selected');
  if (prev) prev.classList.remove('wager-btn--selected');

  btnEl.classList.add('wager-btn--selected');
  state.currentWager = value;
  state.wagerExplicitlySelected = true;
  $('#wager-error').textContent = '';

  // Enable submit button if answer text is present
  const hasText = $('#answer-input').value.length > 0;
  if (hasText) $('#btn-submit-answer').disabled = false;
}

// ============================================
// TIMER (purely server-timestamp-based)
// ============================================

/**
 * Calculate remaining seconds from the server-authoritative timestamp.
 * timeLeft = questionTimer - (now - question_started_at)
 * Returns fractional seconds for precise bar rendering.
 */
function getServerTimeLeft() {
  if (!state.questionStartedAt) return state.timerSeconds;
  const startMs = new Date(state.questionStartedAt).getTime();
  const nowServerMs = Date.now() + state.serverTimeOffset;
  const elapsedMs = nowServerMs - startMs;
  return Math.max(0, state.timerSeconds - elapsedMs / 1000);
}

/**
 * Start the timer display loop. Every tick recalculates from the server
 * timestamp — no client-side countdown state. Refreshing, disconnecting,
 * or reconnecting changes nothing; the timer keeps counting from
 * question_started_at stored in Supabase.
 */
/** Update both question-screen and reveal-screen timer displays */
function updateTimerDisplay(timeLeft) {
  const secs = Math.max(0, Math.ceil(timeLeft));
  const pct = `${Math.max(0, (timeLeft / state.timerSeconds) * 100)}%`;
  const warn = secs <= 5;

  // Question screen timer
  const timerEl = $('#timer-text');
  const timerBar = $('#timer-bar');
  if (timerEl) timerEl.textContent = secs;
  if (timerBar) {
    timerBar.style.width = pct;
    const wrapper = timerBar.closest('.timer');
    if (wrapper) wrapper.classList.toggle('timer--warning', warn);
  }

  // Reveal screen timer (mirrors question timer while waiting for others)
  const revealEl = $('#reveal-timer-text');
  const revealBar = $('#reveal-timer-bar');
  if (revealEl) revealEl.textContent = secs;
  if (revealBar) {
    revealBar.style.width = pct;
    const wrapper = revealBar.closest('.timer');
    if (wrapper) wrapper.classList.toggle('timer--warning', warn);
  }
}

function startTimer() {
  if (state.timerId) {
    clearInterval(state.timerId);
    state.timerId = null;
  }

  // Immediate first render
  const initial = getServerTimeLeft();
  if (initial <= 0) {
    updateTimerDisplay(0);
    state.timerExpired = true;
    // Grace period: give in-flight submissions 500ms to land before auto-submitting
    setTimeout(() => handleTimerExpired(), 500);
    return;
  }

  updateTimerDisplay(initial);

  // Tick every 250ms for smooth bar + accurate expiry
  state.timerId = setInterval(() => {
    const timeLeft = getServerTimeLeft();
    updateTimerDisplay(timeLeft);

    if (timeLeft <= 0) {
      clearInterval(state.timerId);
      state.timerId = null;
      state.timerExpired = true;
      // Grace period: give in-flight submissions 500ms to land before auto-submitting
      setTimeout(() => handleTimerExpired(), 500);
    }
  }, 250);
}

async function handleTimerExpired() {
  // Guard: timer callback can fire after cleanup if already queued
  if (!state.room || state.gamePhase === 'loading') return;

  state.timerExpired = true;

  // Hide the reveal screen timer (round is over)
  const revealTimer = $('#reveal-timer');
  if (revealTimer) revealTimer.style.display = 'none';

  // Auto-select lowest available wager if none was explicitly selected
  if (!state.wagerExplicitlySelected && !state.isFinalWagerRound) {
    let found = false;
    for (let i = 1; i <= state.totalQuestions; i++) {
      if (!state.usedWagers.has(i)) {
        state.currentWager = i;
        found = true;
        break;
      }
    }
    if (!found) state.currentWager = state.currentQuestion + 1;
  }

  // Auto-submit with whatever is currently typed
  if (!state.hasSubmitted) {
    const currentAnswer = ($('#answer-input')?.value || '').trim();
    await doSubmitAnswer(currentAnswer, { autoSubmit: true });
  }

  // Host: auto-submit blank for any players who didn't answer, then broadcast reveal.
  // Await all inserts so they're committed before non-hosts fetch answers.
  if (state.room.isHost) {
    const submittedIds = new Set(state.currentAnswers.map(a => String(a.player_id)));
    // Also count ourselves even if doSubmitAnswer hasn't added to currentAnswers yet
    submittedIds.add(String(state.room.playerId));
    const q = state.questions[state.currentQuestion];
    if (q) {
      const autoSubmits = [];
      for (const p of state.players) {
        if (!submittedIds.has(String(p.id))) {
          autoSubmits.push(submitAnswer({
            roomId: state.room.id,
            playerId: p.id,
            questionNumber: state.currentQuestion,
            questionId: q.id,
            wager: 1,
            submittedAnswer: '',
            isCorrect: false,
            scoreEarned: 0
          }));
        }
      }
      if (autoSubmits.length) await Promise.allSettled(autoSubmits);
    }
    // Broadcast reveal phase so all clients transition
    updateGameState(state.room.id, { game_phase: 'reveal' })
      .catch(err => console.error('Failed to broadcast reveal phase:', err));
  }

  // If host and already on reveal, enable the appropriate button and update text
  if (state.room.isHost && state.onRevealScreen) {
    if (state.resultsRevealed) {
      enableNextQuestion();
    } else {
      enableRevealButton();
      updateRevealButtonText();
    }
  }
}

// ============================================
// ANSWER SUBMISSION
// ============================================

async function handleSubmitAnswer() {
  if (state.hasSubmitted) return;
  const raw = $('#answer-input').value;
  if (raw.length === 0) {
    // Only block if completely empty (nothing typed at all)
    const input = $('#answer-input');
    input.classList.remove('input--flash');
    void input.offsetHeight;
    input.classList.add('input--flash');
    return;
  }
  // Block submission if player hasn't explicitly selected a wager
  if (!state.wagerExplicitlySelected && !state.isFinalWagerRound) {
    const grid = $('#wager-grid');
    grid.classList.remove('wager-grid--highlight');
    void grid.offsetHeight;
    grid.classList.add('wager-grid--highlight');
    $('#wager-error').textContent = 'Select a wager first';
    return;
  }
  // Trim for storage — spaces-only becomes '' which shows "No answer" on reveal
  await doSubmitAnswer(raw.trim());
}

async function doSubmitAnswer(answer, { autoSubmit = false } = {}) {
  if (state.hasSubmitted) return;
  state.hasSubmitted = true;

  // Disable question UI (in case transition is slow)
  $('#answer-input').disabled = true;
  $('#btn-submit-answer').disabled = true;

  const q = state.questions[state.currentQuestion];
  if (!q) return;
  const correctAnswer = getCorrectAnswer(q);
  const alternates = getAlternates(q);
  const isCorrect = answer ? fuzzyMatch(answer, correctAnswer, alternates) : false;
  let wager;
  if (state.isFinalWagerRound) {
    wager = state.finalWager || 0;
  } else if (state.currentWager) {
    wager = state.currentWager;
  } else {
    // Fallback: find lowest available wager (auto-select paths should have set this already)
    wager = null;
    for (let i = 1; i <= state.totalQuestions; i++) {
      if (!state.usedWagers.has(i)) { wager = i; break; }
    }
    if (wager === null) {
      wager = state.currentQuestion + 1;
      console.warn('[Game] doSubmitAnswer: all wagers used, fallback to', wager);
    }
  }
  const scoreEarned = isCorrect ? wager : (state.isFinalWagerRound ? -wager : 0);

  state.usedWagers.add(wager);

  await submitAnswer({
    roomId: state.room.id,
    playerId: state.room.playerId,
    questionNumber: state.currentQuestion,
    questionId: q.id,
    wager,
    submittedAnswer: answer,
    isCorrect,
    scoreEarned
  });

  // Track question answered (fire-and-forget, skip final wager round)
  if (!state.isFinalWagerRound) {
    incrementQuestionsAnswered(state.room.id, state.room.playerId);
  }

  // Immediately transition to reveal screen
  showRevealScreen();
}

// ============================================
// REVEAL SCREEN
// ============================================

async function showRevealScreen() {
  // Don't clear the timer — it's still running for other players
  // (it gets cleared in handleTimerExpired)

  state.onRevealScreen = true;
  showChatToggle();

  const q = state.questions[state.currentQuestion];
  if (!q) return;

  const meta = CATEGORY_META[state.room.category] || { icon: '?', label: state.room.category };
  $('#reveal-category').textContent = `${meta.icon} ${meta.label}`;
  $('#reveal-progress').textContent = state.isFinalWagerRound
    ? 'Final Question'
    : `Question ${state.currentQuestion + 1} of ${state.totalQuestions}`;
  $('#reveal-question-text').textContent = getQuestionText(q);

  // Populate correct answer text (for later reveal), but hide the container
  $('#reveal-answer').textContent = getCorrectAnswer(q);
  $('#reveal-difficulty').style.display = 'none';
  $('.reveal__correct').style.display = 'none';

  // Reset feedback UI
  resetFeedbackUI();

  // Fetch existing answers (some players may not have submitted yet) and cache them
  state.currentAnswers = await fetchAnswersForQuestion(state.room.id, state.currentQuestion);
  // Skip render if doReveal() will be called immediately (it re-renders with colors)
  if (!state.resultsRevealed) {
    renderRevealAnswers(state.currentAnswers);
  }

  // Show countdown timer on reveal screen if the round isn't over yet
  const revealTimer = $('#reveal-timer');
  if (!state.timerExpired && state.currentAnswers.length < state.players.length) {
    revealTimer.style.display = '';
  } else {
    revealTimer.style.display = 'none';
  }

  // Host: show action button (Reveal Results first, then Next Question after reveal)
  if (state.room.isHost) {
    const btn = $('#btn-next-question');
    btn.classList.remove('hidden');
    btn.onclick = handleRevealResults;
    updateRevealButtonText();

    // Enable as soon as host has submitted — host controls the pace
    const hostSubmitted = state.hasSubmitted || state.currentAnswers.some(a => String(a.player_id) === String(state.room.playerId));
    if (hostSubmitted) {
      btn.disabled = false;
      btn.style.opacity = '1';
    } else {
      btn.disabled = true;
      btn.style.opacity = '0.5';
    }
    $('#reveal-waiting-host').classList.add('hidden');
  } else {
    // Non-host: show "Waiting for host..." message
    $('#reveal-waiting-host').classList.remove('hidden');
  }

  // Transition to reveal screen
  const currentScreen = document.querySelector('.screen.active');
  const revealScreen = $('#reveal-screen');
  if (currentScreen && currentScreen !== revealScreen) {
    transitionScreens(currentScreen, revealScreen).then(repositionChatToggle);
  }

  // If results were already revealed (reconnect), show them immediately
  if (state.resultsRevealed) {
    doReveal();
  }
}

function updateHonkBadges() {
  document.querySelectorAll('.honk-badge[data-honk-player]').forEach(badge => {
    const pid = badge.dataset.honkPlayer;
    const count = getHonkCount(pid);
    if (count > 0) {
      badge.textContent = count;
      badge.style.display = '';
    } else {
      badge.style.display = 'none';
    }
  });
}

function honkAvatarHtml(player, hue, initial) {
  const honks = getHonkCount(player.id);
  const badge = `<span class="honk-badge" data-honk-player="${player.id}" style="${honks > 0 ? '' : 'display:none'}">${honks}</span>`;
  return `<div class="avatar-wrap">
    <div class="answer-row__avatar" style="background: hsl(${hue}, 45%, 45%)">${initial}</div>
    ${badge}
  </div>`;
}

function honkBtnHtml(player) {
  const isMe = String(player.id) === String(state.room.playerId);
  return isMe ? '' : `<button class="honk-btn" data-honk-target="${player.id}" aria-label="Quack">&#x1F986;</button>`;
}

function renderRevealAnswers(answers) {
  const container = $('#reveal-answers');

  // Remove old click listener to avoid duplicates
  const newContainer = container.cloneNode(false);
  container.parentNode.replaceChild(newContainer, container);

  for (const player of state.players) {
    const answer = answers.find(a => a.player_id === player.id);
    const row = document.createElement('div');
    row.className = 'answer-row' + (state.awayTimestamps.has(String(player.id)) ? ' answer-row--away' : '');
    row.dataset.playerId = player.id;

    // Avatar
    const hue = getAvatarHue(player.display_name);
    const initial = (player.display_name || '?')[0].toUpperCase();

    if (answer) {
      row.dataset.answerId = answer.id;
      const rawText = (answer.submitted_answer || '').trim();
      const submittedText = rawText === '__WAGER_LOCKED__' ? '' : rawText;
      const isEmpty = !submittedText;
      const isCorrect = answer.is_correct || false;
      const wager = answer.wager || 0;

      // Answer text color: only colored post-reveal (doReveal animates this)
      const colorClass = state.resultsRevealed
        ? (isCorrect ? 'answer-row__answer--correct' : 'answer-row__answer--incorrect')
        : '';
      const emptyClass = isEmpty ? ' answer-row__answer--empty' : '';

      // Toggle: host only, visible only after reveal (prevents host seeing correct/incorrect early)
      const toggleHtml = (state.room.isHost && state.resultsRevealed)
        ? `<div class="answer-toggle ${isCorrect ? 'answer-toggle--correct' : 'answer-toggle--incorrect'} answer-toggle--host" data-answer-id="${answer.id}">
             <div class="answer-toggle__thumb"></div>
           </div>`
        : '';

      // Wager badge: colored after reveal, neutral before
      const wagerColorClass = state.resultsRevealed
        ? (isCorrect ? 'answer-row__wager--correct' : 'answer-row__wager--incorrect')
        : '';

      const hostBadge = player.is_host ? '<span class="badge badge--host">Host</span>' : '';

      row.innerHTML = `
        <div class="answer-row__top">
          ${honkAvatarHtml(player, hue, initial)}
          <span class="answer-row__name">${escapeHtml(player.display_name)}${hostBadge}</span>
          <span class="answer-row__wager ${wagerColorClass}">${wager}</span>
          ${toggleHtml}
          ${honkBtnHtml(player)}
        </div>
        <div class="answer-row__bottom">
          <span class="answer-row__answer ${colorClass}${emptyClass}">
            ${isEmpty ? 'No answer' : escapeHtml(submittedText)}
          </span>
        </div>
      `;
    } else {
      // Player hasn't submitted yet — show waiting state
      const hostBadge = player.is_host ? '<span class="badge badge--host">Host</span>' : '';
      row.innerHTML = `
        <div class="answer-row__top">
          ${honkAvatarHtml(player, hue, initial)}
          <span class="answer-row__name">${escapeHtml(player.display_name)}${hostBadge}</span>
          ${honkBtnHtml(player)}
        </div>
        <div class="answer-row__bottom">
          <span class="answer-row__answer answer-row__answer--waiting">Waiting...</span>
        </div>
      `;
    }

    newContainer.appendChild(row);
  }

  // Honk click handler on cloned container
  newContainer.addEventListener('click', (e) => {
    const btn = e.target.closest('.honk-btn');
    if (btn) sendHonk(btn.dataset.honkTarget);
  });

  // Host: attach toggle click listeners (pre- and post-reveal)
  if (state.room.isHost) {
    newContainer.addEventListener('click', handleJudgmentOverride);
  }
}

function enableNextQuestion() {
  if (!state.room.isHost) return;
  const nextBtn = $('#btn-next-question');
  if (nextBtn) {
    nextBtn.disabled = false;
    nextBtn.style.opacity = '1';
  }
}

function enableRevealButton() {
  if (!state.room.isHost || state.resultsRevealed) return;
  // Host must have submitted their own answer (check local flag + DB cache)
  const hostSubmitted = state.hasSubmitted || state.currentAnswers.some(a => String(a.player_id) === String(state.room.playerId));
  if (!hostSubmitted) return;
  const btn = $('#btn-next-question');
  if (btn) {
    btn.disabled = false;
    btn.style.opacity = '1';
  }
}

/**
 * Update reveal button text based on whether all players have submitted.
 * Shows "Reveal Early" if some players are still answering, "Reveal Results" otherwise.
 */
function updateRevealButtonText() {
  if (!state.room.isHost || state.resultsRevealed) return;
  const btn = $('#btn-next-question');
  if (!btn) return;
  const allSubmitted = state.currentAnswers.length >= state.players.length;
  btn.textContent = (!state.timerExpired && !allSubmitted) ? 'Reveal Early' : 'Reveal Results';
}

function doReveal() {
  // Snapshot scores before this round (for animation on scores screen)
  state.previousScores = { ...state.scores };

  // Hide the reveal timer — the round is over once results are shown
  const revealTimer = $('#reveal-timer');
  if (revealTimer) revealTimer.style.display = 'none';

  // Show correct answer and difficulty
  $('.reveal__correct').style.display = '';

  // Show feedback icons and start fade timer
  showFeedbackUI();

  // Render immediately with cached answers (Realtime keeps these up-to-date).
  // Late answers from auto-submitted players will arrive via Realtime INSERT
  // and trigger re-renders in handleAnswerChange — no blocking fetch needed.
  renderRevealAnswers(state.currentAnswers);

  // Now mark revealed — subsequent renders will apply colors immediately
  state.resultsRevealed = true;

  // Animate: add color classes on next frame so CSS transition fires
  requestAnimationFrame(() => {
    document.querySelectorAll('#reveal-answers .answer-row').forEach(row => {
      const answer = state.currentAnswers.find(a => String(a.player_id) === String(row.dataset.playerId));
      if (!answer) return;
      const isCorrect = answer.is_correct || false;
      const el = row.querySelector('.answer-row__answer');
      if (el) {
        el.classList.add(isCorrect ? 'answer-row__answer--correct' : 'answer-row__answer--incorrect');
      }
      const wagerEl = row.querySelector('.answer-row__wager');
      if (wagerEl) {
        wagerEl.classList.add(isCorrect ? 'answer-row__wager--correct' : 'answer-row__wager--incorrect');
      }
      // Host: inject toggle switches now that results are revealed
      if (state.room.isHost && answer.id && !row.querySelector('.answer-toggle')) {
        const toggleDiv = document.createElement('div');
        toggleDiv.className = `answer-toggle ${isCorrect ? 'answer-toggle--correct' : 'answer-toggle--incorrect'} answer-toggle--host`;
        toggleDiv.dataset.answerId = answer.id;
        toggleDiv.innerHTML = '<div class="answer-toggle__thumb"></div>';
        const topRow = row.querySelector('.answer-row__top') || row;
        topRow.appendChild(toggleDiv);
      }
    });
  });

  // Host: swap button to "Show Scores"
  if (state.room.isHost) {
    const btn = $('#btn-next-question');
    btn.textContent = 'Show Scores';
    btn.onclick = handleShowScores;
    btn.disabled = false;
    btn.style.opacity = '1';
  }

  // Background re-fetch to catch any answers missed by Realtime
  const revealQNum = state.currentQuestion;
  fetchAnswersForQuestion(state.room.id, revealQNum).then(answers => {
    if (state.currentQuestion !== revealQNum) return; // question changed, discard stale fetch
    const cachedIds = state.currentAnswers.map(a => String(a.id)).sort().join(',');
    const fetchedIds = answers.map(a => String(a.id)).sort().join(',');
    if (fetchedIds !== cachedIds) {
      state.currentAnswers = answers;
      renderRevealAnswers(state.currentAnswers);
    }
  });
}

async function handleRevealResults() {
  // Set gamePhase BEFORE broadcasting so the Realtime echo is rejected
  // by the `if (phase === state.gamePhase) return` guard in handlePhaseTransition.
  // This prevents doReveal() from running twice on the host.
  state.gamePhase = 'answer_reveal';

  // Stop the timer — round is over
  if (state.timerId) {
    clearInterval(state.timerId);
    state.timerId = null;
  }
  state.timerExpired = true;

  // Submit blank answers for players who haven't answered yet.
  // Await all inserts so they're committed before non-hosts fetch answers.
  const submittedIds = new Set(state.currentAnswers.map(a => String(a.player_id)));
  submittedIds.add(String(state.room.playerId));
  const q = state.questions[state.currentQuestion];
  if (q) {
    const autoSubmits = [];
    for (const p of state.players) {
      if (!submittedIds.has(String(p.id))) {
        autoSubmits.push(submitAnswer({
          roomId: state.room.id,
          playerId: p.id,
          questionNumber: state.currentQuestion,
          questionId: q.id,
          wager: 1,
          submittedAnswer: '',
          isCorrect: false,
          scoreEarned: 0
        }));
      }
    }
    if (autoSubmits.length) await Promise.allSettled(autoSubmits);
  }

  // Re-fetch all answers (including just-submitted auto-answers) before revealing.
  // Realtime INSERT callbacks may not have arrived yet, causing "Waiting..." flicker.
  try {
    state.currentAnswers = await fetchAnswersForQuestion(state.room.id, state.currentQuestion);
  } catch (err) {
    console.warn('[Game] Pre-reveal fetch failed, using cached answers:', err);
  }

  // Broadcast phase change so non-hosts transition to reveal
  updateGameState(state.room.id, { game_phase: 'answer_reveal' })
    .catch(err => console.error('Failed to broadcast answer_reveal phase:', err));
  doReveal();
}

async function handleJudgmentOverride(e) {
  const toggle = e.target.closest('.answer-toggle--host');
  if (!toggle) return;

  const answerId = toggle.dataset.answerId;
  if (!answerId) return;

  // Use cached answers — no DB fetch
  const answer = state.currentAnswers.find(a => String(a.id) === String(answerId));
  if (!answer) return;

  const newCorrect = !answer.is_correct;
  const newScore = newCorrect ? answer.wager : (state.isFinalWagerRound ? -answer.wager : 0);

  // Update local cache immediately for instant host feedback
  answer.is_correct = newCorrect;
  answer.score_earned = newScore;
  renderRevealAnswers(state.currentAnswers);

  // Persist to DB — Realtime event will update other clients
  await updateAnswerJudgment(answerId, newCorrect, newScore);
}

async function handleNextQuestion() {
  const isLastQuestion = state.currentQuestion >= state.totalQuestions - 1;

  if (isLastQuestion) {
    await updateGameState(state.room.id, { game_phase: 'results' });
  } else {
    await updateGameState(state.room.id, {
      game_phase: 'question',
      current_question: state.currentQuestion + 1
    });
  }
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
  _lastScoresRenderedForQuestion = state.currentQuestion;

  state.onRevealScreen = false;
  showChatToggle();

  // Track this question as shown (for question browser)
  if (!state.shownQuestionIndices.includes(state.currentQuestion)) {
    state.shownQuestionIndices.push(state.currentQuestion);
  }

  const meta = CATEGORY_META[state.room.category] || { icon: '?', label: state.room.category };
  $('#scores-category').textContent = `${meta.icon} ${meta.label}`;
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
    const hue = getAvatarHue(p.display_name);
    const initial = (p.display_name || '?')[0].toUpperCase();

    const isMe = String(p.id) === String(state.room.playerId);
    const honks = getHonkCount(p.id);
    const honkBadge = `<span class="honk-badge" data-honk-player="${p.id}" style="${honks > 0 ? '' : 'display:none'}">${honks}</span>`;
    const honkBtn = isMe ? '' : `<button class="honk-btn" data-honk-target="${p.id}" aria-label="Quack">&#x1F986;</button>`;

    return `
      <div class="score-anim-row${state.awayTimestamps.has(String(p.id)) ? ' score-anim-row--away' : ''}" data-player-id="${p.id}" data-new-score="${newScore}">
        <div class="avatar-wrap">
          <div class="answer-row__avatar" style="background: hsl(${hue}, 45%, 45%)">${initial}</div>
          ${honkBadge}
        </div>
        <span class="score-anim-row__name">${escapeHtml(p.display_name)}${p.is_host ? '<span class="badge badge--host">Host</span>' : ''}</span>
        <span class="score-anim-row__delta ${deltaClass}">${deltaSign}${delta}</span>
        <span class="score-anim-row__score" data-from="${prevScore}" data-to="${newScore}">${prevScore}</span>
        ${honkBtn}
      </div>
    `;
  }).join('');

  // Transition to scores screen
  const currentScreen = document.querySelector('.screen.active');
  const scoresScreen = $('#scores-screen');
  if (currentScreen && currentScreen !== scoresScreen) {
    transitionScreens(currentScreen, scoresScreen).then(repositionChatToggle);
  }

  // Host: show "Update Scores" button; non-host: auto-animate after delay
  const btn = $('#btn-scores-action');
  if (state.room.isHost) {
    if (hasPreviousScores) {
      btn.classList.remove('hidden');
      btn.textContent = 'Update Scores';
      btn.onclick = () => animateScores();
      btn.disabled = false;
      btn.style.opacity = '1';
    } else {
      // Reconnect: show final state immediately
      showFinalScoresState();
    }
  } else {
    btn.classList.add('hidden');
    if (hasPreviousScores) {
      setTimeout(() => animateScores(), 1500);
    } else {
      showFinalScoresState();
    }
  }
}

function animateScores() {
  const btn = $('#btn-scores-action');
  btn.disabled = true;
  btn.style.opacity = '0.5';

  const rows = document.querySelectorAll('.score-anim-row');
  const scoreEls = document.querySelectorAll('.score-anim-row__score');

  // Phase 1: Count animation (~1s)
  const duration = 1000;
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
      setTimeout(() => reorderRows(), 300);
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
  if (!state.room.isHost) {
    // Non-host: show "Waiting for host..." message
    $('#scores-waiting-host').classList.remove('hidden');
    requestAnimationFrame(repositionChatToggle);
    return;
  }
  $('#scores-waiting-host').classList.add('hidden');
  const btn = $('#btn-scores-action');
  const isLast = state.currentQuestion >= state.totalQuestions - 1;

  if (isLast && !state.isFinalWagerRound) {
    btn.textContent = 'Final Wager';
    btn.onclick = handleFinalWager;
  } else if (state.isFinalWagerRound) {
    btn.textContent = 'Show Results';
    btn.onclick = handleShowResults;
  } else {
    btn.textContent = 'Next Question';
    btn.onclick = handleNextQuestion;
  }
  btn.disabled = false;
  btn.style.opacity = '1';
  btn.classList.remove('hidden');
  // Footer content changed — reposition chat toggle above it
  requestAnimationFrame(repositionChatToggle);
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

  const meta = CATEGORY_META[state.room.category] || { icon: '?', label: state.room.category };
  $('#fw-category').textContent = `${meta.icon} ${meta.label}`;
  $('#fw-current-score').textContent = state.scores[state.room.playerId] || 0;

  const status = $('#fw-status');
  const revealBtn = $('#btn-fw-reveal');
  const options = document.querySelectorAll('.fw-option');

  // Render player wager list (initial "Waiting..." for all, then fetch actual state)
  renderFinalWagerPlayers();
  updateFinalWagerPlayerList();

  // Option buttons (0 / 10 / 20)
  options.forEach(btn => {
    btn.classList.remove('fw-option--selected', 'fw-option--locked');
    btn.onclick = () => {
      if (state.finalWagerLocked) return;
      options.forEach(b => b.classList.remove('fw-option--selected'));
      btn.classList.add('fw-option--selected');
      state.finalWager = parseInt(btn.dataset.wager, 10);

      // Auto lock-in on tap
      lockInFinalWager();
    };
  });

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

  // Host: show reveal button ONLY after they've locked in their own wager
  if (state.room.isHost) {
    revealBtn.onclick = handleRevealFinalQuestion;
    if (state.finalWagerLocked) {
      revealBtn.classList.remove('hidden');
    } else {
      revealBtn.classList.add('hidden');
    }
  } else {
    revealBtn.classList.add('hidden');
  }

  hideChatToggle();

  // Transition
  const currentScreen = document.querySelector('.screen.active');
  const fwScreen = $('#final-wager-screen');
  if (currentScreen && currentScreen !== fwScreen) {
    transitionScreens(currentScreen, fwScreen);
  }
}

async function lockInFinalWager() {
  if (state.finalWagerLocked) return;
  state.finalWagerLocked = true;

  $('#fw-status').classList.remove('hidden');
  document.querySelectorAll('.fw-option').forEach(b => b.classList.add('fw-option--locked'));

  // Host: now show the reveal button (was hidden until wager locked)
  if (state.room.isHost) {
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
    const hue = getAvatarHue(p.display_name);
    const initial = (p.display_name || '?')[0].toUpperCase();
    const score = state.scores[p.id] || 0;
    const wagerVal = wagers[String(p.id)];
    const wagerDisplay = wagerVal !== undefined
      ? `<span class="fw-player-row__wager">${wagerVal}</span>`
      : `<span class="fw-player-row__wager fw-player-row__wager--waiting">Waiting...</span>`;

    return `
      <div class="fw-player-row" data-player-id="${p.id}">
        <div class="answer-row__avatar" style="background: hsl(${hue}, 45%, 45%)">${initial}</div>
        <span class="fw-player-row__name">${escapeHtml(p.display_name)}</span>
        <span class="fw-player-row__score">${score}</span>
        ${wagerDisplay}
      </div>
    `;
  }).join('');
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

async function handleRevealFinalQuestion() {
  // Set current_question to totalQuestions (the final wager question index)
  await updateGameState(state.room.id, {
    game_phase: 'final_question',
    current_question: state.totalQuestions
  });
}

// ============================================
// RESULTS SCREEN
// ============================================

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
  }

  const meta = CATEGORY_META[state.room.category] || { icon: '?', label: state.room.category };
  $('#results-category').textContent = `${meta.icon} ${meta.label}`;

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
    const hue = getAvatarHue(winner.display_name);
    const initial = (winner.display_name || '?')[0].toUpperCase();
    $('#results-winner').innerHTML = `
      <div class="results-winner__badge">🏆</div>
      <div class="answer-row__avatar" style="background: hsl(${hue}, 45%, 45%); width: 48px; height: 48px; font-size: var(--text-xl); margin: 0 auto var(--space-sm);">${initial}</div>
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
    const hue = getAvatarHue(p.display_name);
    const initial = (p.display_name || '?')[0].toUpperCase();
    const placeLabel = PLACE_LABELS[i] || `${i + 1}th`;
    const placeClass = i < 3 ? `results-row__place--${PLACE_LABELS[i]}` : '';

    const isMe = String(p.id) === String(state.room.playerId);
    const honks = getHonkCount(p.id);
    const honkBadge = `<span class="honk-badge" data-honk-player="${p.id}" style="${honks > 0 ? '' : 'display:none'}">${honks}</span>`;
    const honkBtn = isMe ? '' : `<button class="honk-btn" data-honk-target="${p.id}" aria-label="Quack">&#x1F986;</button>`;

    return `
      <div class="results-row" data-player-id="${p.id}">
        <span class="results-row__place ${placeClass}">${placeLabel}</span>
        <div class="avatar-wrap">
          <div class="answer-row__avatar" style="background: hsl(${hue}, 45%, 45%)">${initial}</div>
          ${honkBadge}
        </div>
        <span class="results-row__name">${escapeHtml(p.display_name)}${p.is_host ? '<span class="badge badge--host">Host</span>' : ''}</span>
        <span class="results-row__fw-delta ${fwClass}">${fwSign}${fwDelta}</span>
        <span class="results-row__score">${state.scores[p.id] || 0}</span>
        ${honkBtn}
      </div>
    `;
  }).join('');

  // Transition
  const currentScreen = document.querySelector('.screen.active');
  const resultsScreen = $('#results-screen');
  if (currentScreen && currentScreen !== resultsScreen) {
    transitionScreens(currentScreen, resultsScreen).then(repositionChatToggle);
  }

  showChatToggle();

  // Button handlers
  $('#btn-play-again').onclick = handlePlayAgain;
  $('#btn-quit-game').onclick = handleQuitGame;
  $('#btn-review-questions').onclick = handleReviewQuestions;
}

async function handlePlayAgain() {
  _isLeaving = true; // Player stays in room — prevent handleUnload from removing
  cleanup();
  await updateRoomStatus(state.room.id, 'lobby');

  if (state.room.isHost) {
    // Clear old answers so scores don't carry over to the next game
    await deleteAnswersByRoom(state.room.id);
    await updateGameState(state.room.id, {
      game_phase: 'lobby',
      current_question: 0,
      question_ids: [],
      question_started_at: null,
      countdown_started_at: null
    });
  }

  window.location.href = 'lobby.html';
}

async function handleQuitGame() {
  _isLeaving = true;
  cleanup();
  if (state.players.length <= 1) {
    // Last player — delete the room
    await deleteRoom(state.room.id);
  } else {
    // Remove self — remaining players handle host promotion
    await removePlayer(state.room.playerId);
  }
  sessionStorage.removeItem('oracle_party_room');
  window.location.href = 'index.html';
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

    const item = document.createElement('div');
    const isFlagged = existing === 'thumbs_down' || existing === 'flag';
    item.className = 'review-item' + (isFlagged ? ' review-item--flagged' : '');
    item.innerHTML = `
      <div class="review-item__num">${label}</div>
      <div class="review-item__q">${escapeHtml(getQuestionText(q))}</div>
      <div class="review-item__a">${escapeHtml(getCorrectAnswer(q))}</div>
      ${playerAnswerHtml}
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
    // Targeted update: patch single answer in cached array (host override)
    const idx = state.currentAnswers.findIndex(a => String(a.id) === String(payload.new.id));
    if (idx !== -1) {
      state.currentAnswers[idx] = { ...state.currentAnswers[idx], ...payload.new };
    }
    // Try in-place DOM patch (avoids full re-render for single answer change)
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

    // Host: check if all submitted → enable reveal button and update text
    if (state.room.isHost && !state.resultsRevealed) {
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

// ============================================
// CHAT OVERLAY
// ============================================

/**
 * Position the chat toggle bar just above the active screen's footer.
 * Uses a CSS custom property so the layout adapts to any footer height.
 */
function repositionChatToggle() {
  const activeScreen = document.querySelector('.screen.active');
  if (!activeScreen) return;
  const footer = activeScreen.querySelector('.game-footer');
  const toggle = $('#btn-chat-toggle');
  const toasts = $('#chat-toasts');
  const GAP = 8; // px gap between footer top and toggle bottom

  if (footer) {
    const footerH = footer.offsetHeight;
    // Skip if footer is empty/collapsed (e.g. question screen has an empty footer) —
    // the 850ms timeout or transition callback will reposition once the right screen is active.
    if (footerH === 0) return;
    const bottom = footerH + GAP;
    toggle.style.setProperty('--chat-toggle-bottom', `${bottom}px`);
    // Toast container sits above the toggle bar
    const toggleH = toggle.offsetHeight || 38;
    toasts.style.setProperty('--chat-toasts-bottom', `${bottom + toggleH + GAP}px`);
  } else {
    // No footer — use a sensible default
    const bottom = GAP;
    toggle.style.setProperty('--chat-toggle-bottom', `${bottom}px`);
    toasts.style.setProperty('--chat-toasts-bottom', `${bottom + 38 + GAP}px`);
  }
}

function showChatToggle() {
  $('#btn-chat-toggle').classList.remove('hidden');
  $('#chat-toasts').classList.remove('hidden');
  document.body.classList.add('chat-visible');
  // Reposition after a frame so the active screen's footer is laid out.
  // Also reposition after transition completes (800ms) since screen may not be active yet.
  requestAnimationFrame(repositionChatToggle);
  setTimeout(repositionChatToggle, 850);
}

function hideChatToggle() {
  $('#btn-chat-toggle').classList.add('hidden');
  $('#chat-toasts').classList.add('hidden');
  document.body.classList.remove('chat-visible');
  clearChatToasts();
  // Close chat panel if open
  if (state.chatOpen) {
    state.chatOpen = false;
    $('#chat-panel').classList.remove('open');
    $('#chat-backdrop').classList.remove('open');
  }
}

function attachChatListeners() {
  $('#btn-chat-toggle').addEventListener('click', toggleChat);
  $('#btn-close-chat').addEventListener('click', toggleChat);
  $('#chat-backdrop').addEventListener('click', toggleChat);

  $('#btn-game-chat-send').addEventListener('click', handleSendGameChat);
  $('#game-chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleSendGameChat();
  });
}

function toggleChat() {
  state.chatOpen = !state.chatOpen;
  $('#chat-panel').classList.toggle('open', state.chatOpen);
  $('#chat-backdrop').classList.toggle('open', state.chatOpen);

  if (state.chatOpen) {
    scrollGameChatToBottom();
    $('#game-chat-input').focus();
    // Clear unread badge, preview, and toasts
    state.unreadCount = 0;
    const badge = $('#chat-badge');
    badge.textContent = '0';
    badge.classList.add('hidden');
    const preview = $('#chat-preview');
    if (preview) preview.textContent = '';
    clearChatToasts();
  }
}

async function loadChatMessages() {
  const messages = await fetchMessages(state.room.id);
  const container = $('#game-chat-messages');
  container.innerHTML = '';
  for (const msg of messages) {
    appendGameChatMessage(msg.player_name, msg.message);
  }
  scrollGameChatToBottom();
}

function handleNewMessage(payload) {
  if (!payload.new) return;
  const { player_name, message } = payload.new;

  // Dedup: skip Realtime echoes of our own optimistic appends.
  // Each send increments chatEchoPending; each echo from self decrements it.
  if (player_name === getDisplayName() && state.chatEchoPending > 0) {
    state.chatEchoPending--;
    return;
  }

  appendGameChatMessage(player_name, message);
  scrollGameChatToBottom();

  // Show unread badge + inline preview + toast when chat is closed (but not during hidden phases)
  const chatHidden = $('#btn-chat-toggle').classList.contains('hidden');
  if (!state.chatOpen && !chatHidden) {
    state.unreadCount = (state.unreadCount || 0) + 1;
    const badge = $('#chat-badge');
    badge.textContent = state.unreadCount;
    badge.classList.remove('hidden');
    updateChatPreview(player_name, message);
    showChatToast(player_name, message);
  }
}

function updateChatPreview(name, text) {
  const preview = $('#chat-preview');
  if (!preview) return;
  const truncated = text.length > 40 ? text.slice(0, 40) + '...' : text;
  preview.textContent = `${name}: ${truncated}`;
}

// --- Chat Toast Popups ---

const MAX_TOASTS = 3;

function showChatToast(name, text) {
  const container = $('#chat-toasts');
  if (!container || container.classList.contains('hidden')) return;

  const toast = document.createElement('div');
  toast.className = 'chat-toast';
  const truncated = text.length > 60 ? text.slice(0, 60) + '...' : text;
  toast.innerHTML = `<span class="chat-toast__name">${escapeHtml(name)}</span>${escapeHtml(truncated)}`;
  container.appendChild(toast);

  // Animate in
  requestAnimationFrame(() => {
    toast.classList.add('visible');
  });

  // Cap visible toasts — remove oldest
  const toasts = container.querySelectorAll('.chat-toast');
  if (toasts.length > MAX_TOASTS) {
    removeToast(toasts[0]);
  }

  // Auto-fade after 3 seconds
  setTimeout(() => {
    removeToast(toast);
  }, 3000);
}

function removeToast(toast) {
  if (!toast || !toast.parentNode) return;
  toast.classList.remove('visible');
  toast.classList.add('fading');
  toast.addEventListener('transitionend', () => toast.remove(), { once: true });
  // Fallback if transitionend doesn't fire
  setTimeout(() => { if (toast.parentNode) toast.remove(); }, 400);
}

function clearChatToasts() {
  const container = $('#chat-toasts');
  if (container) container.innerHTML = '';
}

function appendGameChatMessage(name, text) {
  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble';
  bubble.innerHTML = `
    <div class="chat-bubble__name">${escapeHtml(name)}</div>
    <div class="chat-bubble__text">${escapeHtml(text)}</div>
  `;
  $('#game-chat-messages').appendChild(bubble);
}

function scrollGameChatToBottom() {
  const container = $('#game-chat-messages');
  container.scrollTop = container.scrollHeight;
}

async function handleSendGameChat() {
  const input = $('#game-chat-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  const name = getDisplayName();

  // Optimistic append — show instantly for the sender
  appendGameChatMessage(name, text);
  scrollGameChatToBottom();

  // Track pending echo for dedup (counter-based — handles rapid duplicate messages)
  state.chatEchoPending = (state.chatEchoPending || 0) + 1;

  try {
    await sendMessage(state.room.id, name, text);
  } catch {
    // Send failed — no echo will arrive, so undo the counter increment
    state.chatEchoPending = Math.max(0, (state.chatEchoPending || 0) - 1);
  }
}

// ============================================
// QUESTION FEEDBACK
// ============================================

function resetFeedbackUI() {
  if (state.feedbackFadeTimer) {
    clearTimeout(state.feedbackFadeTimer);
    state.feedbackFadeTimer = null;
  }
  const container = $('#reveal-feedback');
  container.style.display = 'none';
  container.classList.remove('reveal__feedback--faded');
  container.querySelectorAll('.feedback-btn').forEach(b => b.classList.remove('feedback-btn--active'));
  container.querySelector('.feedback-flag-menu').style.display = 'none';
  const confirmEl = container.querySelector('.feedback-flag-confirm');
  if (confirmEl) { confirmEl.classList.remove('show'); confirmEl.textContent = ''; }
}

function showFeedbackUI() {
  const container = $('#reveal-feedback');
  container.style.display = '';
  container.classList.remove('reveal__feedback--faded');
  state.feedbackFadeTimer = setTimeout(() => {
    container.classList.add('reveal__feedback--faded');
  }, 5000);
}

function startFeedbackFadeTimer() {
  if (state.feedbackFadeTimer) clearTimeout(state.feedbackFadeTimer);
  const container = $('#reveal-feedback');
  container.classList.remove('reveal__feedback--faded');
  state.feedbackFadeTimer = setTimeout(() => {
    container.classList.add('reveal__feedback--faded');
  }, 5000);
}

function initFeedbackListeners() {
  // Tap question text to bring feedback icons back to full opacity
  $('#reveal-question-text').addEventListener('click', () => {
    const container = $('#reveal-feedback');
    if (container.style.display !== 'none') {
      startFeedbackFadeTimer();
    }
  });

  // Thumbs up / down
  document.querySelectorAll('.feedback-btn[data-type="thumbs_up"], .feedback-btn[data-type="thumbs_down"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const type = btn.dataset.type;
      const otherType = type === 'thumbs_up' ? 'thumbs_down' : 'thumbs_up';
      const otherBtn = document.querySelector(`.feedback-btn[data-type="${otherType}"]`);

      // Toggle: if already active, deactivate; otherwise activate and deactivate other
      const wasActive = btn.classList.contains('feedback-btn--active');
      if (otherBtn) otherBtn.classList.remove('feedback-btn--active');

      const q = state.questions[state.currentQuestion];
      if (wasActive) {
        btn.classList.remove('feedback-btn--active');
        if (q) {
          _qbFeedback[q.id] = null;
          deleteQuestionFeedback({ questionId: q.id, roomId: state.room.id, playerName: getDisplayName() });
        }
      } else {
        btn.classList.add('feedback-btn--active');
        if (q) {
          _qbFeedback[q.id] = type;
          upsertQuestionFeedback({
            questionId: q.id,
            roomId: state.room.id,
            playerName: getDisplayName(),
            feedbackType: type,
            flagReason: null
          });
        }
      }

      startFeedbackFadeTimer();
    });
  });

  // Flag button — toggle dropdown
  const flagBtn = document.querySelector('.feedback-btn[data-type="flag"]');
  const flagMenu = document.querySelector('.feedback-flag-menu');

  flagBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isVisible = flagMenu.style.display !== 'none';
    flagMenu.style.display = isVisible ? 'none' : '';
    startFeedbackFadeTimer();
  });

  // Flag menu options
  flagMenu.querySelectorAll('button[data-reason]').forEach(option => {
    option.addEventListener('click', (e) => {
      e.stopPropagation();
      const reason = option.dataset.reason;
      flagBtn.classList.add('feedback-btn--active');
      flagMenu.style.display = 'none';

      // Show confirmation
      const labels = { wrong_answer: 'wrong answer', ambiguous: 'ambiguous', offensive: 'offensive', other: 'other' };
      const confirmEl = document.getElementById('feedback-flag-confirm');
      confirmEl.textContent = `Flagged as ${labels[reason] || reason} \u2713`;
      confirmEl.classList.remove('show');
      void confirmEl.offsetHeight;
      confirmEl.classList.add('show');

      const q = state.questions[state.currentQuestion];
      if (q) {
        _qbFeedback[q.id] = 'flag';
        upsertQuestionFeedback({
          questionId: q.id,
          roomId: state.room.id,
          playerName: getDisplayName(),
          feedbackType: 'flag',
          flagReason: reason
        });
      }

      startFeedbackFadeTimer();
    });
  });

  // Close flag menu on outside click
  _flagMenuCloseHandler = () => { flagMenu.style.display = 'none'; };
  document.addEventListener('click', _flagMenuCloseHandler);
}

// ============================================
// STALE PLAYER AUTO-KICK (5 min disconnect → removed)
// ============================================
const STALE_TIMEOUT = 30 * 1000; // 30 seconds — fast fallback for when unload beacons fail

function checkStalePresence() {
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
}

// ============================================
// QUESTION BROWSER (between-rounds bottom sheet)
// ============================================

let _qbFeedback = {}; // { questionId: feedbackType }

function openQuestionBrowser() {
  const sheet = $('#question-browser-sheet');

  // Render immediately with whatever feedback we have
  renderQuestionBrowserList();
  sheet.classList.add('active');

  // Fetch existing feedback for this player (async update)
  fetchQuestionFeedback(state.room.id, getDisplayName()).then(ratings => {
    _qbFeedback = {};
    for (const r of ratings) _qbFeedback[r.question_id] = r.feedback_type;
    renderQuestionBrowserList();
  });

  sheet.querySelector('.bottom-sheet__backdrop').onclick = closeQuestionBrowser;
  sheet.querySelector('.bottom-sheet__handle').onclick = closeQuestionBrowser;
}

function closeQuestionBrowser() {
  $('#question-browser-sheet').classList.remove('active');
}

function renderQuestionBrowserList() {
  const list = $('#question-browser-list');
  const indices = state.shownQuestionIndices;

  list.innerHTML = indices.map(i => {
    const q = state.questions[i];
    if (!q) return '';
    const isFinal = i === state.totalQuestions;
    const label = isFinal ? 'Final' : `Q${i + 1}`;
    const text = getQuestionText(q);
    const answer = getCorrectAnswer(q);
    const qId = q.id;
    const current = _qbFeedback[qId] || null;

    return `
      <div class="qb-row">
        <div class="qb-row__header">
          <span class="qb-row__number">${escapeHtml(label)}</span>
          <div class="qb-row__actions">
            <button data-qid="${qId}" data-fb="thumbs_up" class="${current === 'thumbs_up' ? 'qb-active' : ''}" aria-label="Thumbs up">\uD83D\uDC4D</button>
            <button data-qid="${qId}" data-fb="thumbs_down" class="${current === 'thumbs_down' ? 'qb-active' : ''}" aria-label="Thumbs down">\uD83D\uDC4E</button>
            <button data-qid="${qId}" data-fb="flag" class="${current === 'flag' ? 'qb-active' : ''}" aria-label="Flag">\uD83D\uDEA9</button>
            <div class="qb-flag-menu" style="display:none;">
              <button data-qid="${qId}" data-flag-reason="wrong_answer">Wrong answer</button>
              <button data-qid="${qId}" data-flag-reason="ambiguous">Ambiguous</button>
              <button data-qid="${qId}" data-flag-reason="offensive">Offensive</button>
              <button data-qid="${qId}" data-flag-reason="other">Other</button>
            </div>
          </div>
        </div>
        <div class="qb-row__text">${escapeHtml(text)}</div>
        <div class="qb-row__answer">${escapeHtml(answer)}</div>
      </div>
    `;
  }).join('');
}

// Feedback button delegation
$('#question-browser-list').addEventListener('click', (e) => {
  // --- Flag reason sub-option selected ---
  const reasonBtn = e.target.closest('[data-flag-reason]');
  if (reasonBtn) {
    e.stopPropagation();
    const qId = reasonBtn.dataset.qid;
    const reason = reasonBtn.dataset.flagReason;
    const actions = reasonBtn.closest('.qb-row__actions');

    // Mark flag as active, deactivate siblings
    actions.querySelectorAll('[data-fb]').forEach(b => b.classList.remove('qb-active'));
    const flagBtn = actions.querySelector('[data-fb="flag"]');
    if (flagBtn) flagBtn.classList.add('qb-active');
    _qbFeedback[qId] = 'flag';

    upsertQuestionFeedback({
      questionId: qId,
      roomId: state.room.id,
      playerName: getDisplayName(),
      feedbackType: 'flag',
      flagReason: reason
    });

    // Hide dropdown
    reasonBtn.closest('.qb-flag-menu').style.display = 'none';
    return;
  }

  // --- Thumbs up / down / flag button ---
  const btn = e.target.closest('[data-fb]');
  if (!btn) return;
  const qId = btn.dataset.qid;
  const fbType = btn.dataset.fb;
  const current = _qbFeedback[qId];

  // Flag button: toggle dropdown instead of immediate submit
  if (fbType === 'flag') {
    e.stopPropagation();
    const menu = btn.parentElement.querySelector('.qb-flag-menu');
    // Close any other open flag menus first
    document.querySelectorAll('.qb-flag-menu').forEach(m => {
      if (m !== menu) m.style.display = 'none';
    });
    if (current === 'flag') {
      // Already flagged — unflag
      _qbFeedback[qId] = null;
      btn.classList.remove('qb-active');
      menu.style.display = 'none';
      deleteQuestionFeedback({ questionId: qId, roomId: state.room.id, playerName: getDisplayName() });
    } else {
      // Show dropdown for reason selection
      menu.style.display = menu.style.display === 'none' ? '' : 'none';
    }
    return;
  }

  // Thumbs up / down (unchanged logic)
  if (current === fbType) {
    _qbFeedback[qId] = null;
    btn.classList.remove('qb-active');
    deleteQuestionFeedback({ questionId: qId, roomId: state.room.id, playerName: getDisplayName() });
  } else {
    btn.parentElement.querySelectorAll('[data-fb]').forEach(b => b.classList.remove('qb-active'));
    // Close any open flag menus
    btn.parentElement.querySelectorAll('.qb-flag-menu').forEach(m => { m.style.display = 'none'; });
    _qbFeedback[qId] = fbType;
    btn.classList.add('qb-active');
    upsertQuestionFeedback({
      questionId: qId,
      roomId: state.room.id,
      playerName: getDisplayName(),
      feedbackType: fbType
    });
  }
});

// Wire up the browser icon
$('#btn-question-browser').onclick = openQuestionBrowser;

// Swipe-down to dismiss bottom sheet
(function initSheetSwipe() {
  const panel = document.querySelector('.bottom-sheet__panel');
  if (!panel) return;
  let startY = 0;
  panel.addEventListener('touchstart', (e) => {
    if (panel.scrollTop <= 0) startY = e.touches[0].clientY;
  }, { passive: true });
  panel.addEventListener('touchmove', (e) => {
    const dy = e.touches[0].clientY - startY;
    if (dy > 0 && panel.scrollTop <= 0) {
      panel.style.transition = 'none';
      panel.style.transform = `translateY(${dy}px)`;
    }
  }, { passive: true });
  panel.addEventListener('touchend', () => {
    const current = parseFloat(panel.style.transform.replace(/[^0-9.-]/g, '')) || 0;
    panel.style.transition = '';
    panel.style.transform = '';
    if (current > 80) closeQuestionBrowser();
  });
})();

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
  _isLeaving = true;
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

  // When tab becomes visible again, sync to current game state.
  // Supabase Realtime does NOT replay missed messages after a disconnect,
  // so we fetch from DB to catch up if the game advanced while we were away.
  if (!document.hidden && state.room && state.gamePhase !== 'loading') {
    syncToCurrentState();
  }
}

/**
 * Fetch current room state from DB and sync local state if the game has
 * advanced (different question or phase). Handles both brief disconnections
 * and tab-hidden gaps where Realtime messages were missed.
 */
let _syncInFlight = false;
async function syncToCurrentState() {
  if (_syncInFlight) return; // Prevent overlapping syncs
  _syncInFlight = true;
  try {
    const { data: roomData } = await fetchRoom(state.room.id);
    if (!roomData || !roomData.game_phase) return;

    // Room returned to lobby while we were away
    if (roomData.status === 'lobby') {
      _isLeaving = true;
      cleanup();
      window.location.href = 'lobby.html';
      return;
    }

    const questionChanged = roomData.current_question !== undefined &&
                            roomData.current_question !== state.currentQuestion;

    // Only sync on question changes. Phase-only changes on the same question
    // are NOT safe to sync because the local state can legitimately be AHEAD
    // of the DB (e.g., host sets gamePhase = 'answer_reveal' locally before
    // the DB write completes, or player entered reveal screen before host
    // broadcasts). Realtime handles phase-only updates; sync is the safety
    // net for missed question transitions.
    if (!questionChanged) return;

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
      state.usedWagers = new Set();
      for (const a of myAnswers) {
        state.usedWagers.add(a.wager);
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
    console.error('[Game] syncToCurrentState failed:', err);
  } finally {
    _syncInFlight = false;
  }
}

// ============================================
// CLEANUP (shared teardown for all exit paths)
// ============================================

function cleanup() {
  window.removeEventListener('popstate', handleBackButton);
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  destroyHonkSystem();
  if (state.timerId) {
    clearInterval(state.timerId);
    state.timerId = null;
  }
  if (state.stalePollId) {
    clearInterval(state.stalePollId);
    state.stalePollId = null;
  }
  if (state._hotJoinPollId) {
    clearInterval(state._hotJoinPollId);
    state._hotJoinPollId = null;
  }
  if (state.presenceHeartbeatId) {
    clearInterval(state.presenceHeartbeatId);
    state.presenceHeartbeatId = null;
  }
  if (state._syncIntervalId) {
    clearInterval(state._syncIntervalId);
    state._syncIntervalId = null;
  }
  if (_flagMenuCloseHandler) {
    document.removeEventListener('click', _flagMenuCloseHandler);
    _flagMenuCloseHandler = null;
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
init();
