// Draft and Random — the rules. No imports, so Node can test it.
//
// Both end in ONE SPIN at Start that picks the subject for the whole game,
// the way the difficulty vote picks the final question's level.
//
// DRAFT: in the lobby every person makes one move. A WANT puts a block for
// that category on the wheel. A BAN takes one of that category's blocks off
// and keeps the category out of the upset. Wanted categories share 95% of the
// wheel by their blocks; every category nobody touched shares the last 5%
// (the upset, 1 in 20, the same number as the difficulty wheel). With no
// blocks at all, every unbanned category is equally likely.
//
// RANDOM: no lobby step; every subject is equally likely.
//
// A room is stored as category 'wild-card' with one of the two subcategory
// keys below. A move lives on its player's seat (players.draft_move:
// "want:science" / "ban:history"); the spin's result on the room
// (rooms.draft_pick). Both columns are migration 082.

export const DRAFT_KEY = '__draft__';
export const DRAFT_ICON = '🗳️';
export const DRAFT_LABEL = 'Draft';
export const RANDOM_KEY = '__random__';
export const RANDOM_ICON = '🎰';
export const RANDOM_LABEL = 'Random';
/** What the difficulty wheel also keeps for options nobody chose: 1 in 20. */
export const DRAFT_UPSET_SHARE = 0.05;

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

// "Spin: Every question" — the same wheel, drawn once per question, so a game
// moves between subjects. Stored as two more subcategory keys, so the setting
// needs no column of its own.
export const DRAFT_EACH_KEY = '__draft_each__';
export const RANDOM_EACH_KEY = '__random_each__';

/** The stored key for a kind ('draft' | 'random') and how often it spins. */
export function spinKey(kind, everyQuestion) {
  if (kind === 'draft') return everyQuestion ? DRAFT_EACH_KEY : DRAFT_KEY;
  if (kind === 'random') return everyQuestion ? RANDOM_EACH_KEY : RANDOM_KEY;
  return null;
}
/** 'draft', 'random', or null for any other subcategory value. */
export function spinKind(key) {
  if (key === DRAFT_KEY || key === DRAFT_EACH_KEY) return 'draft';
  if (key === RANDOM_KEY || key === RANDOM_EACH_KEY) return 'random';
  return null;
}
export function spinLabel(key) {
  const kind = spinKind(key);
  return kind === 'draft' ? DRAFT_LABEL : kind === 'random' ? RANDOM_LABEL : null;
}
export function spinIcon(key) {
  const kind = spinKind(key);
  return kind === 'draft' ? DRAFT_ICON : kind === 'random' ? RANDOM_ICON : null;
}

