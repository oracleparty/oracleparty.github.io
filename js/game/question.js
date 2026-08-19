// ============================================
// Oracle Party — Question Screen Module
// Wager grid, timer, answer submission.
// ============================================

import { state, canControlGame, getCategoryLabel, getQuestionText, getCorrectAnswer, getAlternates,
         _screenTransitioning, setScreenTransitioning } from './state.js';
import { $, transitionScreens, fuzzyMatch } from '../utils.js';
import { logger } from '../logger.js';
import { WAGER_AUTO_SKIP_MS, TIMER_GRACE_MS } from '../constants.js';
import { updateGameState, submitAnswer, fetchAnswersForQuestion, fetchAllAnswers, insertBlankAnswers, incrementQuestionsAnswered } from '../supabase.js';
import { computeScoreEarned, findNextAvailableWager } from './scoring-helpers.js';
import { getServerTimeLeft as _getServerTimeLeft } from './timer-helpers.js';
import { hideChatBar, _appendLocalChatNotice } from './chat.js';
import { showHostSettingsGear } from './host.js';
import { answerQuestionForBots, answerFinalQuestionForBots } from './bots.js';

// Forward reference — set by init.js to avoid circular imports
let _showRevealScreen = null;
export function registerShowRevealScreen(fn) { _showRevealScreen = fn; }

// Forward references for reveal functions called from handleTimerExpired
let _enableNextQuestion = null;
let _enableRevealButton = null;
let _updateRevealButtonText = null;
export function registerRevealHelpers(fns) {
  _enableNextQuestion = fns.enableNextQuestion;
  _enableRevealButton = fns.enableRevealButton;
  _updateRevealButtonText = fns.updateRevealButtonText;
}

// ============================================
// QUESTION SCREEN (with inline wager)
// ============================================

export function showQuestionScreen() {
  const q = state.questions[state.currentQuestion];
  if (!q) {
    // Out of bounds — likely a Realtime ordering glitch where currentQuestion
    // advanced before state.questions caught up. Bail instead of falling back
    // to the LAST question (which would show a stale, already-answered card);
    // the periodic syncToCurrentState poll or the next Realtime room update
    // will refetch and re-call this once questions are aligned.
    logger.warn('Game', 'Question ' + state.currentQuestion + ' missing — deferring render until sync');
    return;
  }

  $('#question-category').textContent = getCategoryLabel();

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
  // Cancel any stale grace-period timeout from the previous question's timer
  if (state._timerGraceId) {
    clearTimeout(state._timerGraceId);
    state._timerGraceId = null;
  }

  // Reset wager — player must explicitly select (skip for final wager — already set)
  // ONLY reset if this is a genuinely new question (not a re-render of the same one).
  // Without this guard, Realtime events that re-call showQuestionScreen() would wipe
  // the player's already-selected wager, causing auto-submit to discard their choice.
  if (!state.isFinalWagerRound && !state.wagerExplicitlySelected) {
    state.currentWager = null;
  }
  // Don't reset wagerExplicitlySelected here — it's already reset in handlePhaseTransition
  // when a new question starts (line ~863). Resetting it here caused a race condition
  // where the player's wager selection was wiped on re-render.

  // Defensive: if we're past the last regular question, we must be in the final round
  // (handles reconnects where the 'final_question' phase case may not have fired)
  if (state.currentQuestion >= state.totalQuestions) {
    state.isFinalWagerRound = true;
  }

  if (state.isFinalWagerRound) {
    $('#question-progress').textContent = 'Final Question';
    // Use the wager already locked in on the final wager screen
    state.currentWager = state.finalWager || 0;
    $('#wager-grid').style.display = 'none';
    $('.wager-label').style.display = 'none';
    $('#wager-error').style.display = 'none';
    $('#question-screen .game-content').classList.add('game-content--centered');
  } else {
    $('#question-progress').textContent = `Question ${state.currentQuestion + 1} of ${state.totalQuestions}`;
    $('#wager-grid').style.display = '';
    $('.wager-label').style.display = '';
    $('#wager-error').style.display = '';
    $('#question-screen .game-content').classList.remove('game-content--centered');
    renderWagerGrid(); // Must run AFTER state resets — auto-selects last remaining wager
  }
  // BUG 1 FIX: ALWAYS close chat when a new question starts.
  hideChatBar();

  // If chat drawer is still open, notify the player in-chat that a new question started
  if (state.chatOpen) {
    const qNum = state.isFinalWagerRound ? 'Final' : `Q${state.currentQuestion + 1}`;
    _appendLocalChatNotice(`\u23F1 ${qNum} started — timer is running!`);
  }

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
    setScreenTransitioning(true);
    transitionScreens(currentScreen, questionScreen).finally(() => {
      setScreenTransitioning(false);
    });
  } else if (!currentScreen || currentScreen === questionScreen) {
    questionScreen.style.display = '';
    void questionScreen.offsetHeight;
    questionScreen.classList.add('active');
  }

  showHostSettingsGear();

  if (isReconnect) {
    // Reconnect: skip sync buffer, resume timer from server timestamp
    startTimer();
    answerForBots();
    $('#answer-input').focus({ preventScroll: true });
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

      // Bots answer the moment the question is live — nobody waits for one.
      answerForBots();

      // Focus the answer input for quick typing
      $('#answer-input').focus({ preventScroll: true });
    }, WAGER_AUTO_SKIP_MS);
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

