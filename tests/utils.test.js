import { describe, it, expect } from 'vitest';
import {
  normalizeAnswer,
  levenshteinDistance,
  fuzzyMatch,
  pickProfileByTag,
  calculateTitle,
  getAvatarHue,
  shuffleArray,
} from '../js/utils.js';

// ============================================
// normalizeAnswer
// ============================================
describe('normalizeAnswer', () => {
  it('lowercases and trims', () => {
    expect(normalizeAnswer('  HELLO  ')).toBe('hello');
  });

  it('strips leading articles', () => {
    expect(normalizeAnswer('The Great Wall')).toBe('great wall');
    expect(normalizeAnswer('a cat')).toBe('cat');
    expect(normalizeAnswer('An apple')).toBe('apple');
  });

  it('removes punctuation', () => {
    expect(normalizeAnswer("it's a test!")).toBe('its a test');
    expect(normalizeAnswer('rock & roll')).toBe('rock roll');
  });

  it('collapses whitespace', () => {
    expect(normalizeAnswer('too   many   spaces')).toBe('too many spaces');
  });

  it('expands numeric abbreviations', () => {
    expect(normalizeAnswer('5 bil')).toBe('5 billion');
    expect(normalizeAnswer('3mil')).toBe('3 million');
    expect(normalizeAnswer('2 tril')).toBe('2 trillion');
    expect(normalizeAnswer('10k')).toBe('10 thousand');
  });

  it('returns empty string for falsy input', () => {
    expect(normalizeAnswer('')).toBe('');
    expect(normalizeAnswer(null)).toBe('');
    expect(normalizeAnswer(undefined)).toBe('');
  });

  it('strips diacritics so accented characters compare to their base letters', () => {
    expect(normalizeAnswer('São Paulo')).toBe('sao paulo');
    expect(normalizeAnswer("Côte d'Ivoire")).toBe('cote divoire');
    expect(normalizeAnswer('niño')).toBe('nino');
    expect(normalizeAnswer('café')).toBe('cafe');
    expect(normalizeAnswer('Zürich')).toBe('zurich');
    expect(normalizeAnswer('Bogotá')).toBe('bogota');
  });
});

// ============================================
// levenshteinDistance
// ============================================
describe('levenshteinDistance', () => {
  it('returns 0 for identical strings', () => {
    expect(levenshteinDistance('hello', 'hello')).toBe(0);
  });

  it('handles empty strings', () => {
    expect(levenshteinDistance('', 'abc')).toBe(3);
    expect(levenshteinDistance('abc', '')).toBe(3);
    expect(levenshteinDistance('', '')).toBe(0);
  });

  it('counts single character edits', () => {
    expect(levenshteinDistance('cat', 'bat')).toBe(1); // substitution
    expect(levenshteinDistance('cat', 'cats')).toBe(1); // insertion
    expect(levenshteinDistance('cats', 'cat')).toBe(1); // deletion
  });

  it('counts multiple edits', () => {
    expect(levenshteinDistance('kitten', 'sitting')).toBe(3);
  });
});

// ============================================
// fuzzyMatch — Core Answer Judging
// ============================================
describe('fuzzyMatch — short answers are exact', () => {
  // From a playtest: "for single letter answers like what letter yaddah yaddah
  // it should be exact not fuzzy". It was worse than loose. The threshold had a
  // Math.max(1, ...) floor, so a one-character answer allowed one edit — and
  // one edit turns any letter into any other. A question asking which letter
  // something begins with could not be got wrong by anybody.
  //
  // 415 tests passed both before and after the fix, so nothing here could have
  // caught it. These are the cases that fail without it.
  it('one letter accepts only that letter', () => {
    expect(fuzzyMatch('A', 'A')).toBe(true);
    expect(fuzzyMatch('a', 'A')).toBe(true);
    for (const wrong of ['B', 'C', 'Z', 'Q']) {
      expect(fuzzyMatch(wrong, 'A')).toBe(false);
    }
  });

  it('two and three letter answers do not accept a near miss', () => {
    expect(fuzzyMatch('cat', 'cat')).toBe(true);
    expect(fuzzyMatch('bat', 'cat')).toBe(false);
    expect(fuzzyMatch('cot', 'cat')).toBe(false);
    expect(fuzzyMatch('ca', 'cat')).toBe(false);
    expect(fuzzyMatch('up', 'us')).toBe(false);
  });

  it('four characters and up keep their typo tolerance', () => {
    // The rule is one typo per four characters, and this is where it starts.
    expect(fuzzyMatch('Ohao', 'Ohio')).toBe(true);
    expect(fuzzyMatch('Napolean', 'Napoleon')).toBe(true);
    expect(fuzzyMatch('Shakespere', 'Shakespeare')).toBe(true);
  });

  it('still rejects a different word of the same length', () => {
    expect(fuzzyMatch('Idaho', 'Ohio')).toBe(false);
  });
});

