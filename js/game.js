// ============================================
// Oracle Party — Game
// Gameplay loop: question (with wager) → submit → reveal (live) → repeat
// ============================================

import { $, transitionScreens, escapeHtml, fuzzyMatch } from './utils.js';
import {
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
  getServerTimeOffset
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
  timerId: null,
  channels: [],
  chatOpen: false,
  serverTimeOffset: 0,  // serverTime - clientTime in ms
  questionStartedAt: null  // ISO timestamp from DB — single source of truth for timer
};

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
  console.log('[Game] Resolved question field map:', FIELD_MAP);
}

function getQuestionText(q) { return q[FIELD_MAP.text] || ''; }
function getCorrectAnswer(q) { return q[FIELD_MAP.correct] || ''; }
function getAlternates(q) { return q[FIELD_MAP.alternates] || []; }
function getDifficulty(q) { return q[FIELD_MAP.difficulty] || 'medium'; }

// ============================================
// INIT
// ============================================

async function init() {
  await ensureDisplayName();

  const stored = sessionStorage.getItem('oracle_party_room');
  if (!stored) {
    window.location.href = 'index.html';
    return;
  }

  state.room = JSON.parse(stored);
  state.totalQuestions = state.room.settings?.questionsPerGame || 10;
  state.timerSeconds = state.room.settings?.questionTimer || 30;

  // Calibrate clock offset between client and server
  state.serverTimeOffset = await getServerTimeOffset();

  state.players = await fetchPlayers(state.room.id);

  for (const p of state.players) {
    state.scores[p.id] = 0;
  }

  const roomCh = subscribeToRoom(state.room.id, handleRoomChange);
  const answerCh = subscribeToAnswers(state.room.id, handleAnswerChange);
  const msgCh = subscribeToMessages(state.room.id, handleNewMessage);
  state.channels = [roomCh, answerCh, msgCh];

  loadChatMessages();
  attachChatListeners();

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
    state.totalQuestions = roomData.question_ids.length;
    state.questions = await fetchQuestionsByIds(roomData.question_ids);
    if (state.questions.length > 0) resolveFieldMap(state.questions[0]);
    state.currentQuestion = roomData.current_question || 0;

    // Rebuild used wagers from existing answers
    const allAnswers = await fetchAllAnswers(state.room.id);
    const myAnswers = allAnswers.filter(a => a.player_id === state.room.playerId);
    for (const a of myAnswers) {
      state.usedWagers.add(a.wager);
    }

    if (roomData.question_started_at) {
      state.questionStartedAt = roomData.question_started_at;
    }

    handlePhaseTransition(roomData.game_phase);
    return;
  }

  const questions = await fetchQuestionsByCategory(state.room.category, state.totalQuestions);

  if (questions.length === 0) {
    $('#game-loading .game-loading__text').textContent = 'No questions found for this category.';
    return;
  }

  state.totalQuestions = Math.min(state.totalQuestions, questions.length);
  state.questions = questions;
  resolveFieldMap(questions[0]);

  const questionIds = questions.map(q => q.id);
  await updateGameState(state.room.id, {
    question_ids: questionIds,
    game_phase: 'question',
    current_question: 0
  });

  showQuestionScreen();
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
    return;
  }

  state.totalQuestions = roomData.question_ids.length;
  state.questions = await fetchQuestionsByIds(roomData.question_ids);

  if (state.questions.length > 0) {
    resolveFieldMap(state.questions[0]);
  }

  state.currentQuestion = roomData.current_question || 0;

  // Rebuild used wagers from existing answers
  const allAnswers = await fetchAllAnswers(state.room.id);
  const myAnswers = allAnswers.filter(a => a.player_id === state.room.playerId);
  for (const a of myAnswers) {
    state.usedWagers.add(a.wager);
  }

  // Store server timer start for reconnect scenarios
  if (roomData.question_started_at) {
    state.questionStartedAt = roomData.question_started_at;
  }

  handlePhaseTransition(roomData.game_phase);
}

// ============================================
// ROOM CHANGE HANDLER
// ============================================

