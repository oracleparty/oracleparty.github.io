// ============================================
// Oracle Party — Question Screen Module
// Wager grid, timer, answer submission.
// ============================================

import { state, canControlGame, currentGameAnswers, getCategoryLabel, getQuestionText, getCorrectAnswer, getAlternates,
         _screenTransitioning, setScreenTransitioning } from './state.js';
import { $, transitionScreens, fuzzyMatch } from '../utils.js';
import { logger } from '../logger.js';
import { WAGER_AUTO_SKIP_MS, TIMER_GRACE_MS } from '../constants.js';
import { updateGameState, startClockOnServer, submitAnswer, submitAnswerViaServer, fillBlankAnswersViaServer, fetchAnswersForQuestion, fetchAllAnswers, insertBlankAnswers, upsertAnswers, incrementQuestionsAnswered } from '../supabase.js';
import { computeScoreEarned, findNextAvailableWager, answersForCurrentGame } from './scoring-helpers.js';
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

  // Is this a genuinely NEW question, or a re-render of the one already on
  // screen? Realtime events re-call this function for the same question — the
  // wager reset below has been guarded against exactly that for a while, and
  // the answer box and hasSubmitted never were. So a re-render emptied the
  // input and marked the player as not having submitted, and the reveal's
  // auto-submit then wrote a blank over the answer they had really sent.
  // Reported from a playtest: "someone put an answer in and then it disappeared
  // to no answer ... disappear on reveal".
  const sameQuestion = state._renderedQuestion === state.currentQuestion
    && state._renderedFinalRound === !!state.isFinalWagerRound;
  state._renderedQuestion = state.currentQuestion;
  state._renderedFinalRound = !!state.isFinalWagerRound;

  if (!sameQuestion) {
    $('#answer-form').classList.remove('answer-input--submitted');
    $('#answer-input').value = '';
    $('#answer-input').disabled = false;
    $('#btn-submit-answer').disabled = true;
    // Back to "Pass" for a fresh question — an empty box is the starting
    // state, and leaving the previous round's "Submit" there would offer a
    // word the button does not mean yet.
    $('#btn-submit-answer').textContent = 'Pass';
    $('#submit-status').classList.add('hidden');
    state.hasSubmitted = false;
  }
  $('#wager-error').textContent = '';

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
      // Host: start the round's clock.
      //
      // The DATABASE stamps it now (migration 047), because the server judges
      // answers against its own now() and this used to be the host phone's
      // ESTIMATE of that. A slow estimate would have every answer in the room
      // refused as late; a fast one would stop the timer ever expiring. One
      // clock, by construction. Falls back to the estimate when the function is
      // not installed, which is exactly the old behaviour.
      if (state.room.isHost) {
        // THE FINAL ROUND'S PHASE IS 'final_question', NOT 'question'. This
        // screen renders both, and op_start_clock checks the phase it is given
        // against the room's — so passing 'question' here made the final round
        // look like a stale caller, the stamp was refused, and the client took
        // the PREVIOUS round's timestamp as this one's start. The last question
        // of every game would have opened with its timer nearly gone.
        const phase = state.isFinalWagerRound ? 'final_question' : 'question';
        const served = await startClockOnServer(state.room.id, phase, state.currentQuestion);
        const startedAt = served || new Date(Date.now() + state.serverTimeOffset).toISOString();
        state.questionStartedAt = startedAt;
        if (!served) await updateGameState(state.room.id, { question_started_at: startedAt });
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
  $('#answer-input').oninput = refreshSubmitButton;
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

  refreshSubmitButton();
}

/**
 * Submit is live as soon as a wager is chosen, EVEN WITH AN EMPTY BOX — and it
 * says "Pass" then, rather than "Submit".
 *
 * It used to be disabled until something was typed, so a player who did not
 * know the answer had two options: invent a character, or sit there holding
 * the whole room until the timer ran out. Typing a single space already worked
 * (it is trimmed to '' and shows as "No answer"), which is a trick nobody
 * could be expected to find.
 *
 * The word on the button is what makes this safe. An empty Submit that silently
 * spends your round is an accident waiting to happen; a button labelled Pass is
 * a decision. The wager is still required first, and still spent — passing is
 * not a free round, it is the same as being present and wrong.
 */