/**
 * Answer for any bots in the room, host only (the gate lives in bots.js).
 *
 * Fire-and-forget: a bot failing to answer must never hold up the question for
 * the humans, and if it does fail the host's timer-expiry pass writes it a
 * blank like any absent player.
 */
function answerForBots() {
  const run = state.isFinalWagerRound ? answerFinalQuestionForBots : answerQuestionForBots;
  run().catch(err => logger.warn('Bots', 'Bot answering failed', err));
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
      const wasCorrect = state.usedWagers.get(i);
      btn.classList.add(wasCorrect ? 'wager-btn--correct' : 'wager-btn--incorrect');
    } else {
      btn.addEventListener('click', () => selectWager(i, btn));
    }

    grid.appendChild(btn);
  }

  // Auto-select if only one wager remains (prevents getting stuck on last question)
  const available = grid.querySelectorAll('.wager-btn:not(.wager-btn--correct):not(.wager-btn--incorrect)');
  if (available.length === 1 && !state.wagerExplicitlySelected) {
    const onlyBtn = available[0];
    const val = parseInt(onlyBtn.dataset.value, 10);
    onlyBtn.classList.add('wager-btn--selected');
    state.currentWager = val;
    state.wagerExplicitlySelected = true;
  } else if (available.length === 0) {
    // Defensive: all exhausted — assign fallback so player can still submit
    state.currentWager = findNextAvailableWager(state.usedWagers, state.totalQuestions);
    state.wagerExplicitlySelected = true;
    logger.warn('Game', 'All wagers exhausted, fallback to ' + state.currentWager);
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
  return _getServerTimeLeft(state.questionStartedAt, state.serverTimeOffset, state.timerSeconds);
}

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

