import { describe, it, expect } from 'vitest';
import {
  CATEGORY_META,
  findSubcategoryNode,
  flattenSubcategories,
  resolveCategoryLabel,
  resolveSubcategoryIcon,
} from '../js/categories.js';

// ============================================
// CATEGORY_META structure sanity
// ============================================
describe('CATEGORY_META structure', () => {
  it('has all 12 categories', () => {
    const expected = [
      'history', 'science', 'nature', 'arts-literature', 'culture-society',
      'pop-culture', 'world-geography', 'technology', 'sports', 'food', 'logic', 'wild-card',
    ];
    expect(Object.keys(CATEGORY_META).sort()).toEqual(expected.sort());
  });

  it('every category has icon and label', () => {
    for (const [key, meta] of Object.entries(CATEGORY_META)) {
      expect(typeof meta.icon, `${key} missing icon`).toBe('string');
      expect(typeof meta.label, `${key} missing label`).toBe('string');
    }
  });

  it('every category has subcategories or wildCardOptions', () => {
    for (const [key, meta] of Object.entries(CATEGORY_META)) {
      const hasSubs = Array.isArray(meta.subcategories) && meta.subcategories.length > 0;
      const hasWild = Array.isArray(meta.wildCardOptions) && meta.wildCardOptions.length > 0;
      expect(hasSubs || hasWild, `${key} has neither subcategories nor wildCardOptions`).toBe(true);
    }
  });
});

// ============================================
// findSubcategoryNode
// ============================================
describe('findSubcategoryNode', () => {
  it('returns null for null meta', () => {
    expect(findSubcategoryNode(null, 'ancient')).toBe(null);
  });

  it('returns null for null key', () => {
    expect(findSubcategoryNode(CATEGORY_META['history'], null)).toBe(null);
  });

  it('returns null for empty key', () => {
    expect(findSubcategoryNode(CATEGORY_META['history'], '')).toBe(null);
  });

  it('finds a depth-1 subcategory', () => {
    const node = findSubcategoryNode(CATEGORY_META['history'], 'ancient');
    expect(node).not.toBe(null);
    expect(node.key).toBe('ancient');
    expect(node.label).toBe('Ancient');
  });

  it('finds a depth-2 subcategory (child)', () => {
    const node = findSubcategoryNode(CATEGORY_META['pop-culture'], 'entertainment-movies');
    expect(node).not.toBe(null);
    expect(node.key).toBe('entertainment-movies');
    expect(node.label).toBe('Movies');
  });

  it('finds a depth-3 subcategory (deeply nested)', () => {
    const node = findSubcategoryNode(CATEGORY_META['world-geography'], 'human-countries-capitals');
    expect(node).not.toBe(null);
    expect(node.key).toBe('human-countries-capitals');
    expect(node.label).toBe('Capitals');
  });

  it('returns null for nonexistent key', () => {
    expect(findSubcategoryNode(CATEGORY_META['history'], 'nonexistent')).toBe(null);
  });

  it('returns null for meta without subcategories', () => {
    expect(findSubcategoryNode({ icon: '?', label: 'Test' }, 'anything')).toBe(null);
  });
});

// ============================================
// resolveCategoryLabel
// ============================================
describe('resolveCategoryLabel', () => {
  it('returns raw key for unknown category', () => {
    expect(resolveCategoryLabel('nonexistent', null)).toBe('nonexistent');
  });

  it('returns category label when no subcategory', () => {
    expect(resolveCategoryLabel('history', null)).toBe('History');
    expect(resolveCategoryLabel('history', '')).toBe('History');
    expect(resolveCategoryLabel('history', undefined)).toBe('History');
  });

  it('builds depth-1 breadcrumb', () => {
    expect(resolveCategoryLabel('history', 'ancient')).toBe('History \u2014 Ancient');
  });

  it('builds depth-2 breadcrumb', () => {
    expect(resolveCategoryLabel('pop-culture', 'entertainment-movies'))
      .toBe('Pop Culture \u2014 Entertainment \u2014 Movies');
  });

  it('builds depth-3 breadcrumb', () => {
    expect(resolveCategoryLabel('world-geography', 'human-countries-capitals'))
      .toBe('World Geography \u2014 Human \u2014 Countries \u2014 Capitals');
  });

  it('falls back to category label for unknown subcategory', () => {
    expect(resolveCategoryLabel('history', 'nonexistent')).toBe('History');
  });

  it('resolves wild-card special options', () => {
    expect(resolveCategoryLabel('wild-card', '__all_questions__'))
      .toBe('Wild Card \u2014 All Questions');
    expect(resolveCategoryLabel('wild-card', '__true_wild_card__'))
      .toBe('Wild Card \u2014 True Wild Card');
  });

  it('falls back for unknown wild-card option', () => {
    expect(resolveCategoryLabel('wild-card', 'nonexistent')).toBe('Wild Card');
  });
});

