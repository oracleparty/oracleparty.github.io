// ============================================
// Oracle Party — Scores Module
// Scores screen, final wager, score edit, results, play again/quit.
// ============================================

import { $, transitionScreens, escapeHtml, renderAvatar, showToast, navigateWithFade, navigateWithFadeReplace } from '../utils.js';
import { logger } from '../logger.js';
import { SCORE_ANIMATE_MS, SCORE_REORDER_DELAY_MS, SCORE_PRE_ANIMATE_DELAY_MS, AUTO_PROCEED_TICK_MS, FINAL_WAGER_TIMER_SECONDS } from '../constants.js';
import {
  supabase,
  updateGameState,
  addRoomScores,
  submitAnswer,
  fetchAnswersForQuestion,
  updateAnswerJudgment,
  fetchAllAnswers,
  sendMessage,
  updateRoomStatus,
  createDifficultyVoteChannel,
  fetchQuestionByDifficulty,
  deleteAnswersByRoom,
  deleteRoom,
  removePlayer,
  insertGamePlay,
  completeGamePlay,
  archiveChatMessages,
  insertGameHistoryEntry,
  upsertQuestionHistory,
  amendQuestionHistory,
  fetchPlayerStats,
  fetchTitleUnlocks,
  upsertTitleUnlock,
  fetchQuestionFeedback,
  upsertQuestionFeedback,
  deleteQuestionFeedbackByVoter,
} from '../supabase.js';
import { getDisplayName, getCurrentUser, showSignUpModal, getVoterId } from '../auth.js';
import { evaluateUnlocks, hasReachedApprentice } from '../titles.js';
import { CATEGORY_META } from '../categories.js';
import { sendHonk, getHonkCount } from '../honk.js';
import { computeScoresFromAnswers, tallyDifficultyVotes, modalDifficulty, pickWeightedDifficulty, allowedDifficulties } from './scoring-helpers.js';
import { getServerTimeLeft as _getServerTimeLeft } from './timer-helpers.js';
import {
  state, canControlGame, getCategoryLabel,
  getQuestionText, getCorrectAnswer,
  _lastScoresRenderedForQuestion, setLastScoresRendered,
  _isLeaving, setIsLeaving,
  _screenTransitioning, setScreenTransitioning,
  _qbFeedback,
} from './state.js';
import { repositionChatBar, showChatBar, hideChatBar, closeChatDrawer } from './chat.js';
import { showHostSettingsGear } from './host.js';
import { lockBotFinalWagers, getHumans } from './bots.js';

// Forward references — registered by init.js to avoid circular imports
let _cleanup = null;
export function registerCleanup(fn) { _cleanup = fn; }

let _showQuestionScreen = null;
export function registerShowQuestionScreen(fn) { _showQuestionScreen = fn; }

let _handleNextQuestion = null;
export function registerHandleNextQuestion(fn) { _handleNextQuestion = fn; }

// ============================================
// SCORES SCREEN (animated reveal)
// ============================================

export async function handleShowScores() {
  // Apply locally first so the host doesn't depend on Realtime echo
  state.gamePhase = 'scores_reveal';
  state.onRevealScreen = false;
  showScoresScreen();
  // Broadcast to other clients
  await updateGameState(state.room.id, { game_phase: 'scores_reveal' });
}

