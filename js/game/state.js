// ============================================
// Oracle Party — Game State & Helpers
// Shared mutable state imported by all game modules.
// ============================================

import { CATEGORY_META, resolveCategoryLabel } from '../categories.js';
import { answersForCurrentGame } from './scoring-helpers.js';
import { AWAY_GRACE_MS } from '../constants.js';
import { transitionScreens } from '../utils.js';

// --- State ---
export const state = {
  room: null,
  players: [],
  questions: [],
  currentQuestion: 0,
  gamePhase: 'loading',
  totalQuestions: 0,
  timerSeconds: 30,
  usedWagers: new Map(), // Map<wagerValue, isCorrect> for green/red styling
  currentWager: null,
  hasSubmitted: false,
  onRevealScreen: false,
  resultsRevealed: false,
  timerExpired: false,
  scores: {},
  previousScores: {},   // scores before current round (for animation delta)
  currentAnswers: [],   // cached answers for current question (avoids re-fetch)
  timerId: null,
  channels: [],
  chatOpen: false,
  serverTimeOffset: 0,  // serverTime - clientTime in ms
  questionStartedAt: null, // ISO timestamp from DB — single source of truth for timer
  // WHEN THIS PHONE ENTERED THE ROUND IT IS ON, in server time. Set by
  // beginRoundClock(); read only by the rule that decides whether an arriving
  // stamp belongs to this round or to the last one. Without it a phone cannot
  // tell those apart, because the room row carries no round number ON the
  // stamp — see isStampForCurrentRound.
  _roundEnteredAt: null,
  presenceChannel: null,
  presenceReady: false,
  awayTimestamps: new Map(), // player ID → Date.now() when first seen as away
  feedbackFadeTimer: null,
  // The host review, which is ONE VOTE PER GAME rather than per round — so it
  // lives here rather than being re-read for each question. 'up' | 'down' | null.
  hostVote: null,
  hostFlagReason: null,
  // WHICH host the vote above is for. The role can move mid-game, and a vote
  // belongs to a person rather than to the game.
  hostVoteFor: null,
  // Has this game asked whether host ratings are installed at all, and has the
  // answer come back? The row is not drawn until the second is true — see
  // showHostReviewUI for why optimism is the wrong default here.
  _hostRepChecked: false,
  _hostRepKnown: false,
  // Set when the server refuses a rating because this player did not play the
  // whole game (migration 059). The thumbs then stay hidden for the rest of the
  // game rather than lighting up and recording nothing.
  _hostReviewRefused: false,
  isFinalWagerRound: false,
  // Has the final-wager screen already been drawn this game? Guards the
  // player's chosen wager against being cleared by a re-render.
  _renderedFinalWager: false,
  // The round's room writes (question list, then phase), chained. Only the
  // host's clock stamp waits on it — see showQuestionScreen. Null at every
  // other moment.
  _roomWritePending: null,
  finalWager: 20, // Default to highest — punishes indecision on final round
  finalWagerLocked: false,
  // Did the player actually TAP a wager, as opposed to inheriting the default
  // above? The 20-second timer needs to tell those apart: someone who chose 20
  // and did not press Lock In gets 20, but someone who never touched the screen
  // must get 0. Letting the timer commit the default would take 20 points off a
  // player for being away, which is the opposite of the rule everywhere else in
  // the game — a missed question costs a wager and nothing more.
  finalWagerSelected: false,
  finalWagerTimerId: null,
  // Which question the question screen is currently showing. Realtime re-calls
  // showQuestionScreen for the SAME question, and without knowing that, it
  // cleared the answer box and reset hasSubmitted every time — so the reveal's
  // auto-submit wrote a blank over an answer the player had really sent.
  // null rather than -1: question 0 is a real question and -1 would be a magic
  // number pretending not to be one.
  _renderedQuestion: null,
  _renderedFinalRound: false,
  difficultyVoteLocked: false,
  difficultyVotes: {},       // { playerId: 'easy'|'medium'|'hard' }
  votedDifficulty: null,     // consensus result
  difficultyVoteChannel: null,
  countdownStartedAt: null,
  _lastProcessedQuestion: -1,
  stalePollId: null,
  _timerGraceId: null,
  // The migration-056 backstop poll: asks the server to move a round on when
  // nobody in the room is driving it. Lives here so cleanup() can clear it.
  _advancePollId: null,
  presenceHeartbeatId: null,
  shownQuestionIndices: [],
  wagerExplicitlySelected: false,
  _cumulativeScoresWritten: false,
  _wasHidden: false,
  chatEchoPending: 0,
  unreadCount: 0,
  _hotJoinPollId: null,
  _gamePlayCompleted: false,
  _guestNudgeProcessed: false,
  _syncIntervalId: null,
  disqualifiedQuestions: new Set(),
  autoProceedTimerId: null,
  autoProceedSeconds: 0,
  // Re-applies the away labels once the youngest away player crosses
  // AWAY_GRACE_MS. Presence only syncs on CHANGE, so without a scheduled
  // re-check somebody who goes away and stays away is never shown as away at
  // all. Cleared by cleanup() like every other state-held timer.
  _awayRecheckId: null,
  // Set while the host is away: grants advance rights without moving the role.
  isDeputy: false
};

