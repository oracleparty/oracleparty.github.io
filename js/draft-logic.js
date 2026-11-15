// Category draft — the rules. No imports, so Node can test it.
//
// The host picks "Draft" instead of a subject. In the lobby every person makes
// ONE move: want a category or ban one. A want and a ban on the same category
// cancel out. Each surviving want guarantees a share of the game's questions;
// a category with more bans than wants is left out; everything else is a
// random mix. Moves are public and may be changed until the host starts.
//
// A room in Draft is stored as category 'wild-card' with this subcategory, the
// same shape the two existing Wild Card options use, so no room column is new.
// Each person's move lives on their own seat (players.draft_move, migration
// 082) as "want:science" or "ban:history".

export const DRAFT_KEY = '__draft__';
export const DRAFT_ICON = '🗳️';
export const DRAFT_LABEL = 'Draft';

/** The subjects on offer. Wild Card is not one: it is not a subject. */
export const DRAFT_CATEGORIES = [
  'history', 'science', 'nature', 'arts-literature', 'culture-society',
  'pop-culture', 'world-geography', 'technology', 'sports', 'food', 'logic'
];

/** Labels short enough for a tile a quarter of a phone wide. */
export const DRAFT_SHORT_LABELS = {
  'history': 'History', 'science': 'Science', 'nature': 'Nature',
  'arts-literature': 'Arts & Lit', 'culture-society': 'Culture',
  'pop-culture': 'Pop Culture', 'world-geography': 'Geography',
  'technology': 'Tech', 'sports': 'Sports', 'food': 'Food', 'logic': 'Logic'
};

export function isDraftRoom(room) {
  return !!room && room.subcategory === DRAFT_KEY;
}

export function encodeDraftMove(kind, category) {
  if (kind !== 'want' && kind !== 'ban') return null;
  if (!DRAFT_CATEGORIES.includes(category)) return null;
  return `${kind}:${category}`;
}

/** "want:science" → { kind, category }. Anything else → null. */
export function parseDraftMove(value) {
  if (typeof value !== 'string') return null;
  const i = value.indexOf(':');
  if (i < 0) return null;
  const kind = value.slice(0, i);
  const category = value.slice(i + 1);
  if (kind !== 'want' && kind !== 'ban') return null;
  if (!DRAFT_CATEGORIES.includes(category)) return null;
  return { kind, category };
}

/** People only. A bot has no opinion about tonight's subjects. */
function movers(players) {
  return (players || []).filter(p => p && !p.is_bot);
}

/**
 * Who did what, per category. Only categories somebody touched appear.
 * { science: { wants: [player], bans: [player], net: 1 }, ... }
 */
export function draftTally(players) {
  const tally = {};
  for (const p of movers(players)) {
    const move = parseDraftMove(p.draft_move);
    if (!move) continue;
    const entry = tally[move.category] || (tally[move.category] = { wants: [], bans: [], net: 0 });
    if (move.kind === 'want') { entry.wants.push(p); entry.net += 1; }
    else { entry.bans.push(p); entry.net -= 1; }
  }
  return tally;
}

/** 'want' (guaranteed), 'ban' (left out), or 'even' (cancelled out). */
export function draftStatus(entry) {
  if (!entry) return null;
  if (entry.net > 0) return 'want';
  if (entry.net < 0) return 'ban';
  return 'even';
}

/** How many questions one want guarantees: an equal slice of the game. */
export function draftShare(totalQuestions, humanCount) {
  const n = Math.max(1, Math.floor(Number(totalQuestions) || 0));
  const people = Math.max(1, Math.floor(Number(humanCount) || 0));
  return Math.max(1, Math.floor(n / people));
}

/**
 * What the game is built from.
 *   featured: [{ category, count }]  guaranteed questions, never more than the game holds
 *   banned:   [category]             left out entirely
 *   share:    questions one want is worth
 */
export function draftPlan(players, totalQuestions) {
  const total = Math.max(1, Math.floor(Number(totalQuestions) || 0));
  const share = draftShare(total, movers(players).length);
  const tally = draftTally(players);
  const featured = [];
  const banned = [];
  for (const category of DRAFT_CATEGORIES) {
    const entry = tally[category];
    if (!entry) continue;
    if (entry.net > 0) featured.push({ category, count: entry.net * share });
    else if (entry.net < 0) banned.push(category);
  }
  // Never promise more than the game holds: trim the largest first.
  let promised = featured.reduce((sum, f) => sum + f.count, 0);
  while (promised > total) {
    const biggest = featured.reduce((a, b) => (b.count > a.count ? b : a));
    biggest.count -= 1;
    promised -= 1;
  }
  return { featured: featured.filter(f => f.count > 0), banned, share };
}

/**
 * Whose want a question answers, for the "Alice's pick" line. A question
 * counts when one of its categories was wanted and the want survived.
 */
export function draftPickers(players, questionCategories) {
  const cats = Array.isArray(questionCategories) ? questionCategories : [];
  const tally = draftTally(players);
  const names = [];
  for (const category of cats) {
    const entry = tally[category];
    if (!entry || entry.net <= 0) continue;
    for (const p of entry.wants) {
      const name = p.display_name || 'Someone';
      if (!names.includes(name)) names.push(name);
    }
  }
  return names;
}

/**
 * The one category to show for a question in a drafted game: a wanted one if
 * it has one, else its first real subject, else Wild Card.
 */
export function draftQuestionCategory(players, questionCategories) {
  const cats = Array.isArray(questionCategories) ? questionCategories : [];
  const tally = draftTally(players);
  return cats.find(c => tally[c] && tally[c].net > 0)
    || cats.find(c => DRAFT_CATEGORIES.includes(c))
    || 'wild-card';
}

/** "Alice's pick", "Alice & Bob's pick", "3 players' pick", or '' for none. */
export function draftPickLabel(names) {
  if (!names || names.length === 0) return '';
  if (names.length === 1) return `${names[0]}'s pick`;
  if (names.length === 2) return `${names[0]} & ${names[1]}'s pick`;
  return `${names.length} players' pick`;
}

/** True when a question belongs to a category the room banned. */
export function inBannedCategory(question, banned) {
  if (!banned || banned.length === 0) return false;
  const cats = Array.isArray(question?.categories) ? question.categories : [];
  return cats.some(c => banned.includes(c));
}
