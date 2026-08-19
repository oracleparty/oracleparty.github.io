// ============================================
// Oracle Party — Phases Module
// Phase router, room/player changes, countdown, stale check, answer dispatch.
// ============================================

import { $, transitionScreens, escapeHtml, navigateWithFadeReplace } from '../utils.js';
import { findNextAvailableWager } from './scoring-helpers.js';
import { getCountdownElapsed } from './timer-helpers.js';
import { determineNextHost, findAbsentPlayers } from './host-promotion.js';
import { logger } from '../logger.js';
import { COUNTDOWN_DELAY_MS, COUNTDOWN_STEP_MS, COUNTDOWN_TRANSITION_MS, COUNTDOWN_FINISH_MS, STALE_TIMEOUT_MS, DISCONNECTED_TIMEOUT_MS, HOST_HANDOVER_MS } from '../constants.js';
import {
  updateGameState,
  fetchQuestionsByIds,
  fetchAnswersForQuestion,
  fetchPlayers,
  fetchRoom,
  sendMessage,
  removePlayer,
  deleteRoom,
  promoteToHost,
  insertGamePlay,
  demoteCohost,
  demoteHost,
} from '../supabase.js';
import { getDisplayName } from '../auth.js';
import {
  state, canControlGame,
  resolveFieldMap,
  _isLeaving, setIsLeaving,
  setLastScoresRendered,
  _countdownActive, setCountdownActive,
  _deferredPhase, setDeferredPhase,
  _staleCheckCount, setStaleCheckCount,
} from './state.js';
import { showChatBar, hideChatBar } from './chat.js';
import { initHostSettingsPanel, showHostSettingsGear, hideHostSettingsGear } from './host.js';
import { showQuestionScreen, doSubmitAnswer, startTimer } from './question.js';
import {
  showRevealScreen, renderRevealAnswers, enableRevealButton,
  updateRevealButtonText, handleJudgmentOverride, doReveal,
  handleNextQuestion,
} from './reveal.js';
import {
  showScoresScreen, showFinalWagerScreen, showResultsScreen,
  updateScores, updateFinalWagerPlayerList, handleRevealFinalQuestion,
  showScoreEditSheet,
} from './scores.js';

// Forward reference — registered by init.js to avoid circular imports
let _cleanup = null;
export function registerCleanup(fn) { _cleanup = fn; }

// ============================================
// PLAYER CHANGE HANDLER
// ============================================

