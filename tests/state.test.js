import { describe, it, expect, beforeEach } from 'vitest';
import {
  state,
  canControlGame,
  getCategoryLabel,
  _isLeaving, setIsLeaving,
  _countdownActive, setCountdownActive,
  _deferredPhase, setDeferredPhase,
  _lastScoresRenderedForQuestion, setLastScoresRendered,
  _staleCheckCount, setStaleCheckCount,
  _screenTransitioning, setScreenTransitioning,
  _syncInFlight, setSyncInFlight,
} from '../js/game/state.js';

// ============================================
// canControlGame
// ============================================
describe('canControlGame', () => {
  beforeEach(() => { state.room = null; });

  it('returns true when player is host', () => {
    state.room = { isHost: true, isCohost: false };
    expect(canControlGame()).toBe(true);
  });

  it('returns true when player is co-host', () => {
    state.room = { isHost: false, isCohost: true };
    expect(canControlGame()).toBe(true);
  });

  it('returns true when player is both host and co-host', () => {
    state.room = { isHost: true, isCohost: true };
    expect(canControlGame()).toBe(true);
  });

  it('returns false when neither host nor co-host', () => {
    state.room = { isHost: false, isCohost: false };
    expect(canControlGame()).toBeFalsy();
  });

  it('returns falsy when room is null', () => {
    state.room = null;
    expect(canControlGame()).toBeFalsy();
  });
});

// ============================================
// getCategoryLabel
// ============================================
describe('getCategoryLabel', () => {
  beforeEach(() => { state.room = null; });

  it('returns "?" when room is null', () => {
    expect(getCategoryLabel()).toBe('?');
  });

  it('returns icon + label for known category', () => {
    state.room = { category: 'history', subcategory: null };
    const result = getCategoryLabel();
    expect(result).toContain('History');
  });

  it('returns "? category" for unknown category', () => {
    state.room = { category: 'nonexistent-thing', subcategory: null };
    const result = getCategoryLabel();
    expect(result).toContain('?');
    expect(result).toContain('nonexistent-thing');
  });

  it('resolves subcategory label when provided', () => {
    state.room = { category: 'science', subcategory: 'space' };
    const result = getCategoryLabel();
    expect(result).toContain('Space');
  });
});

// ============================================
// Guard setters
// ============================================
describe('guard setters', () => {
  it('setIsLeaving updates _isLeaving', async () => {
    setIsLeaving(false);
    // Re-import to read updated value
    const mod = await import('../js/game/state.js');
    expect(mod._isLeaving).toBe(false);
    setIsLeaving(true);
    const mod2 = await import('../js/game/state.js');
    expect(mod2._isLeaving).toBe(true);
    setIsLeaving(false); // cleanup
  });

  it('setCountdownActive updates _countdownActive', async () => {
    setCountdownActive(true);
    const mod = await import('../js/game/state.js');
    expect(mod._countdownActive).toBe(true);
    setCountdownActive(false);
  });

  it('setDeferredPhase updates _deferredPhase', async () => {
    setDeferredPhase('question');
    const mod = await import('../js/game/state.js');
    expect(mod._deferredPhase).toBe('question');
    setDeferredPhase(null);
  });

  it('setLastScoresRendered updates _lastScoresRenderedForQuestion', async () => {
    setLastScoresRendered(3);
    const mod = await import('../js/game/state.js');
    expect(mod._lastScoresRenderedForQuestion).toBe(3);
    setLastScoresRendered(-1);
  });

  it('setStaleCheckCount updates _staleCheckCount', async () => {
    setStaleCheckCount(5);
    const mod = await import('../js/game/state.js');
    expect(mod._staleCheckCount).toBe(5);
    setStaleCheckCount(-1);
  });

  it('setScreenTransitioning updates _screenTransitioning', async () => {
    setScreenTransitioning(true);
    const mod = await import('../js/game/state.js');
    expect(mod._screenTransitioning).toBe(true);
    setScreenTransitioning(false);
  });

  it('setSyncInFlight updates _syncInFlight', async () => {
    setSyncInFlight(true);
    const mod = await import('../js/game/state.js');
    expect(mod._syncInFlight).toBe(true);
    setSyncInFlight(false);
  });
});

// ============================================
// resolveFieldMap + field accessors
// ============================================
describe('resolveFieldMap and field accessors', () => {
  // Note: resolveFieldMap only resolves ONCE per module load.
  // We test with a fresh import using dynamic import + query string trick.

  it('resolves standard field names and accessors work', async () => {
    // Use a unique query param to get a fresh module instance
    const mod = await import('../js/game/state.js?t=field1');
    const q = {
      question_text: 'What is 2+2?',
      correct_answer: '4',
      acceptable_answers: ['four'],
      difficulty: 'easy',
      fun_fact: 'Math is fun',
    };
    mod.resolveFieldMap(q);
    expect(mod.getQuestionText(q)).toBe('What is 2+2?');
    expect(mod.getCorrectAnswer(q)).toBe('4');
    expect(mod.getAlternates(q)).toEqual(['four']);
    expect(mod.getDifficulty(q)).toBe('easy');
    expect(mod.getFunFact(q)).toBe('Math is fun');
  });

  it('resolves alternate field names (question, answer)', async () => {
    const mod = await import('../js/game/state.js?t=field2');
    const q = {
      question: 'Capital of France?',
      answer: 'Paris',
      alternates: ['paris'],
    };
    mod.resolveFieldMap(q);
    expect(mod.getQuestionText(q)).toBe('Capital of France?');
    expect(mod.getCorrectAnswer(q)).toBe('Paris');
    expect(mod.getAlternates(q)).toEqual(['paris']);
  });

  it('defaults difficulty to medium when missing', async () => {
    const mod = await import('../js/game/state.js?t=field3');
    const q = { question_text: 'Test', correct_answer: 'A' };
    mod.resolveFieldMap(q);
    expect(mod.getDifficulty(q)).toBe('medium');
  });

  it('defaults fun_fact to empty string when missing', async () => {
    const mod = await import('../js/game/state.js?t=field4');
    const q = { question_text: 'Test', correct_answer: 'A' };
    mod.resolveFieldMap(q);
    expect(mod.getFunFact(q)).toBe('');
  });

  it('returns empty array for missing alternates', async () => {
    const mod = await import('../js/game/state.js?t=field5');
    const q = { question_text: 'Test', correct_answer: 'A' };
    mod.resolveFieldMap(q);
    expect(mod.getAlternates(q)).toEqual([]);
  });

  it('resolveFieldMap only resolves once (first call wins)', async () => {
    const mod = await import('../js/game/state.js?t=field6');
    const q1 = { question_text: 'First', correct_answer: 'A' };
    const q2 = { question: 'Second', answer: 'B' };
    mod.resolveFieldMap(q1);
    mod.resolveFieldMap(q2); // should be ignored
    expect(mod.getQuestionText(q1)).toBe('First');
    // q2 uses 'question' field, but FIELD_MAP resolved to 'question_text'
    expect(mod.getQuestionText(q2)).toBe('');
  });
});
