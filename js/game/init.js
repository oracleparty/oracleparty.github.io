// ============================================
// Oracle Party — Game Init
// Entry point, startup, cleanup, sync, lifecycle.
// ============================================

import { $, navigateWithFade, navigateWithFadeReplace, notifyConnectionLost, notifyConnectionRestored } from '../utils.js';
import { logger } from '../logger.js';
import { presenceNeedsRebuild } from '../presence-health.js';
import { LOBBY_POLL_INTERVAL, STALE_CHECK_INTERVAL, STATE_SYNC_INTERVAL, HEARTBEAT_DB_INTERVAL_MS, PLAYER_INIT_WAIT_MS, PLAYER_READY_CONFIRM_MS, STALE_TIMEOUT_MS } from '../constants.js';
import {
  claimSeat,
  fetchPlayers,
  fetchQuestionsByCategory,
  fetchQuestionsByIds,
  supabase,
  updateGameState,
  fetchAllAnswers,
  fetchRoom,
  subscribeToRoom,
  subscribeToAnswers,
  subscribeToMessages,
  unsubscribe,
  getServerTimeOffset,
  createPresenceChannel,
  removePlayer,
  removePlayerBeacon,
  markDisconnectedBeacon,
  playerHeartbeat,
  deleteRoom,
  deleteRoomBeacon,
  leaveRoomBeacon,
  leaveRoomOnServer,
  serverFunctionsMissing,
  subscribeToPlayers,
  reassignPlayerAnswers,
  appendUsedQuestionIds,
  fetchAllOpenQuestions,
  fetchExclusiveWildCardQuestions,
  fetchQuestionFeedback
} from '../supabase.js';
import { getDisplayName, ensureDisplayName, initAuth, getCurrentUser, getVoterId,
         rememberSeat, recallSeat } from '../auth.js';
import { initHonkSystem, sendHonk, destroyHonkSystem } from '../honk.js';
import { initTypingIndicator, destroyTypingIndicator } from '../typing.js';
import { updatePresence } from '../presence.js';
import { attachProfileCardHandler } from '../profile.js';
import {
  state,
  resolveFieldMap,
  _flagMenuCloseHandler, setFlagMenuCloseHandler,
  _isLeaving, setIsLeaving,
  _syncInFlight, setSyncInFlight,
  _qbFeedback,
} from './state.js';
import { buildDisqualifiedSet, buildUsedWagersMap } from './scoring-helpers.js';
import {
  attachChatListeners, loadChatMessages, handleNewMessage,
  updateTypingUI,
} from './chat.js';
import {
  initHostSettingsPanel, hideHostSettingsGear,
  resetReturnConfirm, registerCleanup as registerHostCleanup,
} from './host.js';
import {
  showQuestionScreen,
  registerShowRevealScreen, registerRevealHelpers,
} from './question.js';
import {
  showRevealScreen, enableRevealButton,
  enableNextQuestion, updateRevealButtonText,
  updateHonkBadges, handleNextQuestion, initFeedbackListeners,
  registerScoresRef as registerRevealScoresRef,
} from './reveal.js';
import {
  handleShowScores, showResultsScreen, updateScores, clearAutoProceed,
  clearFinalWagerTimer,
  registerCleanup as registerScoresCleanup,
  registerShowQuestionScreen as registerScoresShowQuestionScreen,
  registerHandleNextQuestion as registerScoresHandleNextQuestion,
} from './scores.js';
import {
  handlePhaseTransition, handleRoomChange, handlePlayerChange,
  handleAnswerChange, checkStalePresence, showCountdownScreen,
  registerCleanup as registerPhasesCleanup,
} from './phases.js';

// ============================================
// FEEDBACK PREFETCH
// ============================================

/** Load any previous feedback this player gave on these questions. */
async function prefetchFeedback() {
  try {
    const ratings = await fetchQuestionFeedback(getVoterId());
    for (const r of ratings) {
      _qbFeedback[r.question_id] = {
        type: r.feedback_type,
        reason: r.flag_reason || null
      };
    }
  } catch (e) {
    logger.error('Init', 'prefetchFeedback failed', e);
  }
}