export function startTimer() {
  if (state.timerId) {
    clearInterval(state.timerId);
    state.timerId = null;
  }
  if (state._timerGraceId) {
    clearTimeout(state._timerGraceId);
    state._timerGraceId = null;
  }

  // Immediate first render
  const initial = getServerTimeLeft();
  if (initial <= 0) {
    updateTimerDisplay(0);
    state.timerExpired = true;
    // Grace period: give in-flight submissions time to land before auto-submitting
    state._timerGraceId = setTimeout(() => { state._timerGraceId = null; handleTimerExpired(); }, TIMER_GRACE_MS);
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
      // Grace period: give in-flight submissions time to land before auto-submitting
      state._timerGraceId = setTimeout(() => { state._timerGraceId = null; handleTimerExpired(); }, TIMER_GRACE_MS);
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

  // Auto-select wager if none was explicitly selected
  if (!state.wagerExplicitlySelected) {
    if (state.isFinalWagerRound) {
      state.currentWager = state.finalWager || 20;
    } else {
      let found = false;
      for (let i = 1; i <= state.totalQuestions; i++) {
        if (!state.usedWagers.has(i)) { state.currentWager = i; found = true; break; }
      }
      if (!found) state.currentWager = 1;
    }
  }

  // Auto-submit with whatever is currently typed
  if (!state.hasSubmitted) {
    const currentAnswer = ($('#answer-input')?.value || '').trim();
    await doSubmitAnswer(currentAnswer, { autoSubmit: true });
  }

  // Host/cohost: auto-submit blank for any players who didn't answer, then broadcast reveal.
  if (canControlGame()) {
    // Re-fetch answers to ensure we have the host's just-submitted answer
    const freshAnswers = await fetchAnswersForQuestion(state.room.id, state.currentQuestion);
    state.currentAnswers = freshAnswers;
    const submittedIds = new Set(freshAnswers.map(a => String(a.player_id)));
    const q = state.questions[state.currentQuestion];
    if (q) {
      // Each absent player burns their OWN lowest unused wager, not a hardcoded
      // 1. Writing 1 for everyone gave a player two answers at wager 1 whenever
      // they had already spent it, breaking the rule that values 1..N are each
      // used exactly once.
      const allAnswers = await fetchAllAnswers(state.room.id);
      const wagersByPlayer = new Map();
      for (const a of allAnswers) {
        const key = String(a.player_id);
        if (!wagersByPlayer.has(key)) wagersByPlayer.set(key, new Set());
        if (a.wager != null) wagersByPlayer.get(key).add(a.wager);
      }

      const blanks = [];
      for (const p of state.players) {
        if (submittedIds.has(String(p.id))) continue;
        const used = wagersByPlayer.get(String(p.id)) || new Set();
        blanks.push({
          roomId: state.room.id,
          playerId: p.id,
          questionNumber: state.currentQuestion,
          questionId: q.id,
          wager: findNextAvailableWager(used, state.totalQuestions)
        });
      }
      // Never overwrites a real answer — see insertBlankAnswers.
      if (blanks.length) await insertBlankAnswers(blanks);
    }
    // Broadcast reveal phase so all clients transition
    updateGameState(state.room.id, { game_phase: 'reveal' })
      .catch(err => logger.error('Game', 'Failed to broadcast reveal phase', err));
  }

  // If host/co-host and already on reveal, enable the appropriate button and update text
  if (canControlGame() && state.onRevealScreen) {
    if (state.resultsRevealed) {
      if (_enableNextQuestion) _enableNextQuestion();
    } else {
      if (_enableRevealButton) _enableRevealButton();
      if (_updateRevealButtonText) _updateRevealButtonText();
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

export async function doSubmitAnswer(answer, { autoSubmit = false } = {}) {
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
    // Fallback: find lowest available wager (centralised in scoring-helpers)
    wager = findNextAvailableWager(state.usedWagers, state.totalQuestions);
    logger.warn('Game', 'doSubmitAnswer: no wager selected, auto-assigned ' + wager);
  }
  const scoreEarned = computeScoreEarned(isCorrect, wager, state.isFinalWagerRound);

  const submitResult = await submitAnswer({
    roomId: state.room.id,
    playerId: state.room.playerId,
    questionNumber: state.currentQuestion,
    questionId: q.id,
    wager,
    submittedAnswer: answer,
    isCorrect,
    scoreEarned
  });

  // If the DB write failed (network drop mid-submit), revert local state and
  // allow retry — without this revert, the player thinks they submitted, gets
  // shown as "no answer" on reveal (because host's auto-submit pass writes a
  // blank for them), and silently loses their actual answer.
  if (submitResult && submitResult.error && !autoSubmit) {
    state.hasSubmitted = false;
    $('#answer-input').disabled = false;
    $('#btn-submit-answer').disabled = false;
    const errEl = $('#wager-error');
    if (errEl) errEl.textContent = 'Submit failed — try again';
    logger.error('Game', 'submitAnswer failed', submitResult.error);
    return;
  }

  // Mark wager as used AFTER DB write succeeds (prevents stale state if submit fails)
  state.usedWagers.set(wager, isCorrect);

  // Track question answered (fire-and-forget, skip final wager round)
  if (!state.isFinalWagerRound) {
    incrementQuestionsAnswered(state.room.id, state.room.playerId);
  }

  // Immediately transition to reveal screen
  if (_showRevealScreen) _showRevealScreen();
}
