// ============================================
// Oracle Party — Game State & Helpers
// Shared mutable state imported by all game modules.
// ============================================

import { CATEGORY_META, resolveCategoryLabel } from '../categories.js';

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
  presenceChannel: null,
  presenceReady: false,
  awayTimestamps: new Map(), // player ID → Date.now() when first seen as away
  feedbackFadeTimer: null,
  isFinalWagerRound: false,
  finalWager: 20, // Default to highest — punishes indecision on final round
  finalWagerLocked: false,
  difficultyVoteLocked: false,
  difficultyVotes: {},       // { playerId: 'easy'|'medium'|'hard' }
  votedDifficulty: null,     // consensus result
  difficultyVoteChannel: null,
  countdownStartedAt: null,
  _lastProcessedQuestion: -1,
  stalePollId: null,
  _timerGraceId: null,
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
export function setScreenTransitioning(v) { _screenTransitioning = v; }

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
