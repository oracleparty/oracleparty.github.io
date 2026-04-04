// ============================================
// Oracle Party — Centralized Category Metadata
// Single source of truth for all category/subcategory definitions
// ============================================

export const CATEGORY_META = {
  // Hieroglyph key: Gardiner sign list reference
  'history':          { icon: '𓋹', label: 'History', subcategories: [  // S34 Ankh — eternal life / time
    { key: 'ancient', icon: '𓊹', label: 'Ancient' },        // O7 — shrine / temple
    { key: 'medieval', icon: '𓌂', label: 'Medieval' },       // T3 — mace / weapon
    { key: 'early-modern', icon: '𓇳', label: 'Early Modern' }, // N5 — sun disk / era
    { key: 'modern', icon: '𓊝', label: 'Modern' },           // U19 — adze / tool / craft
  ]},
  'science':          { icon: '𓁹', label: 'Science', subcategories: [  // D4 Eye — observation / knowledge
    { key: 'human-body', icon: '𓁷', label: 'Human Body' },   // D2 — face
    { key: 'elements', icon: '𓈖', label: 'Elements' },       // N35 — water ripple
    { key: 'space', icon: '𓇯', label: 'Space' },             // N1 — sky
    { key: 'misc', icon: '𓁹', label: 'Misc' },               // D4 — eye
  ]},
  'nature':           { icon: '𓆭', label: 'Nature', subcategories: [  // M9 Lotus — plant / nature
    { key: 'animals', icon: '𓃭', label: 'Animals' },         // E23 — lion
    { key: 'plants', icon: '𓆰', label: 'Plants' },           // M13 — papyrus plant
    { key: 'environment', icon: '𓇋', label: 'Environment' }, // M17 — reed
  ]},
  'arts-literature':  { icon: '𓏞', label: 'Arts & Literature', subcategories: [  // Y1 Papyrus scroll
    { key: 'literature', icon: '𓏛', label: 'Literature' },   // Y3 — writing palette
    { key: 'visual-arts', icon: '𓍹', label: 'Visual Arts' }, // V10 — cartouche
    { key: 'performing-arts', icon: '𓁐', label: 'Performing Arts' }, // A15 — person with arms raised
    { key: 'misc', icon: '𓏞', label: 'Misc' },               // Y1 — scroll
  ]},
  'culture-society':  { icon: '𓉐', label: 'Culture & Society', subcategories: [  // O1 House — settlement
    { key: 'beliefs', icon: '𓊹', label: 'Beliefs' },         // O7 — shrine
    { key: 'language', icon: '𓂝', label: 'Language' },       // D36 — arm / offering
    { key: 'traditions', icon: '𓋹', label: 'Traditions' },   // S34 — ankh
    { key: 'institutions', icon: '𓉐', label: 'Institutions' }, // O1 — house
    { key: 'misc', icon: '𓂀', label: 'Misc' },               // D10 — Eye of Horus
  ]},
  'pop-culture':      { icon: '𓊃', label: 'Pop Culture', subcategories: [  // O34 bolt — energy / flash
    { key: 'entertainment', icon: '𓊃', label: 'Entertainment', children: [
      { key: 'entertainment-movies', icon: '𓁹', label: 'Movies' },
      { key: 'entertainment-television', icon: '𓊃', label: 'Television' },
      { key: 'entertainment-music', icon: '𓎛', label: 'Music' },     // V28 — wick / string
      { key: 'entertainment-games', icon: '𓆣', label: 'Games' },     // L1 — scarab
    ]},
    { key: 'celebrities', icon: '𓇳', label: 'Celebrities' },  // N5 — sun
    { key: 'misc', icon: '𓊃', label: 'Misc' },
  ]},
  'world-geography':  { icon: '𓇳', label: 'World Geography', subcategories: [  // N5 Sun disk — the world
    { key: 'human', icon: '𓉐', label: 'Human', children: [
      { key: 'human-countries', icon: '𓈎', label: 'Countries', children: [  // N29 — hill / land
        { key: 'human-countries-capitals', icon: '𓊹', label: 'Capitals' },
        { key: 'human-countries-cities', icon: '𓉐', label: 'Cities' },
        { key: 'human-countries-states', icon: '𓈎', label: 'States & Regions' },
      ]},
      { key: 'human-landmarks', icon: '𓍋', label: 'Landmarks' },  // U28 — fire drill
      { key: 'human-misc', icon: '𓇳', label: 'Misc' },
    ]},
    { key: 'natural', icon: '𓈗', label: 'Natural' },          // N36 — water channel
  ]},
  'technology':       { icon: '𓊝', label: 'Technology', subcategories: [  // U19 Adze — tool / craft
    { key: 'computing', icon: '𓊝', label: 'Computing' },
    { key: 'inventions', icon: '𓍹', label: 'Inventions' },   // V10 — cartouche
  ]},
  'sports':           { icon: '𓀀', label: 'Sports', subcategories: [  // A1 Seated man — person / athlete
    { key: 'team-sports', icon: '𓀀', label: 'Team Sports' },
    { key: 'individual-sports', icon: '𓁐', label: 'Individual Sports' },
    { key: 'athletics-events', icon: '𓋹', label: 'Athletics & Events' },
    { key: 'racing', icon: '𓃗', label: 'Racing' },           // E6 — horse
    { key: 'misc', icon: '𓀀', label: 'Misc' },
  ]},
  'food':             { icon: '𓎟', label: 'Food & Drink', subcategories: [  // X1 Bread — offering / sustenance
    { key: 'cuisines', icon: '𓎟', label: 'Cuisines' },
    { key: 'ingredients', icon: '𓆰', label: 'Ingredients' },  // M13 — papyrus / plant
    { key: 'beverages', icon: '𓈖', label: 'Beverages' },      // N35 — water
    { key: 'brands-restaurants', icon: '𓉐', label: 'Brands & Restaurants' },
    { key: 'language', icon: '𓂝', label: 'Language' },
    { key: 'misc', icon: '𓎟', label: 'Misc' },
  ]},
  'logic':            { icon: '𓂧', label: 'Logic', subcategories: [  // D46 Hand — direction / precision
    { key: 'math', icon: '𓃋', label: 'Math' },               // E2 — bull / power
    { key: 'puzzles-strategy', icon: '𓂧', label: 'Puzzles & Strategy' },
  ]},
  'wild-card':        { icon: '𓆣', label: 'Wild Card', wildCardOptions: [  // L1 Scarab — luck / transformation
    { key: '__all_questions__', icon: '𓇳', label: 'All Questions', hint: 'Every open-format question in the database' },
    { key: '__true_wild_card__', icon: '𓆣', label: 'True Wild Card', hint: 'Only the weird, uncategorizable ones' },
  ]}
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

  // Wild-card special options
  if (meta.wildCardOptions) {
    const opt = meta.wildCardOptions.find(o => o.key === subcategoryKey);
    if (opt) return `${meta.label} \u2014 ${opt.label}`;
  }

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
  // Wild-card special options
  if (meta.wildCardOptions) {
    const opt = meta.wildCardOptions.find(o => o.key === subcategoryKey);
    if (opt) return opt.icon;
  }
  const node = findSubcategoryNode(meta, subcategoryKey);
  return node ? node.icon : meta.icon;
}
