// ============================================
// Oracle Party — Game
// Gameplay loop: wager → question → reveal → repeat
// ============================================

import { $, transitionScreens, escapeHtml, fuzzyMatch, shuffleArray } from './utils.js';
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
  scores: {},
  timerId: null,
  channels: [],
  chatOpen: false
};

// --- Question field name resolution ---
// Different Supabase schemas may use different column names.
// We detect these once from the first question object.
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

// --- Init ---
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

  // Fetch players
  state.players = await fetchPlayers(state.room.id);

  // Initialize scores
  for (const p of state.players) {
    state.scores[p.id] = 0;
  }

  // Subscribe to realtime channels
  const roomCh = subscribeToRoom(state.room.id, handleRoomChange);
  const answerCh = subscribeToAnswers(state.room.id, handleAnswerChange);
  const msgCh = subscribeToMessages(state.room.id, handleNewMessage);
  state.channels = [roomCh, answerCh, msgCh];

  // Load chat messages
  loadChatMessages();
  attachChatListeners();

  if (state.room.isHost) {
    await initHostGame();
  } else {
    await initPlayerGame();
  }
}

async function initHostGame() {
  // Fetch random questions for this category
  const questions = await fetchQuestionsByCategory(state.room.category, state.totalQuestions);

  if (questions.length === 0) {
    $('#game-loading .game-loading__text').textContent = 'No questions found for this category.';
    return;
  }

  // If we got fewer questions than requested, adjust
  state.totalQuestions = Math.min(state.totalQuestions, questions.length);
  state.questions = questions;

  // Resolve field names from first question
  resolveFieldMap(questions[0]);

  // Save question IDs to room
  const questionIds = questions.map(q => q.id);
  await saveQuestionIds(state.room.id, questionIds);

  // Set game state to wager phase
  await updateGameState(state.room.id, {
    game_phase: 'wager',
    current_question: 0
  });

  // Show wager screen
  showWagerScreen();
}

async function initPlayerGame() {
  // Wait briefly for room data to have question_ids populated
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
    // Will be driven by room subscription
    return;
  }

  state.totalQuestions = roomData.question_ids.length;
  state.questions = await fetchQuestionsByIds(roomData.question_ids);

  if (state.questions.length > 0) {
    resolveFieldMap(state.questions[0]);
  }

  state.currentQuestion = roomData.current_question || 0;

  // Show correct screen based on current game_phase
  handlePhaseTransition(roomData.game_phase);
}

// --- Room Change Handler ---
function handleRoomChange(payload) {
  if (!payload.new) return;
  const { game_phase, current_question, question_ids } = payload.new;

  // If non-host and questions not loaded yet, try loading
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
  if (phase === state.gamePhase) return;
  state.gamePhase = phase;

  // Reset per-question state on new question
  if (phase === 'wager') {
    state.currentWager = null;
    state.hasSubmitted = false;
  }

  switch (phase) {
    case 'wager':    showWagerScreen(); break;
    case 'question': showQuestionScreen(); break;
    case 'reveal':   showRevealScreen(); break;
    case 'results':  showResultsScreen(); break;
    default: break;
  }
}

// ============================================
// WAGER SCREEN
// ============================================

function showWagerScreen() {
  const meta = CATEGORY_META[state.room.category] || { icon: '?', label: state.room.category };
  $('#wager-category').textContent = `${meta.icon} ${meta.label}`;
  $('#wager-progress').textContent = `Question ${state.currentQuestion + 1} of ${state.totalQuestions}`;

  renderWagerGrid();
  showChatToggle();

  const currentScreen = document.querySelector('.screen.active');
  const wagerScreen = $('#wager-screen');
  if (currentScreen && currentScreen !== wagerScreen) {
    transitionScreens(currentScreen, wagerScreen);
  } else {
    wagerScreen.style.display = '';
    void wagerScreen.offsetHeight;
    wagerScreen.classList.add('active');
    if (currentScreen && currentScreen !== wagerScreen) {
      currentScreen.classList.remove('active');
      currentScreen.style.display = 'none';
    }
  }

  // Host: show wager status
  if (state.room.isHost) {
    $('#wager-status').classList.remove('hidden');
    $('#wager-status').textContent = 'Waiting for all players to wager...';
  }

  // Attach wager listeners
  const lockBtn = $('#btn-lock-wager');
  lockBtn.disabled = true;
  lockBtn.onclick = handleLockWager;
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
}

function selectWager(value, btnEl) {
  // Deselect previous
  const prev = $('#wager-grid .wager-btn--selected');
  if (prev) prev.classList.remove('wager-btn--selected');

  btnEl.classList.add('wager-btn--selected');
  state.currentWager = value;
  $('#btn-lock-wager').disabled = false;
}

