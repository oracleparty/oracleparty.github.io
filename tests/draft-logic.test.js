import { describe, it, expect } from 'vitest';
import {
  DRAFT_KEY, DRAFT_CATEGORIES, isDraftRoom, encodeDraftMove, parseDraftMove,
  draftTally, draftStatus, draftShare, draftPlan, draftPickers, draftPickLabel,
  inBannedCategory
} from '../js/draft-logic.js';
import { CATEGORY_META } from '../js/categories.js';

const P = (name, move, extra = {}) => ({ id: name, display_name: name, draft_move: move, ...extra });

describe('category draft: moves', () => {
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

  it('knows a draft room by its subcategory', () => {
    expect(isDraftRoom({ category: 'wild-card', subcategory: DRAFT_KEY })).toBe(true);
    expect(isDraftRoom({ category: 'wild-card', subcategory: '__all_questions__' })).toBe(false);
    expect(isDraftRoom(null)).toBe(false);
  });
});

describe('category draft: the tally', () => {
  it('a want and a ban on one category cancel out', () => {
    const tally = draftTally([P('Bob', 'want:sports'), P('Carol', 'ban:sports')]);
    expect(tally.sports.net).toBe(0);
    expect(draftStatus(tally.sports)).toBe('even');
  });

  it('two wants against one ban still leaves one want', () => {
    const tally = draftTally([P('A', 'want:food'), P('B', 'want:food'), P('C', 'ban:food')]);
    expect(tally.food.net).toBe(1);
    expect(draftStatus(tally.food)).toBe('want');
  });

  it('a bot never moves, whatever its row says', () => {
    const tally = draftTally([P('Bot', 'ban:science', { is_bot: true }), P('A', 'want:science')]);
    expect(tally.science.net).toBe(1);
    expect(tally.science.bans).toHaveLength(0);
  });

  it('ignores a player who has not moved', () => {
    expect(draftTally([P('A', null), P('B', undefined)])).toEqual({});
  });
});

describe('category draft: the plan', () => {
  it('a want is worth an equal slice of the game', () => {
    expect(draftShare(10, 4)).toBe(2);
    expect(draftShare(10, 2)).toBe(5);
    expect(draftShare(5, 8)).toBe(1);   // never worth nothing
    expect(draftShare(10, 0)).toBe(10); // nobody counted is one person
  });

  it('builds the example from the design: 4 players, 10 questions', () => {
    const players = [P('Alice', 'want:science'), P('Bob', 'want:sports'), P('Carol', 'ban:sports'), P('Dan', 'ban:history')];
    const plan = draftPlan(players, 10);
    expect(plan.share).toBe(2);
    expect(plan.featured).toEqual([{ category: 'science', count: 2 }]);
    expect(plan.banned).toEqual(['history']);
  });

  it('bots do not shrink a person\'s share', () => {
    const plan = draftPlan([P('Alice', 'want:logic'), P('Bot', null, { is_bot: true })], 10);
    expect(plan.share).toBe(10);
    expect(plan.featured).toEqual([{ category: 'logic', count: 10 }]);
  });

  it('never promises more questions than the game holds', () => {
    // 3 people, 5 questions: share 1. Stack wants so the total would exceed 5.
    const players = [P('A', 'want:food'), P('B', 'want:food'), P('C', 'want:food')];
    const stacked = draftPlan(players, 2); // share = max(1, floor(2/3)) = 1, 3 wanted, only 2 exist
    const promised = stacked.featured.reduce((s, f) => s + f.count, 0);
    expect(promised).toBe(2);
  });

  it('with no moves the game is a plain mix', () => {
    expect(draftPlan([P('A', null), P('B', null)], 10)).toEqual({ featured: [], banned: [], share: 5 });
  });
});

describe('category draft: whose pick', () => {
  const players = [P('Alice', 'want:science'), P('Bob', 'want:sports'), P('Carol', 'ban:sports'), P('Dan', 'want:science')];

  it('names everyone whose surviving want a question answers', () => {
    expect(draftPickers(players, ['science'])).toEqual(['Alice', 'Dan']);
    expect(draftPickers(players, ['history', 'science'])).toEqual(['Alice', 'Dan']);
  });

  it('a cancelled want is nobody\'s pick', () => {
    expect(draftPickers(players, ['sports'])).toEqual([]);
  });

  it('labels one, two and many', () => {
    expect(draftPickLabel([])).toBe('');
    expect(draftPickLabel(['Alice'])).toBe("Alice's pick");
    expect(draftPickLabel(['Alice', 'Dan'])).toBe("Alice & Dan's pick");
    expect(draftPickLabel(['A', 'B', 'C'])).toBe("3 players' pick");
  });

  it('spots a question filed under a banned category', () => {
    expect(inBannedCategory({ categories: ['history', 'science'] }, ['history'])).toBe(true);
    expect(inBannedCategory({ categories: ['science'] }, ['history'])).toBe(false);
    expect(inBannedCategory({ categories: ['science'] }, [])).toBe(false);
    expect(inBannedCategory({}, ['history'])).toBe(false);
  });
});