describe('fuzzyMatch', () => {
  describe('exact matches after normalization', () => {
    it('matches identical answers', () => {
      expect(fuzzyMatch('Paris', 'Paris')).toBe(true);
    });

    it('matches case-insensitively', () => {
      expect(fuzzyMatch('paris', 'Paris')).toBe(true);
      expect(fuzzyMatch('PARIS', 'paris')).toBe(true);
    });

    it('matches ignoring leading articles', () => {
      expect(fuzzyMatch('The Beatles', 'Beatles')).toBe(true);
      expect(fuzzyMatch('Beatles', 'The Beatles')).toBe(true);
    });

    it('matches ignoring punctuation', () => {
      expect(fuzzyMatch("it's", 'its')).toBe(true);
    });
  });

  describe('fuzzy tolerance (typos)', () => {
    it('accepts 1 typo in short answers', () => {
      expect(fuzzyMatch('Pars', 'Paris')).toBe(true); // 1 deletion, within threshold
      expect(fuzzyMatch('Parix', 'Paris')).toBe(true); // 1 substitution
    });

    it('accepts typos proportional to length', () => {
      expect(fuzzyMatch('Shakespare', 'Shakespeare')).toBe(true);
      expect(fuzzyMatch('Missisippi', 'Mississippi')).toBe(true);
    });

    it('rejects too many typos', () => {
      expect(fuzzyMatch('Tokio', 'Paris')).toBe(false);
      expect(fuzzyMatch('abcdef', 'xyzabc')).toBe(false);
    });
  });

  describe('numeric guard', () => {
    it('rejects wrong numbers even if close by edit distance', () => {
      expect(fuzzyMatch('1994', '1996')).toBe(false);
      expect(fuzzyMatch('1995', '1996')).toBe(false);
    });

    it('accepts same number with typo in text part', () => {
      expect(fuzzyMatch('Appollo 13', 'Apollo 13')).toBe(true);
    });

    it('accepts exact number matches', () => {
      expect(fuzzyMatch('1776', '1776')).toBe(true);
    });
  });

  describe('last-name matching', () => {
    it('accepts last name for full name answers', () => {
      expect(fuzzyMatch('Antoinette', 'Marie Antoinette')).toBe(true);
      expect(fuzzyMatch('Booth', 'John Wilkes Booth')).toBe(true);
    });

    it('accepts first name for full name answers if long enough', () => {
      expect(fuzzyMatch('Marie', 'Marie Antoinette')).toBe(true);
    });

    it('rejects short partial names (3 chars or less)', () => {
      expect(fuzzyMatch('Joe', 'Joe Montana')).toBe(false);
    });
  });

  describe('alternate answers', () => {
    it('matches against alternates', () => {
      expect(fuzzyMatch('NYC', 'New York City', ['NYC', 'New York'])).toBe(true);
    });

    it('applies fuzzy matching to alternates', () => {
      expect(fuzzyMatch('New Yrok', 'New York City', ['New York'])).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('rejects empty submissions', () => {
      expect(fuzzyMatch('', 'Paris')).toBe(false);
    });

    it('handles null/undefined alternates', () => {
      expect(fuzzyMatch('Paris', 'Paris', null)).toBe(true);
      expect(fuzzyMatch('Paris', 'Paris', undefined)).toBe(true);
    });
  });
});

// ============================================
// calculateTitle
// ============================================
describe('calculateTitle', () => {
  it('returns Novice with no stats', () => {
    expect(calculateTitle([])).toEqual({ title: 'Novice', tier: 'Novice', category: null });
    expect(calculateTitle(null)).toEqual({ title: 'Novice', tier: 'Novice', category: null });
  });

  it('returns Novice if no category has enough questions', () => {
    const stats = [{ category: 'history', questions_answered: 10, correct_answers: 10 }];
    expect(calculateTitle(stats)).toEqual({ title: 'Novice', tier: 'Novice', category: null });
  });

  it('returns Apprentice tier for low scores', () => {
    const stats = [{ category: 'history', questions_answered: 20, correct_answers: 10 }];
    const result = calculateTitle(stats);
    expect(result.tier).toBe('Apprentice');
    expect(result.category).toBe('history');
    expect(result.title).toContain('The Historian');
  });

  it('returns Oracle tier for perfect high-volume performance', () => {
    const stats = [{ category: 'science', questions_answered: 200, correct_answers: 200 }];
    const result = calculateTitle(stats);
    expect(result.tier).toBe('Oracle');
    expect(result.title).toContain('The Scientist');
  });

  it('picks the category with the highest score', () => {
    const stats = [
      { category: 'history', questions_answered: 50, correct_answers: 25 },
      { category: 'science', questions_answered: 50, correct_answers: 45 },
    ];
    const result = calculateTitle(stats);
    expect(result.category).toBe('science');
  });

  it('uses category title mapping correctly', () => {
    const stats = [{ category: 'food', questions_answered: 40, correct_answers: 35 }];
    const result = calculateTitle(stats);
    expect(result.title).toContain('The Connoisseur');
  });
});

// ============================================
// getAvatarHue
// ============================================
describe('getAvatarHue', () => {
  it('returns a number between 0-359', () => {
    const hue = getAvatarHue('TestPlayer');
    expect(hue).toBeGreaterThanOrEqual(0);
    expect(hue).toBeLessThan(360);
  });

  it('is deterministic for the same name', () => {
    expect(getAvatarHue('Alice')).toBe(getAvatarHue('Alice'));
  });

  it('differs for different names', () => {
    expect(getAvatarHue('Alice')).not.toBe(getAvatarHue('Bob'));
  });
});

// ============================================
// shuffleArray
// ============================================
describe('shuffleArray', () => {
  it('returns an array of the same length', () => {
    const arr = [1, 2, 3, 4, 5];
    expect(shuffleArray(arr)).toHaveLength(5);
  });

  it('does not mutate the original', () => {
    const arr = [1, 2, 3, 4, 5];
    const copy = [...arr];
    shuffleArray(arr);
    expect(arr).toEqual(copy);
  });

  it('contains the same elements', () => {
    const arr = [1, 2, 3, 4, 5];
    expect(shuffleArray(arr).sort()).toEqual([1, 2, 3, 4, 5]);
  });
});

// ============================================
// pickProfileByTag — finding one person by "Name#1234"
//
// This replaced an ILIKE query whose every part was a hazard. Measured against
// a real Postgres: ILIKE 'Bob_1' matches Bob01 too, because `_` is a
// single-character wildcard and display names have no character restriction;
// and ILIKE 'Alice' matches 'alice'. Paired with .maybeSingle(), which ERRORS
// on more than one row, either collision made the lookup return null — which
// the friend search renders as "No results found" for somebody who exists.
// ============================================

describe('pickProfileByTag', () => {
  it('returns the only candidate when the name matches', () => {
    const rows = [{ display_name: 'Alice', discriminator: '1234' }];
    expect(pickProfileByTag(rows, 'Alice')?.display_name).toBe('Alice');
  });

  it('IGNORES a wildcard collision — Bob_1 must never resolve to Bob01', () => {
    // The exact pair measured in Postgres. Under the old ILIKE query these two
    // came back together and the lookup failed; with .limit(1) instead it would
    // have returned the WRONG PERSON and the friend request would have gone to
    // a stranger. Order is deliberately hostile: the impostor is first.
    const rows = [
      { display_name: 'Bob01', discriminator: '1234' },
      { display_name: 'Bob_1', discriminator: '1234' },
    ];
    expect(pickProfileByTag(rows, 'Bob_1')?.display_name).toBe('Bob_1');
    expect(pickProfileByTag(rows, 'Bob01')?.display_name).toBe('Bob01');
  });

  it('prefers the EXACT case when two people share a tag', () => {
    // Reachable because generateDiscriminator used to check uniqueness
    // case-sensitively while this lookup was case-insensitive, so neither
    // uniqueness check could see the other.
    const rows = [
      { display_name: 'alice', discriminator: '1234' },
      { display_name: 'Alice', discriminator: '1234' },
    ];
    expect(pickProfileByTag(rows, 'Alice')?.display_name).toBe('Alice');
    expect(pickProfileByTag(rows, 'alice')?.display_name).toBe('alice');
  });

  it('still finds somebody when only the case differs', () => {
    const rows = [{ display_name: 'Alice', discriminator: '1234' }];
    expect(pickProfileByTag(rows, 'ALICE')?.display_name).toBe('Alice');
  });

  it('returns null rather than a stranger when nobody matches', () => {
    const rows = [{ display_name: 'Carol', discriminator: '1234' }];
    expect(pickProfileByTag(rows, 'Alice')).toBeNull();
  });

  it('survives an empty, missing or malformed candidate list', () => {
    expect(pickProfileByTag([], 'Alice')).toBeNull();
    expect(pickProfileByTag(null, 'Alice')).toBeNull();
    expect(pickProfileByTag([{}, null], 'Alice')).toBeNull();
    expect(pickProfileByTag([{ display_name: 'Alice' }], '')).toBeNull();
  });

  it('ignores whitespace around the typed name', () => {
    const rows = [{ display_name: 'Alice', discriminator: '1234' }];
    expect(pickProfileByTag(rows, '  Alice  ')?.display_name).toBe('Alice');
  });
});
