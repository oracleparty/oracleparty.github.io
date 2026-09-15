/**
 * CLAPS — the rules, with no imports, so they can be unit tested in Node.
 *
 * Everything else in js/game/ pulls the Supabase client from esm.sh and cannot
 * be loaded by the test runner at all, which is why bot-logic.js, timer-helpers.js
 * and phase-order.js exist in this same shape. A rule that cannot be tested is a
 * rule that has been wrong for months before, in this exact codebase.
 */

/**
 * How many claps must have been AVAILABLE to you before a rate is shown.
 *
 * The owner's number: "20 claps available — about one game". It lives here
 * rather than in constants.js because this module deliberately has no imports,
 * and it is EXPORTED so that a screen explaining the floor reads it instead of
 * writing 20 again — the same quantity in two places is this project's most
 * repeated fault, and it would surface as a page promising a number at a
 * threshold the maths does not use.
 */
export const CLAP_RATE_FLOOR = 20;

/** How many claps an answer has. */
export function clapsForAnswer(claps, answerId) {
  if (!Array.isArray(claps) || !answerId) return 0;
  const target = String(answerId);
  let n = 0;
  for (const c of claps) if (String(c.answer_id) === target) n++;
  return n;
}

/** Did this player clap this answer? */
export function iClapped(claps, answerId, voterPlayerId) {
  if (!Array.isArray(claps) || !answerId || !voterPlayerId) return false;
  const a = String(answerId), v = String(voterPlayerId);
  return claps.some(c => String(c.answer_id) === a && String(c.voter_player_id) === v);
}

/**
 * Which answer this player clapped in a given round, if any.
 *
 * ONE PER ROUND is the owner's rule, so this can only ever return one id. It is
 * what lets the screen know that tapping a different row MOVES a clap rather
 * than adding one — without it the player would watch their old clap vanish
 * from a row they never touched and have no idea why.
 */
export function myClapInRound(claps, questionNumber, voterPlayerId) {
  if (!Array.isArray(claps) || voterPlayerId == null) return null;
  const v = String(voterPlayerId);
  const hit = claps.find(c =>
    Number(c.question_number) === Number(questionNumber) && String(c.voter_player_id) === v);
  return hit ? String(hit.answer_id) : null;
}

/** The seats that clapped one answer, in the order they did. */
export function clappersOf(claps, answerId) {
  if (!Array.isArray(claps) || !answerId) return [];
  const a = String(answerId);
  return claps.filter(c => String(c.answer_id) === a).map(c => String(c.voter_player_id));
}

/**
 * Apply one Realtime event to the cache, returning a NEW array.
 *
 * A DELETE PAYLOAD CARRIES ONLY THE PRIMARY KEY. Postgres sends the old row's
 * identity and nothing else for a delete, so a handler that tries to read
 * `old.answer_id` gets undefined and quietly removes nothing — the clap stays
 * on screen for ever after somebody takes it back. Removing by `id` is the only
 * thing that can work, and it is why the row has a surrogate key at all.
 *
 * Returns the same array reference when nothing changed, so a caller can skip
 * repainting rather than redrawing the screen on every echo of its own write.
 */
export function applyClapEvent(claps, payload) {
  const list = Array.isArray(claps) ? claps : [];
  const type = payload?.eventType || payload?.type;
  const row = payload?.new;
  const gone = payload?.old;

  if (type === 'DELETE') {
    const id = gone?.id != null ? String(gone.id) : null;
    if (!id) return list;
    const next = list.filter(c => String(c.id) !== id);
    return next.length === list.length ? list : next;
  }

  if (!row?.id) return list;
  const id = String(row.id);
  const at = list.findIndex(c => String(c.id) === id);

  // ONE CLAP PER ROUND IS AN INVARIANT, SO IT IS ALSO A DEDUPE RULE — and this
  // is what makes an optimistic tap safe. The screen adds a clap the instant it
  // is tapped, under a temporary id, so the player sees it move without waiting
  // for a round trip. The server's own row then arrives over Realtime with a
  // REAL id, and without this the two would sit side by side and every tap
  // would read as two claps.
  //
  // Nothing has to track which rows were optimistic: a second clap from the
  // same voter in the same round cannot exist, so the arriving truth simply
  // displaces whatever was standing in for it.
  const stale = (c) => String(c.id) !== id
    && String(c.voter_player_id) === String(row.voter_player_id)
    && Number(c.question_number) === Number(row.question_number);

  if (at === -1) {
    const next = list.filter(c => !stale(c));
    next.push(row);
    return next;
  }
  // An UPDATE is a clap MOVING to another answer. Replacing in place keeps the
  // order stable so the clapper strip does not reshuffle under a finger.
  const next = list.filter(c => !stale(c));
  const idx = next.findIndex(c => String(c.id) === id);
  next[idx] = row;
  return next;
}

/**
 * The Favourite Answers of a finished game.
 *
 * TIES ARE THE NORMAL CASE, NOT AN EDGE CASE, and this function exists because
 * of it. With TWO players nobody can win: each can only clap the other, so every
 * clapped answer sits at exactly one clap. Three players caps it at two. Only at
 * four or more does a single winner normally emerge.
 *
 * So it never picks one. It returns the top `limit` in clap order, and `more`
 * counts what would not fit — because a card that silently shows three of eight
 * equal answers is claiming those three were special, which is a small lie the
 * screen has no business telling.
 *
 * Ordering: most claps first, then by round. Chronological within a tier is the
 * only tie-break that is not arbitrary — it is the order they happened in.
 */
export function favouriteAnswers(claps, { limit = 3 } = {}) {
  if (!Array.isArray(claps) || claps.length === 0) return { entries: [], more: 0 };

  const byAnswer = new Map();
  for (const c of claps) {
    const key = String(c.answer_id);
    const seen = byAnswer.get(key);
    if (seen) {
      seen.claps++;
    } else {
      byAnswer.set(key, {
        answerId: key,
        playerId: c.clapped_player_id != null ? String(c.clapped_player_id) : null,
        questionNumber: Number(c.question_number),
        claps: 1,
      });
    }
  }

  const ranked = [...byAnswer.values()].sort((a, b) =>
    b.claps - a.claps || a.questionNumber - b.questionNumber);

  return {
    entries: ranked.slice(0, limit),
    more: Math.max(0, ranked.length - limit),
  };
}

/**
 * Lifetime clap numbers from `clap_history` rows.
 *
 * TOTAL and WEIGHTED, which the owner asked for as one weight rather than two:
 * claps received over claps AVAILABLE to you. The denominator already accounts
 * for game length and group size because the server counted it per round, so
 * nothing further has to be normalised here.
 *
 * `rate` IS NULL UNDER THE FLOOR rather than 0, and that distinction is the
 * whole point. Somebody clapped once in their only round is not a 100% player,
 * and showing 0 for "not enough play yet" is the same lie the admin count chips
 * refuse to tell by rendering `?` instead of `0`.
 */
export function clapTotals(rows, { floor = CLAP_RATE_FLOOR } = {}) {
  let received = 0, available = 0;
  for (const r of (Array.isArray(rows) ? rows : [])) {
    received += Number(r.claps_received) || 0;
    available += Number(r.claps_available) || 0;
  }
  return {
    received,
    available,
    rate: available >= floor ? received / available : null,
  };
}
