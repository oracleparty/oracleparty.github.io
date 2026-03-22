// ============================================
// Oracle Party — Game
// Gameplay loop: question (with wager) → submit → reveal (live) → repeat
// ============================================

import { $, transitionScreens, escapeHtml, fuzzyMatch } from './utils.js';
import {
  fetchPlayers,
  fetchQuestionsByCategory,
  fetchQuestionsByIds,
  saveQuestionIds,
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
  unsubscribe
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
  timerExpired: false,
  scores: {},
  timerId: null,
  channels: [],
  chatOpen: false
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
  const questions = await fetchQuestionsByCategory(state.room.category, state.totalQuestions);

  if (questions.length === 0) {
    $('#game-loading .game-loading__text').textContent = 'No questions found for this category.';
    return;
  }

  state.totalQuestions = Math.min(state.totalQuestions, questions.length);
  state.questions = questions;
  resolveFieldMap(questions[0]);

  const questionIds = questions.map(q => q.id);
  await saveQuestionIds(state.room.id, questionIds);

  await updateGameState(state.room.id, {
    game_phase: 'question',
    current_question: 0
  });

  showQuestionScreen();
}

async function initPlayerGame() {
  let roomData = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    const { data } = await fetchRoom(state.room.id);
    if (data && data.question_ids && data.question_ids.length > 0) {
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
  handlePhaseTransition(roomData.game_phase);
}

// ============================================
// ROOM CHANGE HANDLER
// ============================================

function handleRoomChange(payload) {
  if (!payload.new) return;
  const { game_phase, current_question, question_ids } = payload.new;

  if (!state.room.isHost && state.questions.length === 0 && question_ids && question_ids.length > 0) {
    state.totalQuestions = question_ids.length;
    fetchQuestionsByIds(question_ids).then(qs => {
      state.questions = qs;
      if (qs.length > 0) resolveFieldMap(qs[0]);
      handlePhaseTransition(game_phase);
    });
    return;
  }

  if (current_question !== undefined) {
    state.currentQuestion = current_question;
  }

  handlePhaseTransition(game_phase);
}

function handlePhaseTransition(phase) {
  // 'question' phase with new current_question always resets
  if (phase === 'question') {
    // Only reset if it's actually a new question (avoid resetting if we're already on this question)
    if (state.gamePhase !== 'question' || !state.onRevealScreen) {
      state.currentWager = null;
      state.hasSubmitted = false;
      state.onRevealScreen = false;
      state.timerExpired = false;
      state.gamePhase = phase;
      showQuestionScreen();
    } else {
      // We're on reveal screen viewing answers for current question, new question incoming
      state.currentWager = null;
      state.hasSubmitted = false;
      state.onRevealScreen = false;
      state.timerExpired = false;
      state.gamePhase = phase;
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
  $('#btn-submit-answer').disabled = false;
  $('#submit-status').classList.add('hidden');
  $('#wager-error').textContent = '';

  if (state.room.isHost) {
    $('#btn-skip-timer').classList.remove('hidden');
  } else {
    $('#btn-skip-timer').classList.add('hidden');
  }

  state.hasSubmitted = false;
  state.onRevealScreen = false;
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

  startTimer();

  $('#btn-submit-answer').onclick = handleSubmitAnswer;
  $('#answer-input').onkeydown = (e) => {
    if (e.key === 'Enter') handleSubmitAnswer();
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
// TIMER
// ============================================

function startTimer() {
  if (state.timerId) {
    clearInterval(state.timerId);
    state.timerId = null;
  }

  let remaining = state.timerSeconds;
  const timerEl = $('#timer-text');
  const timerBar = $('#timer-bar');
  const timerWrapper = timerBar.closest('.timer');

  timerWrapper.classList.remove('timer--warning');
  timerEl.textContent = remaining;
  timerBar.style.width = '100%';

  state.timerId = setInterval(() => {
    remaining--;
    timerEl.textContent = remaining;
    timerBar.style.width = `${(remaining / state.timerSeconds) * 100}%`;

    if (remaining <= 5) {
      timerWrapper.classList.add('timer--warning');
    }

    if (remaining <= 0) {
      clearInterval(state.timerId);
      state.timerId = null;
      handleTimerExpired();
    }
  }, 1000);
}

function handleTimerExpired() {
  state.timerExpired = true;

  // Auto-submit with whatever is currently typed
  if (!state.hasSubmitted) {
    const currentAnswer = ($('#answer-input')?.value || '').trim();
    doSubmitAnswer(currentAnswer);
  }

  // If host and already on reveal, enable Next Question
  if (state.room.isHost && state.onRevealScreen) {
    enableNextQuestion();
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

  // If host already submitted and on reveal, enable next
  if (state.onRevealScreen) {
    enableNextQuestion();
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
  $('#reveal-answer').textContent = getCorrectAnswer(q);
  $('#reveal-difficulty').textContent = getDifficulty(q);

  // Fetch existing answers (some players may not have submitted yet)
  const answers = await fetchAnswersForQuestion(state.room.id, state.currentQuestion);
  renderRevealAnswers(answers);

  await updateScores();
  renderScores();

  // Host: show Next Question button (initially disabled, enabled when timer expires or all submitted)
  if (state.room.isHost) {
    const nextBtn = $('#btn-next-question');
    nextBtn.classList.remove('hidden');
    const isLastQuestion = state.currentQuestion >= state.totalQuestions - 1;
    nextBtn.textContent = isLastQuestion ? 'Show Results' : 'Next Question';
    nextBtn.onclick = handleNextQuestion;

    // Check if we can enable it immediately
    if (state.timerExpired || answers.length >= state.players.length) {
      nextBtn.disabled = false;
      nextBtn.style.opacity = '1';
    } else {
      nextBtn.disabled = true;
      nextBtn.style.opacity = '0.5';
    }
  }

  // Transition to reveal screen
  const currentScreen = document.querySelector('.screen.active');
  const revealScreen = $('#reveal-screen');
  if (currentScreen && currentScreen !== revealScreen) {
    transitionScreens(currentScreen, revealScreen);
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
      const isCorrect = answer.is_correct || false;
      const wager = answer.wager || 0;

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
      updateScores().then(() => renderScores());

      // Host: check if all players have submitted — enable Next Question
      if (state.room.isHost && answers.length >= state.players.length) {
        enableNextQuestion();
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