export async function showScoresScreen() {
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
    const honkBtn = (isMe || p.is_bot) ? '' : `<button class="honk-btn" data-honk-target="${p.id}" aria-label="Quack">&#x1F986;</button>`;

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
    actionFn = _handleNextQuestion;
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

export function clearAutoProceed() {
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
  // Drop the last question's stamp before the screen reads it, or the 20-second
  // clock would open already expired.
  state.questionStartedAt = null;
  showFinalWagerScreen();
  await updateGameState(state.room.id, { game_phase: 'final_wager' });

  // Stamp the clock as a SEPARATE write, after the phase. Every other client
  // clears the previous question's stamp when the phase lands, so a stamp sent
  // in the same payload would be wiped by the transition it arrived with. This
  // is the same two-step the question screen uses, for the same reason.
  const startedAt = new Date(Date.now() + state.serverTimeOffset).toISOString();
  state.questionStartedAt = startedAt;
  updateGameState(state.room.id, { question_started_at: startedAt })
    .catch(err => logger.warn('Game', 'Could not stamp the final wager timer', err));
}

async function handleShowResults() {
  state.gamePhase = 'results';
  showResultsScreen();
  await updateGameState(state.room.id, { game_phase: 'results' });
}

// ============================================
// FINAL WAGER SCREEN
// ============================================

export function showFinalWagerScreen() {
  state.isFinalWagerRound = true;

  // A timestamp already present here means a reconnect: init.js reads
  // question_started_at off the room row before it routes the phase, and the
  // final_wager case leaves it alone when it came from 'loading'. So a player
  // returning mid-wager resumes the countdown already running rather than
  // getting a fresh 20 seconds nobody else has.
  if (!state.finalWagerLocked) state.finalWagerSelected = false;

  $('#fw-category').textContent = getCategoryLabel();
  $('#fw-current-score').textContent = state.scores[state.room.playerId] || 0;

  const status = $('#fw-status');
  const revealBtn = $('#btn-fw-reveal');
  const options = document.querySelectorAll('.fw-option');

  // Bots lock their final wager immediately, so the list shows a number for
  // them instead of a "Waiting..." that would never resolve. Host only, and
  // fire-and-forget — the screen must render either way.
  lockBotFinalWagers()
    .then(() => updateFinalWagerPlayerList())
    .catch(err => logger.warn('Bots', 'Could not lock bot final wagers', err));

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
      state.finalWagerSelected = true;
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

  // The 20-second clock. The stamp itself is written by handleFinalWager, after
  // the phase, so it cannot be cleared by the transition it travelled with.
  // Until it lands the bar simply reads full — every tick re-reads
  // state.questionStartedAt rather than capturing it once.
  startFinalWagerTimer();

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
    .on('broadcast', { event: 'reveal' }, ({ payload }) => {
      // Non-host: run the same slot-machine animation locally so all clients
      // see the dramatic difficulty reveal in sync. Host already triggered
      // its own animation directly in handleRevealFinalQuestion.
      if (state.room.isHost) return;
      // voted comes over the wire so every client spins through the same
      // options. Deriving it locally would let a client whose vote state was
      // incomplete animate a different wheel from everyone else's.
      playDifficultyRevealAnimation(payload?.mostVoted || null, payload?.winner || 'medium', payload?.voted || null);
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

/**
 * Stop the final-wager countdown and put the header back the way it was.
 * Safe to call when no timer is running — every exit from the screen calls it,
 * and a stray interval on this screen would keep ticking into the next round.
 */
export function clearFinalWagerTimer() {
  if (state.finalWagerTimerId) {
    clearInterval(state.finalWagerTimerId);
    state.finalWagerTimerId = null;
  }
  const el = $('#fw-timer');
  if (el) {
    el.style.display = 'none';
    el.classList.remove('timer--warning', 'timer--expired');
  }
}

/**
 * Count 20 seconds down from the room's shared timestamp, then commit.
 *
 * Reads state.questionStartedAt every tick rather than capturing it once:
 * showFinalWagerScreen runs the moment the phase arrives, and on a non-host
 * device the host's timestamp lands a beat later over Realtime. Until it does,
 * getServerTimeLeft returns the full duration, so the bar simply sits at 100%
 * instead of the screen having to sequence the two events.
 */
function startFinalWagerTimer() {
  clearFinalWagerTimer();

  const wrap = $('#fw-timer');
  const bar = $('#fw-timer-bar');
  const text = $('#fw-timer-text');
  if (!wrap || !bar || !text) return;

  // Nothing to count for somebody who has already committed. Showing them a
  // clock they cannot act on only makes them think something is still expected.
  if (state.finalWagerLocked) return;

  wrap.style.display = '';

  const tick = () => {
    const left = _getServerTimeLeft(
      state.questionStartedAt, state.serverTimeOffset, FINAL_WAGER_TIMER_SECONDS);
    const secs = Math.ceil(left);
    text.textContent = `${secs}s`;
    bar.style.width = `${Math.max(0, (left / FINAL_WAGER_TIMER_SECONDS) * 100)}%`;
    wrap.classList.toggle('timer--warning', left <= 5 && left > 0);

    if (left > 0) return;

    wrap.classList.add('timer--expired');
    clearInterval(state.finalWagerTimerId);
    state.finalWagerTimerId = null;

    if (state.finalWagerLocked) return;

    // Whatever they tapped stands — not pressing Lock In is indecision about
    // confirming, not about the number. Someone who never touched the screen
    // wagers 0: state.finalWager defaults to 20, and committing that default
    // would take 20 points off a player for being away, when every other
    // missed round in this game costs a wager and nothing else.
    if (!state.finalWagerSelected) state.finalWager = 0;
    lockInFinalWager();
  };

  tick();
  state.finalWagerTimerId = setInterval(tick, 200);
}

async function lockInFinalWager() {
  if (state.finalWagerLocked) return;
  state.finalWagerLocked = true;
  clearFinalWagerTimer();

  // Reflect the committed number, which the timer may have just decided.
  document.querySelectorAll('.fw-option').forEach(b => {
    b.classList.toggle('fw-option--selected',
      parseInt(b.dataset.wager, 10) === state.finalWager);
  });
  const lockBtn = $('#btn-fw-lock');
  if (lockBtn) lockBtn.style.display = 'none';

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
    const honkBtn = (isMe || p.is_bot) ? '' : `<button class="honk-btn" data-honk-target="${p.id}" aria-label="Quack">&#x1F986;</button>`;

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

export async function updateFinalWagerPlayerList() {
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

export async function handleRevealFinalQuestion() {
  // Vote acts as a FLOOR: result can be at-or-above the most-voted, never
  // lower. Unvoted-but-allowed levels keep a 0.1 weight so an all-Easy room
  // still has a small comedic chance of jumping to Medium or Hard.
  const tally = tallyDifficultyVotes(state.difficultyVotes);
  const mostVoted = modalDifficulty(tally); // null if no votes
  const winner = pickWeightedDifficulty(tally);
  // The wheel visits every level the result could actually be, which is the
  // most-voted one and everything harder (the vote is a floor). Cycling only
  // the VOTED levels stopped the wheel dead whenever a small room agreed —
  // three people picking Easy left one pill to cycle through, so it looked
  // like the game just decided on its own. See allowedDifficulties.
  const voted = allowedDifficulties(tally);
  state.votedDifficulty = winner;

  // Try to fetch a question matching the voted difficulty (optional — pre-fetched is fallback)
  try {
    const usedIds = state.questions.map(q => q.id);
    const q = await fetchQuestionByDifficulty(state.room.category, winner, usedIds, state.room.subcategory || null);
    if (q) state.questions[state.totalQuestions] = q;
  } catch (e) { /* Use pre-fetched question */ }

  // Broadcast the slot-machine reveal to all clients via the existing vote
  // channel BEFORE we start the local animation, so non-hosts get the same
  // (mostVoted, winner) pair and run a synchronized animation.
  if (state.difficultyVoteChannel) {
    try {
      state.difficultyVoteChannel.send({
        type: 'broadcast',
        event: 'reveal',
        payload: { mostVoted, winner, voted }
      });
    } catch (_) { /* swallow — animation still runs locally */ }
  }

  // Animate the dramatic reveal locally (slot-machine cycle, settle on most-
  // voted, comedic last-second switch if randomness defied the votes).
  await playDifficultyRevealAnimation(mostVoted, winner, voted);

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
  // The wager screen is over. A tick left running here would fire
  // lockInFinalWager against a screen nobody is looking at any more.
  clearFinalWagerTimer();
  $('#reveal-answers').innerHTML = '';

  _showQuestionScreen();

  // Broadcast to other players — include question_ids so non-host gets the updated question
  const questionIds = state.questions.map(qn => qn.id);
  await updateGameState(state.room.id, {
    game_phase: 'final_question',
    current_question: state.totalQuestions,
    question_ids: questionIds
  });
}

/**
 * Slot-machine difficulty reveal. Non-blocking-ish (resolves when done so
 * caller can sequence). The animation:
 *   1. Cycle highlight rapidly through the VOTED difficulties only (slowing)
 *   2. Settle on the most-voted (or center if no votes)
 *   3. If the actual winner is different, "gotcha" jump to it after a beat
 *   4. Final flourish on the winner, then fade.
 */
function playDifficultyRevealAnimation(mostVoted, winner, voted = null) {
  return new Promise((resolve) => {
    const overlay = $('#difficulty-reveal-overlay');
    if (!overlay) { resolve(); return; }
    const pills = overlay.querySelectorAll('.dr-pill');
    const finalEl = overlay.querySelector('.difficulty-reveal__final');
    const ALL = ['easy', 'medium', 'hard'];

    // The wheel only visits difficulties somebody chose. It used to cycle all
    // three every time, so in a room where nobody picked Easy the pill still
    // lit up on the way past and looked like a live possibility.
    //
    // The FINAL result can still be an unvoted level — that is the deliberate
    // last-second switch, and it stays. What changes is that the wheel no
    // longer teases options that were never in contention.
    const order = (Array.isArray(voted) && voted.length) ? voted : ALL;
    const setActive = (d) => {
      pills.forEach(p => p.classList.remove('dr-pill--active', 'dr-pill--settling', 'dr-pill--gotcha'));
      if (d) overlay.querySelector(`.dr-pill[data-difficulty="${d}"]`)?.classList.add('dr-pill--active');
    };

    overlay.classList.remove('hidden');
    finalEl.textContent = '';
    pills.forEach(p => p.classList.remove('dr-pill--active', 'dr-pill--settling', 'dr-pill--gotcha'));

    // The pill we'll appear to "settle on" (visual fakeout). If no votes,
    // settle on the actual winner (no comedic switch happens).
    const settleTarget = mostVoted || winner;

    // Phase 1: rapid cycle (~1.4s, decelerating).
    //
    // The modulo follows the cycle set, not a hardcoded 3 — with two voted
    // options a fixed 3 would have indexed off the end and blanked the wheel
    // every third tick. When only one difficulty was voted there is nothing to
    // cycle through, so it holds on that one and settles sooner rather than
    // strobing a single pill.
    const soleChoice = order.length === 1;
    const ticks = soleChoice ? 6 : 22;
    let i = 0;
    let speed = soleChoice ? 140 : 60;  // ms
    const cycle = () => {
      setActive(order[i % order.length]);
      i++;
      speed = Math.min(speed + 8, 220);  // slow down
      if (i < ticks) {
        setTimeout(cycle, speed);
      } else {
        // Phase 2: settle on the "expected" choice
        setActive(settleTarget);
        overlay.querySelector(`.dr-pill[data-difficulty="${settleTarget}"]`)?.classList.add('dr-pill--settling');
        setTimeout(() => {
          if (settleTarget !== winner) {
            // Phase 3: comedic last-second switch
            setActive(null);
            setTimeout(() => {
              setActive(winner);
              overlay.querySelector(`.dr-pill[data-difficulty="${winner}"]`)?.classList.add('dr-pill--gotcha');
              setTimeout(finalReveal, 700);
            }, 120);
          } else {
            // No switch needed — flow straight to final reveal
            setTimeout(finalReveal, 400);
          }
        }, 800);
      }
    };
    const finalReveal = () => {
      finalEl.textContent = winner.toUpperCase();
      finalEl.classList.add('difficulty-reveal__final--show');
      setTimeout(() => {
        overlay.classList.add('hidden');
        finalEl.classList.remove('difficulty-reveal__final--show');
        resolve();
      }, 1100);
    };
    cycle();
  });
}

// ============================================
// SCORE EDIT (Host Only)
// ============================================

export function showScoreEditSheet() {
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

  // A round the host threw out is not up for re-judgement anywhere. Awarding
  // points inside a disqualified question would move the score with no visible
  // reason, since the whole round reads as zero.
  const editDisqualified = state.disqualifiedQuestions?.has(questionNumber);

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
        ${editDisqualified ? '' : `<div class="answer-toggle ${isCorrect ? 'answer-toggle--correct' : 'answer-toggle--incorrect'} answer-toggle--host" data-answer-id="${answer.id}" data-question-number="${questionNumber}" data-player-name="${escapeHtml(player.display_name)}">
          <div class="answer-toggle__thumb"></div>
        </div>`}
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
    if (state.disqualifiedQuestions?.has(qNum)) return;

    const newCorrect = !answer.is_correct;
    const isFinal = qNum >= state.totalQuestions;
    const newScore = newCorrect ? answer.wager : (isFinal ? -answer.wager : 0);

    answer.is_correct = newCorrect;
    answer.score_earned = newScore;

    await updateAnswerJudgment(answerId, newCorrect, newScore);

    // AMEND, not upsert — a retroactive correction is not a second attempt.
    const player = state.players.find(p => String(p.id) === String(answer.player_id));
    if (player?.user_id && answer.question_id) {
      amendQuestionHistory(player.user_id, answer.question_id, newCorrect, state.room.id);
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


export async function showResultsScreen() {
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
      // Placement is against PEOPLE. A bot's score comes from a percentage
      // somebody chose, so counting it would mean a player's own history is
      // partly made of that invented number — "2nd of 3" against two bots is
      // not a fact about anybody's trivia.
      const humans = getHumans(state.players);
      const sortedForPlacement = [...humans].sort((a, b) => (state.scores[b.id] || 0) - (state.scores[a.id] || 0));
      const placement = sortedForPlacement.findIndex(p => String(p.id) === String(state.room.playerId)) + 1;
      const sub = state.room.subcategory || null;
      // Fire-and-forget — don't block results rendering
      insertGameHistoryEntry({
        userId: uid, roomId: state.room.id, category: cat,
        subcategory: sub,
        score: state.scores[state.room.playerId] || 0,
        placement, totalPlayers: humans.length
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

  // Room session cumulative scores (for the lobby leaderboard).
  //
  // HOST ONLY, and once per game. Every device computes the same scores from
  // the same answers, so letting all of them add to a shared total would
  // multiply it by the number of phones in the room. The re-render guard stays
  // because showResultsScreen is re-entered on Realtime events.
  //
  // Keyed on display name, not player id: a player row is deleted when someone
  // leaves and recreated when they return, so the id is not stable across the
  // very event this is meant to survive, and guests have no account to key on.
  if (!state._cumulativeScoresWritten && state.room.isHost) {
    state._cumulativeScoresWritten = true;
    const earned = {};
    for (const p of state.players) earned[p.display_name] = state.scores[p.id] || 0;
    addRoomScores(state.room.id, earned)
      .catch(err => logger.warn('Game', 'Could not save room scores', err));
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
    const honkBtn = (isMe || p.is_bot) ? '' : `<button class="honk-btn" data-honk-target="${p.id}" aria-label="Quack">&#x1F986;</button>`;

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

export async function handlePlayAgain() {
  setIsLeaving(true); // Player stays in room — prevent handleUnload from removing
  try { if (_cleanup) _cleanup(); } catch (_) { /* Don't let cleanup errors block navigation */ }

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

let _quitConfirmTimer = null;
async function handleQuitGame() {
  const btn = $('#btn-quit-game');
  // Tap-again-to-confirm — leaves the room and goes home, no undo.
  if (_quitConfirmTimer === null) {
    if (btn) {
      btn.textContent = 'Tap to confirm';
      btn.classList.add('btn--confirming');
    }
    _quitConfirmTimer = setTimeout(() => {
      _quitConfirmTimer = null;
      if (btn) {
        btn.textContent = 'Quit';
        btn.classList.remove('btn--confirming');
      }
    }, 3000);
    return;
  }
  clearTimeout(_quitConfirmTimer);
  _quitConfirmTimer = null;
  setIsLeaving(true);
  try { if (_cleanup) _cleanup(); } catch (_) { /* Don't let cleanup errors block navigation */ }
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
  for (const r of ratings) _qbFeedback[r.question_id] = { type: r.feedback_type, reason: r.flag_reason || null };

  // Build question list (all regular + final wager question)
  const totalQ = Math.min(state.questions.length, state.totalQuestions + 1);
  list.innerHTML = '';

  for (let i = 0; i < totalQ; i++) {
    const q = state.questions[i];
    if (!q) continue;

    const isFinal = i === state.totalQuestions;
    const label = isFinal ? 'Final Question' : `Question ${i + 1}`;
    const myAnswer = answerByQ[i];
    const fb = _qbFeedback[q.id] || null;
    const existingType = fb?.type || null;

    let playerAnswerHtml = '';
    if (myAnswer) {
      const correctClass = myAnswer.is_correct
        ? 'review-item__player-answer--correct'
        : 'review-item__player-answer--incorrect';
      playerAnswerHtml = `<div class="review-item__player-answer ${correctClass}">${escapeHtml(myAnswer.submitted_answer)}</div>`;
    }

    // Host: show ALL player answers with toggle switches for score correction
    let hostAnswersHtml = '';
    // Same rule as the reveal and the score-edit sheet: a disqualified round
    // shows what happened but offers no way to re-judge it.
    if (canControlGame() && !state.disqualifiedQuestions?.has(i)) {
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

    // Flag reason label for previously-flagged questions
    const flagReasonLabels = { wrong_answer: 'wrong answer', ambiguous: 'ambiguous', offensive: 'offensive', alternate_answer: 'another valid answer', other: 'other' };
    const flagReasonHtml = (existingType === 'flag' && fb.reason)
      ? `<span class="review-item__flag-reason">Flagged: ${flagReasonLabels[fb.reason] || fb.reason}</span>`
      : '';

    const item = document.createElement('div');
    const isFlagged = existingType === 'thumbs_down' || existingType === 'flag';
    item.className = 'review-item' + (isFlagged ? ' review-item--flagged' : '');
    item.innerHTML = `
      <div class="review-item__num">${label}</div>
      <div class="review-item__q">${escapeHtml(getQuestionText(q))}</div>
      <div class="review-item__a">${escapeHtml(getCorrectAnswer(q))}</div>
      ${canControlGame() ? hostAnswersHtml : playerAnswerHtml}
      <div class="review-item__feedback">
        <button class="feedback-btn${existingType === 'thumbs_up' ? ' feedback-btn--active' : ''}" data-type="thumbs_up" data-qid="${q.id}" aria-label="Thumbs up">👍</button>
        <button class="feedback-btn${existingType === 'thumbs_down' ? ' feedback-btn--active' : ''}" data-type="thumbs_down" data-qid="${q.id}" aria-label="Thumbs down">👎</button>
        <button class="feedback-btn feedback-btn--flag${existingType === 'flag' ? ' feedback-btn--active' : ''}" data-type="flag" data-qid="${q.id}" aria-label="Flag">🚩</button>
        ${flagReasonHtml}
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
      const reasonLabel = reviewItem.querySelector('.review-item__flag-reason');

      if (type === 'flag') {
        const wasActive = btn.classList.contains('feedback-btn--active');
        btn.classList.toggle('feedback-btn--active');
        if (!wasActive) {
          _qbFeedback[qid] = { type: 'flag', reason: 'other' };
          upsertQuestionFeedback({
            questionId: qid,
            roomId: state.room.id,
            playerName: getDisplayName(),
            feedbackType: 'flag',
            flagReason: 'other'
          });
          if (reasonLabel) reasonLabel.textContent = 'Flagged: other';
          else btn.insertAdjacentHTML('afterend', '<span class="review-item__flag-reason">Flagged: other</span>');
        } else {
          _qbFeedback[qid] = null;
          deleteQuestionFeedbackByVoter({ questionId: qid, voterId: getVoterId() });
          if (reasonLabel) reasonLabel.remove();
        }
        // Update flagged highlight
        const fbObj = _qbFeedback[qid];
        const fbType = fbObj?.type || null;
        reviewItem.classList.toggle('review-item--flagged', fbType === 'flag' || fbType === 'thumbs_down');
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
        _qbFeedback[qid] = { type, reason: null };
        upsertQuestionFeedback({
          questionId: qid,
          roomId: state.room.id,
          playerName: getDisplayName(),
          feedbackType: type,
          flagReason: null
        });
      } else {
        _qbFeedback[qid] = null;
        deleteQuestionFeedbackByVoter({ questionId: qid, voterId: getVoterId() });
      }
      // Update flagged highlight
      const fbObj = _qbFeedback[qid];
      const fbType = fbObj?.type || null;
      reviewItem.classList.toggle('review-item--flagged', fbType === 'flag' || fbType === 'thumbs_down');
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
        if (state.disqualifiedQuestions?.has(answer.question_number)) return;
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

        // AMEND, not upsert — a retroactive correction is not a second attempt.
        const player = state.players.find(p => String(p.id) === String(answer.player_id));
        if (player?.user_id && answer.question_id) {
          amendQuestionHistory(player.user_id, answer.question_id, newCorrect, state.room.id);
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

export async function updateScores() {
  const allAnswers = await fetchAllAnswers(state.room.id);
  state.scores = computeScoresFromAnswers(allAnswers, state.players);
}
