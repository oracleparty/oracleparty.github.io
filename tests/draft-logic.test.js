import { describe, it, expect } from 'vitest';
import {
  DRAFT_KEY, RANDOM_KEY, DRAFT_CATEGORIES, DRAFT_UPSET_SHARE,
  isDraftRoom, isRandomRoom, isSpinRoom, encodeDraftMove, parseDraftMove,
  draftTally, draftStatus, draftWeights, randomWeights, spinWeights, pickWeighted, validPick,
  DRAFT_EACH_KEY, RANDOM_EACH_KEY, spinKey, spinKind, spinLabel, spinIcon, spinsEveryQuestion,
  pickSequence, questionSubject
} from '../js/draft-logic.js';
import { CATEGORY_META } from '../js/categories.js';

const P = (name, move, extra = {}) => ({ id: name, display_name: name, draft_move: move, ...extra });
const sum = w => Object.values(w).reduce((a, b) => a + b, 0);

describe('draft: moves', () => {
  it('offers every real subject and never Wild Card', () => {
    const subjects = Object.keys(CATEGORY_META).filter(k => k !== 'wild-card').sort();
    expect([...DRAFT_CATEGORIES].sort()).toEqual(subjects);
  });

  it('round-trips a move and refuses anything else', () => {
    expect(parseDraftMove(encodeDraftMove('want', 'science'))).toEqual({ kind: 'want', category: 'science' });
    expect(parseDraftMove('ban:arts-literature')).toEqual({ kind: 'ban', category: 'arts-literature' });
    expect(encodeDraftMove('steal', 'science')).toBeNull();
    expect(encodeDraftMove('want', 'wild-card')).toBeNull();
    for (const bad of [null, undefined, '', 'science', 'want:', 'want:nonsense', 'love:science', 7]) {
      expect(parseDraftMove(bad)).toBeNull();
    }
  });

  it('knows which rooms spin', () => {
    const draft = { category: 'wild-card', subcategory: DRAFT_KEY };
    const random = { category: 'wild-card', subcategory: RANDOM_KEY };
    const plain = { category: 'wild-card', subcategory: '__all_questions__' };
    expect([isDraftRoom(draft), isRandomRoom(draft), isSpinRoom(draft)]).toEqual([true, false, true]);
    expect([isDraftRoom(random), isRandomRoom(random), isSpinRoom(random)]).toEqual([false, true, true]);
    expect(isSpinRoom(plain)).toBe(false);
    expect(isSpinRoom(null)).toBe(false);
  });

  it('only believes a stored pick that names a real subject', () => {
    expect(validPick('science')).toBe('science');
    for (const bad of ['wild-card', 'nonsense', '', null, undefined]) expect(validPick(bad)).toBeNull();
  });
});

describe('draft: blocks on the wheel', () => {
  it('each want is one block', () => {
    const tally = draftTally([P('A', 'want:science'), P('C', 'want:science')]);
    expect(tally.science.blocks).toBe(2);
    expect(draftStatus(tally.science)).toBe('want');
  });

  it('a ban takes one block off', () => {
    const tally = draftTally([P('A', 'want:food'), P('B', 'want:food'), P('C', 'ban:food')]);
    expect(tally.food.blocks).toBe(1);
    expect(draftStatus(tally.food)).toBe('want');
  });

  it('a want and a ban cancel, and blocks never go below none', () => {
    const tally = draftTally([P('A', 'want:sports'), P('B', 'ban:sports'), P('C', 'ban:sports')]);
    expect(tally.sports.blocks).toBe(0);
    expect(draftStatus(tally.sports)).toBe('even');
    expect(draftStatus(draftTally([P('D', 'ban:history')]).history)).toBe('ban');
  });

  it('a bot never moves, whatever its row says', () => {
    const tally = draftTally([P('Bot', 'ban:science', { is_bot: true }), P('A', 'want:science')]);
    expect(tally.science.blocks).toBe(1);
    expect(tally.science.bans).toHaveLength(0);
  });
});