export function isDraftRoom(room) {
  return !!room && spinKind(room.subcategory) === 'draft';
}
export function isRandomRoom(room) {
  return !!room && spinKind(room.subcategory) === 'random';
}
/** A room that draws a subject for every question rather than once. */
export function spinsEveryQuestion(room) {
  return !!room && (room.subcategory === DRAFT_EACH_KEY || room.subcategory === RANDOM_EACH_KEY);
}
/** A room whose subject is chosen by the spin at Start. */
export function isSpinRoom(room) {
  return isDraftRoom(room) || isRandomRoom(room);
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

/** People only. A bot has no opinion about tonight's subject. */
function movers(players) {
  return (players || []).filter(p => p && !p.is_bot);
}

/**
 * Who did what, per category. Only categories somebody touched appear.
 * { science: { wants: [player], bans: [player], blocks: 1 }, ... }
 * `blocks` is what is left on the wheel: wants minus bans, never below zero.
 */
export function draftTally(players) {
  const tally = {};
  for (const p of movers(players)) {
    const move = parseDraftMove(p.draft_move);
    if (!move) continue;
    const entry = tally[move.category] || (tally[move.category] = { wants: [], bans: [], blocks: 0 });
    (move.kind === 'want' ? entry.wants : entry.bans).push(p);
  }
  for (const entry of Object.values(tally)) {
    entry.blocks = Math.max(0, entry.wants.length - entry.bans.length);
  }
  return tally;
}

/**
 * 'want' (has blocks), 'even' (wanted, and every block was banned off) or
 * 'ban' (only banned). null for a category nobody touched.
 */
export function draftStatus(entry) {
  if (!entry) return null;
  if (entry.blocks > 0) return 'want';
  return entry.wants.length > 0 ? 'even' : 'ban';
}

/**
 * The wheel: every category's chance of being picked, summing to 1.
 * A category with a ban and no blocks left is 0, upset included.
 */
export function draftWeights(players) {
  const tally = draftTally(players);
  const weights = {};
  const wanted = DRAFT_CATEGORIES.filter(c => tally[c] && tally[c].blocks > 0);
  const untouched = DRAFT_CATEGORIES.filter(c => !tally[c]);
  for (const c of DRAFT_CATEGORIES) weights[c] = 0;

  if (wanted.length === 0) {
    // Nobody's want survived: every category nobody banned, equally. If the
    // room somehow banned all of them, the bans have nothing left to mean.
    const pool = untouched.length > 0 ? untouched : DRAFT_CATEGORIES;
    for (const c of pool) weights[c] = 1 / pool.length;
    return weights;
  }
  const blocks = wanted.reduce((sum, c) => sum + tally[c].blocks, 0);
  const upset = untouched.length > 0 ? DRAFT_UPSET_SHARE : 0;
  for (const c of wanted) weights[c] = (1 - upset) * (tally[c].blocks / blocks);
  for (const c of untouched) weights[c] = upset / untouched.length;
  return weights;
}

// RANDOM WITH VETOES (owner, 2026-11-17): in a Random lobby each person may
// veto one subject; nobody has to. Every subject nobody vetoed is equally
// likely. A veto that would leave fewer than RANDOM_MIN_LEFT subjects is not
// offered. A Random move is stored like a Draft ban ("ban:history"), so the
// column and its check need nothing new; only the word on screen is "Veto".
export const RANDOM_MIN_LEFT = 2;

/** The subjects some person vetoed. Wants are ignored: Random has none. */
export function vetoedSubjects(players) {
  const out = new Set();
  for (const p of movers(players)) {
    const move = parseDraftMove(p.draft_move);
    if (move && move.kind === 'ban') out.add(move.category);
  }
  return out;
}

/**
 * Random mode's wheel: every subject nobody vetoed, equally. If two vetoes
 * made at the same moment somehow leave nothing, the vetoes are ignored.
 */
export function randomWeights(players = []) {
  const vetoed = vetoedSubjects(players);
  let pool = DRAFT_CATEGORIES.filter(c => !vetoed.has(c));
  if (pool.length === 0) pool = DRAFT_CATEGORIES;
  const weights = {};
  for (const c of DRAFT_CATEGORIES) weights[c] = pool.includes(c) ? 1 / pool.length : 0;
  return weights;
}

/**
 * May this player veto `category` in a Random room? Their own current veto is
 * taken back first (a person holds one), and at least RANDOM_MIN_LEFT
 * subjects must stay in play.
 */
export function vetoAllowed(players, playerId, category) {
  if (!DRAFT_CATEGORIES.includes(category)) return false;
  const others = (players || []).filter(p => String(p?.id) !== String(playerId));
  const vetoed = vetoedSubjects(others);
  vetoed.add(category);
  return DRAFT_CATEGORIES.length - vetoed.size >= RANDOM_MIN_LEFT;
}

/** The wheel for a room, whichever kind it is. */
export function spinWeights(room, players) {
  return isDraftRoom(room) ? draftWeights(players) : randomWeights(players);
}

/** Only the subjects that can come up, in the usual order. */
export function liveSubjects(weights) {
  return DRAFT_CATEGORIES.filter(c => weights?.[c] > 0);
}

/** One spin. `roll` is a number in [0, 1); injectable so tests can aim it. */
export function pickWeighted(weights, roll = Math.random()) {
  const entries = DRAFT_CATEGORIES.map(c => [c, weights?.[c] || 0]).filter(([, w]) => w > 0);
  if (entries.length === 0) return DRAFT_CATEGORIES[Math.floor(roll * DRAFT_CATEGORIES.length)];
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let mark = roll * total;
  for (const [category, w] of entries) {
    mark -= w;
    if (mark < 0) return category;
  }
  return entries[entries.length - 1][0];
}

/** One subject per question, each an independent spin of the same wheel. */
export function pickSequence(weights, count, roll = Math.random) {
  return Array.from({ length: Math.max(0, count) }, () => pickWeighted(weights, roll()));
}

/**
 * The subject a question stands for in an every-question game. Every phone
 * works this out from the question itself, so nothing has to be stored per
 * round: of the question's own subjects, the one with the best odds on the
 * wheel, earliest in the list on a tie. A question filed under one subject
 * (nine in ten) has only one answer.
 */
export function questionSubject(weights, questionCategories) {
  const cats = (Array.isArray(questionCategories) ? questionCategories : [])
    .filter(c => DRAFT_CATEGORIES.includes(c));
  if (cats.length === 0) return null;
  let best = null;
  for (const c of DRAFT_CATEGORIES) {
    if (!cats.includes(c)) continue;
    if (best === null || (weights?.[c] || 0) > (weights?.[best] || 0)) best = c;
  }
  return best;
}

/** A stored pick is only believed if it names a real subject. */
export function validPick(value) {
  return DRAFT_CATEGORIES.includes(value) ? value : null;
}
