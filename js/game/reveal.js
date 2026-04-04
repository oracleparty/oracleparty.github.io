// ============================================
// Oracle Party — Reveal Screen Module
// Answer reveal, judgment overrides, feedback UI, honks.
// ============================================

import { state, canControlGame, getCategoryLabel, getQuestionText, getCorrectAnswer, getFunFact,
         _screenTransitioning, setScreenTransitioning,
         _flagMenuCloseHandler, setFlagMenuCloseHandler,
         _qbFeedback, setQbFeedback } from './state.js';
import { $, transitionScreens, escapeHtml, renderAvatar } from '../utils.js';
import { logger } from '../logger.js';
import { REVEAL_ANSWER_DELAY_MS, RESULTS_ACTION_DELAY_MS } from '../constants.js';
import { fetchAnswersForQuestion, updateAnswerJudgment, updateGameState, submitAnswer,
         upsertQuestionHistory, upsertQuestionFeedback, deleteQuestionFeedback, sendMessage } from '../supabase.js';
import { getDisplayName, getCurrentUser } from '../auth.js';
import { sendHonk, getHonkCount } from '../honk.js';
import { attachProfileCardHandler } from '../profile.js';
import { showChatBar } from './chat.js';
import { showHostSettingsGear } from './host.js';

// Forward references — set by init.js to avoid circular imports
let _handleShowScores = null;
let _updateScores = null;
let _clearAutoProceed = null;
let _showResultsScreen = null;
let _handlePhaseTransition = null;

export function registerScoresRef(fns) {
  _handleShowScores = fns.handleShowScores;
  _updateScores = fns.updateScores;
  _clearAutoProceed = fns.clearAutoProceed;
  _showResultsScreen = fns.showResultsScreen;
  _handlePhaseTransition = fns.handlePhaseTransition;
}

// ============================================
// REVEAL SCREEN
// ============================================