// ============================================
// INIT
// ============================================

async function init() {
  // Cancel the boot-guard timer in <head> — JS module chain is alive.
  window.__appReady = true;
  if (window.__appBootGuard) clearTimeout(window.__appBootGuard);
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

  // If room is back in lobby (e.g. host hit Play Again while we were navigating
  // to game.html), redirect to lobby. Without this, the host would inadvertently
  // start a new game, and non-hosts would hang on the loading screen waiting for
  // question_ids that were just cleared by the lobby reset.
  // Guard on status only. status is the authoritative "is a game running"
  // flag; game_phase lags behind it.
  //
  // Play Again sets game_phase to 'lobby', and starting the next game flips
  // status to 'playing' without clearing that. Including game_phase here
  // therefore bounced everyone straight back to the lobby on the second game
  // of any session — the most common thing players do — and no second game
  // could ever begin.
  //
  // The case this guard exists for (the host hits Play Again while we are
  // still navigating to game.html) sets BOTH fields, so status alone still
  // catches it.
  if (roomCheck.status === 'lobby') {
    sessionStorage.setItem('oracle_party_returning_from_game', '1');
    window.location.replace('lobby.html');
    return;
  }

  // Session resume: since handleUnload now marks disconnected_at instead of deleting,
  // the player row should still exist after a refresh. Clear the disconnect flag.
  const me = state.players.find(p => String(p.id) === String(state.room.playerId));
  if (me) {
    // Player row exists — clear disconnected_at and refresh last_seen_at immediately
    if (me.disconnected_at) {
      await playerHeartbeat(state.room.playerId);
    }
  } else {
    // Player row genuinely missing (stale timeout removed them, or explicit kick).
    // Fall back to re-join logic.
    const displayName = getDisplayName();

    // ONE PERSON, ONE SEAT — and this was the last copy of the ratchet.
    //
    // The old code here adopted an existing row only when there was EXACTLY ONE
    // name match and otherwise added another. At two duplicates it made a
    // third, at three a fourth, and it could never get back to the one case it
    // knew how to handle — every return added another copy for the life of the
    // room. That is the bug reported from a live game as three copies of one
    // player, all flagged host.
    //
    // join.html and the lobby were fixed by routing both through claimSeat.
    // This third call site was missed, so refreshing on the GAME screen still
    // ratcheted. claimSeat is the single path now: a user id is exact and its
    // duplicates are cleared; a guest's same-name row is only adopted once it
    // has gone quiet, because a live one might genuinely be somebody else.
    //
    // AND IT MUST NOT RE-CROWN ITSELF. state.room.isHost comes from
    // sessionStorage, so a host whose row was swept — after somebody else was
    // promoted — used to come back and add a SECOND row flagged host. That is
    // the other half of the photographed "two hosts in the lobby". If a host is
    // already here and it is not us, we return as an ordinary player.
    const prevPlayerId = state.room.playerId || recallSeat(state.room.id);
    const authUser = getCurrentUser();
    const rejoinUserId = authUser?.user?.id || null;
    const extras = {};
    if (authUser?.profile) {
      extras.avatarColor = authUser.profile.avatar_color;
      extras.avatarEmoji = authUser.profile.avatar_emoji;
      extras.title = authUser.profile._cachedTitle || null;
    }

    const stale = Date.now() - STALE_TIMEOUT_MS;
    const seenAt = p => new Date(p.last_seen_at || p.joined_at || 0).getTime();
    // A missing timestamp means CANNOT TELL, and cannot-tell counts as HERE —
    // the same rule as everywhere else in this project. Treating absence of
    // evidence as evidence of absence once had hosts kicking every player.
    const someoneElseIsHost = state.players.some(p =>
      p.is_host && !p.is_bot
      && String(p.id) !== String(prevPlayerId)
      && (!(p.last_seen_at || p.joined_at) || seenAt(p) > stale));

    const { data: rejoinedPlayer } = await claimSeat({
      roomId: state.room.id,
      displayName,
      userId: rejoinUserId,
      isHost: state.room.isHost && !someoneElseIsHost,
      extras,
      // Exact when it is there. This branch runs because our own row went
      // missing from the list we fetched, but a row carrying the remembered id
      // may have arrived since — and adopting it beats adding another seat.
      priorPlayerId: prevPlayerId,
    });

    if (rejoinedPlayer) {
      const changedSeat = String(rejoinedPlayer.id) !== String(prevPlayerId);
      state.room.playerId = rejoinedPlayer.id;
      if (someoneElseIsHost) state.room.isHost = false;
      sessionStorage.setItem('oracle_party_room', JSON.stringify(state.room));
      state.players = await fetchPlayers(state.room.id);

      if (changedSeat) await reassignPlayerAnswers(state.room.id, prevPlayerId, rejoinedPlayer.id);

      const allAnswers = await fetchAllAnswers(state.room.id);
      const myAnswers = allAnswers.filter(a => String(a.player_id) === String(rejoinedPlayer.id));
      state.disqualifiedQuestions = buildDisqualifiedSet(allAnswers);
      state.usedWagers = buildUsedWagersMap(myAnswers, state.totalQuestions, state.disqualifiedQuestions);
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
  buildPresenceChannel();
  document.addEventListener('visibilitychange', handleVisibilityChange);

  // Heartbeat: re-announce presence, and REBUILD the channel if it has died.
  //
  // Re-announcing alone was not enough, and that is the bug this fixes. A
  // backgrounded phone has its WebSocket suspended; on return the track() call
  // failed on a dead channel, the failure was swallowed by `.catch(() => {})`,
  // and nothing ever checked. The player stayed greyed out for the whole room
  // AND saw the whole room greyed out back — the symmetry a playtest reported,
  // and the tell that it is a dead socket rather than a state error.
  state.presenceHeartbeatId = setInterval(beatPresence, LOBBY_POLL_INTERVAL);

  // DB heartbeat: update last_seen_at every 15s for stale detection.
  // Also sends an immediate heartbeat to clear any disconnected_at from a prior refresh.
  playerHeartbeat(state.room.playerId).catch(() => {});
  state._dbHeartbeatId = setInterval(() => {
    playerHeartbeat(state.room.playerId).catch(() => {});
  }, HEARTBEAT_DB_INTERVAL_MS);

  // Poll for stale disconnected players (auto-kick after timeout)
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

  // Reclaim a previous seat in this room, whatever route brought us back.
  //
  // The rejoin branch above only fires when our own player row is missing. A
  // player who returns through the join screen arrives with a brand new row
  // already created, so that branch is skipped and every answer they had
  // given stays orphaned on the seat they lost. Reconciling here covers both
  // routes.
  const priorSeat = recallSeat(state.room.id);
  if (priorSeat && String(priorSeat) !== String(state.room.playerId)) {
    const stillThere = state.players.some(p => String(p.id) === String(priorSeat));
    if (!stillThere) {
      await reassignPlayerAnswers(state.room.id, priorSeat, state.room.playerId);
      logger.info('Init', 'reclaimed answers from a previous seat in this room');
    }
  }
  rememberSeat(state.room.id, state.room.playerId);

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
    prefetchFeedback(); // fire-and-forget: restore previous ratings

    // Detect final wager phases
    if (['final_wager', 'final_question'].includes(roomData.game_phase)) {
      state.isFinalWagerRound = true;
    }

    // Rebuild used wagers from existing answers (clear first to prevent stale data)
    const allAnswers = await fetchAllAnswers(state.room.id);
    const myAnswers = allAnswers.filter(a => String(a.player_id) === String(state.room.playerId));
    state.disqualifiedQuestions = buildDisqualifiedSet(allAnswers);
    state.usedWagers = buildUsedWagersMap(myAnswers, state.totalQuestions, state.disqualifiedQuestions);
    // Recover final wager value if locked in
    const fwAnswer = myAnswers.find(a => a.question_number === state.totalQuestions);
    if (fwAnswer) {
      state.finalWager = fwAnswer.wager;
      state.finalWagerLocked = true;
    }

    if (roomData.question_started_at) {
      state.questionStartedAt = roomData.question_started_at;
    }

    // Hydrate scores from the answers already in the database. Without this the
    // host's own scoreboard reads all zeros after a refresh: line ~222 sets
    // every score to 0 as a baseline, and only applyGameState — the NON-host
    // reconnect path — ever recomputed them. Two paths doing the same job, one
    // of which forgot half of it. Reported from a playtest as "upon players
    // refreshing ... reset scores to zero also".
    await updateScores();

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

  // Need at least 2 questions: 1 regular round + 1 final wager round.
  // With 1 question, the game would start but then ask for state.questions[1]
  // at the final wager phase and break.
  if (questions.length < 2) {
    const loadingEl = document.querySelector('#game-loading .game-loading__text');
    if (loadingEl) {
      loadingEl.textContent = questions.length === 0
        ? 'No questions found for this category.'
        : 'Not enough questions in this category — need at least 2.';
      const backBtn = document.createElement('button');
      backBtn.className = 'btn btn-secondary';
      backBtn.textContent = 'Back to Lobby';
      backBtn.style.marginTop = 'var(--space-lg)';
      backBtn.onclick = () => {
        setIsLeaving(true);
        cleanup();
        sessionStorage.setItem('oracle_party_returning_from_game', '1');
        navigateWithFadeReplace('lobby.html');
      };
      loadingEl.after(backBtn);
    }
    return;
  }

  // If we got fewer than requested, adjust totalQuestions (the extra is for final wager)
  if (questions.length <= state.totalQuestions) {
    state.totalQuestions = Math.max(1, questions.length - 1);
  }
  state.questions = questions;
  resolveFieldMap(questions[0]);
  prefetchFeedback(); // fire-and-forget: restore previous ratings

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
    const loadingEl = document.querySelector('#game-loading .game-loading__text');
    if (loadingEl) loadingEl.textContent = 'Waiting for host...';
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
    // After 30s still waiting, show a Back to Lobby option
    setTimeout(() => {
      if (state._hotJoinPollId && loadingEl && !document.getElementById('guest-back-btn')) {
        const backBtn = document.createElement('button');
        backBtn.id = 'guest-back-btn';
        backBtn.className = 'btn btn-secondary';
        backBtn.textContent = 'Back to Lobby';
        backBtn.style.marginTop = 'var(--space-lg)';
        backBtn.onclick = () => {
          clearInterval(state._hotJoinPollId);
          state._hotJoinPollId = null;
          setIsLeaving(true);
          cleanup();
          sessionStorage.setItem('oracle_party_returning_from_game', '1');
          navigateWithFadeReplace('lobby.html');
        };
        loadingEl.after(backBtn);
      }
    }, 30000);
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
  prefetchFeedback(); // fire-and-forget: restore previous ratings

  // Build list of questions shown so far (for question browser on reconnect)
  state.shownQuestionIndices = [];
  for (let i = 0; i <= state.currentQuestion; i++) {
    state.shownQuestionIndices.push(i);
  }

  // Detect final wager phases
  if (['final_wager', 'final_question'].includes(roomData.game_phase)) {
    state.isFinalWagerRound = true;
  }

  // Rebuild disqualified questions and used wagers from existing answers.
  // Disq must come first so usedWagers can correctly skip wagers from disqualified Qs.
  const allAnswers = await fetchAllAnswers(state.room.id);
  const myAnswers = allAnswers.filter(a => String(a.player_id) === String(state.room.playerId));
  state.disqualifiedQuestions = buildDisqualifiedSet(allAnswers);
  state.usedWagers = buildUsedWagersMap(myAnswers, state.totalQuestions, state.disqualifiedQuestions);

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
    // One keepalive request that removes the player and takes the room only if
    // it is now empty. The old pair of beacons made that judgement on this
    // phone, from a player list that may be seconds out of date.
    if (!serverFunctionsMissing()) {
      leaveRoomBeacon(state.room.id, state.room.playerId);
    } else if (state.players.length <= 1) {
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
  // Soft disconnect: mark player as disconnected but DON'T delete.
  // Refresh will resume via sessionStorage; tab close will be cleaned up
  // by stale check after DISCONNECTED_TIMEOUT_MS.
  if (state.room && state.room.playerId) {
    markDisconnectedBeacon(state.room.playerId);
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

// ============================================
// PRESENCE CHANNEL
//
// Built through a function rather than inline because it has to be REBUILDABLE.
// supabase-js throws "tried to subscribe multiple times" on a channel that has
// already joined once, so a channel whose socket died cannot be revived — the
// only way back is a new one.
// ============================================

function applyAwayClasses() {
  const isAway = row => state.awayTimestamps.has(String(row.dataset.playerId));
  document.querySelectorAll('#reveal-answers .answer-row').forEach(row => {
    row.classList.toggle('answer-row--away', isAway(row));
  });
  document.querySelectorAll('#scores-animated-list .score-anim-row').forEach(row => {
    row.classList.toggle('score-anim-row--away', isAway(row));
  });
  document.querySelectorAll('#results-list .results-row').forEach(row => {
    row.classList.toggle('results-row--away', isAway(row));
  });
  document.querySelectorAll('#fw-player-list .fw-player-row').forEach(row => {
    row.classList.toggle('fw-player-row--away', isAway(row));
  });
  // The word, not just the fade. 40% opacity alone is ambiguous — it reads as
  // away, gone, disabled or still loading, and a playtest could not tell which.
  document.querySelectorAll('[data-away-label]').forEach(el => {
    el.textContent = state.awayTimestamps.has(String(el.dataset.awayLabel)) ? 'Away' : '';
  });
}

function buildPresenceChannel() {
  const channel = createPresenceChannel(state.room.id, String(state.room.playerId));
  state.presenceChannel = channel;

  channel
    .on('presence', { event: 'sync' }, () => {
      // Read from the channel this handler belongs to, not from
      // state.presenceChannel — a rebuild swaps that out, and a late sync from
      // the old channel would otherwise read the new one's empty state and
      // grey out the entire room.
      const ps = channel.presenceState();
      const connectedActive = new Set();
      for (const key of Object.keys(ps)) {
        for (const p of ps[key]) {
          if (!p.is_away) connectedActive.add(String(p.player_id));
        }
      }
      if (state.presenceChannel !== channel) return;

      const newAway = new Map();
      for (const p of state.players) {
        const id = String(p.id);
        // A bot joins no presence channel, so it is permanently "not
        // connected". Faded at 40% opacity through every reveal and scoreboard
        // it would read as the player everyone is waiting on, when it is the
        // one that has always already answered.
        if (p.is_bot) continue;
        if (!connectedActive.has(id)) {
          newAway.set(id, state.awayTimestamps.get(id) || Date.now());
        }
      }
      state.awayTimestamps = newAway;
      checkStalePresence();
      applyAwayClasses();
    })
    .subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        state.presenceReady = true;
        notifyConnectionRestored();
        await channel.track({ player_id: state.room.playerId, is_away: document.hidden })
          .catch(() => {});
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        state.presenceReady = false;
        notifyConnectionLost();
      }
    });

  // Registered for cleanup. beatPresence removes the dead one before calling
  // here, so a rebuild swaps rather than accumulates — scenario-fullgame counts
  // live subscriptions after a game and fails on a leak.
  if (!state.channels.includes(channel)) state.channels.push(channel);
  return channel;
}

/**
 * One presence beat: rebuild if the channel is dead, otherwise re-announce.
 *
 * A rebuild does its own track() from the subscribe callback, so this returns
 * rather than announcing on a channel that is still joining.
 */
async function beatPresence() {
  if (!state.presenceChannel) return;
  if (presenceNeedsRebuild(state.presenceChannel)) {
    logger.warn('Game', 'presence channel died — rebuilding', { state: state.presenceChannel.state });
    const dead = state.presenceChannel;
    const at = state.channels.indexOf(dead);
    try { dead.unsubscribe(); } catch { /* already gone */ }
    if (at !== -1) state.channels.splice(at, 1);
    state.presenceChannel = null;
    buildPresenceChannel();
    return;
  }
  try {
    await state.presenceChannel.track({ player_id: state.room.playerId, is_away: document.hidden });
  } catch (err) {
    // Not swallowed any more. A failing track on a channel that still claims to
    // be joined is the case this whole fix exists for, and it used to be
    // invisible.
    logger.warn('Game', 'presence track failed', err);
  }
}

function handleVisibilityChange() {
  if (!state.presenceChannel) return;
  // Coming back is exactly when the channel is most likely to be dead, so heal
  // here rather than waiting up to 15s for the next beat — that wait is the
  // window a returning player spends still greyed out to everybody.
  beatPresence();

  if (document.hidden) {
    // Track that we went hidden — syncToCurrentState needs to know
    state._wasHidden = true;
    return;
  }

  // Tab became visible — send immediate DB heartbeat so other clients
  // see us as alive right away (don't wait for 15s interval).
  playerHeartbeat(state.room.playerId).catch(() => {});

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

    // IS THIS PHONE EVEN LOOKING AT THE RIGHT QUESTIONS?
    //
    // This poll is the safety net for a Realtime event that never arrived, and
    // it caught up the phase and the question NUMBER but never the question
    // LIST. The host swaps the final question for one matching the difficulty
    // vote and broadcasts a new list; miss that single update and there was
    // nothing to correct it — the player sat on their own pre-fetched question
    // for the rest of the round.
    //
    // It became far worse when the server started judging (migration 046),
    // because the verdict comes from the room's question, not the one on the
    // screen. So a player answered a question nobody else was asked and was
    // marked wrong on one they never saw. Reported from a live game as
    // receiving "a different final question entirely".
    const serverIds = Array.isArray(roomData.question_ids) ? roomData.question_ids : null;
    const listChanged = serverIds && serverIds.length > 0 && state.questions.length > 0
      && (serverIds.length !== state.questions.length
          || serverIds.some((id, i) => String(state.questions[i]?.id) !== String(id)));
    if (listChanged) {
      logger.warn('Game', 'the room is asking different questions from this screen — refetching');
      const fresh = await fetchQuestionsByIds(serverIds).catch(() => []);
      if (fresh.length > 0) {
        state.questions = fresh;
        // Force a re-render even if the round number did not move: the question
        // on screen is the thing that is wrong.
        state._renderedQuestion = null;
      }
    }

    const wasHidden = state._wasHidden;
    state._wasHidden = false;

    // Phase-only sync when returning from hidden tab.
    // Realtime may have missed messages while the tab was hidden, so we need
    // to catch up on phase transitions even if the question hasn't changed.
    if (!questionChanged && listChanged &&
        ['question', 'final_question'].includes(roomData.game_phase)) {
      // The round number is the same but the QUESTION is not, so the screen has
      // to be redrawn even though nothing else moved.
      handlePhaseTransition(roomData.game_phase);
      return;
    }

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

      // Rebuild disqualified questions and usedWagers from DB
      // (host may have auto-submitted wagers for questions we missed)
      const allAnswers = await fetchAllAnswers(state.room.id);
      const myAnswers = allAnswers.filter(a => String(a.player_id) === String(state.room.playerId));
      state.disqualifiedQuestions = buildDisqualifiedSet(allAnswers);
      state.usedWagers = buildUsedWagersMap(myAnswers, state.totalQuestions, state.disqualifiedQuestions);

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
  if (state._dbHeartbeatId) {
    clearInterval(state._dbHeartbeatId);
    state._dbHeartbeatId = null;
  }
  if (state._syncIntervalId) {
    clearInterval(state._syncIntervalId);
    state._syncIntervalId = null;
  }
  clearAutoProceed();
  clearFinalWagerTimer();
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
registerPhasesCleanup(cleanup);
init();
