// ============================================
// Oracle Party — Reveal Screen Module
// Answer reveal, judgment overrides, feedback UI, honks.
// ============================================

import { state, canControlGame, currentGameAnswers, getCategoryLabel, getQuestionText, getCorrectAnswer, getFunFact,
         _screenTransitioning, setScreenTransitioning,
         _flagMenuCloseHandler, setFlagMenuCloseHandler,
         _qbFeedback, setQbFeedback } from './state.js';
import { $, transitionScreens, escapeHtml, renderAvatar } from '../utils.js';
import { logger } from '../logger.js';
import { REVEAL_ANSWER_DELAY_MS, RESULTS_ACTION_DELAY_MS } from '../constants.js';
import { fetchAnswersForQuestion, updateAnswerJudgment, setJudgementOnServer,
         disqualifyRoundOnServer, updateGameState,
         upsertQuestionHistory, recordRoundHistory, amendQuestionHistory, revokeQuestionHistory,
         upsertQuestionFeedback, deleteQuestionFeedbackByVoter, sendMessage,
  rateHost, fetchHostReputations, hostRatingsAvailable,
  insertBlankAnswers, fetchAllAnswers,
  recordQuestionOutcome, recordAnswerText, fetchQuestionPlayStats,
} from '../supabase.js';
import { describeDifficulty } from '../difficulty-band.js';
import { countAnswersFrom, findNextAvailableWager } from './scoring-helpers.js';
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
  state.currentAnswers = currentGameAnswers(await fetchAnswersForQuestion(state.room.id, currentQ));
  // Skip render if doReveal() will be called immediately (it re-renders with colors)
  if (!state.resultsRevealed) {
    renderRevealAnswers(state.currentAnswers);
  }

  // BUG 3 FIX: Safety re-fetch after 1.5s to catch answers submitted concurrently.
  if (!state.resultsRevealed && submittedCount(state.currentAnswers) < state.players.length) {
    setTimeout(async () => {
      if (!state.onRevealScreen || state.currentQuestion !== currentQ || state.resultsRevealed) return;
      const fresh = currentGameAnswers(await fetchAnswersForQuestion(state.room.id, currentQ));
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
 * This used to be its own filter here, skipping the __WAGER_LOCKED__ placeholder
 * and nothing else — so it was blind to the fault migration 052 introduced, in
 * which an answer outlives the seat it was given in and a departed player's row
 * stands in for somebody still typing. countAnswersFrom had the opposite half.
 * One function holds both rules now; this is a thin wrapper so the call sites
 * below still read as the question they are asking.
 */
function submittedCount(answers) {
  return countAnswersFrom(answers, state.players);
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

    // AN EMPTY ANSWER BEFORE THE REVEAL ALSO MEANS WAITING, for the same reason
    // as a placeholder. The blank fill writes an empty row for anybody who has
    // not answered, and it can beat a submission that is already in flight — so
    // the row appears empty, the screen says "No answer", and a moment later
    // their real answer overwrites it. Reported from a live game: an answer
    // "appears as no answer for a split second before the correct one shows".
    //
    // Before the reveal the two cases are genuinely indistinguishable, and
    // guessing WAITING is the one that never shows somebody a verdict on an
    // answer they did send. Once the answers are revealed, empty means empty.
    const isEmptyRow = answer && !(answer.submitted_answer || '').trim();
    const stillWaiting = !answer
      || ((isPlaceholder || isEmptyRow) && !state.resultsRevealed);
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
  // Only the people still in the room count — see countAnswersFrom.
  const allSubmitted = countAnswersFrom(state.currentAnswers, state.players) >= state.players.length;
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
  showHostReviewUI();

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
  fetchAnswersForQuestion(state.room.id, revealQNum).then(rows => {
    const answers = currentGameAnswers(rows);
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

  // CLOSE THE ROUND FOR EVERYONE WHO NEVER ANSWERED.
  //
  // THIS WAS THE THIRD BLANK-FILL SITE AND IT NEVER GOT EITHER OF THE FIXES THE
  // OTHER TWO DID. It called submitAnswer — an UPSERT — with a hardcoded
  // wager of 1, and both halves were wrong:
  //
  //  * Migration 049 revoked UPDATE on `answers`, and a conflicting
  //    ON CONFLICT DO UPDATE raises 42501 and writes nothing (measured). On the
  //    final round every player who locked a wager already HOLDS a row — the
  //    __WAGER_LOCKED__ placeholder — so pressing "Reveal Results" while
  //    somebody had not answered wrote nothing at all, left their locked wager
  //    attached to a question they never answered, and told the HOST "your
  //    answer didn't save" once per absent player. The final round is the only
  //    one that SUBTRACTS, so that is the difference between scoring nothing
  //    and losing 20 for being away.
  //  * A hardcoded wager of 1 is the exact fault the 2026-08-18 playtest fixed
  //    in the other two fill paths: it hands a player a second answer at a
  //    wager they had already spent, breaking the rule that 1..N are each used
  //    exactly once.
  //
  // insertBlankAnswers, and NOT op_fill_blank_answers, which is the wider call
  // handleTimerExpiry makes. The two mean different things and reaching for the
  // server function here changed the feature:
  //
  //   the CLOCK running out  -> close everybody out, including converting a
  //                             __WAGER_LOCKED__ placeholder into a blank
  //   the host revealing EARLY -> only people who have no row at all
  //
  // Somebody who has locked a final wager and is still typing has a row, and a
  // host cutting the round short must not turn their 20 into a blank. Using the
  // server call here did exactly that, and scenario-fullgame caught it by name:
  // "Bob tapped 20 on the final wager and was committed to 0."
  //
  // ON CONFLICT DO NOTHING is what makes that safe by construction rather than
  // by remembering: it cannot touch a row that already exists, whatever is in
  // it. It also survives 049, which the upsert this replaces did not.
  const q = state.questions[state.currentQuestion];
  if (q) {
    const submittedIds = new Set(state.currentAnswers.map(a => String(a.player_id)));
    const allAnswers = currentGameAnswers(await fetchAllAnswers(state.room.id));
    const spent = new Map();
    for (const a of allAnswers) {
      const key = String(a.player_id);
      if (!spent.has(key)) spent.set(key, new Set());
      if (a.wager != null) spent.get(key).add(a.wager);
    }
    const blanks = [];
    for (const p of state.players) {
      if (submittedIds.has(String(p.id))) continue;
      blanks.push({
        roomId: state.room.id,
        playerId: p.id,
        questionNumber: state.currentQuestion,
        questionId: q.id,
        wager: findNextAvailableWager(spent.get(String(p.id)) || new Set(), state.totalQuestions)
      });
    }
    if (blanks.length) await insertBlankAnswers(blanks);
  }

  // Re-fetch all answers (including just-submitted auto-answers) before revealing.
  try {
    state.currentAnswers = currentGameAnswers(await fetchAnswersForQuestion(state.room.id, state.currentQuestion));
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
    //
    // AND AN ANSWER WE CANNOT ATTRIBUTE IS SKIPPED TOO. Until migration 052 an
    // answer was deleted along with its player row, so every row here had a
    // player to look up. Now an answer outlives the seat — which is what makes
    // a rejoining player's score recoverable — and `player` can be undefined,
    // making `player?.is_bot` quietly false and letting a departed BOT's answer
    // through into exactly the two tables this guard exists to keep clean.
    //
    // Skipping costs one human's answer out of an aggregate over thousands of
    // plays. Recording a bot's puts an invented percentage into the evidence
    // used to judge whether a question is too hard and whether its answer key
    // is wrong. That is not a close call.
    const player = (state.players || []).find(p => String(p.id) === String(answer.player_id));
    if (!player || player.is_bot) continue;

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

/**
 * The host review row: "play with this host again?"
 *
 * SHOWN ONLY WHEN THERE IS SOMEBODY TO RATE AND SOMEWHERE TO PUT IT.
 *
 *  - not to the host themselves, and not to a bot;
 *  - only when the host is SIGNED IN. A reputation attaches to an account, and
 *    a guest has none — that is what guest play means. Hiding the row is the
 *    honest answer; showing buttons that silently do nothing is not.
 *
 * One vote per player per game (migration 054), so this is the same row on
 * every round of the game and re-tapping changes the vote rather than adding
 * one. That is why the previous choice is restored from state rather than
 * re-read: the vote is about the host, not about this question.
 */
function showHostReviewUI() {
  const row = $('#reveal-host-review');
  if (!row) return;

  const host = state.players.find(p => p.is_host && !p.is_bot);
  const iAmHost = host && String(host.id) === String(state.room?.playerId);
  if (!host || !host.user_id || iAmHost) {
    row.style.display = 'none';
    return;
  }

  // NOTHING IS SHOWN UNTIL WE KNOW THE FEATURE IS INSTALLED, and "show it and
  // hide it when the answer comes back" is not good enough.
  //
  // Migrations here are pasted by hand, so there is a real window where this
  // JavaScript is live and migration 054 is not. In that window an optimistic
  // row puts three buttons on screen that light up when tapped and record
  // NOTHING — a player believing they rated somebody when they did not, which
  // is the silent-failure shape this codebase is built out of (#4). Hiding it
  // only once the failure arrives leaves exactly that window open, for however
  // long the round trip takes.
  //
  // So: hide, ask once per game, and draw the row only if the answer says the
  // feature is there. The cost is that on a working system the row appears a
  // moment after the reveal, which for a secondary control is nothing.
  if (!state._hostRepChecked) {
    state._hostRepChecked = true;
    fetchHostReputations([host.user_id]).then(() => {
      state._hostRepKnown = true;
      // Re-render rather than un-hiding here: the round may have moved on, and
      // this function already knows every reason the row should stay hidden.
      if (state.onRevealScreen) showHostReviewUI();
    });
  }
  if (!state._hostRepKnown || !hostRatingsAvailable()) {
    row.style.display = 'none';
    return;
  }

  // THE VOTE BELONGS TO A HOST, NOT TO THE GAME. The role can move mid-game —
  // a host who leaves is replaced by promotion — and without this the buttons
  // would show your verdict on the OLD host as already cast for the new one,
  // who you have never rated. Each vote is its own row on the server, so
  // nothing is lost; what was wrong was the screen.
  if (state.hostVoteFor && String(state.hostVoteFor) !== String(host.user_id)) {
    state.hostVote = null;
    state.hostFlagReason = null;
  }
  state.hostVoteFor = host.user_id;

  row.style.display = '';
  row.querySelectorAll('[data-host-vote]').forEach(b => {
    b.classList.toggle('feedback-btn--active', b.dataset.hostVote === state.hostVote);
  });
  const confirmEl = document.getElementById('host-review-confirm');
  if (confirmEl) {
    confirmEl.textContent = state.hostFlagReason ? 'Reported \u2713' : '';
    confirmEl.classList.toggle('show', !!state.hostFlagReason);
  }
}

/** Send the current host verdict. Failure is logged, never toasted: this is an
 *  optional opinion, and a toast on every dropped one is the noise CLAUDE.md #4
 *  warns is how real warnings get ignored. */
function sendHostVote({ rating = null, flagReason = null, flagNote = null }) {
  const host = state.players.find(p => p.is_host && !p.is_bot);
  if (!host || !host.user_id) return;
  rateHost({
    roomId: state.room.id,
    playerId: state.room.playerId,
    voterId: getVoterId(),
    rating,
    flagReason,
    flagNote,
  }).then(res => {
    if (!res.ok && res.reason && res.reason !== 'host has no account' && res.reason !== 'not installed') {
      logger.warn('Game', 'host rating was not recorded', res);
    }
  });
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

/**
 * Host review taps. Kept apart from the question feedback listeners on purpose:
 * the two rows look similar and mean completely different things, and a shared
 * handler is how one would quietly start writing the other's rows.
 */
function initHostReviewListeners() {
  const row = $('#reveal-host-review');
  if (!row) return;

  row.querySelectorAll('[data-host-vote]').forEach(btn => {
    btn.addEventListener('click', () => {
      const vote = btn.dataset.hostVote;
      const menu = row.querySelector('.host-review__menu');

      if (vote === 'flag') {
        if (menu) menu.style.display = menu.style.display === 'none' ? '' : 'none';
        return;
      }
      if (menu) menu.style.display = 'none';

      // Tap again to take it back. There is no way to WITHDRAW a vote once
      // cast — op_rate_host only ever sets — so an un-tap flips to the other
      // side rather than pretending to erase it, and the buttons say so by
      // both going inactive only when nothing has been sent yet.
      if (state.hostVote === vote) return;
      state.hostVote = vote;
      row.querySelectorAll('[data-host-vote]').forEach(b => {
        b.classList.toggle('feedback-btn--active', b.dataset.hostVote === vote);
      });
      sendHostVote({ rating: vote === 'up' ? 1 : -1 });
    });
  });

  row.querySelectorAll('[data-host-reason]').forEach(btn => {
    btn.addEventListener('click', () => {
      const reason = btn.dataset.hostReason;
      state.hostFlagReason = reason;
      const menu = row.querySelector('.host-review__menu');
      if (menu) menu.style.display = 'none';
      const confirmEl = document.getElementById('host-review-confirm');
      if (confirmEl) {
        confirmEl.textContent = 'Reported \u2713';
        confirmEl.classList.add('show');
      }
      sendHostVote({ flagReason: reason });
    });
  });
}

export function initFeedbackListeners() {
  initHostReviewListeners();

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