export async function showRevealScreen() {
  // Don't clear the timer — it's still running for other players
  // (it gets cleared in handleTimerExpired)

  state.onRevealScreen = true;

  // Reset disqualify button for this round
  const dqBtn = $('#btn-disqualify-round');
  if (dqBtn) { dqBtn.classList.add('hidden'); dqBtn.disabled = false; dqBtn.textContent = 'Disqualify Round'; }

  const q = state.questions[state.currentQuestion];
  if (!q) return;

  $('#reveal-category').textContent = getCategoryLabel();
  $('#reveal-progress').textContent = state.isFinalWagerRound
    ? 'Final Question'
    : `Question ${state.currentQuestion + 1} of ${state.totalQuestions}`;
  $('#reveal-question-text').textContent = getQuestionText(q);

  // Populate correct answer text (for later reveal), but hide the container
  $('#reveal-answer').textContent = getCorrectAnswer(q);
  $('#reveal-difficulty').style.display = 'none';
  $('#reveal-fun-fact').style.display = 'none';
  $('.reveal__correct').style.display = 'none';

  // Reset feedback UI
  resetFeedbackUI();

  // Fetch existing answers (some players may not have submitted yet) and cache them
  const currentQ = state.currentQuestion;
  state.currentAnswers = await fetchAnswersForQuestion(state.room.id, currentQ);
  // Skip render if doReveal() will be called immediately (it re-renders with colors)
  if (!state.resultsRevealed) {
    renderRevealAnswers(state.currentAnswers);
  }

  // BUG 3 FIX: Safety re-fetch after 1.5s to catch answers submitted concurrently.
  if (!state.resultsRevealed && state.currentAnswers.length < state.players.length) {
    setTimeout(async () => {
      if (!state.onRevealScreen || state.currentQuestion !== currentQ || state.resultsRevealed) return;
      const fresh = await fetchAnswersForQuestion(state.room.id, currentQ);
      if (fresh.length > state.currentAnswers.length) {
        state.currentAnswers = fresh;
        renderRevealAnswers(fresh);
      }
    }, REVEAL_ANSWER_DELAY_MS);
  }

  // Show countdown timer on reveal screen if the round isn't over yet
  const revealTimer = $('#reveal-timer');
  if (!state.timerExpired && state.currentAnswers.length < state.players.length) {
    revealTimer.style.display = '';
  } else {
    revealTimer.style.display = 'none';
  }

  // Host/co-host: show action button (Reveal Results first, then Next Question after reveal)
  if (canControlGame()) {
    const btn = $('#btn-next-question');
    btn.classList.remove('hidden');
    btn.onclick = handleRevealResults;
    updateRevealButtonText();

    // Enable as soon as this player has submitted — they control the pace
    const mySubmitted = state.hasSubmitted || state.currentAnswers.some(a => String(a.player_id) === String(state.room.playerId));
    if (mySubmitted) {
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


  const currentScreen = document.querySelector('.screen.active');
  const revealScreen = $('#reveal-screen');
  if (currentScreen && currentScreen !== revealScreen) {
    transitionScreens(currentScreen, revealScreen).then(showChatBar);
  } else {
    showChatBar();
  }

  showHostSettingsGear();

  // If results were already revealed (reconnect), show them immediately
  if (state.resultsRevealed) {
    doReveal();
  }
}

export function updateHonkBadges() {
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

function honkAvatarHtml(player) {
  const honks = getHonkCount(player.id);
  const badge = `<span class="honk-badge" data-honk-player="${player.id}" style="${honks > 0 ? '' : 'display:none'}">${honks}</span>`;
  const avatarHtml = renderAvatar({ displayName: player.display_name, avatarColor: player.avatar_color, avatarEmoji: player.avatar_emoji });
  return `<div class="avatar-wrap">
    ${avatarHtml}
    ${badge}
  </div>`;
}

function honkBtnHtml(player) {
  const isMe = String(player.id) === String(state.room.playerId);
  return isMe ? '' : `<button class="honk-btn" data-honk-target="${player.id}" aria-label="Quack">&#x1F986;</button>`;
}

export function renderRevealAnswers(answers) {
  const container = $('#reveal-answers');

  // Remove old click listener to avoid duplicates
  const newContainer = container.cloneNode(false);
  container.parentNode.replaceChild(newContainer, container);

  for (const player of state.players) {
    const answer = answers.find(a => a.player_id === player.id);
    const row = document.createElement('div');
    row.className = 'answer-row' + (state.awayTimestamps.has(String(player.id)) ? ' answer-row--away' : '');
    row.dataset.playerId = player.id;
    if (player.user_id) row.dataset.profileUserId = player.user_id;

    const titleHtml = player.title ? `<span class="player-title">${escapeHtml(player.title)}</span>` : '';

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
      const toggleHtml = (canControlGame() && state.resultsRevealed)
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
          ${honkAvatarHtml(player)}
          <div class="name-stack">
            <span class="answer-row__name">${escapeHtml(player.display_name)}${hostBadge}</span>
            ${titleHtml}
          </div>
          ${honkBtnHtml(player)}
          <span class="answer-row__wager ${wagerColorClass}">${wager}</span>
          ${toggleHtml}
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
          ${honkAvatarHtml(player)}
          <div class="name-stack">
            <span class="answer-row__name">${escapeHtml(player.display_name)}${hostBadge}</span>
            ${titleHtml}
          </div>
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

  // Host/co-host: attach toggle click listeners (pre- and post-reveal)
  if (canControlGame()) {
    newContainer.addEventListener('click', handleJudgmentOverride);
  }

  // Profile card on player tap
  attachProfileCardHandler(newContainer, () => state.players, state.room.id);
}

export function enableNextQuestion() {
  if (!canControlGame()) return;
  const nextBtn = $('#btn-next-question');
  if (nextBtn) {
    nextBtn.disabled = false;
    nextBtn.style.opacity = '1';
  }
}

export function enableRevealButton() {
  if (!canControlGame() || state.resultsRevealed) return;
  // Controller must have submitted their own answer (check local flag + DB cache)
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
export function updateRevealButtonText() {
  if (!canControlGame() || state.resultsRevealed) return;
  const btn = $('#btn-next-question');
  if (!btn) return;
  const allSubmitted = state.currentAnswers.length >= state.players.length;
  btn.textContent = (!state.timerExpired && !allSubmitted) ? 'Reveal Early' : 'Reveal Results';
}

export function doReveal() {
  // Snapshot scores before this round (for animation on scores screen)
  state.previousScores = { ...state.scores };

  // Hide the reveal timer — the round is over once results are shown
  const revealTimer = $('#reveal-timer');
  if (revealTimer) revealTimer.style.display = 'none';

  // Show correct answer and difficulty
  $('.reveal__correct').style.display = '';

  // Show fun fact if the question has one
  const funFact = getFunFact(state.questions[state.currentQuestion]);
  const funFactEl = $('#reveal-fun-fact');
  if (funFact) {
    funFactEl.textContent = funFact;
    funFactEl.style.display = '';
  } else {
    funFactEl.style.display = 'none';
  }

  // Show feedback icons and start fade timer
  showFeedbackUI();

  // Render immediately with cached answers (Realtime keeps these up-to-date).
  renderRevealAnswers(state.currentAnswers);

  // Now mark revealed — subsequent renders will apply colors immediately
  state.resultsRevealed = true;

  // Write per-question mastery in real-time (fire-and-forget).
  const authUser = getCurrentUser();
  if (authUser) {
    const uid = authUser.user.id;
    const myAnswer = state.currentAnswers.find(a => String(a.player_id) === String(state.room.playerId));
    if (myAnswer?.question_id) {
      upsertQuestionHistory(uid, myAnswer.question_id, !!myAnswer.is_correct);
    }
  }

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
      if (canControlGame() && answer.id && !row.querySelector('.answer-toggle')) {
        const toggleDiv = document.createElement('div');
        toggleDiv.className = `answer-toggle ${isCorrect ? 'answer-toggle--correct' : 'answer-toggle--incorrect'} answer-toggle--host`;
        toggleDiv.dataset.answerId = answer.id;
        toggleDiv.innerHTML = '<div class="answer-toggle__thumb"></div>';
        const topRow = row.querySelector('.answer-row__top') || row;
        topRow.appendChild(toggleDiv);
      }
    });
  });

  // Host/co-host: swap button to "Show Scores" and show Disqualify option
  if (canControlGame()) {
    const btn = $('#btn-next-question');
    btn.textContent = 'Show Scores';
    btn.onclick = () => { if (_handleShowScores) _handleShowScores(); };
    btn.disabled = false;
    btn.style.opacity = '1';
    // Show disqualify button (only if not already disqualified)
    const dqBtn = $('#btn-disqualify-round');
    if (dqBtn && !state.disqualifiedQuestions.has(state.currentQuestion)) {
      dqBtn.classList.remove('hidden');
      dqBtn.onclick = handleDisqualifyRound;
    }
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
  // Cancel any running auto-proceed timer (host may return to judging from scores)
  if (_clearAutoProceed) _clearAutoProceed();

  // Set gamePhase BEFORE broadcasting so the Realtime echo is rejected
  state.gamePhase = 'answer_reveal';

  // Stop the timer — round is over
  if (state.timerId) {
    clearInterval(state.timerId);
    state.timerId = null;
  }
  state.timerExpired = true;

  // BUG 3 FIX: Submit blank answers for ALL players who haven't answered
  const submittedIds = new Set(state.currentAnswers.map(a => String(a.player_id)));
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
  try {
    state.currentAnswers = await fetchAnswersForQuestion(state.room.id, state.currentQuestion);
  } catch (err) {
    logger.warn('Game', 'Pre-reveal fetch failed, using cached answers', err);
  }

  // Broadcast phase change so non-hosts transition to reveal
  updateGameState(state.room.id, { game_phase: 'answer_reveal' })
    .catch(err => logger.error('Game', 'Failed to broadcast answer_reveal phase', err));
  doReveal();
}

export async function handleJudgmentOverride(e) {
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

  // Update mastery for the affected player
  const player = state.players.find(p => p.id === answer.player_id);
  if (player?.user_id && answer.question_id) {
    upsertQuestionHistory(player.user_id, answer.question_id, newCorrect);
  }
}

async function handleDisqualifyRound() {
  if (!canControlGame()) return;
  const qNum = state.currentQuestion;

  // Guard against double-click
  if (state.disqualifiedQuestions.has(qNum)) return;

  // Mark locally
  state.disqualifiedQuestions.add(qNum);

  // Refund wagers — remove from usedWagers so players can reuse them
  for (const answer of state.currentAnswers) {
    if (answer.wager && answer.player_id === state.room.playerId) {
      state.usedWagers.delete(answer.wager);
    }
  }

  // Set all answers for this question to score_earned = 0
  const updates = [];
  for (const answer of state.currentAnswers) {
    answer.is_correct = false;
    answer.score_earned = 0;
    if (answer.id) {
      updates.push(updateAnswerJudgment(answer.id, false, 0));
    }
  }
  // Re-render immediately
  renderRevealAnswers(state.currentAnswers);

  // Hide the disqualify button and show confirmation
  const dqBtn = $('#btn-disqualify-round');
  if (dqBtn) {
    dqBtn.textContent = 'Round Disqualified';
    dqBtn.disabled = true;
  }

  // Persist to DB (fires Realtime updates to all clients)
  await Promise.all(updates);

  // Correct mastery: doReveal() already wrote mastery with the original is_correct,
  // so we need to overwrite it for all players who have accounts
  for (const answer of state.currentAnswers) {
    if (answer.question_id) {
      const player = state.players.find(p => p.id === answer.player_id);
      if (player?.user_id) {
        upsertQuestionHistory(player.user_id, answer.question_id, false);
      }
    }
  }

  // Recalculate scores
  if (_updateScores) await _updateScores();

  // Send system chat message — non-host clients will detect this
  await sendMessage(state.room.id, 'System',
    `Host disqualified Q${qNum + 1} — no scores affected.`);
}

export async function handleNextQuestion() {
  const isLastQuestion = state.currentQuestion >= state.totalQuestions - 1;

  if (isLastQuestion) {
    // Apply locally first — don't depend on Realtime echo
    state.gamePhase = 'results';
    if (_showResultsScreen) _showResultsScreen();
    await updateGameState(state.room.id, { game_phase: 'results' });
  } else {
    // Apply locally first
    state.currentQuestion = state.currentQuestion + 1;
    if (_handlePhaseTransition) _handlePhaseTransition('question');
    await updateGameState(state.room.id, {
      game_phase: 'question',
      current_question: state.currentQuestion
    });
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
  }, RESULTS_ACTION_DELAY_MS);
}

function startFeedbackFadeTimer() {
  if (state.feedbackFadeTimer) clearTimeout(state.feedbackFadeTimer);
  const container = $('#reveal-feedback');
  container.classList.remove('reveal__feedback--faded');
  state.feedbackFadeTimer = setTimeout(() => {
    container.classList.add('reveal__feedback--faded');
  }, RESULTS_ACTION_DELAY_MS);
}

export function initFeedbackListeners() {
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
      const labels = { wrong_answer: 'wrong answer', ambiguous: 'ambiguous', offensive: 'offensive', alternate_answer: 'another valid answer', other: 'other' };
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
  setFlagMenuCloseHandler(() => { flagMenu.style.display = 'none'; });
  document.addEventListener('click', _flagMenuCloseHandler);
}