describe('draft: the odds', () => {
  it('always adds up to a whole wheel', () => {
    const rooms = [
      [],
      [P('A', 'want:science')],
      [P('A', 'want:science'), P('B', 'ban:science')],
      [P('A', 'want:science'), P('B', 'want:food'), P('C', 'ban:history')],
      DRAFT_CATEGORIES.map((c, i) => P('p' + i, 'ban:' + c)),
      DRAFT_CATEGORIES.map((c, i) => P('p' + i, 'want:' + c)),
    ];
    for (const players of rooms) expect(sum(draftWeights(players))).toBeCloseTo(1, 10);
    expect(sum(randomWeights())).toBeCloseTo(1, 10);
  });

  it('wanted categories share 95% by their blocks', () => {
    const w = draftWeights([P('A', 'want:science'), P('C', 'want:science'), P('B', 'want:food')]);
    expect(w.science).toBeCloseTo(0.95 * 2 / 3, 10);
    expect(w.food).toBeCloseTo(0.95 * 1 / 3, 10);
  });

  it('the upset is 1 in 20, shared by the categories nobody touched', () => {
    const w = draftWeights([P('A', 'want:science'), P('B', 'ban:history')]);
    const untouched = DRAFT_CATEGORIES.filter(c => c !== 'science' && c !== 'history');
    expect(DRAFT_UPSET_SHARE).toBe(0.05);
    expect(untouched.reduce((s, c) => s + w[c], 0)).toBeCloseTo(0.05, 10);
    for (const c of untouched) expect(w[c]).toBeCloseTo(0.05 / 9, 10);
  });

  it('a banned category cannot come up, not even as the upset', () => {
    expect(draftWeights([P('A', 'want:science'), P('B', 'ban:history')]).history).toBe(0);
    expect(draftWeights([P('B', 'ban:history')]).history).toBe(0);
    // Wanted, then banned off: also out.
    expect(draftWeights([P('A', 'want:sports'), P('B', 'ban:sports'), P('C', 'want:food')]).sports).toBe(0);
  });

  it('with no blocks, every unbanned category is equally likely', () => {
    const none = draftWeights([P('A', null), P('B', null)]);
    for (const c of DRAFT_CATEGORIES) expect(none[c]).toBeCloseTo(1 / 11, 10);
    const oneBan = draftWeights([P('B', 'ban:history')]);
    expect(oneBan.science).toBeCloseTo(1 / 10, 10);
  });

  it('when every category was touched there is no upset to give', () => {
    const players = DRAFT_CATEGORIES.map((c, i) => P('p' + i, (i === 0 ? 'want:' : 'ban:') + c));
    expect(draftWeights(players)[DRAFT_CATEGORIES[0]]).toBeCloseTo(1, 10);
  });

  it('random mode is every subject equally, whatever the seats say', () => {
    const room = { subcategory: RANDOM_KEY };
    const w = spinWeights(room, [P('A', 'want:science')]);
    for (const c of DRAFT_CATEGORIES) expect(w[c]).toBeCloseTo(1 / 11, 10);
    expect(spinWeights({ subcategory: DRAFT_KEY }, [P('A', 'want:science')]).science).toBeCloseTo(0.95, 10);
  });
});

