// ============================================
// Oracle Party — Centralized Category Metadata
// Single source of truth for all category/subcategory definitions
// ============================================

export const CATEGORY_META = {
  // Hieroglyph key: Gardiner sign list reference
  // Top-level icons chosen for visual impact + thematic accuracy
  'history':          { icon: '𓋹', emoji: '⏳', label: 'History', subcategories: [  // S34 Ankh — eternal, iconic
    { key: 'ancient', icon: '𓊹', emoji: '🏺', label: 'Ancient' },
    { key: 'medieval', icon: '𓌂', emoji: '⚔️', label: 'Medieval' },
    { key: 'early-modern', icon: '𓍹', emoji: '🗺️', label: 'Early Modern' },
    { key: 'modern', icon: '𓊝', emoji: '🏭', label: 'Modern' },
  ]},
  'science':          { icon: '𓂀', emoji: '⚗️', label: 'Science', subcategories: [  // D10 Eye of Horus — sacred knowledge
    { key: 'human-body', icon: '𓁷', emoji: '🫀', label: 'Human Body' },
    { key: 'elements', icon: '𓈗', emoji: '⚛️', label: 'Elements' },
    { key: 'space', icon: '𓇯', emoji: '🚀', label: 'Space' },
    { key: 'misc', icon: '𓁹', emoji: '🔬', label: 'Misc' },
  ]},
  'nature':           { icon: '𓅃', emoji: '🌿', label: 'Nature', subcategories: [  // G5 Falcon — apex of nature
    { key: 'animals', icon: '𓃭', emoji: '🦁', label: 'Animals' },
    { key: 'plants', icon: '𓆭', emoji: '🌸', label: 'Plants' },
    { key: 'environment', icon: '𓈖', emoji: '🌊', label: 'Environment' },
  ]},
  'arts-literature':  { icon: '𓏞', emoji: '📜', label: 'Arts & Literature', subcategories: [  // Y1 Papyrus scroll
    { key: 'literature', icon: '𓏛', emoji: '📖', label: 'Literature' },
    { key: 'visual-arts', icon: '𓍹', emoji: '🎨', label: 'Visual Arts' },
    { key: 'performing-arts', icon: '𓁐', emoji: '🎭', label: 'Performing Arts' },
    { key: 'misc', icon: '𓏞', emoji: '📜', label: 'Misc' },
  ]},
  'culture-society':  { icon: '𓀭', emoji: '🏛️', label: 'Culture & Society', subcategories: [  // A40 Seated god — authority / civilization
    { key: 'beliefs', icon: '𓊹', emoji: '🕊️', label: 'Beliefs' },
    { key: 'language', icon: '𓏞', emoji: '🗣️', label: 'Language' },
    { key: 'traditions', icon: '𓋹', emoji: '🎎', label: 'Traditions' },
    { key: 'institutions', icon: '𓉐', emoji: '⚖️', label: 'Institutions' },
    { key: 'misc', icon: '𓂀', emoji: '🏛️', label: 'Misc' },
  ]},
  'pop-culture':      { icon: '𓇳', emoji: '🎬', label: 'Pop Culture', subcategories: [  // N5 Sun disk — star / fame
    { key: 'entertainment', icon: '𓇳', emoji: '🎭', label: 'Entertainment', children: [
      { key: 'entertainment-movies', icon: '𓁹', emoji: '🎥', label: 'Movies' },
      { key: 'entertainment-television', icon: '𓇯', emoji: '📺', label: 'Television' },
      { key: 'entertainment-music', icon: '𓎛', emoji: '🎵', label: 'Music' },
      { key: 'entertainment-games', icon: '𓆣', emoji: '🎮', label: 'Games' },
    ]},
    { key: 'celebrities', icon: '𓇳', emoji: '⭐', label: 'Celebrities' },
    { key: 'misc', icon: '𓇳', emoji: '🎬', label: 'Misc' },
  ]},
  'world-geography':  { icon: '𓇯', emoji: '🌍', label: 'World Geography', subcategories: [  // N1 Sky — the expanse / the world
    { key: 'human', icon: '𓉐', emoji: '🏙️', label: 'Human', children: [
      { key: 'human-countries', icon: '𓈎', emoji: '🏳️', label: 'Countries', children: [
        { key: 'human-countries-capitals', icon: '𓊹', emoji: '🏛️', label: 'Capitals' },
        { key: 'human-countries-cities', icon: '𓉐', emoji: '🌆', label: 'Cities' },
        { key: 'human-countries-states', icon: '𓈎', emoji: '🗺️', label: 'States & Regions' },
      ]},
      { key: 'human-landmarks', icon: '𓍋', emoji: '🗿', label: 'Landmarks' },
      { key: 'human-misc', icon: '𓇯', emoji: '🌍', label: 'Misc' },
    ]},
    { key: 'natural', icon: '𓈗', emoji: '🏔️', label: 'Natural' },
  ]},
  'technology':       { icon: '𓊝', emoji: '💻', label: 'Technology', subcategories: [  // U19 Adze — tool / invention
    { key: 'computing', icon: '𓊝', emoji: '🖥️', label: 'Computing' },
    { key: 'inventions', icon: '𓍹', emoji: '💡', label: 'Inventions' },
  ]},
  'sports':           { icon: '𓃗', emoji: '⚽', label: 'Sports', subcategories: [  // E6 Horse — power / competition
    { key: 'team-sports', icon: '𓃭', emoji: '🏀', label: 'Team Sports' },
    { key: 'individual-sports', icon: '𓁐', emoji: '🏃', label: 'Individual Sports' },
    { key: 'athletics-events', icon: '𓃗', emoji: '🏅', label: 'Athletics & Events' },
    { key: 'racing', icon: '𓃗', emoji: '🏎️', label: 'Racing' },
    { key: 'misc', icon: '𓃗', emoji: '⚽', label: 'Misc' },
  ]},
  'food':             { icon: '𓋍', emoji: '🍕', label: 'Food & Drink', subcategories: [  // S30 Offering table — feast
    { key: 'cuisines', icon: '𓎟', emoji: '🍽️', label: 'Cuisines' },
    { key: 'ingredients', icon: '𓆭', emoji: '🧅', label: 'Ingredients' },
    { key: 'beverages', icon: '𓈖', emoji: '🍹', label: 'Beverages' },
    { key: 'brands-restaurants', icon: '𓉐', emoji: '🍔', label: 'Brands & Restaurants' },
    { key: 'language', icon: '𓏞', emoji: '📝', label: 'Language' },
    { key: 'misc', icon: '𓋍', emoji: '🍕', label: 'Misc' },
  ]},
  'logic':            { icon: '𓁹', emoji: '🧩', label: 'Logic', subcategories: [  // D4 Eye — precision / focus
    { key: 'math', icon: '𓏞', emoji: '🔢', label: 'Math' },
    { key: 'puzzles-strategy', icon: '𓂧', emoji: '♟️', label: 'Puzzles & Strategy' },
  ]},
  'wild-card':        { icon: '𓆣', emoji: '🃏', label: 'Wild Card', wildCardOptions: [  // L1 Scarab — luck / chaos
    { key: '__all_questions__', icon: '𓇳', emoji: '🌟', label: 'All Questions', hint: 'Every open-format question in the database' },
    { key: '__true_wild_card__', icon: '𓆣', emoji: '🎲', label: 'True Wild Card', hint: 'Only the weird, uncategorizable ones' },
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
 * Resolve the icon for a subcategory key. Falls back to the category icon.
 * @param {object} meta  CATEGORY_META[catName]
 * @param {string|null} subcategoryKey
 * @returns {string} icon character
 */
export function resolveSubcategoryIcon(meta, subcategoryKey) {
  if (!subcategoryKey) return meta.emoji || meta.icon;
  const node = findSubcategoryNode(meta, subcategoryKey);
  return node?.emoji || node?.icon || meta.emoji || meta.icon;
}
