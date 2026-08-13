// ============================================
// Oracle Party — Named Constants
// Single source of truth for all magic numbers.
// ============================================

// === TIMING (ms) ===
export const COUNTDOWN_DELAY_MS = 500;
export const COUNTDOWN_STEP_MS = 900;
export const TIMER_GRACE_MS = 500;
export const TOAST_DURATION_MS = 3000;
export const TRANSITION_MS = 260;
export const FADE_MS = 500;
export const SCORE_ANIMATE_MS = 1000;
export const SCORE_REORDER_DELAY_MS = 300;
export const FEEDBACK_FADE_MS = 4000;
export const FRIEND_REQUEST_TOAST_MS = 10000;
export const ADMIN_STATUS_FADE_MS = 2000;
export const REVEAL_ANSWER_DELAY_MS = 1500;
export const SCORE_PRE_ANIMATE_DELAY_MS = 800;
export const WAGER_AUTO_SKIP_MS = 1000;
export const CHAT_FLASH_MS = 500;
export const COUNTDOWN_FINISH_MS = 300;
export const COUNTDOWN_TRANSITION_MS = 300;
export const PLAYER_INIT_WAIT_MS = 500;
export const PLAYER_READY_CONFIRM_MS = 3000;
export const LOBBY_PLAYER_DEBOUNCE_MS = 15000;
export const HOST_WAIT_TIMEOUT_MS = 1000;
export const CHAT_MSG_DELAY_MS = 1500;
export const RESULTS_ACTION_DELAY_MS = 5000;
export const RETURN_HOME_DELAY_MS = 3000;
export const AUTO_PROCEED_TICK_MS = 1000;

// === INTERVALS (ms) ===
export const LOBBY_POLL_INTERVAL = 15000;
export const STALE_CHECK_INTERVAL = 30000;
export const STATE_SYNC_INTERVAL = 60000;
export const PUBLIC_GAMES_REFRESH = 10000;
export const TYPING_TIMEOUT = 3000;
export const TYPING_THROTTLE = 1000;
export const HONK_THROTTLE = 300;
export const CATEGORY_CACHE_TTL = 1800000;

// === PAGINATION / QUERY LIMITS ===
export const CATEGORY_PAGE_SIZE = 1000;
export const PUBLIC_ROOMS_LIMIT = 20;
export const CHAT_MESSAGES_LIMIT = 100;
export const QUESTION_POOL_SIZE = 500;
export const WILDCARD_LIMIT = 200;
export const DIFFICULTY_QUESTION_LIMIT = 20;
export const TITLE_BATCH_SIZE = 100;
export const PROFILE_SEARCH_LIMIT = 10;
export const ADMIN_PAGE_SIZE = 25;
export const LEADERBOARD_LIMIT = 50;

// === SCORING / MASTERY ===
export const MASTERY_HIGH_THRESHOLD = 75;
export const MASTERY_COMPLETE_THRESHOLD = 100;
export const MIN_QUESTIONS_FOR_TITLE = 20;
export const MIN_QUESTIONS_FOR_ACCURACY = 20;
export const MIN_QUESTIONS_FOR_CATEGORY = 10;
export const FUZZY_MATCH_THRESHOLD = 0.25;
export const MIN_WORD_LENGTH_LASTNAME = 3;

// === TIER SCORES ===
export const TIER_ORACLE = 6.5;
export const TIER_MASTER = 5.5;
export const TIER_SCHOLAR = 4.5;
export const TIER_APPRENTICE = 3.0;

// === LOYALTY (days) ===
export const LOYAL_DAYS = 30;
export const ANCIENT_DAYS = 365;
export const NIGHT_OWL_START_HOUR = 2;
export const NIGHT_OWL_END_HOUR = 5;

// === STALE PRESENCE ===
// A host who goes quiet for this long hands the role over. Deliberately far
// shorter than STALE_TIMEOUT_MS: their row is kept so they can rejoin
// seamlessly, but the game must not sit frozen waiting for one phone.
export const HOST_HANDOVER_MS = 30000;
export const STALE_TIMEOUT_MS = 120000;          // 2 minutes — seat released; rejoining restores score and history
export const DISCONNECTED_TIMEOUT_MS = 45000;     // 45 seconds — faster cleanup after beacon (tab close)
export const HEARTBEAT_DB_INTERVAL_MS = 15000;    // 15 seconds — DB heartbeat (last_seen_at update)

// === UI ===
export const PULL_REFRESH_THRESHOLD = 60;
export const MASTERY_TREE_BASE_INDENT = 12;
export const MASTERY_TREE_DEPTH_INDENT = 16;
