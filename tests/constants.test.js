import { describe, it, expect } from 'vitest';
import * as C from '../js/constants.js';

describe('constants sanity checks', () => {
  describe('timing constants are positive', () => {
    const timingKeys = [
      'COUNTDOWN_DELAY_MS', 'COUNTDOWN_STEP_MS', 'TIMER_GRACE_MS',
      'TOAST_DURATION_MS', 'TRANSITION_MS', 'FADE_MS',
      'SCORE_ANIMATE_MS', 'SCORE_REORDER_DELAY_MS', 'FEEDBACK_FADE_MS',
      'FRIEND_REQUEST_TOAST_MS', 'ADMIN_STATUS_FADE_MS',
      'REVEAL_ANSWER_DELAY_MS', 'SCORE_PRE_ANIMATE_DELAY_MS',
      'WAGER_AUTO_SKIP_MS', 'CHAT_FLASH_MS', 'COUNTDOWN_FINISH_MS',
      'COUNTDOWN_TRANSITION_MS', 'PLAYER_INIT_WAIT_MS', 'PLAYER_READY_CONFIRM_MS',
      'LOBBY_PLAYER_DEBOUNCE_MS', 'HOST_WAIT_TIMEOUT_MS', 'CHAT_MSG_DELAY_MS',
      'RESULTS_ACTION_DELAY_MS', 'RETURN_HOME_DELAY_MS', 'AUTO_PROCEED_TICK_MS',
    ];

    for (const key of timingKeys) {
      it(`${key} > 0`, () => {
        expect(C[key]).toBeGreaterThan(0);
      });
    }
  });

  describe('interval constants are positive', () => {
    const intervalKeys = [
      'LOBBY_POLL_INTERVAL', 'STALE_CHECK_INTERVAL', 'STATE_SYNC_INTERVAL',
      'PUBLIC_GAMES_REFRESH', 'TYPING_TIMEOUT', 'TYPING_THROTTLE',
      'HONK_THROTTLE', 'CATEGORY_CACHE_TTL',
    ];

    for (const key of intervalKeys) {
      it(`${key} > 0`, () => {
        expect(C[key]).toBeGreaterThan(0);
      });
    }
  });

  describe('pagination limits are positive integers', () => {
    const limitKeys = [
      'CATEGORY_PAGE_SIZE', 'PUBLIC_ROOMS_LIMIT', 'CHAT_MESSAGES_LIMIT',
      'QUESTION_POOL_SIZE', 'WILDCARD_LIMIT', 'DIFFICULTY_QUESTION_LIMIT',
      'TITLE_BATCH_SIZE', 'PROFILE_SEARCH_LIMIT', 'ADMIN_PAGE_SIZE',
      'LEADERBOARD_LIMIT',
    ];

    for (const key of limitKeys) {
      it(`${key} is a positive integer`, () => {
        expect(C[key]).toBeGreaterThan(0);
        expect(Number.isInteger(C[key])).toBe(true);
      });
    }
  });

  describe('tier scores are in descending order', () => {
    it('Oracle > Master > Scholar > Apprentice', () => {
      expect(C.TIER_ORACLE).toBeGreaterThan(C.TIER_MASTER);
      expect(C.TIER_MASTER).toBeGreaterThan(C.TIER_SCHOLAR);
      expect(C.TIER_SCHOLAR).toBeGreaterThan(C.TIER_APPRENTICE);
    });

    it('all tier scores are positive', () => {
      expect(C.TIER_APPRENTICE).toBeGreaterThan(0);
    });
  });

  describe('mastery thresholds are valid percentages', () => {
    it('high threshold < complete threshold', () => {
      expect(C.MASTERY_HIGH_THRESHOLD).toBeLessThan(C.MASTERY_COMPLETE_THRESHOLD);
    });

    it('thresholds are in 0-100 range', () => {
      expect(C.MASTERY_HIGH_THRESHOLD).toBeGreaterThan(0);
      expect(C.MASTERY_COMPLETE_THRESHOLD).toBeLessThanOrEqual(100);
    });
  });

  describe('fuzzy match threshold is valid', () => {
    it('is between 0 and 1', () => {
      expect(C.FUZZY_MATCH_THRESHOLD).toBeGreaterThan(0);
      expect(C.FUZZY_MATCH_THRESHOLD).toBeLessThan(1);
    });
  });

  describe('loyalty days are valid', () => {
    it('loyal < ancient', () => {
      expect(C.LOYAL_DAYS).toBeLessThan(C.ANCIENT_DAYS);
    });
  });

  describe('night owl hours are valid', () => {
    it('start < end and within 0-23', () => {
      expect(C.NIGHT_OWL_START_HOUR).toBeGreaterThanOrEqual(0);
      expect(C.NIGHT_OWL_END_HOUR).toBeLessThanOrEqual(23);
      expect(C.NIGHT_OWL_START_HOUR).toBeLessThan(C.NIGHT_OWL_END_HOUR);
    });
  });
});