async function handleLockWager() {
  if (state.currentWager === null) return;

  const lockBtn = $('#btn-lock-wager');
  lockBtn.disabled = true;
  lockBtn.textContent = 'Locked In';
  lockBtn.classList.add('is-loading');

  state.usedWagers.add(state.currentWager);

  const q = state.questions[state.currentQuestion];

  // Submit wager as answer with empty submitted_answer (will be filled during question phase)
  await submitAnswer({
    roomId: state.room.id,
    playerId: state.room.playerId,
    questionNumber: state.currentQuestion,
    questionId: q.id,
    wager: state.currentWager,
    submittedAnswer: '',
    isCorrect: false,
    scoreEarned: 0
  });

  // Reset button text for next time
  setTimeout(() => {
    lockBtn.textContent = 'Lock In';
    lockBtn.classList.remove('is-loading');
  }, 500);

  // If host, check if all wagers are in
  if (state.room.isHost) {
    checkAllWagersIn();
  }
}

async function checkAllWagersIn() {
  // Brief delay to let the DB catch up
  await new Promise(r => setTimeout(r, 300));
  const answers = await fetchAnswersForQuestion(state.room.id, state.currentQuestion);
  const wagerCount = answers.filter(a => a.wager > 0).length;

  if (wagerCount >= state.players.length) {
    $('#wager-status').textContent = 'All wagers in!';
    // Auto-advance to question phase
    await updateGameState(state.room.id, { game_phase: 'question' });
  } else {
    $('#wager-status').textContent = `${wagerCount} of ${state.players.length} wagers in`;
  }
}

// ============================================
// QUESTION SCREEN
// ============================================

function showQuestionScreen() {
  const q = state.questions[state.currentQuestion];
  if (!q) return;

  const meta = CATEGORY_META[state.room.category] || { icon: '?', label: state.room.category };
  $('#question-category').textContent = `${meta.icon} ${meta.label}`;
  $('#question-progress').textContent = `Question ${state.currentQuestion + 1} of ${state.totalQuestions}`;
  $('#question-text').textContent = getQuestionText(q);
  $('#question-wager').textContent = `Wagered: ${state.currentWager || '?'} pts`;

  // Reset answer form
  const answerForm = $('#answer-form');
  answerForm.classList.remove('answer-input--submitted');
  const answerInput = $('#answer-input');
  answerInput.value = '';
  answerInput.disabled = false;
  $('#btn-submit-answer').disabled = false;
  $('#submit-status').classList.add('hidden');

  // Host controls
  if (state.room.isHost) {
    $('#btn-skip-timer').classList.remove('hidden');
  } else {
    $('#btn-skip-timer').classList.add('hidden');
  }

  state.hasSubmitted = false;

  // Transition
  const currentScreen = document.querySelector('.screen.active');
  const questionScreen = $('#question-screen');
  if (currentScreen && currentScreen !== questionScreen) {
    transitionScreens(currentScreen, questionScreen);
  }

  // Start timer
  startTimer();

  // Attach listeners
  $('#btn-submit-answer').onclick = handleSubmitAnswer;
  $('#answer-input').onkeydown = (e) => {
    if (e.key === 'Enter') handleSubmitAnswer();
  };
  $('#btn-skip-timer').onclick = handleSkipTimer;
}

function startTimer() {
  // Clear any existing timer
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
  if (!state.hasSubmitted) {
    // Auto-submit empty answer
    doSubmitAnswer('');
  }

  // Host auto-advances to reveal
  if (state.room.isHost) {
    setTimeout(() => {
      updateGameState(state.room.id, { game_phase: 'reveal' });
    }, 500);
  }
}

async function handleSubmitAnswer() {
  if (state.hasSubmitted) return;

  const answerInput = $('#answer-input');
  const answer = answerInput.value.trim();
  await doSubmitAnswer(answer);
}

async function doSubmitAnswer(answer) {
  if (state.hasSubmitted) return;
  state.hasSubmitted = true;

  const q = state.questions[state.currentQuestion];
  const correctAnswer = getCorrectAnswer(q);
  const alternates = getAlternates(q);
  const isCorrect = answer ? fuzzyMatch(answer, correctAnswer, alternates) : false;
  const scoreEarned = isCorrect ? (state.currentWager || 0) : 0;

  // Update UI
  $('#answer-form').classList.add('answer-input--submitted');
  $('#answer-input').disabled = true;
  $('#btn-submit-answer').disabled = true;
  $('#submit-status').classList.remove('hidden');

  await submitAnswer({
    roomId: state.room.id,
    playerId: state.room.playerId,
    questionNumber: state.currentQuestion,
    questionId: q.id,
    wager: state.currentWager || 0,
    submittedAnswer: answer,
    isCorrect,
    scoreEarned
  });
}

async function handleSkipTimer() {
  if (!state.room.isHost) return;

  // Stop timer
  if (state.timerId) {
    clearInterval(state.timerId);
    state.timerId = null;
  }

  // Advance to reveal
  await updateGameState(state.room.id, { game_phase: 'reveal' });
}