// ============================================
// resolveSubcategoryIcon
// ============================================
describe('resolveSubcategoryIcon', () => {
  it('returns ? for unknown category', () => {
    expect(resolveSubcategoryIcon('nonexistent', null)).toBe('?');
  });

  it('returns category icon when no subcategory', () => {
    const meta = CATEGORY_META['history'];
    expect(resolveSubcategoryIcon('history', null)).toBe(meta.emoji || meta.icon);
  });

  it('returns subcategory icon for depth-1 node', () => {
    const node = findSubcategoryNode(CATEGORY_META['history'], 'ancient');
    expect(resolveSubcategoryIcon('history', 'ancient')).toBe(node.emoji || node.icon);
  });

  it('returns deeply nested subcategory icon', () => {
    const node = findSubcategoryNode(CATEGORY_META['world-geography'], 'human-countries-capitals');
    expect(resolveSubcategoryIcon('world-geography', 'human-countries-capitals')).toBe(node.emoji || node.icon);
  });

  it('falls back to category icon for unknown subcategory', () => {
    const meta = CATEGORY_META['history'];
    expect(resolveSubcategoryIcon('history', 'nonexistent')).toBe(meta.emoji || meta.icon);
  });

  it('resolves wild-card option icons', () => {
    const opt = CATEGORY_META['wild-card'].wildCardOptions.find(o => o.key === '__all_questions__');
    expect(resolveSubcategoryIcon('wild-card', '__all_questions__')).toBe(opt.emoji || opt.icon);
  });
});

// ============================================
// flattenSubcategories feeds the admin question editor's subcategory picker.
// A key it omits is a filing an admin cannot choose, and a key it invents is a
// filing that matches no question — both are silent, because `subcategory` is
// a free text column with no constraint behind it.

describe('flattenSubcategories', () => {
  it('returns every subcategory of a flat category', () => {
    const keys = flattenSubcategories('nature').map(s => s.key);
    expect(keys).toEqual(['animals', 'plants', 'environment']);
  });

  it('descends into children and records how deep each one is', () => {
    const geo = flattenSubcategories('world-geography');
    const byKey = Object.fromEntries(geo.map(s => [s.key, s.depth]));

    expect(byKey['human']).toBe(0);
    expect(byKey['human-countries']).toBe(1);
    expect(byKey['human-countries-capitals']).toBe(2);
    expect(byKey['natural']).toBe(0);
  });

  it('keeps depth-first order, so a child follows its parent', () => {
    const keys = flattenSubcategories('world-geography').map(s => s.key);
    expect(keys.indexOf('human-countries')).toBe(keys.indexOf('human') + 1);
    expect(keys.indexOf('human-countries-capitals')).toBe(keys.indexOf('human-countries') + 1);
  });

  it('includes wild-card options, which live outside `subcategories`', () => {
    const meta = CATEGORY_META['wild-card'];
    const keys = flattenSubcategories('wild-card').map(s => s.key);
    for (const opt of meta.wildCardOptions || []) {
      expect(keys).toContain(opt.key);
    }
  });

  it('returns nothing for a category that does not exist', () => {
    expect(flattenSubcategories('not-a-category')).toEqual([]);
    expect(flattenSubcategories(undefined)).toEqual([]);
  });

  // The picker's whole promise is that choosing an entry files the question
  // somewhere the game can find it again. That only holds if every key it
  // offers is a real node in the tree it came from.
  it('every key it offers resolves back to a node in that category', () => {
    for (const category of Object.keys(CATEGORY_META)) {
      const meta = CATEGORY_META[category];
      const wildCardKeys = new Set((meta.wildCardOptions || []).map(o => o.key));
      for (const { key, label } of flattenSubcategories(category)) {
        expect(typeof key, `${category}/${key}`).toBe('string');
        expect(label, `${category}/${key} has no label`).toBeTruthy();
        if (wildCardKeys.has(key)) continue;
        expect(findSubcategoryNode(meta, key), `${category}/${key} is not in the tree`).toBeTruthy();
      }
    }
  });

  // Selection matches with LIKE 'key%', so two subcategories where one key is
  // a prefix of the other are indistinguishable to the query — asking for the
  // shorter one silently drags in the longer one's questions. Children are
  // deliberately named that way ('human' → 'human-countries'), so the check is
  // for collisions BETWEEN branches, which nothing intends.
  it('no subcategory key prefixes an unrelated one', () => {
    for (const category of Object.keys(CATEGORY_META)) {
      const meta = CATEGORY_META[category];
      const subs = flattenSubcategories(category);
      for (const a of subs) {
        for (const b of subs) {
          if (a.key === b.key || !b.key.startsWith(a.key)) continue;
          // b is under a's prefix — legitimate only if b really descends from a.
          const node = findSubcategoryNode(meta, a.key);
          const descends = !!node && !!findSubcategoryNode({ subcategories: node.children || [] }, b.key);
          expect(descends, `${category}: "${b.key}" is caught by "${a.key}" but is not its child`).toBe(true);
        }
      }
    }
  });
});