export async function handlePlayerChange(payload) {
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
    const nextHost = determineNextHost(state.players, findAbsentPlayers(state.players, HOST_HANDOVER_MS));
    if (nextHost && String(nextHost.id) === String(state.room.playerId)) {
      // Cross-client race guard — another client may have already promoted
      // itself before our DELETE event arrived. Re-fetch and bail if a host
      // already exists. Otherwise we'd both promote and end up with two hosts.
      const fresh = await fetchPlayers(state.room.id);
      if (fresh.some(p => p.is_host)) {
        state.players = fresh;
      } else {
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
    // Use showRevealScreen() to install the correct button handlers based on
    // current state (handleRevealResults pre-reveal, handleShowScores after
    // reveal). The previous code nulled the onclick when state.resultsRevealed
    // was true with a comment saying "Will be set by the scores advancement
    // handler" — but no later code actually set it, leaving the new host with
    // a dead button. showRevealScreen short-circuits the screen transition
    // when we're already on it, so it's safe to re-invoke here.
    showRevealScreen();
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

export function handleRoomChange(payload) {
  // Room deleted (last player left) — kick to home
  if (payload.eventType === 'DELETE') {
    setIsLeaving(true); // Room already gone — prevent handleUnload beacon
    if (_cleanup) _cleanup();
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

  // When the host starts a NEW game while this player is still on results,
  // show a notification instead of auto-pulling them in.
  //
  // A new game means the room moved to some phase OTHER than results. Testing
  // only our own gamePhase caught the host's own write: handleShowResults sets
  // state.gamePhase = 'results' before writing game_phase = 'results', so the
  // echo of that write matched this condition, was mistaken for a new game,
  // and — because showResultsScreen() is still awaiting network calls, leaving
  // #results-screen hidden — _showNewGameNotice() navigated the host straight
  // to the lobby.
  //
  // The host therefore never saw their own results, and never pressed "Back to
  // Lobby", which is the only thing that clears answers and returns the room to
  // lobby. Every room was left holding a finished game's state.
  if (status === 'playing' && state.gamePhase === 'results' && game_phase && game_phase !== 'results') {
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
    try { if (_cleanup) _cleanup(); } catch (_) {}
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
    try { if (_cleanup) _cleanup(); } catch (_) {}
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
    if (_cleanup) _cleanup();
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
    if (_cleanup) _cleanup();
    sessionStorage.setItem('oracle_party_returning_from_game', '1');
    navigateWithFadeReplace('lobby.html');
  };
}

/**
 * Reveal the hidden question elements and start the server-synced timer.
 * Called on non-host clients when they receive question_started_at from host.
 */
export function revealQuestionAndStartTimer() {
  $('.question-card').style.visibility = '';
  $('#wager-grid').style.visibility = '';
  $('#answer-form').style.visibility = '';
  $('#wager-error').style.visibility = '';
  $('.timer').style.visibility = '';

  startTimer();
  $('#answer-input').focus({ preventScroll: true });
}

export async function handlePhaseTransition(phase) {
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
        subcategory: state.room.subcategory || null,
        totalQuestions: state.totalQuestions,
        // Identifies WHICH round this is. The room is reused across Play
        // Again, so without it every round in a room is the same play.
        gameKey: state.countdownStartedAt || null
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
          state.currentWager = findNextAvailableWager(state.usedWagers, state.totalQuestions);
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
          state.currentWager = findNextAvailableWager(state.usedWagers, state.totalQuestions);
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

export function showCountdownScreen() {
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
    return getCountdownElapsed(state.countdownStartedAt, state.serverTimeOffset);
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

    // Self-healing fallback: if the host quit mid-countdown and the next-host
    // promotion landed too late to fire the question phase update, the room
    // would be stuck on 'countdown' forever. After 3s, any connected client
    // re-checks the DB phase and force-advances. updateGameState is idempotent
    // (multiple clients writing game_phase='question' converge to same state).
    setTimeout(async () => {
      if (_isLeaving || state.gamePhase !== 'countdown') return;
      try {
        const { data: r } = await fetchRoom(state.room.id);
        if (r && r.game_phase === 'countdown') {
          updateGameState(state.room.id, { game_phase: 'question', current_question: 0 })
            .catch(e => logger.warn('Game', 'countdown self-heal failed', e));
        }
      } catch (_) {}
    }, 3000);
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

export function handleAnswerChange(payload) {
  // On the scores screen, ignore answers arriving (INSERT) — that is just the
  // next round's submissions landing behind the scoreboard, and re-rendering on
  // each one made the animation stutter.
  //
  // A host's retroactive correction is an UPDATE, though, and it was being
  // swallowed by the same guard. The host saw their own edit because they
  // re-render locally; nobody else's scoreboard ever moved, so the room walked
  // away disagreeing about the score. Same fault the results screen already had
  // fixed below.
  if (state.gamePhase === 'scores_reveal') {
    if (payload.eventType === 'UPDATE' && payload.new) {
      updateScores().then(() => {
        setLastScoresRendered(-1);
        showScoresScreen();
      }).catch(err => logger.error('Game', 'Failed to apply score correction', err));
    }
    return;
  }

  // During final wager screen, update the player wager list
  if (state.gamePhase === 'final_wager') {
    if (payload.eventType === 'INSERT' && payload.new && payload.new.submitted_answer === '__WAGER_LOCKED__') {
      updateFinalWagerPlayerList();
    }
    return;
  }

  // On the results screen, host edits via the Review Questions overlay arrive
  // as answer UPDATE events. Without this, non-host results scoreboards never
  // reflect the host's corrections.
  if (state.gamePhase === 'results') {
    if (payload.eventType === 'UPDATE' && payload.new) {
      showResultsScreen();
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
    // Update usedWagers if the judgment change affects the current player's wager.
    // Disqualified questions refund the wager regardless of UPDATE/chat order.
    if (idx !== -1) {
      const answer = state.currentAnswers[idx];
      if (String(answer.player_id) === String(state.room.playerId) && answer.wager) {
        if (state.disqualifiedQuestions.has(answer.question_number)) {
          state.usedWagers.delete(answer.wager);
        } else {
          state.usedWagers.set(answer.wager, !!answer.is_correct);
        }
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

// STALE PLAYER AUTO-KICK
// ============================================
// Uses last_seen_at (DB heartbeat) for reliable stale detection.
// Two thresholds:
//   - DISCONNECTED_TIMEOUT_MS (45s): player beacon fired (tab close)
//   - STALE_TIMEOUT_MS (3 min): heartbeat stopped (internet loss / crash)

export async function checkStalePresence() {
  setStaleCheckCount(_staleCheckCount + 1);
  const now = Date.now();

  // See the note in js/lobby.js: without a working last_seen_at heartbeat,
  // every fallback timestamp is frozen at join time and healthy players get
  // kicked minutes into a game. When the evidence is unavailable, do nothing.
  const heartbeatWorking = state.players.some(p => p.last_seen_at);
  if (!heartbeatWorking) return;


  for (const p of state.players) {
    const id = String(p.id);
    if (id === String(state.room.playerId)) continue;
    // A bot has no browser and sends no heartbeat, so every timestamp it has is
    // frozen at the moment it was added. Judged like a player it goes stale
    // partway through the game it was added for and gets swept out mid-round.
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

    // Fast path: beacon fired + heartbeat stopped for 45s → remove
    // Slow path: no beacon but heartbeat stopped for 3 min → remove
    const threshold = hasDisconnected ? DISCONNECTED_TIMEOUT_MS : STALE_TIMEOUT_MS;
    if (silenceMs < threshold) continue;

    if (p.is_host) {
      // Stale host: earliest connected player kicks them (deterministic)
      const connected = state.players
        .filter(pl => {
          const raw = pl.last_seen_at || pl.joined_at;
          const ls = raw ? new Date(raw).getTime() : 0;
          // No timestamp: treat as connected rather than silently excluding them
          // from the promotion ballot, which would leave the room hostless.
          if (!ls) return true;
          return (now - ls) < DISCONNECTED_TIMEOUT_MS && !pl.disconnected_at;
        })
        .sort((a, b) => new Date(a.joined_at) - new Date(b.joined_at));
      if (connected[0] && String(connected[0].id) === String(state.room.playerId)) {
        removePlayer(id);
      }
    } else if (state.room.isHost) {
      // Stale non-host: host kicks them
      removePlayer(id);
    }
  }

  // Re-fetch on every check. Realtime DELETE events can be missed entirely —
  // the room_id filter cannot match a DELETE payload, because default REPLICA
  // IDENTITY sends only the primary key — so this poll is the reliable source
  // of who is still here.
  //
  // This previously ran every third call to save queries. That made the local
  // view of last_seen_at up to 90 seconds out of date, so absence was noticed
  // three times slower than intended and HOST_HANDOVER_MS could not do its
  // job. One small query every 30 seconds is not worth that.
  const freshPlayers = await fetchPlayers(state.room.id);
  if (freshPlayers.length > 0) {
    state.players = freshPlayers;
  }
  // While the host is merely ABSENT, deputise rather than replace. Taking the
  // role from someone who glanced at a notification means they return to find
  // they no longer run their own game. The crown moves only when they actually
  // leave — which arrives as a DELETE and is handled in handlePlayerChange.
  const absent = findAbsentPlayers(state.players, HOST_HANDOVER_MS);
  const hostRow = state.players.find(p => p.is_host);
  const hostAbsent = hostRow && absent.has(String(hostRow.id));

  if (hostRow && !hostAbsent) {
    // Host is back: stand any deputy down.
    if (state.isDeputy) {
      state.isDeputy = false;
      logger.info('Game', 'host returned — deputy stood down');
    }
    return;
  }

  if (hostAbsent) {
    const deputy = determineNextHost(state.players, absent);
    const iAmDeputy = deputy && String(deputy.id) === String(state.room.playerId);
    if (iAmDeputy && !state.isDeputy) {
      state.isDeputy = true;
      logger.info('Game', 'host away — deputised to advance the game');
      _activateHostControlsForCurrentPhase();
      sendMessage(state.room.id, 'System', `${getDisplayName()} can advance while the host is away`);
    }
    return;
  }

  // No host row at all (they left for good) — promote properly.
  const staleNextHost = determineNextHost(state.players, absent);
  if (staleNextHost && String(staleNextHost.id) === String(state.room.playerId)) {
    const fresh = await fetchPlayers(state.room.id);
    const freshAbsent = findAbsentPlayers(fresh, HOST_HANDOVER_MS);
    if (fresh.some(p => p.is_host && !freshAbsent.has(String(p.id)))) {
      state.players = fresh;
      return;
    }
    if (state.room.isCohost) {
      state.room.isCohost = false;
      const localMe = state.players.findIndex(p => String(p.id) === String(state.room.playerId));
      if (localMe !== -1) state.players[localMe].is_cohost = false;
      demoteCohost(state.room.playerId).catch(e => logger.warn('Game', 'demoteCohost on promotion failed', e));
    }
    state.isDeputy = false;          // the real thing now, not a stand-in
    state.room.isHost = true;
    sessionStorage.setItem('oracle_party_room', JSON.stringify(state.room));
    const localIdx = state.players.findIndex(p => String(p.id) === String(state.room.playerId));
    if (localIdx !== -1) state.players[localIdx].is_host = true;
    await promoteToHost(state.room.id, state.room.playerId, getDisplayName());
    _activateHostControlsForCurrentPhase();
    sendMessage(state.room.id, 'System', `${getDisplayName()} is now the host`);
  }
}