// Exposed for the robot harness so a failing scenario can report why, rather
// than only that. Read-only diagnostics; nothing in the app reads it back.
if (typeof window !== 'undefined') window.__state = state;

// --- Module-level guards (shared) ---
export let _flagMenuCloseHandler = null;
export function setFlagMenuCloseHandler(fn) { _flagMenuCloseHandler = fn; }

export let _lastScoresRenderedForQuestion = -1;
export function setLastScoresRendered(n) { _lastScoresRenderedForQuestion = n; }

export let _isLeaving = false;
export function setIsLeaving(v) { _isLeaving = v; }

export let _countdownActive = false;
export function setCountdownActive(v) { _countdownActive = v; }

export let _deferredPhase = null;
export function setDeferredPhase(v) { _deferredPhase = v; }

export let _screenTransitioning = false;
// The screen most recently ASKED for. A fade that is still in flight when a cut
// supersedes it must not re-assert its own target when it finishes.
let _wantedScreen = null;
export function setScreenTransitioning(v) { _screenTransitioning = v; }

/**
 * PUT THIS SCREEN UP. Always.
 *
 * Two callers wrote this by hand and both wrote the same hole: three conditions
 * (a screen is active, it is not the target, no transition is in flight) and
 * only two branches, so the case "a transition IS in flight" fell through both
 * and the screen simply did not change. Everything after it still ran — the
 * question card revealed, the timer started, the clock stamped, the room
 * advanced — on a screen the player never saw.
 *
 * Reported four times, most recently in exactly these words: "it didn't move me
 * (host) to another page. The other player was able to advance." Reproduced in
 * scenario-finalq with `--stuck`: the host NEVER reaches the final question
 * while everybody else does.
 *
 * A TRANSITION IN FLIGHT IS A REASON TO CUT, NEVER A REASON TO STAY. The guard
 * exists so two fades do not fight over the same pair of screens, and that is
 * worth keeping — but the answer to "I cannot fade right now" is to arrive
 * instantly, not to stay behind. A hard cut is a visual compromise; not moving
 * is a broken game.
 *
 * One function, because this rule was stated twice and followed zero times, and
 * "the same rule stated N times and followed N-1" is the fault this project
 * records more than any other.
 */
export function showScreen(targetEl, { duration } = {}) {
  if (!targetEl) return;
  _wantedScreen = targetEl;
  const currentScreen = document.querySelector('.screen.active');
  // Already here — but make sure it is actually VISIBLE. The hand-written
  // version this replaces cleared `display` in that case, and a screen carrying
  // `.active` with `display: none` is exactly the state a half-finished
  // transition leaves behind.
  if (currentScreen === targetEl) {
    targetEl.style.display = '';
    return;
  }

  // HIDE EVERY OTHER SCREEN, not just the one carrying `.active`.
  //
  // During a fade NO screen carries `.active` — `transitionScreens` strips it
  // at t=0 and only adds it to the target after the delay — so mid-fade the
  // screen being faded IN is on display while carrying nothing. Hiding only
  // `currentScreen` (which is null in that window) left it there, and two
  // screens ended up stacked. Reported from a real game: "screen phasing
  // between the question page and the page before that."
  const cut = () => {
    for (const s of document.querySelectorAll('.screen')) {
      if (s === targetEl) continue;
      if (s.style.display === 'none') continue;
      s.style.display = 'none';
      s.classList.remove('active', 'fade-out');
    }
    targetEl.style.display = '';
    void targetEl.offsetHeight;
    targetEl.classList.remove('fade-out');
    targetEl.classList.add('active');
  };

  if (!currentScreen) { cut(); return; }
  if (_screenTransitioning) { cut(); return; }

  _screenTransitioning = true;
  const done = duration === undefined
    ? transitionScreens(currentScreen, targetEl)
    : transitionScreens(currentScreen, targetEl, duration);
  return done.finally(() => {
    _screenTransitioning = false;
    // A CUT MID-FADE IS UNDONE BY THE FADE'S OWN ENDING, and that is the other
    // half of the same bug. `transitionScreens` finishes by showing ITS target
    // and marking it active — so a cut that happened while it was in flight is
    // silently reversed a moment later, putting the player back on a screen the
    // game has already left. Refreshing cleared it, which is what the report
    // said. `_wantedScreen` records what was last asked for; if this fade is no
    // longer it, re-assert.
    if (_wantedScreen && _wantedScreen !== targetEl) {
      const wanted = _wantedScreen;
      for (const s of document.querySelectorAll('.screen')) {
        if (s === wanted) continue;
        if (s.style.display === 'none') continue;
        s.style.display = 'none';
        s.classList.remove('active', 'fade-out');
      }
      wanted.style.display = '';
      void wanted.offsetHeight;
      wanted.classList.remove('fade-out');
      wanted.classList.add('active');
    }
  });
}