function refreshSubmitButton() {
  const btn = $('#btn-submit-answer');
  if (!btn) return;
  const hasText = $('#answer-input').value.trim().length > 0;
  const wagerOk = state.isFinalWagerRound || state.wagerExplicitlySelected;
  btn.disabled = !wagerOk;
  btn.textContent = hasText ? 'Submit' : 'Pass';
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
    const freshAnswers = currentGameAnswers(await fetchAnswersForQuestion(state.room.id, state.currentQuestion));
    state.currentAnswers = freshAnswers;
    const submittedIds = new Set(freshAnswers.map(a => String(a.player_id)));
    const q = state.questions[state.currentQuestion];

    // One call, and the database works out who is missing and what each of them
    // still holds — including the locked-final-wager rows this used to need a
    // whole second pass for. It is idempotent, so it does not matter how many
    // phones make it.
    const served = await fillBlankAnswersViaServer(state.room.id, state.currentQuestion);

    if (q && !served.ok) {
      // Each absent player burns their OWN lowest unused wager, not a hardcoded
      // 1. Writing 1 for everyone gave a player two answers at wager 1 whenever
      // they had already spent it, breaking the rule that values 1..N are each
      // used exactly once.
      const allAnswers = answersForCurrentGame(await fetchAllAnswers(state.room.id), state.questions);
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

      // The final round needs a second pass, because insertBlankAnswers cannot
      // reach these rows. Everyone who locked a wager already HAS an answer row
      // holding __WAGER_LOCKED__, so the insert above skips them as duplicates
      // and their locked number stays attached to a question they never
      // answered. The final wager is the only round that subtracts, so leaving
      // 20 there is the difference between "scored nothing" and "lost 20 for
      // being away". A blank answer bets 0, whatever was chosen.
      //
      // upsertAnswers, NOT submitAnswer. This is the host writing on OTHER
      // PEOPLE'S behalf, and submitAnswer is a player-facing call: it toasts
      // "Your answer didn't save — check your connection and try again". The
      // host's own answer is not what is being written, so that message was
      // wrong whatever the cause, and it appeared once per absent player.
      //
      // It can now only fail one way. These rows all EXIST — the placeholder
      // is what makes this second pass necessary — so the upsert conflicts, and
      // migration 049 revoked UPDATE on `answers`: 42501, measured. That is not
      // a reason to go quiet. If this branch is ever reached, the locked wager
      // stays attached to a question nobody answered, and the final round is
      // the only one that SUBTRACTS — the difference between scoring nothing
      // and losing 20 for being away. It needs to be loud in a log, and it is
      // reached only when op_fill_blank_answers (migration 046, which does this
      // correctly server-side) could not be called at all.
      if (state.isFinalWagerRound) {
        const unanswered = freshAnswers.filter(a =>
          (a.submitted_answer || '').trim() === '__WAGER_LOCKED__');
        if (unanswered.length) {
          await upsertAnswers(unanswered.map(a => ({
            roomId: state.room.id,
            playerId: a.player_id,
            questionNumber: state.currentQuestion,
            questionId: q.id,
            wager: 0,
            submittedAnswer: '',
            isCorrect: false,
            scoreEarned: 0
          })), 'finalWagerBlankFill (fallback — op_fill_blank_answers was unreachable)');
        }
      }
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
  // An empty box is a deliberate pass now — the button says "Pass" when it is
  // empty, so this is not an accident. The wager below is still required.
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
  const isBlank = !String(answer || '').trim();
  let wager;
  if (state.isFinalWagerRound) {
    // A blank final answer wagers 0 whatever was locked in. The final wager is
    // the only round that can SUBTRACT points, and losing 20 for a question you
    // were never present to attempt is not a bet, it is a penalty for going
    // away — which no other round in this game imposes. Someone who typed
    // something and got it wrong still pays: they made the bet.
    wager = isBlank ? 0 : (state.finalWager || 0);
  } else if (state.currentWager) {
    wager = state.currentWager;
  } else {
    // Fallback: find lowest available wager (centralised in scoring-helpers)
    wager = findNextAvailableWager(state.usedWagers, state.totalQuestions);
    logger.warn('Game', 'doSubmitAnswer: no wager selected, auto-assigned ' + wager);
  }
  const scoreEarned = computeScoreEarned(isCorrect, wager, state.isFinalWagerRound);

  // An AUTO-submitted blank must never overwrite an answer that is already
  // there. submitAnswer is an upsert, so it happily replaces a real answer with
  // an empty string — which is how a player reported typing an answer and
  // watching it turn into "No answer" at the reveal. Any path that resets
  // state.hasSubmitted while their answer is already in the database (a
  // refresh, a re-render of the same question) turns the reveal's tidy-up pass
  // into an eraser. insertBlankAnswers is ON CONFLICT DO NOTHING and is exactly
  // the right instrument; it already exists for the host's version of this.
  //
  // Deliberately NOT applied to a deliberate submit or to auto-submitted TEXT:
  // both are the player saying something, and the last thing they said wins.
  // The verdict that actually gets stored comes from the SERVER when the server
  // has one (migrations 045/046), so every phone in the room reads one judgement
  // computed once rather than each browser deciding for itself. isCorrect above
  // is still computed here, because the screen needs an answer before the round
  // trip returns and because it is what the fallback writes.
  //
  // A REJECTION FALLS BACK INSTEAD OF LOSING THE ROUND, deliberately. If the
  // server's idea of "the current question" ever disagreed with this client's,
  // every submission in every game would be refused — and an unplayable game is
  // far worse than a client-judged answer. It costs nothing: the lockdown is
  // RLS in a later slice, and an attacker is not running this file anyway. Once
  // real games show no rejections in the log, this can tighten.
  let verdict = isCorrect;
  let earnedFinal = scoreEarned;
  let wagerFinal = wager;
  let submitResult;
  let serverRefusal = null;   // why the server said no, for the message below

  if (autoSubmit && isBlank) {
    submitResult = await insertBlankAnswers([{
      roomId: state.room.id,
      playerId: state.room.playerId,
      questionNumber: state.currentQuestion,
      questionId: q.id,
      wager
    }]).then(() => ({ data: null, error: null }), error => ({ data: null, error }));
  } else {
    const server = await submitAnswerViaServer({
      roomId: state.room.id,
      playerId: state.room.playerId,
      questionNumber: state.currentQuestion,
      answer,
      wager
    });
    if (server.row && !server.row.rejected) {
      verdict = !!server.row.is_correct;
      if (server.row.score_earned != null) earnedFinal = server.row.score_earned;
      if (server.row.wager != null) wagerFinal = server.row.wager;
      submitResult = { data: server.row, error: null };
    } else {
      if (server.row?.rejected) {
        serverRefusal = server.row.rejected;
        logger.warn('Game', 'the server refused this answer, storing it locally', {
          reason: serverRefusal, question: state.currentQuestion
        });
      }
      submitResult = await submitAnswer({
        roomId: state.room.id,
        playerId: state.room.playerId,
        questionNumber: state.currentQuestion,
        questionId: q.id,
        wager,
        submittedAnswer: answer,
        isCorrect,
        scoreEarned,
        // A refusal plus a row that already exists is the system working, not a
        // failure — see submitAnswer. Without this the player got a "check your
        // connection" toast on top of the correct message below.
        afterServerRefusal: !!serverRefusal
      });
    }
  }

  // If the DB write failed (network drop mid-submit), revert local state and
  // allow retry — without this revert, the player thinks they submitted, gets
  // shown as "no answer" on reveal (because host's auto-submit pass writes a
  // blank for them), and silently loses their actual answer.
  if (submitResult && submitResult.error && !autoSubmit) {
    state.hasSubmitted = false;
    $('#answer-input').disabled = false;
    $('#btn-submit-answer').disabled = false;
    const errEl = $('#wager-error');
    // SAY WHY, when the reason is known. "Submit failed — try again" is a lie
    // whenever the server refused the answer: trying again cannot help, and the
    // player retypes into a box that will keep saying the same thing.
    //
    // The fallback below a refusal can now only fail one way — an EDIT, because
    // migration 049 revoked UPDATE on `answers` — so the row already holding
    // their answer is the one that stands. A first answer still inserts, which
    // is the safety valve CLAUDE.md deliberately keeps until real games show no
    // rejections; this changes what the screen SAYS, not what the game does.
    if (errEl) {
      errEl.textContent = serverRefusal === 'time is up'
        ? "Time's up — your last answer stands"
        : serverRefusal
          ? `Not accepted: ${serverRefusal}`
          : 'Submit failed — try again';
    }
    logger.error('Game', 'submitAnswer failed', submitResult.error);
    return;
  }

  // Mark wager as used AFTER DB write succeeds (prevents stale state if submit
  // fails). The SERVER's wager and verdict when it gave one — it may have
  // handed back a different value, because it refuses to let one number be
  // spent twice and this screen can be out of date about what is left.
  state.usedWagers.set(wagerFinal, verdict);

  // Track question answered (fire-and-forget, skip final wager round)
  if (!state.isFinalWagerRound) {
    incrementQuestionsAnswered(state.room.id, state.room.playerId);
  }

  // Immediately transition to reveal screen
  if (_showRevealScreen) _showRevealScreen();
}
