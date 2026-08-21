// ============================================
// Oracle Party — Question Selection
//
// NO IMPORTS, deliberately. js/db/questions.js reaches Supabase through
// esm.sh, which the test runner cannot resolve, so anything importing it is
// untestable. The same reason js/game/bot-logic.js exists. Pure decisions live
// here; the database half stays there.
// ============================================

/** Fisher-Yates. randFn injectable so a test can pin the order. */
function shuffle(arr, randFn = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(randFn() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Sort a pool of questions into the four buckets selection draws from, using
 * ONE definition of "this player knows it" — the verdict of their most recent
 * sighting, `last_correct`.
 *
 * WHY THIS EXISTS AS A FUNCTION. The two selection paths had grown two
 * different rules and neither matched the app's own idea of knowing something:
 *
 *   fetchQuestionsByCategory  knows it = got it right EVERY time
 *   fetchAllOpenQuestions     knows it = got it right AT LEAST ONCE
 *   Proficiency (migration 040)  knows it = got it right LAST time
 *
 * So the Wild Card mode and a normal category disagreed about the same player
 * and the same question, and the profile disagreed with both.
 *
 * THE CONSEQUENCE OF THE OLD CATEGORY RULE was the one that actually bit. A
 * question you missed once and have since learned reads times_seen=2,
 * times_correct=1 — which is "not right every time", so it could never reach
 * `mastered`, AND "has been wrong at least once", so it stayed in `redemption`
 * FOREVER. The redemption pool only ever grew: every question anybody had ever
 * fumbled stayed eligible for the ~5% draw for life, so the same old questions
 * kept resurfacing long after they had been learned. The draw rate was never
 * the problem; the pool it drew from could not shrink.
 *
 * With last_correct the pool is self-cleaning in both directions. Learn a
 * question and it leaves redemption for the back of the queue; forget one and
 * it comes back. Which is the same rule Proficiency uses, so the number on the
 * profile and the questions the game picks finally agree.
 *
 * Falls back to `times_correct > 0` where last_correct is null, so rows
 * predating migration 016 are read sensibly rather than as "never knew it".
 */
export function bucketQuestionsByHistory(available, history, playerUserIds, randFn = Math.random) {
  const histMap = {};
  for (const h of (history || [])) {
    const qid = h.question_id;
    if (!histMap[qid]) {
      histMap[qid] = { seenBy: new Set(), knownBy: new Set(), unknownBy: new Set(), lastSeen: 0 };
    }
    const e = histMap[qid];
    e.seenBy.add(h.user_id);
    const knows = h.last_correct == null ? (h.times_correct > 0) : !!h.last_correct;
    (knows ? e.knownBy : e.unknownBy).add(h.user_id);
    const ts = new Date(h.last_seen_at).getTime();
    if (ts > e.lastSeen) e.lastSeen = ts;
  }

  const loggedInCount = (playerUserIds || []).length;
  const fresh = [];       // nobody signed in has met it
  const redemption = [];  // at least one of them does not currently know it
  const seenMixed = [];   // met, nobody is missing it, but not everyone knows it
  const mastered = [];    // everyone signed in currently knows it

  for (const q of available) {
    const h = histMap[q.id];
    if (!h || h.seenBy.size === 0) fresh.push(q);
    else if (h.seenBy.size >= loggedInCount && h.knownBy.size >= loggedInCount) mastered.push(q);
    else if (h.unknownBy.size > 0) redemption.push(q);
    else seenMixed.push(q);
  }

  // Least-recently-seen first for the fallback pools, so a repeat is at least
  // the stalest one available.
  const byAge = (a, b) => (histMap[a.id]?.lastSeen || 0) - (histMap[b.id]?.lastSeen || 0);
  seenMixed.sort(byAge);
  mastered.sort(byAge);
  shuffle(fresh, randFn);
  shuffle(redemption, randFn);

  return { fresh, redemption, seenMixed, mastered, histMap };
}