describe('draft: the spin', () => {
  const weights = draftWeights([P('A', 'want:science'), P('B', 'ban:history')]);

  it('lands on the wanted category for 19 rolls in 20', () => {
    expect(pickWeighted(weights, 0)).not.toBe('history');
    expect(pickWeighted(weights, 0.5)).toBe('science');
  });

  it('never lands on a category with no chance', () => {
    for (let i = 0; i < 1000; i++) expect(pickWeighted(weights, i / 1000)).not.toBe('history');
    expect(pickWeighted(weights, 0.999999)).not.toBe('history');
  });

  it('follows the odds over many spins', () => {
    const w = draftWeights([P('A', 'want:science'), P('C', 'want:science'), P('B', 'want:food')]);
    const hits = {};
    const N = 20000;
    for (let i = 0; i < N; i++) { const c = pickWeighted(w, (i + 0.5) / N); hits[c] = (hits[c] || 0) + 1; }
    expect(hits.science / N).toBeCloseTo(0.95 * 2 / 3, 2);
    expect(hits.food / N).toBeCloseTo(0.95 / 3, 2);
    const upsets = N - hits.science - hits.food;
    expect(upsets / N).toBeCloseTo(0.05, 2);
  });

  it('still answers when handed nothing', () => {
    expect(DRAFT_CATEGORIES).toContain(pickWeighted({}, 0.3));
    expect(DRAFT_CATEGORIES).toContain(pickWeighted(null, 0.99));
  });
});

describe('spin: every question', () => {
  it('is stored as its own key and still counts as the same kind of room', () => {
    expect(spinKey('draft', false)).toBe(DRAFT_KEY);
    expect(spinKey('draft', true)).toBe(DRAFT_EACH_KEY);
    expect(spinKey('random', true)).toBe(RANDOM_EACH_KEY);
    expect(spinKey('science', true)).toBeNull();
    for (const key of [DRAFT_KEY, DRAFT_EACH_KEY]) {
      expect(spinKind(key)).toBe('draft');
      expect(isDraftRoom({ subcategory: key })).toBe(true);
      expect(spinLabel(key)).toBe('Draft');
    }
    for (const key of [RANDOM_KEY, RANDOM_EACH_KEY]) {
      expect(isRandomRoom({ subcategory: key })).toBe(true);
      expect(spinLabel(key)).toBe('Random');
      expect(spinIcon(key)).toBeTruthy();
    }
    expect(spinKind('__all_questions__')).toBeNull();
    expect(spinLabel('ancient')).toBeNull();
  });

  it('knows which rooms spin every question', () => {
    expect(spinsEveryQuestion({ subcategory: DRAFT_EACH_KEY })).toBe(true);
    expect(spinsEveryQuestion({ subcategory: RANDOM_EACH_KEY })).toBe(true);
    expect(spinsEveryQuestion({ subcategory: DRAFT_KEY })).toBe(false);
    expect(spinsEveryQuestion({ subcategory: RANDOM_KEY })).toBe(false);
    expect(spinsEveryQuestion(null)).toBe(false);
  });

  it('draws one subject per question from the same wheel, never a banned one', () => {
    const weights = draftWeights([P('A', 'want:science'), P('B', 'ban:history')]);
    let i = 0;
    const rolls = [0.01, 0.5, 0.94, 0.951, 0.999, 0.3];
    const seq = pickSequence(weights, 6, () => rolls[i++]);
    expect(seq).toHaveLength(6);
    expect(seq.filter(c => c === 'science')).toHaveLength(4);
    expect(seq).not.toContain('history');
    expect(pickSequence(weights, 0)).toEqual([]);
  });

  it('reads a question\'s subject off the question, the same on every phone', () => {
    const even = randomWeights();
    expect(questionSubject(even, ['science'])).toBe('science');
    // Filed under two subjects with equal odds: the earlier one in the list.
    expect(questionSubject(even, ['science', 'history'])).toBe('history');
    expect(questionSubject(even, ['history', 'science'])).toBe('history');
    // The better odds win, whichever order the question lists them in.
    const w = draftWeights([P('A', 'want:science')]);
    expect(questionSubject(w, ['history', 'science'])).toBe('science');
    // Wild Card is never a subject.
    expect(questionSubject(even, ['wild-card', 'food'])).toBe('food');
    expect(questionSubject(even, ['wild-card'])).toBeNull();
    expect(questionSubject(even, null)).toBeNull();
  });
});
