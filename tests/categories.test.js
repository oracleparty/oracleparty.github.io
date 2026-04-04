import { describe, it, expect } from 'vitest';
import {
  CATEGORY_META,
  findSubcategoryNode,
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
    expect(resolveSubcategoryIcon('history', null)).toBe(CATEGORY_META['history'].icon);
  });

  it('returns subcategory icon for depth-1 node', () => {
    const node = findSubcategoryNode(CATEGORY_META['history'], 'ancient');
    expect(resolveSubcategoryIcon('history', 'ancient')).toBe(node.icon);
  });

  it('returns deeply nested subcategory icon', () => {
    const node = findSubcategoryNode(CATEGORY_META['world-geography'], 'human-countries-capitals');
    expect(resolveSubcategoryIcon('world-geography', 'human-countries-capitals')).toBe(node.icon);
  });

  it('falls back to category icon for unknown subcategory', () => {
    expect(resolveSubcategoryIcon('history', 'nonexistent')).toBe(CATEGORY_META['history'].icon);
  });

  it('resolves wild-card option icons', () => {
    const allQIcon = CATEGORY_META['wild-card'].wildCardOptions.find(o => o.key === '__all_questions__').icon;
    expect(resolveSubcategoryIcon('wild-card', '__all_questions__')).toBe(allQIcon);
  });
});
