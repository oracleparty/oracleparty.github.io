// ============================================
// Oracle Party — Centralized Category Metadata
// Single source of truth for all category/subcategory definitions
// ============================================

export const CATEGORY_META = {
  'history':          { icon: '\u23F3', label: 'History', subcategories: [
    { key: 'ancient', icon: '\uD83C\uDFDB\uFE0F', label: 'Ancient' },
    { key: 'medieval', icon: '\uD83D\uDEE1\uFE0F', label: 'Medieval' },
    { key: 'early-modern', icon: '\uD83D\uDD2D', label: 'Early Modern' },
    { key: 'modern', icon: '\uD83D\uDE80', label: 'Modern' },
  ]},
  'science':          { icon: '\u2697\uFE0F', label: 'Science', subcategories: [
    { key: 'human-body', icon: '\uD83E\uDDEC', label: 'Human Body' },
    { key: 'elements', icon: '\uD83E\uDDEA', label: 'Elements' },
    { key: 'space', icon: '\uD83E\uDE90', label: 'Space' },
    { key: 'misc', icon: '\uD83D\uDD2C', label: 'Misc' },
  ]},
  'nature':           { icon: '\uD83C\uDF3F', label: 'Nature' },
  'arts-literature':  { icon: '\uD83D\uDCDC', label: 'Arts & Literature' },
  'culture-society':  { icon: '\uD83C\uDFDB\uFE0F', label: 'Culture & Society', subcategories: [
    { key: 'beliefs', icon: '\uD83D\uDE4F', label: 'Beliefs' },
    { key: 'language', icon: '\uD83D\uDCAC', label: 'Language' },
    { key: 'traditions', icon: '\uD83C\uDFAD', label: 'Traditions' },
    { key: 'institutions', icon: '\uD83C\uDFE6', label: 'Institutions' },
    { key: 'misc', icon: '\uD83D\uDD2C', label: 'Misc' },
  ]},
  'pop-culture':      { icon: '\uD83C\uDFAC', label: 'Pop Culture', subcategories: [
    { key: 'entertainment-movies', icon: '\uD83C\uDFAC', label: 'Movies' },
    { key: 'entertainment-television', icon: '\uD83D\uDCFA', label: 'Television' },
    { key: 'entertainment-music', icon: '\uD83C\uDFB5', label: 'Music' },
    { key: 'entertainment-games', icon: '\uD83C\uDFAE', label: 'Games' },
    { key: 'celebrities', icon: '\u2B50', label: 'Celebrities' },
    { key: 'misc', icon: '\uD83D\uDD2C', label: 'Misc' },
  ]},
  'world-geography':  { icon: '\uD83D\uDDFA\uFE0F', label: 'World Geography', subcategories: [
    { key: 'human', icon: '\uD83C\uDFD9\uFE0F', label: 'Human', children: [
      { key: 'human-countries', icon: '\uD83C\uDF0D', label: 'Countries', children: [
        { key: 'human-countries-capitals', icon: '\uD83C\uDFDB\uFE0F', label: 'Capitals' },
        { key: 'human-countries-cities', icon: '\uD83C\uDF06', label: 'Cities' },
        { key: 'human-countries-states', icon: '\uD83D\uDDFE', label: 'States & Regions' },
      ]},
      { key: 'human-landmarks', icon: '\uD83D\uDDFD', label: 'Landmarks' },
      { key: 'human-misc', icon: '\uD83C\uDF10', label: 'Misc' },
    ]},
    { key: 'natural', icon: '\uD83C\uDFD4\uFE0F', label: 'Natural' },
  ]},
  'technology':       { icon: '\u26A1', label: 'Technology' },
  'sports':           { icon: '\uD83C\uDFC6', label: 'Sports', subcategories: [
    { key: 'team-sports', icon: '\u26BD', label: 'Team Sports' },
    { key: 'individual-sports', icon: '\uD83C\uDFCB\uFE0F', label: 'Individual Sports' },
    { key: 'athletics-events', icon: '\uD83C\uDFC5', label: 'Athletics & Events' },
    { key: 'racing', icon: '\uD83C\uDFCE\uFE0F', label: 'Racing' },
    { key: 'misc', icon: '\uD83D\uDD2C', label: 'Misc' },
  ]},
  'food':             { icon: '\uD83C\uDF7D\uFE0F', label: 'Food & Drink', subcategories: [
    { key: 'cuisines', icon: '\uD83C\uDF5C', label: 'Cuisines' },
    { key: 'ingredients', icon: '\uD83E\uDDC5', label: 'Ingredients' },
    { key: 'beverages', icon: '\uD83E\uDD64', label: 'Beverages' },
    { key: 'brands-restaurants', icon: '\uD83C\uDF54', label: 'Brands & Restaurants' },
    { key: 'misc', icon: '\uD83D\uDD2C', label: 'Misc' },
  ]},
  'logic':            { icon: '\uD83E\uDDE9', label: 'Logic' },
  'wild-card':        { icon: '\uD83C\uDFB2', label: 'Wild Card' }
};

/**
 * Find a subcategory node by key anywhere in the tree (DFS).
 * Returns the node object { key, icon, label, children? } or null.
 */
export function findSubcategoryNode(meta, key) {
  if (!meta?.subcategories || !key) return null;
  function search(nodes) {
    for (const node of nodes) {
      if (node.key === key) return node;
      if (node.children) {
        const found = search(node.children);
        if (found) return found;
      }
    }
    return null;
  }
  return search(meta.subcategories);
}

/**
 * Build a breadcrumb label for a category + subcategory key.
 * e.g. resolveCategoryLabel('world-geography', 'human-countries-capitals')
 *   → "World Geography — Human — Countries — Capitals"
 * If subcategoryKey is null/empty, returns just the category label.
 */
export function resolveCategoryLabel(category, subcategoryKey) {
  const meta = CATEGORY_META[category];
  if (!meta) return category;
  if (!subcategoryKey) return meta.label;

  function search(nodes, path) {
    for (const node of nodes) {
      if (node.key === subcategoryKey) return [...path, node.label];
      if (node.children) {
        const result = search(node.children, [...path, node.label]);
        if (result) return result;
      }
    }
    return null;
  }

  const chain = search(meta.subcategories || [], [meta.label]);
  return chain ? chain.join(' \u2014 ') : meta.label;
}

/**
 * Resolve the icon for a subcategory key. Falls back to the category icon.
 */
export function resolveSubcategoryIcon(category, subcategoryKey) {
  const meta = CATEGORY_META[category];
  if (!meta) return '?';
  if (!subcategoryKey) return meta.icon;
  const node = findSubcategoryNode(meta, subcategoryKey);
  return node ? node.icon : meta.icon;
}
