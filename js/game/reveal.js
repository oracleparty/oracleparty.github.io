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
import { fetchAnswersForQuestion, updateAnswerJudgment, setJudgementOnServer,
         disqualifyRoundOnServer, updateGameState, submitAnswer,
         upsertQuestionHistory, recordRoundHistory, amendQuestionHistory, revokeQuestionHistory,
         upsertQuestionFeedback, deleteQuestionFeedbackByVoter, sendMessage,
  recordQuestionOutcome, recordAnswerText, fetchQuestionPlayStats,
} from '../supabase.js';
import { describeDifficulty } from '../difficulty-band.js';
import { getDisplayName, getCurrentUser, getVoterId } from '../auth.js';
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
  if (!state.resultsRevealed && submittedCount(state.currentAnswers) < state.players.length) {
    setTimeout(async () => {
      if (!state.onRevealScreen || state.currentQuestion !== currentQ || state.resultsRevealed) return;
      const fresh = await fetchAnswersForQuestion(state.room.id, currentQ);
      if (submittedCount(fresh) > submittedCount(state.currentAnswers)) {
        state.currentAnswers = fresh;
        renderRevealAnswers(fresh);
      }
    }, REVEAL_ANSWER_DELAY_MS);
  }

  // Show countdown timer on reveal screen if the round isn't over yet
  const revealTimer = $('#reveal-timer');
  if (!state.timerExpired && submittedCount(state.currentAnswers) < state.players.length) {
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

/**
 * Paint the difficulty line, or hide it when there is nothing honest to say.
 *
 * The detail is only ever present when the band came from real plays, so the
 * sample is always attached to the claim: "12%" and "12% of 20 plays" are
 * different statements and must not look alike.
 */
function renderDifficultyBand(el, band) {
  if (!band) { el.style.display = 'none'; return; }
  el.style.display = '';
  el.dataset.band = band.label.toLowerCase().replace(/\s+/g, '-');
  el.dataset.measured = band.measured ? 'true' : 'false';
  el.innerHTML = band.detail
    ? `<span class="reveal__difficulty-label">${escapeHtml(band.label)}</span><span class="reveal__difficulty-detail">${escapeHtml(band.detail)}</span>`
    : `<span class="reveal__difficulty-label">${escapeHtml(band.label)}</span>`;
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
  // Never at a bot — there is nobody on the other end to startle.
  return (isMe || player.is_bot) ? '' : `<button class="honk-btn" data-honk-target="${player.id}" aria-label="Quack">&#x1F986;</button>`;
}

/**
 * How many players have actually ANSWERED, as opposed to merely having a row.
 *
 * On the final question lockInFinalWager writes a __WAGER_LOCKED__ placeholder
 * for every player the moment they choose a number, so plain answers.length
 * equals the player count before anybody has typed a word — which made the
 * screen believe the round was complete and hide the countdown.
 */
function submittedCount(answers) {
  return (answers || []).filter(a =>
    (a.submitted_answer || '').trim() !== '__WAGER_LOCKED__').length;
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

    // On the FINAL question every player already has a row the moment they lock
    // a wager: lockInFinalWager writes __WAGER_LOCKED__ as a placeholder so
    // other phones can see the number. That is not a submission, and rendering
    // it as one made the reveal screen say "No answer" for somebody who was
    // still typing. Reported from a playtest: "it showed no answer for them so
    // I thought they were ready". Before the reveal a placeholder means WAITING;
    // only once the answers are revealed does it mean they never answered.
    const isPlaceholder = answer && (answer.submitted_answer || '').trim() === '__WAGER_LOCKED__';
    const stillWaiting = !answer || (isPlaceholder && !state.resultsRevealed);
    const isDisqualified = state.disqualifiedQuestions?.has(state.currentQuestion);

    if (!stillWaiting) {
      row.dataset.answerId = answer.id;
      const rawText = (answer.submitted_answer || '').trim();
      const submittedText = isPlaceholder ? '' : rawText;
      const isEmpty = !submittedText;
      const isCorrect = answer.is_correct || false;
      const wager = answer.wager || 0;

      // Answer text color: only colored post-reveal (doReveal animates this)
      const colorClass = state.resultsRevealed
        ? (isCorrect ? 'answer-row__answer--correct' : 'answer-row__answer--incorrect')
        : '';
      const emptyClass = isEmpty ? ' answer-row__answer--empty' : '';

      // Toggle: host only, visible only after reveal (prevents host seeing
      // correct/incorrect early), and never on a round that has been thrown
      // out. Marking somebody correct in a disqualified round would award
      // points for a question the host has just declared did not happen —
      // the score would move and the reason would be invisible.
      const toggleHtml = (canControlGame() && state.resultsRevealed && !isDisqualified)
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
      // Player hasn't submitted yet — show waiting state. A locked final wager
      // still shows its number here, because they really did choose it; it is
      // the ANSWER that has not arrived.
      const hostBadge = player.is_host ? '<span class="badge badge--host">Host</span>' : '';
      const wagerHtml = isPlaceholder
        ? `<span class="answer-row__wager">${answer.wager || 0}</span>`
        : '';
      row.innerHTML = `
        <div class="answer-row__top">
          ${honkAvatarHtml(player)}
          <div class="name-stack">
            <span class="answer-row__name">${escapeHtml(player.display_name)}${hostBadge}</span>
            ${titleHtml}
          </div>
          ${honkBtnHtml(player)}
          ${wagerHtml}
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

  // HOW HARD WAS THAT?
  //
  // #reveal-difficulty has been in game.html since the beginning and the code
  // only ever HID it — the slot existed and was never once filled.
  //
  // Stored difficulty until a question has been played enough to speak for
  // itself, then what actually happened. See difficulty-band.js: there is
  // essentially no play data yet, so a percentage would be noise for a long
  // while, and the stored value covers that gap honestly.
  const diffEl = $('#reveal-difficulty');
  const revealedQ = state.questions[state.currentQuestion];
  if (diffEl && revealedQ) {
    const immediate = describeDifficulty({ storedDifficulty: revealedQ.difficulty });
    renderDifficultyBand(diffEl, immediate);
    // Then upgrade to the measured band if the numbers are there. Fire and
    // forget — nobody should lose a reveal because a stat did not load.
    fetchQuestionPlayStats(revealedQ.id).then(stats => {
      if (!stats) return;
      // The reveal may have moved on while this was in flight.
      if (state.questions[state.currentQuestion]?.id !== revealedQ.id) return;
      renderDifficultyBand(diffEl, describeDifficulty({
        storedDifficulty: revealedQ.difficulty,
        timesAsked: stats.times_asked,
        timesCorrect: stats.times_correct,
      }));
    }).catch(() => {});
  }

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

  // Record the round's history (fire-and-forget).
  //
  // This used to be "write MY row from MY browser", which made the record
  // depend on hardware: a phone asleep at the reveal recorded nothing and a
  // phone awake recorded a miss, so two people who both missed the same
  // question could end up with different permanent records. The owner settled
  // the question underneath it — a miss is a miss, exactly as it already is
  // for scoring — so the round is now recorded for everybody at once, through
  // record_round_history (migration 043).
  //
  // EVERY device calls it, not just the host. The function marks the answer
  // rows it counts and claims that marker under a row lock, so the first call
  // does the work and the rest are no-ops. That idempotency is the whole
  // design, and it is what lets this survive the case the change exists to
  // fix: if only the host called it, a host whose phone died would take the
  // whole room's record with them.
  //
  // (Contrast room_scores, which is host-gated — that write is NOT idempotent,
  // so a per-device call there multiplies the tally by the room size.)
  const revealedQuestionId = state.questions[state.currentQuestion]?.id;
  if (revealedQuestionId) recordRoundHistory(state.room.id, revealedQuestionId).then(res => {
    if (res.ok) return;
    // Migration 043 unapplied, or the call failed. Fall back to the old
    // per-device write so nothing is lost before the SQL is run — worse,
    // because it is back to depending on this phone being awake, but not
    // nothing.
    const authUser = getCurrentUser();
    if (!authUser) return;
    const myAnswer = state.currentAnswers.find(a => String(a.player_id) === String(state.room.playerId));
    if (myAnswer?.question_id) {
      upsertQuestionHistory(authUser.user.id, myAnswer.question_id, !!myAnswer.is_correct);
    }
  });

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

  // Belt and braces with the render above: the toggle is not drawn on a
  // disqualified round, but a stale one left in the DOM from before the
  // disqualification must not still be clickable.
  if (state.disqualifiedQuestions?.has(state.currentQuestion)) return;

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
  // The DATABASE recomputes the points from the answer's own wager (049), so
  // no score is sent. Falls back to the direct write when it is not installed.
  const served = await setJudgementOnServer(answerId, newCorrect, state.room?.playerId);
  if (!served.ok) await updateAnswerJudgment(answerId, newCorrect, newScore);

  // Correct the mastery record for the affected player. AMEND, not upsert:
  // the attempt was already counted by doReveal, and the host changing their
  // mind is not a second sighting of the question. See amendQuestionHistory.
  const player = state.players.find(p => p.id === answer.player_id);
  if (player?.user_id && answer.question_id) {
    amendQuestionHistory(player.user_id, answer.question_id, newCorrect, state.room.id);
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

  // Set all answers for this question to score_earned = 0.
  //
  // ONE CALL (migration 049), because the whole round is one decision — a loop
  // of per-answer writes can half-succeed and leave a round that was thrown out
  // still paying points to whoever's write went through.
  const updates = [];
  for (const answer of state.currentAnswers) {
    answer.is_correct = false;
    answer.score_earned = 0;
  }
  const servedDq = await disqualifyRoundOnServer(
    state.room.id, state.currentQuestion, state.room?.playerId);
  if (!servedDq.ok) {
    for (const answer of state.currentAnswers) {
      if (answer.id) updates.push(updateAnswerJudgment(answer.id, false, 0));
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

  // Take the attempt back out of mastery entirely. doReveal() already counted
  // it, and a disqualified round must count neither for nor against anybody.
  //
  // This used to write `false`, which was the worst of the three options: it
  // added ANOTHER times_seen on top of doReveal's and scored it as a miss, so
  // the one action meaning "this round does not count" was the action that
  // damaged a player's accuracy most. See revokeQuestionHistory.
  for (const answer of state.currentAnswers) {
    if (answer.question_id) {
      const player = state.players.find(p => p.id === answer.player_id);
      if (player?.user_id) {
        revokeQuestionHistory(player.user_id, answer.question_id, state.room.id);
      }
    }
  }

  // Recalculate scores
  if (_updateScores) await _updateScores();

  // Send system chat message — non-host clients will detect this
  await sendMessage(state.room.id, 'System',
    `Host disqualified Q${qNum + 1} — no scores affected.`);
}

/**
 * Send one outcome row per player for the question just revealed, so the admin
 * Question Health page has durable per-question performance data.
 *
 * Host/co-host only: every device runs this same code, and recording from all
 * of them would multiply every count by the number of players.
 *
 * `overridden` compares the host's final judgement against auto_correct, the
 * verdict fuzzy matching reached at submit time. A mismatch means a human
 * decided the answer key was wrong, which is the signal worth surfacing.
 */
function recordCurrentQuestionOutcomes() {
  if (!canControlGame()) return;
  const question = state.questions[state.currentQuestion];
  if (!question) return;

  // A disqualified round is the host saying this question should not have been
  // asked, so none of it is evidence about anything. Recording it anyway was
  // actively misleading in three directions at once: disqualify sets every
  // answer to is_correct=false, so question_stats would have logged the
  // question as asked-and-nobody-got-it (making a question look impossibly
  // hard precisely when it was thrown out), answer_tally would have counted
  // text nobody was judged on, and every player auto-marked correct before the
  // disqualification would have registered as times_overridden — the column
  // this project treats as its strongest signal that an answer key is wrong.
  if (state.disqualifiedQuestions?.has(state.currentQuestion)) return;

  for (const answer of state.currentAnswers || []) {
    if (answer.submitted_answer === '__WAGER_LOCKED__') continue;

    // NOTHING a bot does is recorded — not the outcome, not the text. Its
    // answer comes from a percentage somebody chose, so counting it would put
    // that invented number into question_stats, which is the evidence used to
    // decide whether a question is too hard, and into answer_tally, which is
    // the evidence used to decide whether its answer key is wrong.
    //
    // This check has to come FIRST. When it sat between the two writes, the
    // outcome was recorded and only the text was skipped, which is the worse
    // half to keep.
    const player = (state.players || []).find(p => String(p.id) === String(answer.player_id));
    if (player?.is_bot) continue;

    const overridden = answer.auto_correct != null
      && !!answer.auto_correct !== !!answer.is_correct;
    recordQuestionOutcome(question.id, answer.is_correct, overridden);

    // Record the text itself, so the common answers to a question can be seen
    // and a missing acceptable answer shows up without anyone noticing it.
    recordAnswerText(question.id, answer.submitted_answer);
  }
}

export async function handleNextQuestion() {
  // Record how this question performed before moving on. Host only, so counts
  // are not multiplied by the number of devices in the room.
  recordCurrentQuestionOutcomes();

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
  const noteBox = container.querySelector('.feedback-flag-note');
  if (noteBox) {
    noteBox.style.display = 'none';
    const noteInput = noteBox.querySelector('input');
    if (noteInput) noteInput.value = '';
  }
  const confirmEl = container.querySelector('.feedback-flag-confirm');
  if (confirmEl) { confirmEl.classList.remove('show'); confirmEl.textContent = ''; }
}

function showFeedbackUI() {
  const container = $('#reveal-feedback');
  container.style.display = '';
  container.classList.remove('reveal__feedback--faded');

  // Restore previous feedback state for this question
  const q = state.questions[state.currentQuestion];
  if (q) {
    const fb = _qbFeedback[q.id];
    const fbType = fb?.type || null;
    container.querySelectorAll('.feedback-btn').forEach(b => {
      b.classList.toggle('feedback-btn--active', b.dataset.type === fbType);
    });
    // If previously flagged with a specific reason, show confirmation text
    if (fbType === 'flag' && fb.reason) {
      const labels = { wrong_answer: 'wrong answer', ambiguous: 'ambiguous', offensive: 'offensive', alternate_answer: 'another valid answer', other: 'other' };
      const confirmEl = document.getElementById('feedback-flag-confirm');
      confirmEl.textContent = `Flagged as ${labels[fb.reason] || fb.reason} \u2713`;
      confirmEl.classList.add('show');
    }
  }

  state.feedbackFadeTimer = setTimeout(() => {
    container.classList.add('reveal__feedback--faded');
  }, RESULTS_ACTION_DELAY_MS);
}

function startFeedbackFadeTimer() {
  if (state.feedbackFadeTimer) clearTimeout(state.feedbackFadeTimer);
  const container = $('#reveal-feedback');
  container.classList.remove('reveal__feedback--faded');
  state.feedbackFadeTimer = setTimeout(() => {
    // Never fade while the flag menu is open. It drops to 20% opacity, which on
    // a phone reads as "this closed" — and it does it after four seconds, which
    // is less time than it takes to read five reasons and pick one. The buttons
    // stayed clickable throughout, so somebody who pressed on anyway did save a
    // flag, but anyone who took the hint gave up. Reported as flagging that
    // "multiple times doesn't seem to work".
    const menu = container.querySelector('.feedback-flag-menu');
    const note = container.querySelector('.feedback-flag-note');
    const openThing = (menu && menu.style.display !== 'none')
      || (note && note.style.display !== 'none');
    if (openThing) {
      startFeedbackFadeTimer();
      return;
    }
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
          deleteQuestionFeedbackByVoter({ questionId: q.id, voterId: getVoterId() });
        }
      } else {
        btn.classList.add('feedback-btn--active');
        if (q) {
          _qbFeedback[q.id] = { type, reason: null };
          upsertQuestionFeedback({
            voterId: getVoterId(),
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
        _qbFeedback[q.id] = { type: 'flag', reason };
        upsertQuestionFeedback({
          voterId: getVoterId(),
          questionId: q.id,
          roomId: state.room.id,
          playerName: getDisplayName(),
          feedbackType: 'flag',
          flagReason: reason
        });
      }

      // "Other" says nothing on its own, so offer a line to say what. The flag
      // is ALREADY saved by this point — somebody who taps Other and then puts
      // their phone down has still filed it, and the note is a follow-up.
      const noteBox = $('#feedback-flag-note');
      if (noteBox) {
        if (reason === 'other' && q) {
          noteBox.style.display = '';
          $('#feedback-flag-note-input').value = '';
          $('#feedback-flag-note-input').focus({ preventScroll: true });
        } else {
          noteBox.style.display = 'none';
        }
      }

      startFeedbackFadeTimer();
    });
  });

  // Send the optional note for an "Other" flag. An UPDATE on the row already
  // written, so a failure here loses the note and never the flag.
  const noteBtn = document.getElementById('btn-feedback-flag-note');
  const noteInput = document.getElementById('feedback-flag-note-input');
  if (noteBtn && noteInput) {
    const sendNote = () => {
      const text = noteInput.value.trim();
      const q = state.questions[state.currentQuestion];
      if (!text || !q) return;
      upsertQuestionFeedback({
        voterId: getVoterId(),
        questionId: q.id,
        roomId: state.room.id,
        playerName: getDisplayName(),
        feedbackType: 'flag',
        flagReason: 'other',
        flagNote: text
      });
      $('#feedback-flag-note').style.display = 'none';
      const confirmEl = document.getElementById('feedback-flag-confirm');
      confirmEl.textContent = 'Thanks \u2014 sent \u2713';
      confirmEl.classList.remove('show');
      void confirmEl.offsetHeight;
      confirmEl.classList.add('show');
      startFeedbackFadeTimer();
    };
    noteBtn.addEventListener('click', (e) => { e.stopPropagation(); sendNote(); });
    noteInput.addEventListener('click', (e) => e.stopPropagation());
    noteInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') sendNote();
    });
  }

  // Close flag menu on outside click
  setFlagMenuCloseHandler(() => { flagMenu.style.display = 'none'; });
  document.addEventListener('click', _flagMenuCloseHandler);
}