// ============================================
// REVEAL SCREEN
// ============================================

async function showRevealScreen() {
  // Stop any running timer
  if (state.timerId) {
    clearInterval(state.timerId);
    state.timerId = null;
  }

  const q = state.questions[state.currentQuestion];
  if (!q) return;

  const meta = CATEGORY_META[state.room.category] || { icon: '?', label: state.room.category };
  $('#reveal-category').textContent = `${meta.icon} ${meta.label}`;
  $('#reveal-progress').textContent = `Question ${state.currentQuestion + 1} of ${state.totalQuestions}`;
  $('#reveal-answer').textContent = getCorrectAnswer(q);
  $('#reveal-difficulty').textContent = getDifficulty(q);

  // Fetch all answers for this question
  const answers = await fetchAnswersForQuestion(state.room.id, state.currentQuestion);
  renderRevealAnswers(answers);

  // Update scores
  await updateScores();
  renderScores();

  // Host: show Next Question button
  if (state.room.isHost) {
    const nextBtn = $('#btn-next-question');
    nextBtn.classList.remove('hidden');
    const isLastQuestion = state.currentQuestion >= state.totalQuestions - 1;
    nextBtn.textContent = isLastQuestion ? 'Show Results' : 'Next Question';
    nextBtn.onclick = handleNextQuestion;
  }

  // Transition
  const currentScreen = document.querySelector('.screen.active');
  const revealScreen = $('#reveal-screen');
  if (currentScreen && currentScreen !== revealScreen) {
    transitionScreens(currentScreen, revealScreen);
  }
}

function renderRevealAnswers(answers) {
  const container = $('#reveal-answers');
  container.innerHTML = '';

  for (const player of state.players) {
    const answer = answers.find(a => a.player_id === player.id);
    const row = document.createElement('div');
    row.className = 'answer-row';
    row.dataset.answerId = answer?.id || '';
    row.dataset.playerId = player.id;

    const submittedText = answer?.submitted_answer || '';
    const isCorrect = answer?.is_correct || false;
    const wager = answer?.wager || 0;

    const judgmentClass = isCorrect ? 'answer-row__judgment--correct' : 'answer-row__judgment--incorrect';
    const judgmentText = isCorrect ? '+' + (answer?.score_earned || 0) : 'Wrong';
    const overrideClass = state.room.isHost ? ' answer-row__judgment--overridable' : '';

    row.innerHTML = `
      <span class="answer-row__name">${escapeHtml(player.display_name)}</span>
      <span class="answer-row__answer ${!submittedText ? 'answer-row__answer--empty' : ''}">
        ${submittedText ? escapeHtml(submittedText) : 'No answer'}
      </span>
      <span class="answer-row__wager">${wager} pts</span>
      <span class="answer-row__judgment ${judgmentClass}${overrideClass}" data-answer-id="${answer?.id || ''}">${judgmentText}</span>
    `;

    container.appendChild(row);
  }

  // Host: attach override listeners
  if (state.room.isHost) {
    container.addEventListener('click', handleJudgmentOverride);
  }
}

async function handleJudgmentOverride(e) {
  const badge = e.target.closest('.answer-row__judgment--overridable');
  if (!badge) return;

  const answerId = badge.dataset.answerId;
  if (!answerId) return;

  const row = badge.closest('.answer-row');
  const playerId = row.dataset.playerId;

  // Find current answer state
  const answers = await fetchAnswersForQuestion(state.room.id, state.currentQuestion);
  const answer = answers.find(a => a.id === answerId);
  if (!answer) return;

  const newCorrect = !answer.is_correct;
  const newScore = newCorrect ? answer.wager : 0;

  await updateAnswerJudgment(answerId, newCorrect, newScore);

  // Update UI immediately for host
  const judgmentClass = newCorrect ? 'answer-row__judgment--correct' : 'answer-row__judgment--incorrect';
  badge.className = `answer-row__judgment ${judgmentClass} answer-row__judgment--overridable`;
  badge.textContent = newCorrect ? '+' + newScore : 'Wrong';

  // Update scores
  await updateScores();
  renderScores();
}

async function handleNextQuestion() {
  const isLastQuestion = state.currentQuestion >= state.totalQuestions - 1;

  if (isLastQuestion) {
    // Go to results
    await updateGameState(state.room.id, { game_phase: 'results' });
  } else {
    // Next question
    await updateGameState(state.room.id, {
      game_phase: 'wager',
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

  // Reset game state on room
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

  // Sort by score descending
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
  // On reveal screen: re-render answers when they change (host override)
  if (state.gamePhase === 'reveal') {
    fetchAnswersForQuestion(state.room.id, state.currentQuestion).then(answers => {
      renderRevealAnswers(answers);
      updateScores().then(() => renderScores());
    });
  }

  // On wager screen (host): check if all wagers are in
  if (state.gamePhase === 'wager' && state.room.isHost) {
    checkAllWagersIn();
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