/**
 * A NEW ROUND STARTS ON THIS PHONE.
 *
 * Two facts move together and were being written apart: the previous round's
 * clock stamp must go, and the moment we arrived has to be recorded, because
 * that moment is the only thing that tells a stamp for THIS round from one the
 * room row is still carrying for the last one.
 *
 * Five places begin a round — the question phase, the final wager, the final
 * question, and two reconnect paths — and "the same rule stated N times and
 * followed N-1" is the most repeated fault in this project, so it is stated
 * once here.
 *
 * `keepStamp` is the RECONNECT: init.js has already put the room's real
 * timestamp into state and clearing it would restart everyone's clock. There
 * the stamp itself is when the round began, which is exactly what we need to
 * record.
 */
export function beginRoundClock({ keepStamp = false } = {}) {
  if (!keepStamp) state.questionStartedAt = null;
  state._roundEnteredAt = state.questionStartedAt
    ? new Date(state.questionStartedAt).getTime()
    : Date.now() + state.serverTimeOffset;
}

// --- Question field name resolution ---
let FIELD_MAP = null;

export function resolveFieldMap(question) {
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
    difficulty: question.difficulty !== undefined ? 'difficulty' : 'difficulty',
    fun_fact: question.fun_fact !== undefined ? 'fun_fact' : 'fun_fact'
  };
}

export function getQuestionText(q) { return q[FIELD_MAP.text] || ''; }
export function getCorrectAnswer(q) { return q[FIELD_MAP.correct] || ''; }
export function getAlternates(q) { return q[FIELD_MAP.alternates] || []; }
export function getDifficulty(q) { return q[FIELD_MAP.difficulty] || 'medium'; }
export function getFunFact(q) { return q[FIELD_MAP.fun_fact] || ''; }

/**
 * Host, co-host, or a temporarily deputised player.
 *
 * When the host goes away the game must not stall, but transferring the role
 * outright means someone who glanced at a notification comes back to find they
 * no longer run their own game. So the crown stays put and the next in line
 * (co-host, else longest-present) is deputised to advance until the host
 * returns. The role itself only moves on real departure.
 */
export function canControlGame() {
  return state.room?.isHost || state.room?.isCohost || state.isDeputy === true;
}

export function getCategoryLabel() {
  if (!state.room) return '?';
  const meta = CATEGORY_META[state.room.category] || { icon: '?', label: state.room.category };
  const label = resolveCategoryLabel(state.room.category, state.room.subcategory);
  return `${meta.emoji || meta.icon} ${label}`;
}

// --- Feedback cache (shared between reveal + review) ---
export let _qbFeedback = {};
export function setQbFeedback(v) { _qbFeedback = v; }

// --- Stale presence ---
export let _staleCheckCount = -1;
export function setStaleCheckCount(v) { _staleCheckCount = v; }

// --- Host settings ---
export let _hostSettingsConfirmTimer = null;
export function setHostSettingsConfirmTimer(v) { _hostSettingsConfirmTimer = v; }

// --- Sync guard ---
export let _syncInFlight = false;
export function setSyncInFlight(v) { _syncInFlight = v; }

/**
 * Should the room be TOLD this player is away? (AWAY_GRACE_MS)
 *
 * ONE RULE, AND IT LIVES HERE BECAUSE IT HAS FOUR READERS — the reveal, the
 * scoreboard, the results/final-wager pass in init.js, and the lobby's own
 * copy. This project's most repeated fault is a rule stated once and applied
 * to two of the three places that need it, so the grace is not written out
 * anywhere else in js/game/.
 *
 * awayTimestamps has always held the moment each player was FIRST seen away,
 * and nothing ever read it — presence flipping was rendered immediately, so a
 * phone backgrounded for two seconds by a notification greyed somebody out in
 * front of the whole room.
 *
 * DISPLAY ONLY. Deputising (HOST_HANDOVER_MS) and releasing a seat
 * (STALE_TIMEOUT_MS) read last_seen_at, not this, and neither is affected: the
 * game still stops waiting for an absent player at once. Only the label waits.
 */
export function isPlayerAway(id) {
  const since = state.awayTimestamps.get(String(id));
  return since !== undefined && (Date.now() - since) >= AWAY_GRACE_MS;
}

/**
 * Answers belonging to the game currently being played, from this room.
 *
 * A thin wrapper so every fetch is filtered the same way and no call site has
 * to remember `state.questions`. See answersForCurrentGame for why a room can
 * still be holding the previous game's answers: the clear-out is host-gated, so
 * a room that returns to the lobby without its host never runs it.
 *
 * It matters more since migration 052. Until then an answer was deleted with
 * its player row, which quietly limited how long a stale one could survive;
 * now they persist until the room itself goes.
 */
export function currentGameAnswers(rows) {
  return answersForCurrentGame(rows, state.questions);
}