function handleRoomChange(payload) {
  if (!payload.new) return;
  const { game_phase, current_question, question_ids, question_started_at } = payload.new;

  // Track server timer start timestamp
  if (question_started_at) {
    state.questionStartedAt = question_started_at;
  }

  // Non-host: when host writes question_started_at, reveal the question and start timer
  if (!state.room.isHost && question_started_at && state.gamePhase === 'question' && !state.hasSubmitted && !state.timerId) {
    revealQuestionAndStartTimer();
    return;
  }

  if (!state.room.isHost && state.questions.length === 0 && question_ids && question_ids.length > 0) {
    state.totalQuestions = question_ids.length;
    fetchQuestionsByIds(question_ids).then(qs => {
      state.questions = qs;
      if (qs.length > 0) resolveFieldMap(qs[0]);
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

function handlePhaseTransition(phase) {
  if (!phase) return; // guard against null/undefined game_phase

  // 'question' phase with new current_question always resets
  if (phase === 'question') {
    state.currentWager = null;
    state.hasSubmitted = false;
    state.onRevealScreen = false;
    state.resultsRevealed = false;
    state.timerExpired = false;
    state.gamePhase = phase;

    // On reconnect (questionStartedAt present), check if we already answered
    if (state.questionStartedAt) {
      fetchAnswersForQuestion(state.room.id, state.currentQuestion).then(answers => {
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
      // Host skipped timer — if we haven't submitted yet, auto-submit with current input
      if (!state.hasSubmitted) {
        const currentAnswer = ($('#answer-input')?.value || '').trim();
        doSubmitAnswer(currentAnswer);
      } else if (!state.onRevealScreen) {
        showRevealScreen();
      }
      break;
    case 'answer_reveal':
      // Host clicked "Reveal Results" — show correct answer, judgments, scores
      state.resultsRevealed = true;
      if (!state.onRevealScreen) {
        showRevealScreen(); // will call doReveal() since resultsRevealed is true
      } else {
        doReveal();
      }
      break;
    case 'results':
      showResultsScreen();
      break;
    default:
      break;
  }
}

// ============================================
// QUESTION SCREEN (with inline wager)
// ============================================

function showQuestionScreen() {
  const q = state.questions[state.currentQuestion];
  if (!q) return;

  const meta = CATEGORY_META[state.room.category] || { icon: '?', label: state.room.category };
  $('#question-category').textContent = `${meta.icon} ${meta.label}`;
  $('#question-progress').textContent = `Question ${state.currentQuestion + 1} of ${state.totalQuestions}`;
  $('#question-text').textContent = getQuestionText(q);

  renderWagerGrid();

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

  // Default wager to lowest available value
  state.currentWager = null;
  for (let i = 1; i <= state.totalQuestions; i++) {
    if (!state.usedWagers.has(i)) {
      state.currentWager = i;
      break;
    }
  }
  showChatToggle();

  // Determine if we should skip the sync buffer (reconnect with existing timer)
  const isReconnect = !!state.questionStartedAt;

  if (!isReconnect) {
    // Hide interactive elements during sync buffer
    $('.question-card').style.visibility = 'hidden';
    $('#wager-grid').style.visibility = 'hidden';
    $('#answer-form').style.visibility = 'hidden';
    $('#wager-error').style.visibility = 'hidden';
    $('#btn-skip-timer').classList.add('hidden');
    $('.timer').style.visibility = 'hidden';
  }

  const currentScreen = document.querySelector('.screen.active');
  const questionScreen = $('#question-screen');
  if (currentScreen && currentScreen !== questionScreen) {
    transitionScreens(currentScreen, questionScreen);
  } else {
    questionScreen.style.display = '';
    void questionScreen.offsetHeight;
    questionScreen.classList.add('active');
    if (currentScreen && currentScreen !== questionScreen) {
      currentScreen.classList.remove('active');
      currentScreen.style.display = 'none';
    }
  }

  if (isReconnect) {
    // Reconnect: skip sync buffer, resume timer from server timestamp
    if (state.room.isHost) {
      $('#btn-skip-timer').classList.remove('hidden');
    } else {
      $('#btn-skip-timer').classList.add('hidden');
    }
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

      if (state.room.isHost) {
        $('#btn-skip-timer').classList.remove('hidden');
      }

      // Start timer from server timestamp
      startTimer();

      // Focus the answer input for quick typing
      $('#answer-input').focus();
    }, 1000);
  }

  $('#btn-submit-answer').onclick = handleSubmitAnswer;
  $('#answer-input').oninput = () => {
    $('#btn-submit-answer').disabled = !$('#answer-input').value.trim();
  };
  $('#answer-input').onkeydown = (e) => {
    if (e.key === 'Enter' && !state.hasSubmitted && $('#answer-input').value.trim()) {
      handleSubmitAnswer();
    }
  };
  $('#btn-skip-timer').onclick = handleSkipTimer;
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
      // Pre-select the default wager
      if (i === state.currentWager) {
        btn.classList.add('wager-btn--selected');
      }
      btn.addEventListener('click', () => selectWager(i, btn));
    }

    grid.appendChild(btn);
  }
}

function selectWager(value, btnEl) {
  const prev = $('#wager-grid .wager-btn--selected');
  if (prev) prev.classList.remove('wager-btn--selected');

  btnEl.classList.add('wager-btn--selected');
  state.currentWager = value;
  $('#wager-error').textContent = '';
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
function startTimer() {
  if (state.timerId) {
    clearInterval(state.timerId);
    state.timerId = null;
  }

  const timerEl = $('#timer-text');
  const timerBar = $('#timer-bar');
  const timerWrapper = timerBar.closest('.timer');

  // Immediate first render
  const initial = getServerTimeLeft();
  if (initial <= 0) {
    timerEl.textContent = '0';
    timerBar.style.width = '0%';
    timerWrapper.classList.add('timer--warning');
    handleTimerExpired();
    return;
  }

  const display = Math.ceil(initial);
  timerEl.textContent = display;
  timerBar.style.width = `${(initial / state.timerSeconds) * 100}%`;
  timerWrapper.classList.toggle('timer--warning', display <= 5);

  // Tick every 250ms for smooth bar + accurate expiry
  state.timerId = setInterval(() => {
    const timeLeft = getServerTimeLeft();
    const secs = Math.ceil(timeLeft);

    timerEl.textContent = Math.max(0, secs);
    timerBar.style.width = `${Math.max(0, (timeLeft / state.timerSeconds) * 100)}%`;
    timerWrapper.classList.toggle('timer--warning', secs <= 5);

    if (timeLeft <= 0) {
      clearInterval(state.timerId);
      state.timerId = null;
      handleTimerExpired();
    }
  }, 250);
}

function handleTimerExpired() {
  state.timerExpired = true;

  // Auto-submit with whatever is currently typed
  if (!state.hasSubmitted) {
    const currentAnswer = ($('#answer-input')?.value || '').trim();
    doSubmitAnswer(currentAnswer);
  }

  // If host and already on reveal, enable the appropriate button
  if (state.room.isHost && state.onRevealScreen) {
    if (state.resultsRevealed) {
      enableNextQuestion();
    } else {
      enableRevealButton();
    }
  }
}

// ============================================
// ANSWER SUBMISSION
// ============================================

async function handleSubmitAnswer() {
  if (state.hasSubmitted) return;
  const answer = $('#answer-input').value.trim();
  await doSubmitAnswer(answer);
}

async function doSubmitAnswer(answer) {
  if (state.hasSubmitted) return;
  state.hasSubmitted = true;

  const q = state.questions[state.currentQuestion];
  const correctAnswer = getCorrectAnswer(q);
  const alternates = getAlternates(q);
  const isCorrect = answer ? fuzzyMatch(answer, correctAnswer, alternates) : false;
  const wager = state.currentWager || 1;
  const scoreEarned = isCorrect ? wager : 0;

  state.usedWagers.add(wager);

  // Disable question UI (in case transition is slow)
  $('#answer-input').disabled = true;
  $('#btn-submit-answer').disabled = true;

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

  // Immediately transition to reveal screen
  showRevealScreen();
}

async function handleSkipTimer() {
  if (!state.room.isHost) return;

  if (state.timerId) {
    clearInterval(state.timerId);
    state.timerId = null;
  }

  state.timerExpired = true;

  // Broadcast reveal phase so non-submitted players auto-submit
  await updateGameState(state.room.id, { game_phase: 'reveal' });

  // If host already submitted and on reveal, enable Reveal Results
  if (state.onRevealScreen && !state.resultsRevealed) {
    enableRevealButton();
  }
}

// ============================================
// REVEAL SCREEN
// ============================================

async function showRevealScreen() {
  // Don't clear the timer — it's still running for other players
  // (it gets cleared in handleTimerExpired or handleSkipTimer)

  state.onRevealScreen = true;

  const q = state.questions[state.currentQuestion];
  if (!q) return;

  const meta = CATEGORY_META[state.room.category] || { icon: '?', label: state.room.category };
  $('#reveal-category').textContent = `${meta.icon} ${meta.label}`;
  $('#reveal-progress').textContent = `Question ${state.currentQuestion + 1} of ${state.totalQuestions}`;
  $('#reveal-question-text').textContent = getQuestionText(q);

  // Populate correct answer text (for later reveal), but hide the container
  $('#reveal-answer').textContent = getCorrectAnswer(q);
  $('#reveal-difficulty').textContent = getDifficulty(q);
  $('.reveal__correct').style.display = 'none';
  $('.scores-panel').style.display = 'none';

  // Fetch existing answers (some players may not have submitted yet)
  const answers = await fetchAnswersForQuestion(state.room.id, state.currentQuestion);
  renderRevealAnswers(answers);

  // Host: show action button (Reveal Results first, then Next Question after reveal)
  if (state.room.isHost) {
    const btn = $('#btn-next-question');
    btn.classList.remove('hidden');
    btn.textContent = 'Reveal Results';
    btn.onclick = handleRevealResults;

    // Enable if timer expired or all players have submitted
    if (state.timerExpired || answers.length >= state.players.length) {
      btn.disabled = false;
      btn.style.opacity = '1';
    } else {
      btn.disabled = true;
      btn.style.opacity = '0.5';
    }
  }

  // Transition to reveal screen
  const currentScreen = document.querySelector('.screen.active');
  const revealScreen = $('#reveal-screen');
  if (currentScreen && currentScreen !== revealScreen) {
    transitionScreens(currentScreen, revealScreen);
  }

  // If results were already revealed (reconnect), show them immediately
  if (state.resultsRevealed) {
    await doReveal();
  }
}

function renderRevealAnswers(answers) {
  const container = $('#reveal-answers');

  // Remove old click listener to avoid duplicates
  const newContainer = container.cloneNode(false);
  container.parentNode.replaceChild(newContainer, container);

  for (const player of state.players) {
    const answer = answers.find(a => a.player_id === player.id);
    const row = document.createElement('div');
    row.className = 'answer-row';
    row.dataset.playerId = player.id;

    if (answer) {
      // Player has submitted
      row.dataset.answerId = answer.id;
      const submittedText = answer.submitted_answer || '';
      const wager = answer.wager || 0;

      if (state.resultsRevealed) {
        // Post-reveal: show colored judgments
        const isCorrect = answer.is_correct || false;
        const judgmentClass = isCorrect ? 'answer-row__judgment--correct' : 'answer-row__judgment--incorrect';
        const judgmentText = isCorrect ? '+' + (answer.score_earned || 0) : 'Wrong';
        const overrideClass = state.room.isHost ? ' answer-row__judgment--overridable' : '';

        row.innerHTML = `
          <span class="answer-row__name">${escapeHtml(player.display_name)}</span>
          <span class="answer-row__answer ${!submittedText ? 'answer-row__answer--empty' : ''}">
            ${submittedText ? escapeHtml(submittedText) : 'No answer'}
          </span>
          <span class="answer-row__wager">${wager} pts</span>
          <span class="answer-row__judgment ${judgmentClass}${overrideClass}" data-answer-id="${answer.id}">${judgmentText}</span>
        `;
      } else {
        // Pre-reveal: plain text answers, no judgment coloring
        row.innerHTML = `
          <span class="answer-row__name">${escapeHtml(player.display_name)}</span>
          <span class="answer-row__answer ${!submittedText ? 'answer-row__answer--empty' : ''}">
            ${submittedText ? escapeHtml(submittedText) : 'No answer'}
          </span>
          <span class="answer-row__wager">${wager} pts</span>
          <span class="answer-row__judgment"></span>
        `;
      }
    } else {
      // Player hasn't submitted yet — show waiting state
      row.innerHTML = `
        <span class="answer-row__name">${escapeHtml(player.display_name)}</span>
        <span class="answer-row__answer answer-row__answer--waiting">Waiting...</span>
        <span class="answer-row__wager"></span>
        <span class="answer-row__judgment answer-row__judgment--waiting"></span>
      `;
    }

    newContainer.appendChild(row);
  }

  // Host: attach override listeners
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
  const btn = $('#btn-next-question');
  if (btn) {
    btn.disabled = false;
    btn.style.opacity = '1';
  }
}

async function doReveal() {
  state.resultsRevealed = true;

  // Show correct answer and difficulty
  $('.reveal__correct').style.display = '';

  // Re-render answers with judgment coloring
  const answers = await fetchAnswersForQuestion(state.room.id, state.currentQuestion);
  renderRevealAnswers(answers);

  // Calculate and show scores
  await updateScores();
  renderScores();
  $('.scores-panel').style.display = '';

  // Host: swap button to Next Question
  if (state.room.isHost) {
    const btn = $('#btn-next-question');
    const isLast = state.currentQuestion >= state.totalQuestions - 1;
    btn.textContent = isLast ? 'Show Results' : 'Next Question';
    btn.onclick = handleNextQuestion;
    btn.disabled = false;
    btn.style.opacity = '1';
  }
}

async function handleRevealResults() {
  await doReveal();
  await updateGameState(state.room.id, { game_phase: 'answer_reveal' });
}

async function handleJudgmentOverride(e) {
  const badge = e.target.closest('.answer-row__judgment--overridable');
  if (!badge) return;

  const answerId = badge.dataset.answerId;
  if (!answerId) return;

  const answers = await fetchAnswersForQuestion(state.room.id, state.currentQuestion);
  const answer = answers.find(a => a.id === answerId);
  if (!answer) return;

  const newCorrect = !answer.is_correct;
  const newScore = newCorrect ? answer.wager : 0;

  await updateAnswerJudgment(answerId, newCorrect, newScore);

  const judgmentClass = newCorrect ? 'answer-row__judgment--correct' : 'answer-row__judgment--incorrect';
  badge.className = `answer-row__judgment ${judgmentClass} answer-row__judgment--overridable`;
  badge.textContent = newCorrect ? '+' + newScore : 'Wrong';

  await updateScores();
  renderScores();
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
// RESULTS SCREEN (Phase 5 placeholder)
// ============================================

async function showResultsScreen() {
  if (state.timerId) {
    clearInterval(state.timerId);
    state.timerId = null;
  }

  state.onRevealScreen = false;

  const currentScreen = document.querySelector('.screen.active');
  const resultsScreen = $('#results-screen');
  if (currentScreen && currentScreen !== resultsScreen) {
    transitionScreens(currentScreen, resultsScreen);
  }

  $('#btn-back-lobby').onclick = handleBackToLobby;
}

async function handleBackToLobby() {
  cleanup();
  await updateRoomStatus(state.room.id, 'lobby');

  if (state.room.isHost) {
    await updateGameState(state.room.id, {
      game_phase: 'lobby',
      current_question: 0,
      question_ids: []
    });
  }

  window.location.href = 'lobby.html';
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

function renderScores() {
  const list = $('#scores-list');
  if (!list) return;

  const sorted = [...state.players].sort((a, b) =>
    (state.scores[b.id] || 0) - (state.scores[a.id] || 0)
  );

  list.innerHTML = sorted.map(p => `
    <div class="score-row">
      <span class="score-row__name">${escapeHtml(p.display_name)}</span>
      <span class="score-row__points">${state.scores[p.id] || 0} pts</span>
    </div>
  `).join('');
}

// ============================================
// ANSWER CHANGE HANDLER (Realtime)
// ============================================

function handleAnswerChange(payload) {
  // Re-render reveal screen whenever we're viewing it
  if (state.onRevealScreen) {
    fetchAnswersForQuestion(state.room.id, state.currentQuestion).then(answers => {
      renderRevealAnswers(answers);

      // Only update scores if results have been revealed
      if (state.resultsRevealed) {
        updateScores().then(() => renderScores());
      }

      // Host: enable the appropriate button when all players have submitted
      if (state.room.isHost && answers.length >= state.players.length) {
        if (state.resultsRevealed) {
          enableNextQuestion();
        } else {
          enableRevealButton();
        }
      }
    });
  }
}

// ============================================
// CHAT OVERLAY
// ============================================

function showChatToggle() {
  $('#btn-chat-toggle').classList.remove('hidden');
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
  if (payload.new) {
    appendGameChatMessage(payload.new.player_name, payload.new.message);
    scrollGameChatToBottom();
  }
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
  await sendMessage(state.room.id, getDisplayName(), text);
}

// ============================================
// CLEANUP
// ============================================

function cleanup() {
  if (state.timerId) {
    clearInterval(state.timerId);
    state.timerId = null;
  }
  for (const ch of state.channels) {
    unsubscribe(ch);
  }
  state.channels = [];
}

window.addEventListener('beforeunload', cleanup);

// ============================================
// START
// ============================================
init();
